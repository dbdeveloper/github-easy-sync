// V2 structure layer — the CM6 `StateField<RangeSet>` that holds the ver-block
// ranges and maps them through every transaction (DIFF-EDITOR-V2.md §2.2.2 NOTE;
// terminal-inside, validated by the 1a/1b geometry gates).
//
// This is the spine of the new DiffPane: decorations (Phase 3b) and the
// commit-time split (diff-model.ts) DERIVE from this field; the pure data shape
// is `VerRange` (diff-model.ts). The field uses an INCLUSIVE `RangeValue` so an
// edit at a ver-block's edge grows THAT block — which is what lets an empty
// ver-block (its protected terminal `\n`) grow when the user types into it,
// with NO external `activeEmptyVer` hint (the old §1 model's complexity).
//
// All exports here are pure / state-level (no EditorView, no DOM), so they are
// unit-testable in vitest. The view wiring (decorations, keymap, the cursorVert
// command) lands in diff-pane.ts and is validated in the browser harness.

import {
  EditorState,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type ChangeDesc,
} from "@codemirror/state";
import type { VerRange } from "./diff-model";

// Inclusive RangeValue: `startSide = -1` (from leans left) + `endSide = 1` (to
// leans right) ⇒ an insert at either edge grows the range (CM6 reads these in
// RangeSet.map). 1a proved a generic StateField<RangeSet> grows the empty
// ver-block `[19,20)`→`[19,22)` over typed text this way — no DecorationSet needed.
export class VerRangeValue extends RangeValue {
  startSide = -1;
  endSide = 1;
  point = false;
  constructor(
    readonly ver: 1 | 2,
    readonly group: number,
  ) {
    super();
  }
  eq(other: RangeValue): boolean {
    return (
      other instanceof VerRangeValue &&
      other.ver === this.ver &&
      other.group === this.group
    );
  }
}

export type StructureSet = RangeSet<VerRangeValue>;

export function toRangeSet(ranges: VerRange[]): StructureSet {
  return RangeSet.of(
    ranges
      .slice()
      .sort((a, b) => a.from - b.from)
      .map((r) => new VerRangeValue(r.ver, r.group).range(r.from, r.to)),
  );
}

export function fromRangeSet(set: StructureSet): VerRange[] {
  const out: VerRange[] = [];
  const it = set.iter();
  while (it.value) {
    out.push({ from: it.from, to: it.to, ver: it.value.ver, group: it.value.group });
    it.next();
  }
  return out;
}

// Replace the whole structure (session start, replay, resolution). The field
// uses the carried RangeSet verbatim instead of mapping the previous one.
export const setStructure = StateEffect.define<StructureSet>();

export const structureField = StateField.define<StructureSet>({
  create() {
    return RangeSet.empty as StructureSet;
  },
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setStructure)) return e.value;
    return tr.docChanged ? value.map(tr.changes) : value;
  },
});

export function readStructure(state: EditorState): VerRange[] {
  return fromRangeSet(state.field(structureField));
}

// §2.2.4(1,3) terminal protection: the terminal `\n` (the char at index
// `range.to-1`) must never be deleted, so a ver-block never collapses below
// width-1. Returns false (reject the transaction) if any change would delete a
// terminal `\n`. Deleting a ver-block's *content* (everything before its
// terminal) is allowed — that maps the range to width-1 (a proper empty ver),
// validated by the delete-to-empty probe.
export function terminalProtected(ranges: VerRange[], changes: ChangeDesc): boolean {
  const terminals = new Set(ranges.map((r) => r.to - 1));
  let ok = true;
  // iterChangedRanges (on ChangeDesc) gives the replaced spans [fromA,toA) on the
  // OLD doc — exactly the chars a change deletes/overwrites.
  changes.iterChangedRanges((fromA: number, toA: number) => {
    for (let p = fromA; p < toA; p++) if (terminals.has(p)) ok = false;
  });
  return ok;
}

export const terminalProtectionFilter = EditorState.changeFilter.of((tr) => {
  if (!tr.docChanged) return true;
  // resolution / replay carry a setStructure effect and replace whole group spans
  // (incl. their terminals) on purpose — they drive doc + structure together.
  if (tr.effects.some((e) => e.is(setStructure))) return true;
  return terminalProtected(readStructure(tr.startState), tr.changes);
});

// §2.2.4(9)/§1.8.a empty-ver keyboard ENTRY — Up/Down only (PgUp/PgDn jump-page,
// decided 2026-06-12). Geometry (where native vertical motion lands) is CM6's
// heightmap, which already accounts for the height:0 hidden terminal lines; this
// pure helper only adds the STOP: the first empty-ver (width-1 range) strictly
// between the caret and the native landing, else the native landing unchanged.
// The empty-ver line then expands (decoration reacts to caret-present).
export function cursorVertTarget(
  ranges: VerRange[],
  curHead: number,
  nativeHead: number,
  forward: boolean,
): number {
  const empties = ranges.filter((r) => r.to - r.from === 1).map((r) => r.from);
  if (forward) {
    const skipped = empties.filter((f) => f > curHead && f < nativeHead).sort((a, b) => a - b);
    return skipped.length ? skipped[0] : nativeHead;
  }
  const skipped = empties.filter((f) => f < curHead && f > nativeHead).sort((a, b) => b - a);
  return skipped.length ? skipped[0] : nativeHead;
}
