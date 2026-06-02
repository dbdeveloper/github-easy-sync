// Selection rules for the DiffPane (DIFF-EDITOR.md §1.7) — Etap 1b.3.
//
// "Two editors in one": normal lines form the main editor; each ver-block
// is an isolated sub-editor. A selection may not mix the two spaces.
//
// Legal (§1.7):
//   - both ends in normal-space (one shared space across ALL normal
//     segments — a selection may span diff groups; their content is just
//     covered) — variants 1 & 3.
//   - both ends strictly inside the SAME ver-block — variant 2.
// Illegal (snapped/clamped):
//   - one end normal, the other in a ver-block (variants 4, 6).
//   - ends in different ver-blocks, incl. ver1↔ver2 of one group (5).
//
// Enforcement (covers keyboard Shift-extend AND mouse drag, both of which
// arrive as selection-only transactions):
//   - anchor strictly inside ver V → clamp head into [V.from, V.to].
//   - anchor in normal-space, head strictly inside ver W → snap head OUT,
//     jumping over W's whole group: forward → group end, backward → group
//     start (both are normal-space, since groups are separated by ≥1
//     common line). "Diff-line hidden under the selection."
// A COLLAPSED caret (anchor === head) is never touched — plain caret
// entry/exit into ver-blocks is §1.8 navigation (1b.4), not selection.
//
// Boundary rule: a position exactly at a ver-block edge (== from or == to)
// is NORMAL-space; only strictly-interior positions (from < p < to) belong
// to the ver-block. So selecting up to a ver edge from normal is legal, and
// an empty ver-block (from === to) has no interior → cannot be selected.
//
// Ctrl/Cmd-A (§1.7 #3): inside a ver-block selects only that block; else
// the whole doc (DiffPane has no default keymap, so we do select-all here).
//
// Canonical spec: docs/tasks/DIFF-EDITOR.md §1.7.

import {
  EditorSelection,
  EditorState,
  Extension,
  Prec,
  SelectionRange,
  Transaction,
  TransactionSpec,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { diffPaneStateField } from "./decorations";
import type { Segment } from "./editor-model";

interface VerBlock {
  group: number;
  role: "ver1" | "ver2";
  from: number;
  to: number;
}

// The ver-block STRICTLY containing pos (from < pos < to), or null when
// pos is in normal-space or at a ver edge. Empty ver-blocks (from === to)
// have no interior → never matched.
export function strictVerBlockAt(
  structure: Segment[],
  pos: number,
): VerBlock | null {
  for (const s of structure) {
    if (s.role === "normal") continue;
    if (pos > s.from && pos < s.to) {
      return { group: s.group, role: s.role, from: s.from, to: s.to };
    }
  }
  return null;
}

// [start, end) covering a group's whole diff-line: ver1.from … ver2.to.
function groupBounds(
  structure: Segment[],
  group: number,
): { start: number; end: number } | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const s of structure) {
    if (s.group !== group) continue;
    if (s.role === "ver1") start = s.from;
    if (s.role === "ver2") end = s.to;
  }
  return start !== null && end !== null ? { start, end } : null;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// Legalize ONE range by adjusting only the head (anchor is the fixed end).
export function legalizeRange(
  structure: Segment[],
  range: SelectionRange,
): SelectionRange {
  const { anchor, head } = range;
  if (anchor === head) return range; // collapsed caret — not a selection

  const aBlock = strictVerBlockAt(structure, anchor);
  if (aBlock) {
    // Anchor inside a ver-block → selection stays within it (variant 2).
    const h = clamp(head, aBlock.from, aBlock.to);
    return h === head ? range : EditorSelection.range(anchor, h);
  }

  // Anchor in normal-space.
  const hBlock = strictVerBlockAt(structure, head);
  if (!hBlock) return range; // both normal-space → legal (variant 1/3)

  // Head landed inside ver W → snap out over W's whole group.
  const g = groupBounds(structure, hBlock.group);
  if (!g) return range; // defensive: malformed group
  const h = head >= anchor ? g.end : g.start;
  return EditorSelection.range(anchor, h);
}

function legalizeSelection(
  structure: Segment[],
  sel: EditorSelection,
): EditorSelection {
  const ranges = sel.ranges.map((r) => legalizeRange(structure, r));
  return EditorSelection.create(ranges, sel.mainIndex);
}

// Transaction filter: legalize any selection-only transaction against the
// current structure. Doc-changing transactions are left alone (the caret
// there is the edit point; structure also shifts mid-transaction).
const selectionFilter = EditorState.transactionFilter.of(
  (tr: Transaction): TransactionSpec | readonly TransactionSpec[] => {
    if (!tr.selection || tr.docChanged) return tr;
    const field = tr.startState.field(diffPaneStateField, false);
    if (!field || field.structure.length === 0) return tr;
    const legal = legalizeSelection(field.structure, tr.newSelection);
    if (legal.eq(tr.newSelection)) return tr;
    return { selection: legal };
  },
);

// Ctrl/Cmd-A: select the enclosing ver-block, or the whole doc.
const selectAllOverride = Prec.high(
  keymap.of([
    {
      key: "Mod-a",
      run: (view: EditorView): boolean => {
        const field = view.state.field(diffPaneStateField, false);
        const head = view.state.selection.main.head;
        const block = field
          ? strictVerBlockAt(field.structure, head)
          : null;
        const sel = block
          ? EditorSelection.single(block.from, block.to)
          : EditorSelection.single(0, view.state.doc.length);
        view.dispatch({ selection: sel });
        return true;
      },
    },
  ]),
);

// DiffPane plugs this into its extensions (after the structure field).
export function selectionRules(): Extension {
  return [selectionFilter, selectAllOverride];
}
