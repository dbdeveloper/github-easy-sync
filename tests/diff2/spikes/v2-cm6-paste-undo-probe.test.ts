// @vitest-environment happy-dom
//
// PROBE — isolate CM6's NATIVE undo/redo cursor behaviour with ZERO diff2 code
// (no structure field, no invertedEffects, no two-dispatch). Just history() + a
// region replace, exactly like a real select-then-paste. Answers: "how does
// select-copy-paste undo actually behave, and is the redo→undo drift CM6-inherent
// or caused by our setStructure?"

import { describe, expect, it } from "vitest";
import { EditorState, EditorSelection, Transaction } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { createDiffPaneState } from "../../../src/diff2/diff-pane-v2";
import { readStructure } from "../../../src/diff2/diff-structure";
import { resolveGroup } from "../../../src/diff2/diff-resolve";

function mk(doc: string) {
  return EditorState.create({ doc, extensions: [history()] });
}
// drive a command on a bare state (no view)
function run(state: EditorState, cmd: typeof undo): EditorState {
  let next: EditorState | null = null;
  cmd({ state, dispatch: (tr) => (next = tr.state) });
  if (!next) throw new Error("command did not dispatch");
  return next;
}

describe("PROBE — CM6 native paste-like undo/redo cursor", () => {
  // doc "a\nL\nc\n" (len 6). "Select the whole region [2,4) = 'L\\n'... " — model a
  // real paste: selection is a RANGE, replace it, caret lands at end of insert.
  it("real paste (selection = RANGE): undo restores the RANGE; redo→end; undo→RANGE again", () => {
    let s = mk("a\nL\nc\n");
    // user SELECTS [2,4) ("L\n"), then pastes "X\n"
    s = s.update({ selection: EditorSelection.range(2, 4) }).state;
    s = s.update({
      changes: { from: 2, to: 4, insert: "X\n" },
      selection: { anchor: 4 }, // paste leaves caret at end of insert
      annotations: Transaction.userEvent.of("input.paste"),
    }).state;
    expect(s.doc.toString()).toBe("a\nX\nc\n");
    expect(s.selection.main.head).toBe(4); // forward: end

    const u1 = run(s, undo);
    expect(u1.doc.toString()).toBe("a\nL\nc\n");
    // KEY: does undo restore the pre-paste SELECTION (the range 2..4)?
    expect([u1.selection.main.anchor, u1.selection.main.head]).toEqual([2, 4]);

    const r1 = run(u1, redo);
    expect(r1.selection.main.head).toBe(4); // redo → end

    const u2 = run(r1, undo); // undo AFTER redo — the case that drifted for us
    expect(u2.doc.toString()).toBe("a\nL\nc\n");
    expect(
      [u2.selection.main.anchor, u2.selection.main.head],
      "undo-after-redo restores the range?",
    ).toEqual([2, 4]);
  });

  // Now model OUR resolve: caret is a CARET (not a range) BEFORE the change, the
  // change replaces a region NOT touching the caret-as-range, explicit end-caret.
  it("caret-before (not a range): undo→caret-before; redo→end; undo-after-redo→?", () => {
    let s = mk("a\nL\nc\n");
    s = s.update({ selection: { anchor: 3 } }).state; // caret at 3 (inside region)
    s = s.update({
      changes: { from: 2, to: 4, insert: "X\n" },
      selection: { anchor: 4 },
      annotations: Transaction.userEvent.of("input.paste"),
    }).state;
    expect(s.selection.main.head).toBe(4);

    const u1 = run(s, undo);
    expect(u1.selection.main.head, "undo → caret-before (3)?").toBe(3);

    const r1 = run(u1, redo);
    expect(r1.selection.main.head, "redo → end (4)?").toBe(4);

    const u2 = run(r1, undo);
    // DOCUMENTS THE FINDING: native CM6 caret-before DRIFTS to the insert end (4)
    // on undo-after-redo (point inside a replaced region maps to a boundary). THIS
    // is exactly why resolution carries an explicit resolveCaret marker instead of
    // trusting native selection mapping (see diff-structure cursorHistory).
    expect(u2.selection.main.head, "native caret-before drifts to end on undo-after-redo").toBe(4);
  });
});

// ── the fix, validated end-to-end THROUGH our stack (structureField +
// structureHistory + history) — model resolution as a REAL paste: pre-select the
// whole group as a RANGE, then replace. Cursor (CM6-native) AND structure
// (invertedEffects) must both round-trip across undo-after-redo. ───────────────
describe("PROBE — resolution-as-real-paste (RANGE pre-select) through diff2 stack", () => {
  it("undo restores whole-group SELECTION + the 2 ranges; stable across undo-after-redo", () => {
    // group [2,8): doc "a\nL\n\nR\n\nc\n"; keep1 → "L\n", end = 4
    const s0 = createDiffPaneState("a\nL\nc\n", "a\nR\nc\n");
    const groupSel = readStructure(s0); // [ver1[2,5), ver2[5,8)]
    const groupFrom = 2;
    const groupTo = 8;

    // pre-select the whole group as a RANGE (so undo restores THIS selection)
    const sel = s0.update({ selection: EditorSelection.range(groupFrom, groupTo) }).state;
    // resolve = the region replace (carries setStructure + explicit end caret)
    const s1 = sel.update(resolveGroup(sel.doc, readStructure(sel), 0, "keep1")!).state;
    expect(s1.doc.toString()).toBe("a\nL\nc\n");
    expect(readStructure(s1)).toEqual([]);
    expect(s1.selection.main.head).toBe(4); // forward: end

    const u1 = run(s1, undo);
    expect(u1.doc.toString()).toBe("a\nL\n\nR\n\nc\n");
    expect(readStructure(u1)).toEqual(groupSel); // ⭐ structure back (invertedEffects)
    expect([u1.selection.main.anchor, u1.selection.main.head]).toEqual([2, 8]); // ⭐ whole group SELECTED

    const r1 = run(u1, redo);
    expect(r1.selection.main.head).toBe(4);
    expect(readStructure(r1)).toEqual([]);

    const u2 = run(r1, undo); // undo AFTER redo — the drift case
    expect(u2.doc.toString()).toBe("a\nL\n\nR\n\nc\n");
    expect(readStructure(u2), "structure restored after redo→undo").toEqual(groupSel);
    expect(
      [u2.selection.main.anchor, u2.selection.main.head],
      "selection restored after redo→undo",
    ).toEqual([2, 8]); // ⭐ STABLE — no drift
  });

  // The user's HYBRID: A (RANGE) for stability, then on undo-of-resolution collapse
  // the restored whole-group selection to its .from (= ver1.from) so the caret sits
  // at the group start instead of the group being highlighted. The load-bearing
  // question: does that extra selection-only dispatch (addToHistory:false) break the
  // subsequent redo / undo?
  it("hybrid: post-undo collapse-to-FROM gives caret at ver1.from AND is redo-safe", () => {
    let s = createDiffPaneState("a\nL\nc\n", "a\nR\nc\n"); // group [2,8)
    const groupSel = readStructure(s);
    s = s.update({ selection: EditorSelection.range(2, 8) }).state; // A: RANGE pre-select
    s = s.update(resolveGroup(s.doc, readStructure(s), 0, "keep1")!).state; // resolve
    expect(s.selection.main.head).toBe(4); // forward → end

    s = run(s, undo);
    expect(readStructure(s)).toEqual(groupSel); // group back
    expect([s.selection.main.anchor, s.selection.main.head]).toEqual([2, 8]); // selected

    // conflict_resolution post-undo collapse-to-.from (selection-only, NOT in history)
    s = s
      .update({
        selection: { anchor: s.selection.main.from },
        annotations: Transaction.addToHistory.of(false),
      })
      .state;
    expect(s.selection.main.head).toBe(2); // ⭐ caret at ver1.from — what the user wants

    // REDO must still work despite the collapse
    s = run(s, redo);
    expect(s.doc.toString()).toBe("a\nL\nc\n");
    expect(readStructure(s)).toEqual([]);
    expect(s.selection.main.head).toBe(4); // forward → end again

    // UNDO again — group restored, still stable
    s = run(s, undo);
    expect(readStructure(s)).toEqual(groupSel);
    expect([s.selection.main.anchor, s.selection.main.head]).toEqual([2, 8]);
  });

  // The user's REAL wish: keyboard resolve → undo returns the caret to EXACTLY
  // where the hotkey was pressed (3), NOT the group start. Mechanism = store the
  // hotkey position as immutable custom data in the undo step, and on undo dispatch
  // the caret there explicitly (bypassing CM6's lossy mapping). The post-undo
  // dispatch is the SAME redo-safe one validated above; here we target the stored
  // position instead of .from. (The marker riding the undo tx is the structureHistory
  // pattern; here we simulate the listener with the known constant.)
  it("store hotkey-position → undo restores EXACT caret (3), even undo-after-redo", () => {
    const HOTKEY_POS = 3; // where Ctrl+Enter fired, inside ver1 content
    let s = createDiffPaneState("a\nL\nc\n", "a\nR\nc\n"); // group [2,8)
    const groupSel = readStructure(s);
    s = s.update({ selection: { anchor: HOTKEY_POS } }).state; // user's caret
    // A: RANGE pre-select for stable text+structure round-trip
    s = s.update({ selection: EditorSelection.range(2, 8) }).state;
    s = s.update(resolveGroup(s.doc, readStructure(s), 0, "keep1")!).state;
    expect(s.selection.main.head).toBe(4); // forward → end

    const restoreCaret = (st: EditorState) =>
      st
        .update({
          selection: { anchor: HOTKEY_POS },
          annotations: Transaction.addToHistory.of(false),
        })
        .state;

    s = restoreCaret(run(s, undo)); // listener: undo-of-resolution → caret to stored pos
    expect(readStructure(s)).toEqual(groupSel); // group back
    expect(s.selection.main.head).toBe(3); // ⭐ EXACT hotkey point

    s = run(s, redo);
    expect(s.selection.main.head).toBe(4); // forward → end

    s = restoreCaret(run(s, undo)); // undo-AFTER-redo
    expect(readStructure(s)).toEqual(groupSel);
    expect(s.selection.main.head, "exact caret survives undo-after-redo").toBe(3); // ⭐
  });
});
