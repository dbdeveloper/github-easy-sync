// V2 selection legalization (DIFF-EDITOR-V2.md §2.2.4(5) + §2.2.6). Two rules,
// applied to every selection-setting transaction:
//   - §2.2.4(5): a selection ANCHORED inside a ver-block stays plain text within
//     that block's content [from, to-1] — it never includes the terminal `\n`
//     (index to-1) and never leaves the block while it stays inside it.
//   - §2.2.6: the moment a selection crosses a diff-group boundary (from a normal
//     line, from one ver-block into its sibling, or out of the group), the WHOLE
//     group is selected — a diff-group behaves as ONE atomic character. Any group
//     a selection partially overlaps is fully included (Ctrl+A → whole doc falls
//     out of this: every group is fully contained, so nothing partial to expand).
//
// Multi-cursor is disabled (§2.2.4(10)), so only the main selection is legalized.
// Pure `legalizeSelection` (unit-tested) + a thin transactionFilter.

import { EditorSelection, EditorState } from "@codemirror/state";
import type { VerRange } from "./diff-model";
import { readStructure, setStructure } from "./diff-structure";

export interface GroupSpan {
  group: number;
  from: number; // ver1.from
  to: number; // ver2.to
}

export function groupsOf(ranges: VerRange[]): GroupSpan[] {
  const by = new Map<number, { v1?: VerRange; v2?: VerRange }>();
  for (const r of ranges) {
    const e = by.get(r.group) ?? {};
    if (r.ver === 1) e.v1 = r;
    else e.v2 = r;
    by.set(r.group, e);
  }
  const out: GroupSpan[] = [];
  for (const [group, { v1, v2 }] of by) {
    if (v1 && v2) out.push({ group, from: v1.from, to: v2.to });
  }
  return out.sort((a, b) => a.from - b.from);
}

// The ver-block whose selectable content zone [from, to-1] contains pos, else null.
// (to-1 is the position just BEFORE the terminal \n — the terminal is never selectable.)
function blockAt(ranges: VerRange[], pos: number): VerRange | null {
  for (const r of ranges) if (pos >= r.from && pos <= r.to - 1) return r;
  return null;
}

export function legalizeSelection(
  ranges: VerRange[],
  anchor: number,
  head: number,
): { anchor: number; head: number } {
  const a = blockAt(ranges, anchor);
  const h = blockAt(ranges, head);
  // §2.2.4(5): plain intra-block selection — anchor & head in the SAME ver-block.
  // blockAt already clamps to [from, to-1], so the terminal \n stays excluded.
  if (a && h && a.from === h.from && a.to === h.to) {
    return { anchor, head };
  }
  // §2.2.6: group-atomic — expand [lo,hi] so every group it overlaps is fully in.
  let lo = Math.min(anchor, head);
  let hi = Math.max(anchor, head);
  const groups = groupsOf(ranges);
  for (let changed = true; changed; ) {
    changed = false;
    for (const g of groups) {
      if (lo < g.to && hi > g.from) {
        // [lo,hi] selects ≥1 char of the group → include the whole group
        if (g.from < lo) {
          lo = g.from;
          changed = true;
        }
        if (g.to > hi) {
          hi = g.to;
          changed = true;
        }
      }
    }
  }
  return head >= anchor ? { anchor: lo, head: hi } : { anchor: hi, head: lo };
}

// Legalize the main selection of any pure selection-setting transaction (shift+
// arrow, mouse drag, Ctrl+A). Edits (docChanged) set a single caret, which
// legalizeSelection leaves untouched, so they're skipped. setStructure
// transactions (resolution/replay) drive the selection themselves.
export const selectionLegalizeFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || tr.docChanged) return tr;
  if (tr.effects.some((e) => e.is(setStructure))) return tr;
  const ranges = readStructure(tr.startState);
  const sel = tr.selection.main;
  const legal = legalizeSelection(ranges, sel.anchor, sel.head);
  if (legal.anchor === sel.anchor && legal.head === sel.head) return tr;
  return {
    selection: EditorSelection.single(legal.anchor, legal.head),
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
  };
});
