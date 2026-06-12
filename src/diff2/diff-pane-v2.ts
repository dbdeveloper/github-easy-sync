// V2 DiffPane view assembly — ties the structure spine (diff-structure.ts), the
// decoration decisions (diff-decorations.ts) and the model (diff-model.ts) into
// a live CM6 editor (DIFF-EDITOR-V2.md §2.2). This MIRRORS the prototype that the
// 1a Playwright gate validated in real Chromium (markers side:-1 don't steal
// Decoration.line, height:0 hides terminals, native moveVertically skips them,
// inclusive RangeSet grows, changeFilter protects the terminal \n, cursorVert
// stops at empty vers).
//
// New file during migration: the old `diff-pane.ts` is the §1 Segment[] model
// still consumed by diff-edit-view.ts; this becomes `diff-pane.ts` (old deleted)
// at the Phase-3 wiring step.
//
// Scope of this increment: the render + navigation spine. The editing-behaviour
// filters (auto-\n §2.2.4(2), external guards §2.2.5, selection-legalization
// §2.2.6, shift+arrow selection) and the marker action buttons (§1.9 / §2.2.9
// resolution) land in the next increments.

import {
  EditorSelection,
  EditorState,
  Prec,
  StateField,
  type Extension,
} from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  WidgetType,
} from "@codemirror/view";
import { buildModel } from "./diff-model";
import {
  cursorVertTarget,
  readStructure,
  structureField,
  terminalProtectionFilter,
  toRangeSet,
} from "./diff-structure";
import { type MarkerKind, markerSpecs, verLineDecisions } from "./diff-decorations";
import { autoNewlineFilter, externalGuardFilter } from "./diff-edits";
import { selectionLegalizeFilter } from "./diff-selection";
import { diffLineNumbers } from "./diff-line-numbers";
import { type ResolveChoice, resolveClickHandler } from "./diff-resolve";

// ── markers ────────────────────────────────────────────────────────────────
const MARKER_GLYPH: Record<MarkerKind, string> = {
  open: "≪",
  mid: "==",
  close: "≫",
};

// Resolution buttons per marker row (§1.9 / TODO #6.3). `↓`/`↑` hint which side
// the action acts on. Each maps to a ResolveChoice handled by resolveClickHandler.
const MARKER_BUTTONS: Record<MarkerKind, { label: string; choice: ResolveChoice }[]> = {
  open: [
    { label: "Keep ↓", choice: "keep1" }, // keep ver1 (ours)
    { label: "Remove ↓", choice: "keep2" }, // drop ver1 → keep ver2
  ],
  mid: [
    { label: "Apply Both ↓↑", choice: "both" },
    { label: "Remove Both ↓↑", choice: "neither" },
    { label: "Join", choice: "join" },
  ],
  close: [
    { label: "Apply ↑", choice: "keep2" }, // keep ver2 (theirs)
    { label: "Remove ↑", choice: "keep1" }, // drop ver2 → keep ver1
  ],
};

class MarkerWidget extends WidgetType {
  constructor(
    readonly kind: MarkerKind,
    readonly group: number,
  ) {
    super();
  }
  eq(other: MarkerWidget): boolean {
    return other.kind === this.kind && other.group === this.group;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = `diff2-marker diff2-marker-${this.kind}`;
    const glyph = document.createElement("span");
    glyph.className = "diff2-marker-glyph";
    glyph.textContent = MARKER_GLYPH[this.kind];
    el.appendChild(glyph);
    for (const b of MARKER_BUTTONS[this.kind]) {
      const btn = document.createElement("button");
      btn.className = "diff2-marker-btn";
      btn.textContent = b.label;
      btn.setAttribute("data-diff2-resolve", b.choice);
      btn.setAttribute("data-diff2-group", String(this.group));
      el.appendChild(btn);
    }
    return el;
  }
  get estimatedHeight(): number {
    return 18;
  }
}

// ── decorations ──────────────────────────────────────────────────────────────
// Build the CM6 DecorationSet from the pure §2.2.8/§2.2.2 decisions. Markers are
// block widgets (side from markerSpecs); ver lines get a colour class +
// `diff2-collapsed` (height:0) + `diff2-eol-glyph` (CSS renders the `↵`).
export function buildDecorations(state: EditorState): DecorationSet {
  const ranges = readStructure(state);
  const caret = state.selection.main.head;
  const all = [];
  for (const m of markerSpecs(state.doc, ranges)) {
    all.push(
      Decoration.widget({
        widget: new MarkerWidget(m.kind, m.group),
        block: true,
        side: m.side,
      }).range(m.pos),
    );
  }
  for (const d of verLineDecisions(state.doc, ranges, caret)) {
    const cls = [d.ver === 1 ? "diff2-v1" : "diff2-v2"];
    if (d.collapsed) cls.push("diff2-collapsed");
    if (d.glyph) cls.push("diff2-eol-glyph");
    all.push(Decoration.line({ class: cls.join(" ") }).range(d.from));
  }
  return Decoration.set(all, true);
}

export const decorationsField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (_value, tr) => buildDecorations(tr.state),
  provide: (f) => EditorView.decorations.from(f),
});

// ── navigation (§2.2.4(9) empty-ver stop) ────────────────────────────────────
// Plain Up/Down: native vertical motion (heightmap skips height:0) + stop at the
// first empty ver in the jumped span. Shift+arrow (selection extend) and
// PgUp/PgDn (jump-page, decided 2026-06-12) fall through to defaultKeymap.
function vertical(view: EditorView, forward: boolean): boolean {
  const cur = view.state.selection.main;
  const native = view.moveVertically(cur, forward);
  const target = cursorVertTarget(readStructure(view.state), cur.head, native.head, forward);
  view.dispatch({ selection: EditorSelection.cursor(target), scrollIntoView: true });
  return true;
}

export const diffNavKeymap: Extension = Prec.highest(
  keymap.of([
    { key: "ArrowDown", run: (v) => vertical(v, true) },
    { key: "ArrowUp", run: (v) => vertical(v, false) },
  ]),
);

// ── assembly ─────────────────────────────────────────────────────────────────
// Build the initial EditorState for a (base, sibling) pair. The structure field
// is seeded via `.init()` from the model's ranges (no post-create dispatch).
export function createDiffPaneState(base: string, sibling: string): EditorState {
  const m = buildModel(base, sibling);
  return EditorState.create({
    doc: m.doc,
    extensions: [
      diffLineNumbers, // §2.2.10 per-side −/+ gutter (replaces lineNumbers())
      history(),
      structureField.init(() => toRangeSet(m.ranges)),
      decorationsField,
      terminalProtectionFilter,
      externalGuardFilter, // §2.2.5(1) — changeFilter (runs before transactionFilters)
      autoNewlineFilter, // §2.2.4(2) — transactionFilter (appends normalization)
      selectionLegalizeFilter, // §2.2.4(5)/§2.2.6 — transactionFilter (legalize selection)
      resolveClickHandler(), // §2.2.9 marker-button clicks (deviceLabel/date wired in Phase 6)
      diffNavKeymap,
      keymap.of([...historyKeymap, ...defaultKeymap]),
      EditorView.lineWrapping,
    ],
  });
}

// Mount a DiffPane into `parent` and return the view. (Geometry validated by the
// 1a gate; full browser validation of THIS bundled module is the device gate.)
export function mountDiffPaneV2(parent: HTMLElement, base: string, sibling: string): EditorView {
  return new EditorView({ state: createDiffPaneState(base, sibling), parent });
}
