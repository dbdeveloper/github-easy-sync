// DiffPane — CM6 EditorView over the Rep A editor model (Stage 1b.1).
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

import {
  ChangeDesc,
  EditorSelection,
  EditorState,
  Extension,
  Prec,
  Transaction,
  TransactionSpec,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { ChunkChoice, JoinContext } from "./chunk-actions";
import {
  activeBlockAt,
  type BuildOpts,
  diffPaneExtension,
  diffPaneStateField,
  setActiveEmptyVer,
  setDiffPaneState,
} from "./decorations";
import {
  baseSiblingToModel,
  type EditorModel,
  fromEditorModel,
  mapStructure,
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
import { selectionRules, strictVerBlockAt } from "./selection-rules";

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
            activeEmptyVer: null,
          }),
          siblingWinsGutter(),
          sentinelGuard,
          collapseGuard,
          selectionRules(),
          normalizeGuard,
          this.hotkeys(),
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

  // Full (base, sibling) reconstruction — Stage 2's 7-step commit writes
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
      onActivateEmptyVer: (group: number, role: "ver1" | "ver2") =>
        this.activateEmptyVer(group, role),
    };
  }

  // §1.8.a — activate an EMPTY ver-block so the next typed char grows it
  // (places the caret at the block's point + sets the explicit active
  // state). No-op if the block isn't found or isn't empty.
  private activateEmptyVer(group: number, role: "ver1" | "ver2"): void {
    const field = this.view.state.field(diffPaneStateField, false);
    if (!field) return;
    const seg = field.structure.find(
      (s) => s.role === role && s.group === group,
    );
    if (!seg || seg.from !== seg.to) return; // only for empty ver-blocks
    this.view.dispatch({
      selection: EditorSelection.single(seg.from),
      effects: setActiveEmptyVer.of({ group, role }),
    });
    this.view.focus();
  }

  // §1.9 hotkeys — active only when the caret sits in a ver-block. Ctrl
  // (not Cmd) on every platform, per spec (Cmd-Backspace is OS-reserved).
  // Each returns false when the caret is outside a ver-block so other
  // handlers still see the key.
  private hotkeys(): Extension {
    const handle =
      (action: HotkeyAction, mdOnly = false) =>
      (view: EditorView): boolean => {
        if (mdOnly && !this.opts.isMarkdown) return false;
        const field = view.state.field(diffPaneStateField, false);
        if (!field) return false;
        const target = hotkeyTarget(
          field.structure,
          view.state.selection.main.head,
          action,
        );
        if (!target) return false;
        this.applyToChunk(target.group, target.choice);
        return true;
      };
    return Prec.high(
      keymap.of([
        { key: "Ctrl-Enter", run: handle("apply") },
        { key: "Ctrl-Backspace", run: handle("remove") },
        { key: "Ctrl-Shift-Enter", run: handle("both") },
        { key: "Ctrl-Shift-Backspace", run: handle("neither") },
        { key: "Ctrl-Shift-.", run: handle("join", true) },
      ]),
    );
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
        activeEmptyVer: null, // a chunk action clears any activation
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

// §1.9 hotkey → (group, choice) for the ver-block the caret sits in, or
// null when the caret is outside any ver-block. apply/remove are relative
// to which side the caret is in: apply ver1→ours, ver2→theirs; remove is
// the opposite (drop the caret's side, keep the other).
export type HotkeyAction = "apply" | "remove" | "both" | "neither" | "join";
export function hotkeyTarget(
  structure: Segment[],
  head: number,
  action: HotkeyAction,
): { group: number; choice: ChunkChoice } | null {
  const b = strictVerBlockAt(structure, head);
  if (!b) return null;
  let choice: ChunkChoice;
  if (action === "apply") {
    choice = b.role === "ver1" ? "ours" : "theirs";
  } else if (action === "remove") {
    choice = b.role === "ver1" ? "theirs" : "ours";
  } else {
    choice = action; // "both" | "neither" | "join"
  }
  return { group: b.group, choice };
}

// Re-lay-out a flat item list into (doc, structure): assign contiguous
// positions, drop empty NORMAL items (a "neither"-resolved group, or an
// emptied common run, leaves no line), but KEEP empty ver items (they
// belong to a live diff group). Applies apply-time normalization first
// (§1.6.a.2): a resolved NORMAL item that is non-empty, lacks a trailing
// \n, and is NOT the document's last surviving element gets a \n — else
// its content would merge into the next segment on split().
function relayout(items: SegItem[]): EditorModel {
  const normalized = normalizeItems(items);
  let doc = "";
  const structure: Segment[] = [];
  let pos = 0;
  for (const it of normalized) {
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

// §1.6.a.2 (apply-time): append \n to any non-last NORMAL item that is
// non-empty and lacks a trailing \n. Ver items pass through untouched
// (focus-leave normalization handles those). The last surviving element
// keeps an EOL-less tail (valid last-line-of-file).
function normalizeItems(items: SegItem[]): SegItem[] {
  let lastSurviving = -1;
  for (let i = 0; i < items.length; i++) {
    if (!(items[i].role === "normal" && items[i].text === "")) lastSurviving = i;
  }
  return items.map((it, i) => {
    if (it.role !== "normal" || i >= lastSurviving) return it;
    if (it.text.length > 0 && !it.text.endsWith("\n")) {
      return { ...it, text: it.text + "\n" };
    }
    return it;
  });
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

// Diff groups whose two ver-blocks became byte-equal after an edit (the
// §1.6 invariant "no diff-line with ver1 === ver2"). Both empty → remove
// (op4 "neither"); same non-empty → apply ver1 (op1 "ours", chosen for
// determinism). Compared against the supplied (post-edit) doc + structure.
function findCollapsibleGroups(
  doc: string,
  structure: Segment[],
): Array<{ group: number; choice: ChunkChoice }> {
  const out: Array<{ group: number; choice: ChunkChoice }> = [];
  for (let i = 0; i < structure.length; i++) {
    const s = structure[i];
    if (s.role !== "ver1") continue;
    const v2 = structure[i + 1];
    if (!v2 || v2.role !== "ver2" || v2.group !== s.group) continue;
    const t1 = doc.slice(s.from, s.to);
    const t2 = doc.slice(v2.from, v2.to);
    if (t1 === t2) {
      out.push({ group: s.group, choice: t1.length === 0 ? "neither" : "ours" });
    }
  }
  return out;
}

// Auto-collapse (§1.6): after a free edit makes a diff group's ver1 ===
// ver2 byte-exact, append the collapse INTO THE SAME transaction (combined
// spec) so a single Ctrl+Z reverts both the edit and the collapse
// (§1.6.a.3). The collapse carries a recomputed structure via the
// setDiffPaneState effect (role change: group → normal), which the field
// uses verbatim. Skips transactions that already carry that effect (chunk
// actions, and the collapse's own output → no re-entrancy).
const collapseGuard = EditorState.transactionFilter.of(
  (tr: Transaction): TransactionSpec | readonly TransactionSpec[] => {
    if (tr.effects.some((e) => e.is(setDiffPaneState))) return tr;
    if (!tr.docChanged) return tr;
    const field = tr.startState.field(diffPaneStateField, false);
    if (!field) return tr;

    // Recompute the post-edit structure exactly as the field will (same
    // active hint), then look for byte-equal ver pairs.
    const active =
      field.activeEmptyVer ??
      activeBlockAt(field.structure, tr.startState.selection.main.head);
    const postStructure = mapStructure(
      field.structure,
      tr.changes as ChangeDesc,
      active,
    );
    const postDoc = tr.newDoc.toString();
    const collapsible = findCollapsibleGroups(postDoc, postStructure);
    if (collapsible.length === 0) return tr;

    let items = currentItems({ doc: postDoc, structure: postStructure });
    for (const c of collapsible) {
      items = resolveGroupInItems(items, c.group, c.choice, undefined) ?? items;
    }
    const collapsed = relayout(items);

    return [
      tr,
      {
        changes: { from: 0, to: postDoc.length, insert: collapsed.doc },
        effects: setDiffPaneState.of({
          structure: collapsed.structure,
          opts: field.opts,
          activeEmptyVer: null,
        }),
      },
    ];
  },
);

// Focus-leave normalization (§1.6.a.2): when the caret leaves a ver-block
// (selection-only transaction) whose last line lost its \n — non-empty,
// no trailing \n, and the group is NOT the document's last element —
// append the \n IN THE SAME transaction. Without it the ver content would
// merge into the next segment on split() (correctness, not cosmetics). The
// combined change is mapped by the field's mapStructure with active = the
// left block (derived from the pre-edit caret), so the \n grows that block.
const normalizeGuard = EditorState.transactionFilter.of(
  (tr: Transaction): TransactionSpec | readonly TransactionSpec[] => {
    if (tr.effects.some((e) => e.is(setDiffPaneState))) return tr;
    if (tr.docChanged || !tr.selection) return tr;
    const field = tr.startState.field(diffPaneStateField, false);
    if (!field) return tr;

    const oldHead = tr.startState.selection.main.head;
    const newHead = tr.newSelection.main.head;
    const left = strictVerBlockAt(field.structure, oldHead);
    // Left iff the caret WAS strictly inside `left` and now is not.
    if (!left || (newHead > left.from && newHead < left.to)) return tr;

    const content = tr.startState.doc.sliceString(left.from, left.to);
    if (content.length === 0 || content.endsWith("\n")) return tr;
    if (isGroupLastElement(field.structure, left.group)) return tr;

    return [tr, { changes: { from: left.to, insert: "\n" } }];
  },
);

// True when `group`'s ver2 is the last segment in the structure (so the
// diff-line is the document's final element → an EOL-less tail is valid).
function isGroupLastElement(structure: Segment[], group: number): boolean {
  let v2Index = -1;
  for (let i = 0; i < structure.length; i++) {
    if (structure[i].role === "ver2" && structure[i].group === group) {
      v2Index = i;
    }
  }
  return v2Index === structure.length - 1;
}
