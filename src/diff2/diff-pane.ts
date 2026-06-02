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
  ChangeSet,
  EditorSelection,
  EditorState,
  Extension,
  Prec,
  Transaction,
  TransactionSpec,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  invertedEffects,
} from "@codemirror/commands";
import type { ChunkChoice, JoinContext } from "./chunk-actions";
import {
  type BuildOpts,
  diffPaneExtension,
  diffPaneStateField,
  setActiveEmptyVer,
  setDiffPaneState,
} from "./decorations";
import {
  type ActiveBlock,
  assertTiling,
  baseSiblingToModel,
  type EditorModel,
  fromEditorModel,
  growIndexFor,
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

// §1.8.a init activation: the initial caret is at position 0. If the document
// starts with an EMPTY ver-block (a `\1<ver2>` diff → empty ver1 at [0,0], or
// the mirror), return it so the field expands it on open. Only a ver sitting
// EXACTLY at [0,0] qualifies (ver1 precedes ver2 in nav order; the §1.6
// invariant means at most one side is empty). Exported for unit testing.
export function initialEmptyVerAt0(structure: Segment[]): ActiveBlock | null {
  for (const s of structure) {
    if (s.from > 0) break; // ordered; nothing else can start at 0
    if ((s.role === "ver1" || s.role === "ver2") && s.from === 0 && s.to === 0) {
      return { role: s.role, group: s.group };
    }
  }
  return null;
}

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
            // §1.8.a init: the default caret is at 0; if a ver-block sits EMPTY
            // there (a leading `\1<ver2>` diff — empty ver1 at [0,0]), activate
            // it so it expands and the cursor visibly lands inside, rather than
            // sitting at a zero-width invisible spot.
            activeEmptyVer: initialEmptyVerAt0(model.structure),
          }),
          siblingWinsGutter(),
          sentinelGuard,
          collapseGuard,
          selectionRules(),
          normalizeGuard,
          emptyVerArrowNav,
          this.hotkeys(),
          // Standard editing/undo. Our Prec.high keymaps above win for the
          // keys they bind (Mod-a, ↑/↓, Ctrl+Enter…); everything else
          // (Backspace/Delete/Enter, word-arrows, Home/End, PageUp/Down,
          // delete-line) falls through to defaultKeymap → a normal edit
          // through the filter pipeline. history({newGroupDelay:0}): each tx
          // is its own undo step (§2.3). structureHistory versions the
          // structure field across undo/redo (chunk-action role changes).
          history({ newGroupDelay: 0 }),
          structureHistory,
          keymap.of([...historyKeymap, ...defaultKeymap]),
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
  // both sides. An emptied side is committed as "\n", never "" — a diff2
  // base/sibling ALWAYS had content (snapshot.size !== 0), so a 0-byte
  // commit would trip SYNC2 §2.9's zero-byte-restore guard and resurrect
  // the old content, silently reverting the user's "clear the file" intent.
  // "\n" is the canonical minimal non-empty file (matches normalizeText's
  // "non-empty ⇒ trailing newline" policy).
  getResolved(): { base: string; sibling: string } {
    const { base, sibling } = split(fromEditorModel(this.modelNow()));
    return {
      base: base === "" ? "\n" : base,
      sibling: sibling === "" ? "\n" : sibling,
    };
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
  out[i] = { ...out[i], text: ensureNlIfFollowed(text, out, i) };
  return out;
}

function resolveAllItems(
  items: SegItem[],
  choice: ChunkChoice,
  joinCtx: JoinContext | undefined,
): SegItem[] {
  const out: SegItem[] = [];
  const resolvedIdx: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.role === "ver1" && items[i + 1]?.role === "ver2") {
      const text = resolveText(it.text, items[i + 1].text, choice, joinCtx);
      out.push({ role: "normal", group: -1, text });
      resolvedIdx.push(out.length - 1);
      i++; // consume ver2
      continue;
    }
    out.push(it);
  }
  for (const idx of resolvedIdx) {
    out[idx] = { ...out[idx], text: ensureNlIfFollowed(out[idx].text, out, idx) };
  }
  return out;
}

// §1.6.a.2 at resolution: a group resolved to NORMAL whose content lacks a
// trailing \n would merge into the following segment on split(). Give it a \n
// — but ONLY the resolved item, and only when content follows it. Pre-existing
// normal segments are never touched (a collapsed group between two normals must
// not gain a spurious blank line); ver segments left unresolved are normalized
// at the commit boundary (fromEditorModel) instead.
function ensureNlIfFollowed(text: string, items: SegItem[], idx: number): string {
  if (text.length === 0 || text.endsWith("\n")) return text;
  const hasLater = items.slice(idx + 1).some((it) => it.text.length > 0);
  return hasLater ? text + "\n" : text;
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
    case "both": {
      // §1.6 op3: ver1 then ver2. Guard the junction — if ver1 lacks a
      // trailing \n its last line would merge with ver2's first line
      // (review finding D), mirroring joinBlockquoteText's guard.
      const head = v1.length > 0 && !v1.endsWith("\n") ? v1 + "\n" : v1;
      return head + v2;
    }
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
// emptied common run, leaves no line), but KEEP empty ver items (they belong
// to a live diff group). Normalization is NOT done here — it is applied per
// resolved item in resolve*InItems (ensureNlIfFollowed), so pre-existing
// normal segments are never given a spurious \n.
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

// Version the structure field across undo/redo. CM6 history reverts the doc
// but does NOT re-apply our setDiffPaneState effects, so undoing a chunk
// action / collapse (which changed segment ROLES) would revert the text yet
// leave the structure "resolved" — a desync. For any tx that set the
// structure, record the PRE-tx structure as the effect to attach to the
// inverse (undo) transaction; symmetrically, the undo tx's own setDiffPaneState
// is inverted on redo. Free edits carry no setDiffPaneState (structure is
// remapped from the inverse changes), so they need no inversion here.
// Exported so the Stage-3b history-replay path can build a recovery editor with
// the SAME undo semantics (replay dispatches setDiffPaneState on every block;
// this inverts them so undo-after-replay walks the per-block trajectory).
export const structureHistory = invertedEffects.of((tr) => {
  for (const e of tr.effects) {
    if (e.is(setDiffPaneState)) {
      const prev = tr.startState.field(diffPaneStateField, false);
      return prev ? [setDiffPaneState.of(prev)] : [];
    }
  }
  return [];
});

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

// §1.7.a (0) — detect a Variant-3 free-edit RESOLUTION: a SINGLE change whose
// replaced range [fromA,toA] has BOTH ends in normal-space (edges count as
// normal — legalizeRange's rule) and fully covers ≥1 non-empty diff group. Per
// the spec this is a banal text replace: the covered region (normals + spanned
// groups) collapses to ONE normal segment carrying the inserted text → the
// conflict is resolved to normal text in both files. mapStructure maps each
// segment independently and CANNOT express this (it mis-tiles, dropping the
// insert into a gap — §1.7.a (0) root cause), so we rebuild the structure.
function detectSpanningResolve(
  structure: Segment[],
  changes: ChangeSet,
): { fromA: number; toA: number; delta: number } | null {
  const ranges: Array<{ fromA: number; toA: number; ins: number }> = [];
  changes.iterChanges((fa, ta, _fb, tb) => ranges.push({ fromA: fa, toA: ta, ins: tb - _fb }));
  if (ranges.length !== 1) return null; // only the single-selection-replace shape
  const { fromA, toA, ins } = ranges[0];
  // both ends normal-space (NOT strictly inside a ver)
  if (strictVerBlockAt(structure, fromA) || strictVerBlockAt(structure, toA)) return null;
  // must fully cover ≥1 non-empty ver
  const coversVer = structure.some(
    (s) => s.role !== "normal" && s.to > s.from && s.from >= fromA && s.to <= toA,
  );
  if (!coversVer) return null;
  return { fromA, toA, delta: ins - (toA - fromA) };
}

// Rebuild the structure for a spanning resolve: the resolved region (left-normal
// prefix … spanned groups … right-normal suffix) becomes ONE normal segment;
// segments fully before it stay; segments fully after shift by delta. The left
// edge is the normal containing fromA (first-match — keeps its prefix); the
// right edge is the normal containing toA (last-match — keeps its suffix).
//
// §1.7.a(1) — DOCUMENT BOUNDARY: when line 0 (or the last line) is a diff there
// is NO real normal at that edge. We then treat it as if a VIRTUAL empty normal
// line bracketed the document: a missing left normal is allowed ONLY when
// fromA === 0 (true doc start), a missing right normal ONLY when toA === oldLen
// (true doc end). A missing normal anywhere else (e.g. a ver1/ver2 junction) is
// ambiguous → return null (falls through → the tiling assert rejects it).
function rebuildSpanningResolve(
  structure: Segment[],
  fromA: number,
  toA: number,
  delta: number,
): Segment[] | null {
  const oldLen = structure[structure.length - 1].to;
  let li = -1;
  for (let k = 0; k < structure.length; k++) {
    const s = structure[k];
    if (s.role === "normal" && fromA >= s.from && fromA <= s.to) {
      li = k;
      break;
    }
  }
  let ri = -1;
  for (let k = structure.length - 1; k >= 0; k--) {
    const s = structure[k];
    if (s.role === "normal" && toA >= s.from && toA <= s.to) {
      ri = k;
      break;
    }
  }
  // Virtual boundary normals only at the true document edges.
  if (li < 0 && fromA !== 0) return null;
  if (ri < 0 && toA !== oldLen) return null;

  const regionStartOld = li >= 0 ? structure[li].from : 0;
  const regionEndOld = ri >= 0 ? structure[ri].to : oldLen;
  if (regionStartOld > fromA || regionEndOld < toA) return null; // region must cover the change

  const merged: Segment = {
    role: "normal",
    group: -1,
    from: regionStartOld,
    to: regionEndOld + delta,
  };
  const prefixEnd = li >= 0 ? li : 0; // segments[0..prefixEnd-1] kept as-is
  const suffixStart = ri >= 0 ? ri + 1 : structure.length; // segments[suffixStart..] shift
  const out: Segment[] = structure.slice(0, prefixEnd);
  out.push(merged);
  for (let k = suffixStart; k < structure.length; k++) {
    out.push({ ...structure[k], from: structure[k].from + delta, to: structure[k].to + delta });
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

    // §1.7.a (0) — Variant-3 spanning RESOLVE handled BEFORE the generic
    // mapStructure path (which mis-tiles a whole-segment-spanning change).
    // Rebuild the structure directly and hand it to the field via
    // setDiffPaneState (so the field skips mapStructure for this tx).
    const span = detectSpanningResolve(field.structure, tr.changes);
    if (span) {
      const rebuilt = rebuildSpanningResolve(field.structure, span.fromA, span.toA, span.delta);
      if (rebuilt) {
        assertTiling(rebuilt, tr.newDoc.length, "spanningResolve");
        return {
          changes: tr.changes,
          effects: [
            setDiffPaneState.of({ structure: rebuilt, opts: field.opts, activeEmptyVer: null }),
            ...tr.effects,
          ],
          selection: tr.newSelection,
          scrollIntoView: true,
        };
      }
    }

    // Recompute the post-edit structure EXACTLY as the field will (same
    // grow target via the shared growIndexFor), then look for byte-equal
    // ver pairs.
    const growIdx = growIndexFor(
      field.structure,
      field.activeEmptyVer,
      tr.startState.selection.main.head,
    );
    const postStructure = mapStructure(
      field.structure,
      tr.changes as ChangeDesc,
      growIdx,
    );
    const postDoc = tr.newDoc.toString();
    // Fail-closed: if mapStructure mis-tiled (e.g. a change spanning whole
    // segments — §1.7.a (0)), currentItems would slice by structure and
    // silently drop text in the gap. Throw loudly instead.
    assertTiling(postStructure, postDoc.length, "collapseGuard");
    const collapsible = findCollapsibleGroups(postDoc, postStructure);
    if (collapsible.length === 0) return tr;

    let items = currentItems({ doc: postDoc, structure: postStructure });
    for (const c of collapsible) {
      items = resolveGroupInItems(items, c.group, c.choice, undefined) ?? items;
    }
    const collapsed = relayout(items);

    // Return ONE composed spec, not `[tr, spec]`. A transactionFilter array
    // is merged with sequential=false, which resolves the appended changes
    // against the ORIGINAL doc — but `collapsed.doc` is in POST-tr space, so
    // the array form threw "Invalid change range" on a length-changing edit
    // and desynced on deletes (review finding A). Composing tr.changes with
    // the collapse (over postDoc) yields a single ChangeSet over startState,
    // interpreted correctly.
    const collapseCS = ChangeSet.of(
      { from: 0, to: postDoc.length, insert: collapsed.doc },
      postDoc.length,
    );
    return {
      changes: tr.changes.compose(collapseCS),
      effects: [
        setDiffPaneState.of({
          structure: collapsed.structure,
          opts: field.opts,
          activeEmptyVer: null,
        }),
        ...tr.effects,
      ],
      selection: tr.newSelection.map(collapseCS),
      scrollIntoView: true,
    };
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

// §1.8 / §1.8.a (1b.4b): the EMPTY ver-block (zero-width point) that a plain
// vertical caret move from `caretHead` to `targetHead` would skip over (an
// empty ver has no visual line, so default nav jumps past it). Returns the
// closest such ver in the direction of travel, or null. `targetHead` comes
// from CM6's own moveVertically (wrap-aware) — geometry stays in CM6.
export function findEmptyVerSkipped(
  structure: Segment[],
  caretHead: number,
  targetHead: number,
): { group: number; role: "ver1" | "ver2"; point: number } | null {
  if (targetHead === caretHead) return null;
  const down = targetHead > caretHead;
  let best: { group: number; role: "ver1" | "ver2"; point: number } | null =
    null;
  for (const s of structure) {
    if (s.role === "normal" || s.from !== s.to) continue; // empty vers only
    const p = s.from;
    const skipped = down
      ? p > caretHead && p <= targetHead
      : p >= targetHead && p < caretHead;
    if (!skipped) continue;
    const cand = { group: s.group, role: s.role, point: p };
    if (down) return cand; // closest below = first in doc order
    best = cand; // closest above = last match while ascending
  }
  return best;
}

// Plain (no-Shift) ↑/↓ caret nav that STOPS at an empty ver-block instead of
// skipping it (§1.8). Reuses the §1.8.a activation state + widget: entering
// sets activeEmptyVer (caret at the ver's point, column 0 — it's empty);
// pressing the arrow again clears it and continues in that direction. The
// "where would the arrow land" geometry is delegated to view.moveVertically
// (wrap-aware), so this needs real layout — verified manually, not in
// happy-dom (the pure findEmptyVerSkipped is unit-tested instead).
function makeArrowNav(forward: boolean) {
  return (view: EditorView): boolean => {
    const field = view.state.field(diffPaneStateField, false);
    if (!field || field.structure.length === 0) return false;
    const cur = view.state.selection.main;
    if (!cur.empty) return false; // plain caret only (Shift-arrow is selection)

    const target = view.moveVertically(cur, forward).head;

    // Already in an activated empty ver → this arrow leaves it.
    if (field.activeEmptyVer) {
      view.dispatch({
        selection: EditorSelection.cursor(target),
        effects: setActiveEmptyVer.of(null),
      });
      return true;
    }

    const skipped = findEmptyVerSkipped(field.structure, cur.head, target);
    if (!skipped) return false; // nothing skipped → default nav

    view.dispatch({
      selection: EditorSelection.cursor(skipped.point),
      effects: setActiveEmptyVer.of({
        group: skipped.group,
        role: skipped.role,
      }),
    });
    return true;
  };
}

const emptyVerArrowNav = Prec.high(
  keymap.of([
    { key: "ArrowDown", run: makeArrowNav(true) },
    { key: "ArrowUp", run: makeArrowNav(false) },
  ]),
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
