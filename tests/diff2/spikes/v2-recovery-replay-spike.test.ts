// @vitest-environment happy-dom
//
// SPIKE — recovery-replay cursor equivalence. Models Phase-5 crash recovery: a
// resolution transaction's persisted data is its change + the resolveCaret
// {before,after} + the post-resolution structure (the effect payloads). Recovery
// re-dispatches those into a FRESH editor to rebuild the in-memory CM6 history.
//
// The claim under test (the user's question): after recovery, UNDO-UNDO-UNDO-
// REDO-REDO-REDO jumps the caret to the SAME positions as the live (never-crashed)
// editor. We prove it the strongest way — run the identical undo/redo script on a
// LIVE view and a RECOVERED view in lockstep and require doc + structure + CARET to
// match at EVERY step.
//
// Why this works by construction: the caret is explicit DATA (resolveCaret), not
// derived from CM6's internal selection state — so replaying the data reproduces
// the behaviour without needing to reconstruct CM6's fragile selection bookkeeping.
// (Structure persistence has its own mechanism; here the spec carries setStructure
// so the structure side is faithful too — the focus assertion is the caret.)

import { describe, expect, it } from "vitest";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import { mountDiffPaneV2 } from "../../../src/diff2/diff-pane-v2";
import { readStructure } from "../../../src/diff2/diff-structure";
import { resolveGroup, type ResolveChoice } from "../../../src/diff2/diff-resolve";

const BASE = "top\nA1\nmid1\nB1\nmid2\nC1\nbot\n";
const SIBLING = "top\nA2\nmid1\nB2\nmid2\nC2\nbot\n";
const CHOICES: ResolveChoice[] = ["keep1", "keep2", "both"];

function snap(v: EditorView) {
  return {
    doc: v.state.doc.toString(),
    struct: readStructure(v.state),
    caret: v.state.selection.main.head,
  };
}

describe("SPIKE v2 recovery-replay — recovered editor matches live across undo/redo", () => {
  it("UNDO×3/REDO×3 (+ mixed tail): doc+structure+CARET identical, live vs recovered", () => {
    const liveParent = document.createElement("div");
    const recParent = document.createElement("div");
    document.body.append(liveParent, recParent);
    const live = mountDiffPaneV2(liveParent, BASE, SIBLING);
    const rec = mountDiffPaneV2(recParent, BASE, SIBLING);

    try {
      // ── LIVE session: resolve 3 groups (keyboard caret one char into ver1),
      //    capturing each transaction's spec as the "persisted log entry" ────────
      const log: TransactionSpec[] = [];
      for (let g = 0; g < 3; g++) {
        const ranges = readStructure(live.state);
        const v1 = ranges.find((r) => r.group === g && r.ver === 1)!;
        const before = v1.from + 1; // where the hotkey fired (keyboard)
        const spec = resolveGroup(live.state.doc, ranges, g, CHOICES[g], {}, before)!;
        log.push(spec);
        live.dispatch(spec);
      }

      // ── RECOVERY: replay the log into the fresh editor (re-dispatch the same
      //    change + resolveCaret + setStructure that disk would carry) ───────────
      for (const spec of log) rec.dispatch(spec);

      // recovered state == live state right after replay
      expect(snap(rec)).toEqual(snap(live));
      expect(snap(rec).struct).toEqual([]); // both fully resolved

      // ── identical undo/redo script on BOTH, lockstep equality at every step ───
      const script = [
        "undo", "undo", "undo", // the user's UNDO-UNDO-UNDO
        "redo", "redo", "redo", // REDO-REDO-REDO
        // mixed varying-depth tail (direction reversals at depth)
        "undo", "redo", "undo", "undo", "redo", "undo", "undo", "redo", "redo",
      ] as const;

      for (let i = 0; i < script.length; i++) {
        const op = script[i];
        const cmd = op === "undo" ? undo : redo;
        cmd(live);
        cmd(rec);
        const l = snap(live);
        const r = snap(rec);
        expect(r.doc, `step ${i} ${op} doc`).toBe(l.doc);
        expect(r.struct, `step ${i} ${op} struct`).toEqual(l.struct);
        expect(r.caret, `step ${i} ${op} CARET (recovered==live)`).toBe(l.caret);
      }
    } finally {
      live.destroy();
      rec.destroy();
      liveParent.remove();
      recParent.remove();
    }
  });
});
