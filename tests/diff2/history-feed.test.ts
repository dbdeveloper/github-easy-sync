// @vitest-environment happy-dom
//
// V2 history-feed wiring (DIFF-EDITOR.md §0.5.6 step-2). The pure `classifyFeed`
// truth table needs no CM6. The FIDELITY tests are the spine: they re-run BOTH
// proven gate spikes (v2-mixed-recovery + v2-1b-coalescing) through the REAL
// production listener — `historyFeedListener` → in-memory sink → serialize →
// `replayWithGuard` into a fresh view — retiring the hand-rolled `liveRecorder`
// the step-1 tests used. If the captured blocks reproduce the live editor on
// replay (doc + structure + undo-model + resolution caret) AND the replay does NOT
// double-record into the replay view's own sink, the wiring is faithful.

import { describe, expect, it } from "vitest";
import { isolateHistory, redo, undo, undoDepth } from "@codemirror/commands";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { mountDiffPaneV2 } from "../../src/diff2/diff-pane-v2";
import { readStructure } from "../../src/diff2/diff-structure";
import { resolveGroup } from "../../src/diff2/diff-resolve";
import {
  buildCommandBlock,
  buildEditBlock,
  serializeBlock,
} from "../../src/diff2/history-log-v2";
import type { HistoryBlockV2 } from "../../src/diff2/history-log-v2";
import {
  classifyFeed,
  ReplayFlag,
  replayWithGuard,
  type HistorySink,
} from "../../src/diff2/history-feed";
import { assessHistoryV2 } from "../../src/diff2/history-replay-v2";
import { HistoryWriterV2 } from "../../src/diff2/history-log-v2";

// Compile-time guard (advisor): the production sink must satisfy the bridge's
// HistorySink interface. Nothing wires a real HistoryWriterV2 until Phase 6, so
// without this a signature drift would surface there, not here.
const _sinkShapeCheck: HistorySink = HistoryWriterV2.prototype;
void _sinkShapeCheck;

// ── pure: classifyFeed truth table (§0.5.3) ──────────────────────────
describe("classifyFeed — pure decision", () => {
  const base = { docChanged: true, isUndo: false, isRedo: false, isReplayDispatch: false, replaying: false };
  it("plain doc change → edit", () => {
    expect(classifyFeed(base)).toBe("edit");
  });
  it("undo wins over docChanged (undo tx is docChanged)", () => {
    expect(classifyFeed({ ...base, isUndo: true })).toBe("undo");
  });
  it("redo wins over docChanged", () => {
    expect(classifyFeed({ ...base, isRedo: true })).toBe("redo");
  });
  it("replaying flag suppresses everything", () => {
    expect(classifyFeed({ ...base, replaying: true })).toBe("skip");
    expect(classifyFeed({ ...base, isUndo: true, replaying: true })).toBe("skip");
  });
  it("replayDispatch annotation suppresses an edit re-dispatch", () => {
    expect(classifyFeed({ ...base, isReplayDispatch: true })).toBe("skip");
  });
  it("pure selection move (no doc change) → skip", () => {
    expect(classifyFeed({ ...base, docChanged: false })).toBe("skip");
  });
});

// ── in-memory sink: builds the SAME blocks HistoryWriterV2 would ─────
// The production HistorySink (HistoryWriterV2) builds blocks via
// buildEditBlock/buildCommandBlock then appends. The test sink builds them the
// same way and keeps them in an array, so we can serialize → replay.
function arraySink(): HistorySink & { blocks: HistoryBlockV2[] } {
  const blocks: HistoryBlockV2[] = [];
  let seq = 0;
  return {
    blocks,
    recordEdit(change, effects, delta, at) {
      blocks.push(buildEditBlock(++seq, at, change, effects, delta));
    },
    recordCommand(kind, at) {
      blocks.push(buildCommandBlock(kind, ++seq, at));
    },
  };
}

const docStruct = (v: EditorView) => ({ doc: v.state.doc.toString(), struct: readStructure(v.state) });

// Dispatch a spec into the live view; `pause` injects isolateHistory.of("before")
// — the synchronous stand-in for a real typing pause (> newGroupDelay) that makes
// CM6 start a fresh undo group. The recorded `newGroup` still comes from the REAL
// undoDepth delta the listener measures; the isolate just makes it deterministic.
function dispatch(view: EditorView, spec: TransactionSpec, pause = false): void {
  view.dispatch(
    pause
      ? ({ ...spec, annotations: ([] as unknown[]).concat(spec.annotations ?? [], isolateHistory.of("before")) as TransactionSpec["annotations"] })
      : spec,
  );
}

describe("FIDELITY — v2-mixed-recovery through the production listener", () => {
  const BASE = "top\nA1\nmid\nB1\nbot\n";
  const SIBLING = "top\nA2\nmid\nB2\nbot\n"; // 2 diff-groups

  it("mixed typing + resolution + undo/redo: captured-live blocks replay == live, no double-record", () => {
    const lp = document.createElement("div");
    const rp = document.createElement("div");
    document.body.append(lp, rp);
    const sink = arraySink();
    const flag = new ReplayFlag();
    const live = mountDiffPaneV2(lp, BASE, SIBLING, { sink, flag });
    try {
      let before2 = -1;
      let after2 = -1;

      dispatch(live, { changes: { from: 0, insert: "Z" }, userEvent: "input.type" }, true); // op1
      {
        const r = readStructure(live.state);
        const v1 = r.find((x) => x.group === 0 && x.ver === 1)!;
        before2 = v1.from + 1;
        dispatch(live, resolveGroup(live.state.doc, r, 0, "keep1", {}, before2)!, true); // op2 resolve
        after2 = live.state.selection.main.head;
      }
      {
        const v1 = readStructure(live.state).find((x) => x.group === 1 && x.ver === 1)!;
        dispatch(live, { changes: { from: v1.from + 1, insert: "q" }, userEvent: "input.type" }, true); // op3
      }
      {
        const r = readStructure(live.state);
        const v1 = r.find((x) => x.group === 1 && x.ver === 1)!;
        dispatch(live, resolveGroup(live.state.doc, r, 1, "keep2", {}, v1.from + 1)!, true); // op4 resolve
      }
      undo(live);
      undo(live);
      redo(live);

      // The production listener captured 4 paused edits (all newGroup) + 3 commands.
      const editFlags = sink.blocks.filter((b) => b.kind === "edit").map((b) => (b.newGroup ? "G" : "·")).join("");
      expect(editFlags, "4 paused ops ⇒ 4 group starts").toBe("GGGG");
      expect(sink.blocks.map((b) => b.kind)).toEqual(["edit", "edit", "edit", "edit", "undo", "undo", "redo"]);

      // CRASH → real NDJSON → replay into a fresh view that ALSO has a live feed.
      const jsonl = sink.blocks.map(serializeBlock).join("\n");
      const sink2 = arraySink();
      const flag2 = new ReplayFlag();
      const replayed = mountDiffPaneV2(rp, BASE, SIBLING, { sink: sink2, flag: flag2 });
      try {
        const res = replayWithGuard(replayed, jsonl, flag2);
        expect(res.stoppedAtCorrupt).toBe(false);
        // GUARD (trap 2): replay must NOT have re-recorded into the replay view.
        expect(sink2.blocks.length, "replayWithGuard suppressed all recording").toBe(0);
        expect(docStruct(replayed), "recovered doc+structure == live").toEqual(docStruct(live));

        const at = (label: string) => expect(docStruct(replayed), label).toEqual(docStruct(live));
        undo(live); undo(replayed); at("undo→after op2 (op3 typing undone)");
        undo(live); undo(replayed); at("undo→after op1 (op2 resolution undone)");
        expect(replayed.state.selection.main.head, "resolution undo → before2").toBe(before2);
        redo(live); redo(replayed); at("redo→after op2 (resolution redone)");
        expect(replayed.state.selection.main.head, "resolution redo → after2").toBe(after2);
      } finally {
        replayed.destroy();
        rp.remove();
      }
    } finally {
      live.destroy();
      lp.remove();
    }
  });
});

describe("FIDELITY — v2-1b-coalescing through the production listener", () => {
  it("coalesced bursts: undoDepth-delta marks group starts (G··G·), replay reproduces granularity", () => {
    const lp = document.createElement("div");
    const rp = document.createElement("div");
    document.body.append(lp, rp);
    const sink = arraySink();
    const flag = new ReplayFlag();
    const live2 = mountDiffPaneV2(lp, "hello\n", "hello\n", { sink, flag }); // no groups — plain text
    try {
      dispatch(live2, { changes: { from: 0, insert: "a" }, userEvent: "input.type" });
      dispatch(live2, { changes: { from: 1, insert: "b" }, userEvent: "input.type" });
      dispatch(live2, { changes: { from: 2, insert: "c" }, userEvent: "input.type" });
      dispatch(live2, { changes: { from: 3, insert: "X" }, userEvent: "input.type" }, true); // new group
      dispatch(live2, { changes: { from: 4, insert: "Y" }, userEvent: "input.type" });

      expect(live2.state.doc.toString()).toBe("abcXYhello\n");
      const flags = sink.blocks.map((b) => (b.kind === "edit" ? (b.newGroup ? "G" : "·") : "?")).join("");
      expect(flags, "two coalesced bursts ⇒ two group starts").toBe("G··G·");
      const liveDepth = undoDepth(live2.state);
      expect(liveDepth, "undo-depth 2").toBe(2);

      const jsonl = sink.blocks.map(serializeBlock).join("\n");
      const sink2 = arraySink();
      const flag2 = new ReplayFlag();
      const replayed = mountDiffPaneV2(rp, "hello\n", "hello\n", { sink: sink2, flag: flag2 });
      try {
        replayWithGuard(replayed, jsonl, flag2);
        expect(sink2.blocks.length, "no double-record on replay").toBe(0);
        expect(replayed.state.doc.toString(), "recovered doc").toBe(live2.state.doc.toString());
        expect(undoDepth(replayed.state), "recovered undo-depth == live").toBe(liveDepth);
        for (let i = 0; i < liveDepth; i++) {
          undo(live2);
          undo(replayed);
          expect(replayed.state.doc.toString(), `undo step ${i + 1} reverts a whole burst`).toBe(live2.state.doc.toString());
        }
        expect(replayed.state.doc.toString(), "all undone → start").toBe("hello\n");
      } finally {
        replayed.destroy();
        rp.remove();
      }
    } finally {
      live2.destroy();
      lp.remove();
    }
  });
});

// ── filter replay-idempotency (advisor #1) ──────────────────────────
// The editing filters (autoNewlineFilter) are transactionFilters that COMPOSE
// their normalization into `tr.changes`, so the listener records the already-
// composed change. Replay re-dispatches that change through the SAME filters — it
// must be a no-op the second time (the normalization is already baked in), else a
// recovered session silently diverges. The other fidelity tests insert mid-line
// and never trip autoNewline's APPEND path; this one provably does.
describe("FIDELITY — recorded change is replay-idempotent through autoNewlineFilter", () => {
  const BASE = "top\nA1\nmid\nB1\nbot\n";
  const SIBLING = "top\nA2\nmid\nB2\nbot\n";

  it("an edit that triggers the auto-\\n append replays byte-identically", () => {
    const lp = document.createElement("div");
    const rp = document.createElement("div");
    document.body.append(lp, rp);
    const sink = arraySink();
    const flag = new ReplayFlag();
    const live = mountDiffPaneV2(lp, BASE, SIBLING, { sink, flag });
    try {
      // Insert just before group-0 ver1's terminal \n → the content no longer ends
      // in \n → autoNewlineFilter composes a second \n into the SAME transaction.
      const v1 = readStructure(live.state).find((x) => x.group === 0 && x.ver === 1)!;
      const lenBefore = live.state.doc.length;
      dispatch(live, { changes: { from: v1.to - 1, insert: "X" }, userEvent: "input.type" }, true);
      // Proof the filter fired: doc grew by 2 (typed "X" + auto "\n"), not 1.
      expect(live.state.doc.length - lenBefore, "autoNewlineFilter appended a \\n").toBe(2);
      // The recorded block's change therefore carries BOTH inserts (composed).
      const block = sink.blocks[0];
      expect(block.kind).toBe("edit");

      const jsonl = sink.blocks.map(serializeBlock).join("\n");
      const sink2 = arraySink();
      const flag2 = new ReplayFlag();
      const replayed = mountDiffPaneV2(rp, BASE, SIBLING, { sink: sink2, flag: flag2 });
      try {
        replayWithGuard(replayed, jsonl, flag2);
        expect(sink2.blocks.length).toBe(0);
        // Idempotent: replay did NOT append a THIRD \n; doc+structure match live.
        expect(docStruct(replayed)).toEqual(docStruct(live));
        expect(replayed.state.doc.length).toBe(live.state.doc.length);
      } finally {
        replayed.destroy();
        rp.remove();
      }
    } finally {
      live.destroy();
      lp.remove();
    }
  });
});

// ── net-count assessment (carry-into-step-2 #3) ──────────────────────
describe("assessHistoryV2 — NET live count gates the modal", () => {
  const edit = (seq: number, g: number) => serializeBlock(buildEditBlock(seq, "t", [1, [0, "x"]], [], g));
  const cmd = (kind: "undo" | "redo", seq: number) => serializeBlock(buildCommandBlock(kind, seq, "t"));

  it("type 3, undo 3 (each its own group) → net 0 → empty, no modal", () => {
    const jsonl = [edit(1, 1), edit(2, 1), edit(3, 1), cmd("undo", 4), cmd("undo", 5), cmd("undo", 6)].join("\n");
    const a = assessHistoryV2(jsonl);
    expect(a.edits).toBe(0);
    expect(a.empty).toBe(true);
  });
  it("type 3, undo 1, redo 1 → net 3 → modal shows", () => {
    const jsonl = [edit(1, 1), edit(2, 1), edit(3, 1), cmd("undo", 4), cmd("redo", 5)].join("\n");
    const a = assessHistoryV2(jsonl);
    expect(a.edits).toBe(3);
    expect(a.empty).toBe(false);
  });
  it("over-undo never goes negative (clamped ≥0)", () => {
    const jsonl = [edit(1, 1), cmd("undo", 2), cmd("undo", 3)].join("\n");
    expect(assessHistoryV2(jsonl).edits).toBe(0);
  });
  it("empty log → empty, no modal", () => {
    expect(assessHistoryV2("")).toEqual({ edits: 0, stoppedAtCorrupt: false, empty: true, firstBlockCorrupt: false });
  });
});
