// DiffPane — CM6 EditorView over the Rep A editor model (Etap 1b.1).
//
// CM6 edits a CLEAN doc (no \0/\1); a StateField holds the ordered
// Segment[] structure (normal/ver1/ver2) and is mapped through every
// transaction (decorations.ts), so free editing stays sound. The
// joined \0/\1 string is internal serialization only — used at commit
// via split(fromEditorModel(model)).
//
// Two structure update paths (decorations.ts header):
//   - free edit  → mapStructure (positions only).
//   - chunk action (apply/remove/both/neither/join) → recompute the
//     structure (resolved group → normal) and dispatch it via the
//     setDiffPaneState effect together with the doc replacement.
//
// What 1b.1 deliberately does NOT add yet: selection rules (§1.7,
// 1b.3), caret navigation + empty-ver activation (§1.8, 1b.4), the
// auto-collapse listener (§1.6, 1b.5), the newline glyph + focus-leave
// normalization (§1.6.a, 1b.6). Editing is live but unconstrained; the
// sentinel transactionFilter is the one hardening pulled in here
// because a \0/\1 paste would corrupt the commit-time split().
//
// Canonical specs:
//   - docs/tasks/DIFF-EDITOR.md §1 (model), §1.10 (gutter), §1.6 (chunk ops)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7

import { EditorState, Transaction, TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ChunkChoice, JoinContext } from "./chunk-actions";
import {
  type BuildOpts,
  diffPaneExtension,
  diffPaneStateField,
  setDiffPaneState,
} from "./decorations";
import {
  baseSiblingToModel,
  type EditorModel,
  fromEditorModel,
  type SegRole,
  type Segment,
} from "./editor-model";
import {
  LINE_TERMINATOR,
  split,
  VER_SEPARATOR,
} from "./joined-doc";
import { siblingWinsGutter } from "./line-numbers";
import type { MarkerWidgetCallbacks } from "./markers";

export interface DiffPaneOpts {
  oursLabel: string;
  theirsLabel: string;
  isMarkdown: boolean;
  joinContext?: JoinContext;
}

const DEFAULT_OPTS: DiffPaneOpts = {
  oursLabel: "ours",
  theirsLabel: "theirs",
  isMarkdown: false,
};

export class DiffPane {
  private view: EditorView;
  private readonly opts: DiffPaneOpts;

  constructor(
    parent: HTMLElement,
    ours: string,
    theirs: string,
    opts: Partial<DiffPaneOpts> = {},
  ) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
    const model = baseSiblingToModel(ours, theirs);

    this.view = new EditorView({
      state: EditorState.create({
        doc: model.doc,
        extensions: [
          diffPaneExtension({
            structure: model.structure,
            opts: this.buildOpts(),
          }),
          siblingWinsGutter(),
          sentinelGuard,
          EditorView.lineWrapping,
        ],
      }),
      parent,
    });
  }

  // Resolve ONE diff group. Public API for marker-widget action buttons.
  applyToChunk(group: number, choice: ChunkChoice): void {
    const items = currentItems(this.modelNow());
    const resolved = resolveGroupInItems(
      items,
      group,
      choice,
      this.opts.joinContext,
    );
    if (!resolved) return; // group not found / not a diff
    this.dispatchModel(relayout(resolved));
  }

  // Resolve EVERY diff group with one choice (toolbar bulk actions).
  resolveAll(choice: ChunkChoice): void {
    const items = currentItems(this.modelNow());
    const resolved = resolveAllItems(items, choice, this.opts.joinContext);
    this.dispatchModel(relayout(resolved));
  }

  // Commit-side reconstruction (DIFF-EDITOR.md §5.0 Step 2 will split
  // BOTH sides). Returns the resolved BASE bytes for the still-naïve
  // exit-protocol. NOTE: returns split(...).base, NOT the merged doc —
  // the merged doc interleaves ver1+ver2 and would corrupt the base
  // file on a partially-resolved [← back].
  getResolvedBase(): string {
    return this.getResolved().base;
  }

  // Full (base, sibling) reconstruction — Etap 2's 7-step commit writes
  // both sides.
  getResolved(): { base: string; sibling: string } {
    return split(fromEditorModel(this.modelNow()));
  }

  getView(): EditorView {
    return this.view;
  }

  // Number of UNRESOLVED diff groups (one ver1 segment per group).
  remainingDiffChunkCount(): number {
    const field = this.view.state.field(diffPaneStateField, false);
    if (!field) return 0;
    return field.structure.filter((s) => s.role === "ver1").length;
  }

  destroy(): void {
    this.view.destroy();
  }

  // ── internals ─────────────────────────────────────────────────────

  private buildOpts(): BuildOpts {
    return {
      oursLabel: this.opts.oursLabel,
      theirsLabel: this.opts.theirsLabel,
      isMarkdown: this.opts.isMarkdown,
      callbacks: this.makeCallbacks(),
    };
  }

  private makeCallbacks(): MarkerWidgetCallbacks {
    return {
      onAction: (group: number, choice: ChunkChoice) =>
        this.applyToChunk(group, choice),
    };
  }

  // Current model read from the live EditorState (source of truth).
  private modelNow(): EditorModel {
    const field = this.view.state.field(diffPaneStateField, false);
    return {
      doc: this.view.state.doc.toString(),
      structure: field ? field.structure : [],
    };
  }

  // Replace the whole doc + set the recomputed structure via effect
  // (the chunk-action update path — roles changed, so this must NOT go
  // through mapStructure).
  private dispatchModel(next: EditorModel): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: next.doc },
      effects: setDiffPaneState.of({
        structure: next.structure,
        opts: this.buildOpts(),
      }),
    });
  }
}

// ── chunk-action helpers (operate on a flat item list) ───────────────

interface SegItem {
  role: SegRole;
  group: number;
  text: string;
}

function currentItems(model: EditorModel): SegItem[] {
  return model.structure.map((s) => ({
    role: s.role,
    group: s.group,
    text: model.doc.slice(s.from, s.to),
  }));
}

// Replace a (ver1, ver2) pair for `group` with a single resolved normal
// item. Returns null when the group isn't found. Other items unchanged.
function resolveGroupInItems(
  items: SegItem[],
  group: number,
  choice: ChunkChoice,
  joinCtx: JoinContext | undefined,
): SegItem[] | null {
  const i = items.findIndex((it) => it.role === "ver1" && it.group === group);
  if (i < 0 || items[i + 1]?.role !== "ver2") return null;
  const v1 = items[i].text;
  const v2 = items[i + 1].text;
  const text = resolveText(v1, v2, choice, joinCtx);
  const out = items.slice();
  out.splice(i, 2, { role: "normal", group: -1, text });
  return out;
}

function resolveAllItems(
  items: SegItem[],
  choice: ChunkChoice,
  joinCtx: JoinContext | undefined,
): SegItem[] {
  const out: SegItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.role === "ver1" && items[i + 1]?.role === "ver2") {
      const text = resolveText(it.text, items[i + 1].text, choice, joinCtx);
      out.push({ role: "normal", group: -1, text });
      i++; // consume ver2
      continue;
    }
    out.push(it);
  }
  return out;
}

// Per-choice resolution on the raw ver texts (which carry their own \n
// terminators). §1.6 ops: ours=ver1, theirs=ver2, both=ver1+ver2 (op3,
// no inserted blank), neither="" (op4), join=md blockquote.
function resolveText(
  v1: string,
  v2: string,
  choice: ChunkChoice,
  joinCtx: JoinContext | undefined,
): string {
  switch (choice) {
    case "ours":
      return v1;
    case "theirs":
      return v2;
    case "both":
      return v1 + v2;
    case "neither":
      return "";
    case "join": {
      if (!joinCtx) {
        throw new Error("DiffPane: 'join' requires a JoinContext");
      }
      return joinBlockquoteText(v1, v2, joinCtx);
    }
  }
}

// ver2 rendered as a Markdown blockquote callout under ver1 (R7.5).
function joinBlockquoteText(
  v1: string,
  v2: string,
  ctx: JoinContext,
): string {
  let out = "";
  if (v1 !== "") {
    out += v1.endsWith("\n") ? v1 : v1 + "\n";
    out += "\n"; // blank line between ours and the callout
  }
  out += `> Changes from \`${ctx.remoteDeviceLabel}\` at \`${ctx.timestamp}\`:\n`;
  out += ">\n";
  for (const line of splitLinesNoTrailing(v2)) out += `> ${line}\n`;
  return out;
}

function splitLinesNoTrailing(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// Re-lay-out a flat item list into (doc, structure): assign contiguous
// positions, drop empty NORMAL items (a "neither"-resolved group, or an
// emptied common run, leaves no line), but KEEP empty ver items (they
// belong to a live diff group).
function relayout(items: SegItem[]): EditorModel {
  let doc = "";
  const structure: Segment[] = [];
  let pos = 0;
  for (const it of items) {
    if (it.role === "normal" && it.text === "") continue;
    structure.push({
      role: it.role,
      group: it.group,
      from: pos,
      to: pos + it.text.length,
    });
    doc += it.text;
    pos += it.text.length;
  }
  return { doc, structure };
}

// Transaction filter: reject any change that would introduce a sentinel
// (\0 or \1) into the doc. Editing is live in 1b.1, so a control-char
// paste must not reach the commit-time split() (DIFF-EDITOR.md §1.3
// edit-time hardening). Dropping the transaction is the fail-closed
// response; the user simply sees the paste not take effect.
const sentinelGuard = EditorState.transactionFilter.of(
  (tr: Transaction): TransactionSpec | readonly TransactionSpec[] => {
    if (!tr.docChanged) return tr;
    let bad = false;
    tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
      const s = inserted.toString();
      if (s.includes(LINE_TERMINATOR) || s.includes(VER_SEPARATOR)) bad = true;
    });
    return bad ? [] : tr;
  },
);
