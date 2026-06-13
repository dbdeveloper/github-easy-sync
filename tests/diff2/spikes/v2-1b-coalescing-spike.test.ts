// @vitest-environment happy-dom
//
// 1b-GATE SPIKE — the FIRM requirement (2026-06-13): history.jsonl reproduces the
// editor's undo-model BYTE-FOR-BYTE. N live undo-steps ⇒ N undo-steps on the
// recovered editor (#edit-blocks-on-stack == live undo-depth). A coalesced typing
// burst (many transactions → ONE undo group) must undo as ONE step on recovery too.
//
// Approach B (record-boundaries, the cleaner one): the writer records per-tx blocks
// + a `newGroup` flag computed from `undoDepth(state)` delta (+1 = new group, 0 =
// coalesced into the current group). Replay forces the SAME grouping with
// `isolateHistory.of("before")` on newGroup blocks (else they join) — so the
// recovered undo-model matches regardless of replay being synchronous.
//
// This spike resolves the open uncertainty: (1) does undoDepth() delta faithfully
// mark group boundaries under real coalescing? (2) does isolateHistory-on-replay
// reconstruct the same grouping → same undo-granularity?

import { describe, expect, it } from "vitest";
import { isolateHistory, redo, undo, undoDepth } from "@codemirror/commands";
import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { mountDiffPaneV2 } from "../../../src/diff2/diff-pane-v2";
import { fromRangeSet, readStructure, resolveCaret, setStructure, toRangeSet } from "../../../src/diff2/diff-structure";
import { resolveGroup } from "../../../src/diff2/diff-resolve";

type Entry =
  | { kind: "edit"; change: { from: number; to?: number; insert?: string }; newGroup: boolean; structure?: ReturnType<typeof fromRangeSet>; caret?: { before: number; after: number } }
  | { kind: "undo" }
  | { kind: "redo" };

const typeAnn = (forceNewGroup: boolean) =>
  forceNewGroup
    ? [Transaction.userEvent.of("input.type"), isolateHistory.of("before")]
    : [Transaction.userEvent.of("input.type")];

describe("1b-GATE SPIKE — coalesced bursts: undo-model reproduced byte-for-byte", () => {
  it("typing bursts coalesce to 1 undo-step each; recovery reproduces undo-depth + granularity", () => {
    const liveParent = document.createElement("div");
    document.body.appendChild(liveParent);
    const live = mountDiffPaneV2(liveParent, "hello\n", "hello\n"); // no groups — plain text

    try {
      const log: Entry[] = [];
      const liveType = (pos: number, ch: string, forceNewGroup: boolean) => {
        const before = undoDepth(live.state);
        live.dispatch({ changes: { from: pos, insert: ch }, annotations: typeAnn(forceNewGroup) });
        const newGroup = undoDepth(live.state) > before;
        log.push({ kind: "edit", change: { from: pos, insert: ch }, newGroup });
      };

      // burst1 "abc" (adjacent input.type, no forced boundary → should coalesce)
      liveType(0, "a", false);
      liveType(1, "b", false);
      liveType(2, "c", false);
      // [simulated typing pause] burst2 "XY" — force a NEW group on its first char
      liveType(3, "X", true);
      liveType(4, "Y", false);

      // ── DISCOVERY: did CM6 coalesce each burst into ONE undo group? ───────────
      expect(live.state.doc.toString()).toBe("abcXYhello\n");
      const liveDepth = undoDepth(live.state);
      expect(liveDepth, "two coalesced bursts ⇒ undo-depth 2").toBe(2);
      // the writer's newGroup flags must mark exactly the two group starts
      expect(log.map((e) => (e.kind === "edit" ? (e.newGroup ? "G" : "·") : "?")).join("")).toBe("G··G·");

      // ── RECOVERY: replay per-tx blocks, isolateHistory at newGroup boundaries ──
      const recParent = document.createElement("div");
      document.body.appendChild(recParent);
      const rec = mountDiffPaneV2(recParent, "hello\n", "hello\n");
      try {
        for (const e of log) {
          if (e.kind !== "edit") continue;
          rec.dispatch({ changes: e.change, annotations: typeAnn(e.newGroup) });
        }

        // recovered doc + UNDO-DEPTH identical
        expect(rec.state.doc.toString()).toBe(live.state.doc.toString());
        expect(undoDepth(rec.state), "recovered undo-depth == live").toBe(liveDepth);

        // ── BYTE-FOR-BYTE undo granularity: each undo reverts a WHOLE burst ──────
        undo(live); undo(rec);
        expect(live.state.doc.toString(), "live undo reverts whole burst2").toBe("abchello\n");
        expect(rec.state.doc.toString(), "recovered undo reverts whole burst2 too").toBe("abchello\n");

        undo(live); undo(rec);
        expect(live.state.doc.toString(), "live undo reverts whole burst1").toBe("hello\n");
        expect(rec.state.doc.toString(), "recovered undo reverts whole burst1 too").toBe("hello\n");
      } finally {
        rec.destroy();
        recParent.remove();
      }
    } finally {
      live.destroy();
      liveParent.remove();
    }
  });

  it("MIXED: coalesced burst + resolution + undo/redo — full undo-model reproduced", () => {
    const liveParent = document.createElement("div");
    document.body.appendChild(liveParent);
    // doc "A1\n\nA2\n\nx\n": group0 ver1[0,4) ver2[4,8), normal "x\n"[8,10)
    const live = mountDiffPaneV2(liveParent, "A1\nx\n", "A2\nx\n");

    try {
      const log: Entry[] = [];
      const liveType = (pos: number, ch: string, forceNewGroup: boolean) => {
        const before = undoDepth(live.state);
        live.dispatch({ changes: { from: pos, insert: ch }, annotations: typeAnn(forceNewGroup) });
        log.push({ kind: "edit", change: { from: pos, insert: ch }, newGroup: undoDepth(live.state) > before });
      };
      // burst "pq" into normal text "x" (positions 9,10 — adjacent, coalesce)
      liveType(9, "p", false);
      liveType(10, "q", false);

      // resolve group0 (keep1) — its own undo group; carries structure + caret
      let before2 = -1, after2 = -1;
      {
        const r = readStructure(live.state);
        const v1 = r.find((x) => x.group === 0 && x.ver === 1)!;
        before2 = v1.from + 1;
        const spec = resolveGroup(live.state.doc, r, 0, "keep1", {}, before2)!;
        const beforeDepth = undoDepth(live.state);
        live.dispatch(spec);
        after2 = live.state.selection.main.head;
        const effs = Array.isArray(spec.effects) ? spec.effects : [spec.effects!];
        log.push({
          kind: "edit",
          change: spec.changes as { from: number; to?: number; insert?: string },
          newGroup: undoDepth(live.state) > beforeDepth,
          structure: fromRangeSet(effs.find((e) => e.is(setStructure))!.value),
          caret: effs.find((e) => e.is(resolveCaret))!.value as { before: number; after: number },
        });
      }
      // undo (undoes resolution) + redo
      log.push({ kind: "undo" }); undo(live);
      log.push({ kind: "redo" }); redo(live);

      const liveDepth = undoDepth(live.state);
      expect(liveDepth, "burst(1) + resolution(1) = depth 2").toBe(2);

      // ── RECOVERY ───────────────────────────────────────────────────────────
      const recParent = document.createElement("div");
      document.body.appendChild(recParent);
      const rec = mountDiffPaneV2(recParent, "A1\nx\n", "A2\nx\n");
      try {
        for (const e of log) {
          if (e.kind === "undo") { undo(rec); continue; }
          if (e.kind === "redo") { redo(rec); continue; }
          const effects = [];
          if (e.structure) effects.push(setStructure.of(toRangeSet(e.structure)));
          if (e.caret) effects.push(resolveCaret.of(e.caret));
          const ann = e.newGroup
            ? [Transaction.userEvent.of("input.type"), isolateHistory.of("before")]
            : [Transaction.userEvent.of("input.type")];
          rec.dispatch({ changes: e.change as never, effects, annotations: ann });
        }

        // recovered doc + structure + undo-depth identical
        expect(rec.state.doc.toString(), "doc").toBe(live.state.doc.toString());
        expect(readStructure(rec.state), "structure").toEqual(readStructure(live.state));
        expect(undoDepth(rec.state), "undo-depth == live").toBe(liveDepth);

        // undo: resolution comes back (structure) + resolution caret = before2 (BOTH)
        undo(live); undo(rec);
        expect(readStructure(rec.state), "resolution undone → group back").toEqual(readStructure(live.state));
        expect(readStructure(rec.state).length).toBe(2); // group0 restored
        expect(rec.state.selection.main.head, "resolution undo caret (recovered)").toBe(before2);
        expect(live.state.selection.main.head, "resolution undo caret (live)").toBe(before2);

        // undo again: the WHOLE burst "pq" reverts as ONE step (byte-for-byte)
        undo(live); undo(rec);
        expect(live.state.doc.toString(), "burst reverts whole").toBe("A1\n\nA2\n\nx\n");
        expect(rec.state.doc.toString(), "recovered burst reverts whole too").toBe("A1\n\nA2\n\nx\n");
      } finally {
        rec.destroy();
        recParent.remove();
      }
    } finally {
      live.destroy();
      liveParent.remove();
    }
  });
});
