// V2 §2.2.9 recon — is scenario-2 (resolution = "paste", filter-rewrite)
// feasible and clean for UNDO/REDO + persistent replay in THIS CM6?
//
// Question (DIFF-EDITOR-V2.md §2.2.9): the two resolution scenarios are
//   (1) hand-built delete/insert range edits;
//   (2) selection + (clipboard) §2.2.7-repr + paste, as ONE command.
// Scenario-2 only wins if, in @codemirror/state 6.6 / commands 6.10:
//   A) a PROGRAMMATIC "paste"-shaped transaction is seen by
//      EditorState.transactionFilter (so the §2.2.7 / resolution rewrite
//      can run there) — no OS clipboard needed;
//   B) the filter can REWRITE that transaction into a composed spec that
//      ALSO carries a structure-field effect (mirrors diff-pane.ts
//      collapseGuard returning {changes, effects:[setDiffPaneState], …});
//   C) the whole thing lands as ONE undo step (history newGroupDelay:0);
//   D) undo reverts BOTH the doc AND the structure field (invertedEffects,
//      mirrors diff-pane.ts structureHistory) — and redo re-applies both;
//   E) the SAME rewrite is reproducible on a re-dispatch (replay): same
//      input text → same doc + same field, deterministically.
//
// This is pure transaction/history/state logic (no DOM geometry), so a
// vitest spike is authoritative here (unlike the height:0 nav spike,
// which needs a device). If all five PASS, scenario-2 is adopted as the
// canonical resolution + the history.jsonl block is a plain text replace
// that replay re-applies through the same filter.

import { describe, it, expect } from "vitest";
import {
  EditorState,
  StateField,
  StateEffect,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { history, invertedEffects, redo, undo } from "@codemirror/commands";

// A minimal stand-in for the V2 structure field (in production a RangeSet
// of {ver,group}; here a string token is enough to prove versioning).
const setStructure = StateEffect.define<string>();
const structureField = StateField.define<string>({
  create: () => "CONFLICT",
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setStructure)) return e.value;
    return value;
  },
});

// (D) version the field across undo/redo — verbatim shape from diff-pane.ts.
const structureHistory = invertedEffects.of((tr) => {
  for (const e of tr.effects) {
    if (e.is(setStructure)) {
      const prev = tr.startState.field(structureField, false);
      return prev != null ? [setStructure.of(prev)] : [];
    }
  }
  return [];
});

// The "resolution" marker a scenario-2 paste would carry. In production
// this is the §2.2.7 diff-group template (or simply the chosen resolved
// text); here a sentinel keeps the spike about the MECHANISM, not parsing.
const RESOLVE_MARKER = "<<RESOLVE:ours>>";

// (A)+(B) one transactionFilter that, on a paste carrying the marker,
// rewrites the transaction: swap the inserted marker for the resolved
// plain text AND attach the structure effect (group → resolved). Exactly
// the collapseGuard composition pattern.
let filterSawPaste = false;
const resolutionFilter = EditorState.transactionFilter.of(
  (tr: Transaction): TransactionSpec | readonly TransactionSpec[] => {
    if (!tr.docChanged) return tr;
    if (tr.effects.some((e) => e.is(setStructure))) return tr; // no re-entrancy
    let pasted = "";
    let from = 0;
    let to = 0;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, ins) => {
      pasted = ins.toString();
      from = fromA;
      to = toA;
    });
    if (!pasted.includes(RESOLVE_MARKER)) return tr;
    if (tr.isUserEvent("input.paste")) filterSawPaste = true; // (A) proof
    const resolved = "ours-line\n";
    return {
      changes: { from, to, insert: resolved },
      effects: [setStructure.of("RESOLVED")],
      selection: { anchor: from + resolved.length },
      userEvent: "input.paste",
    };
  },
);

function freshState(doc: string): EditorState {
  filterSawPaste = false;
  return EditorState.create({
    doc,
    extensions: [
      history({ newGroupDelay: 0 }), // (C) each tx = its own undo group
      structureField,
      structureHistory,
      resolutionFilter,
    ],
  });
}

// Dispatch a programmatic "paste" — NO OS clipboard, just a transaction
// shaped like one (userEvent input.paste). This is how a scenario-2
// resolution button would fire.
function pasteResolve(state: EditorState, from: number, to: number): EditorState {
  return state.update({
    changes: { from, to, insert: RESOLVE_MARKER },
    userEvent: "input.paste",
    scrollIntoView: true,
  }).state;
}

describe("V2 §2.2.9 — scenario-2 (paste-rewrite) feasibility", () => {
  it("A+B: a programmatic paste is filtered and rewritten with a field effect", () => {
    // doc: a normal line, then a 'conflict' region [9,21) we 'resolve'.
    const s0 = freshState("common-1\nCONFLICT-TXT\ncommon-2\n");
    expect(s0.field(structureField)).toBe("CONFLICT");

    const s1 = pasteResolve(s0, 9, 22); // replace "CONFLICT-TXT\n" (incl. its \n)
    expect(filterSawPaste).toBe(true); // (A) filter saw the programmatic paste
    // (B) doc carries the RESOLVED text (marker swapped out), field flipped.
    expect(s1.doc.toString()).toBe("common-1\nours-line\ncommon-2\n");
    expect(s1.field(structureField)).toBe("RESOLVED");
    // caret sits right after the resolved insert (scenario-2 cursor rule).
    expect(s1.selection.main.head).toBe(9 + "ours-line\n".length);
  });

  it("C+D: resolution is ONE undo step; undo reverts doc AND field; redo restores", () => {
    const s0 = freshState("common-1\nCONFLICT-TXT\ncommon-2\n");
    const s1 = pasteResolve(s0, 9, 22);
    expect(s1.field(structureField)).toBe("RESOLVED");

    // (C)+(D) single undo → back to the conflict doc AND the field reverts.
    let undone: EditorState | null = null;
    undo({ state: s1, dispatch: (tr) => { undone = tr.state; } });
    expect(undone).not.toBeNull();
    expect(undone!.doc.toString()).toBe("common-1\nCONFLICT-TXT\ncommon-2\n");
    expect(undone!.field(structureField)).toBe("CONFLICT"); // field versioned

    // redo → both re-apply.
    let redone: EditorState | null = null;
    redo({ state: undone!, dispatch: (tr) => { redone = tr.state; } });
    expect(redone).not.toBeNull();
    expect(redone!.doc.toString()).toBe("common-1\nours-line\ncommon-2\n");
    expect(redone!.field(structureField)).toBe("RESOLVED");
  });

  it("E: replay is deterministic — same paste input reproduces doc + field", () => {
    const a = pasteResolve(freshState("x\nCONFLICT-TXT\ny\n"), 2, 14);
    const b = pasteResolve(freshState("x\nCONFLICT-TXT\ny\n"), 2, 14);
    expect(a.doc.toString()).toBe(b.doc.toString());
    expect(a.field(structureField)).toBe(b.field(structureField));
    // → the history.jsonl block can be the plain text replace; replay
    //   re-dispatches it through the same filter and lands identically.
  });
});
