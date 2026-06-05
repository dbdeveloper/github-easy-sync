// @vitest-environment happy-dom
//
// Stage 3b — history-replay (§3.3) + assessment (§3.5).
//
// Blocks are generated from a REAL DiffPane (faithful ChangeSets + structures),
// serialized through the Stage-3a writer format, then replayed. The undo test
// uses a clean oracle: replay N blocks → undo once → must equal replay of N-1
// blocks (and so on). That directly verifies post-replay Ctrl+Z walks the exact
// per-block trajectory — the thing structureHistory + format B must get right.

import { describe, it, expect } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, historyKeymap, undo, redo } from "@codemirror/commands";
import { DiffPane, structureHistory } from "../../src/diff2/diff-pane";
import {
  diffPaneExtension,
  diffPaneStateField,
  setDiffPaneState,
  type BuildOpts,
} from "../../src/diff2/decorations";
import {
  baseSiblingToModel,
  fromEditorModel,
  type Segment,
} from "../../src/diff2/editor-model";
import { split } from "../../src/diff2/joined-doc";
import { serializeHistoryBlock } from "../../src/diff2/history-log";
import {
  assessHistory,
  replayHistory,
  scanHistory,
} from "../../src/diff2/history-replay";

const OPTS: BuildOpts = {
  oursLabel: "local",
  theirsLabel: "remote",
  isMarkdown: true,
  callbacks: {} as never,
};

interface RawBlock {
  change: unknown;
  structure: Segment[];
}

// Drive a live DiffPane through `ops`, capturing one block per transaction
// (change + post-tx structure — exactly what the Phase-6 listener would feed
// HistoryWriter.record).
function record(
  base: string,
  sibling: string,
  ops: (pane: DiffPane, view: EditorView) => void,
): { blocks: RawBlock[]; liveResolved: { base: string; sibling: string } } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const pane = new DiffPane(container, base, sibling, OPTS);
  const view = pane.getView();
  const blocks: RawBlock[] = [];

  // Capture one block per recordable transaction (change + post-tx structure)
  // — exactly what the Phase-6 listener would feed HistoryWriter.record.
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((u) => {
        for (const tr of u.transactions) {
          if (!tr.docChanged && !tr.effects.some((e) => e.is(setDiffPaneState))) continue;
          blocks.push({
            change: tr.changes.toJSON(),
            structure: u.state.field(diffPaneStateField)!.structure,
          });
        }
      }),
    ),
  });

  ops(pane, view);
  const liveResolved = pane.getResolved();
  pane.destroy();
  container.remove();
  return { blocks, liveResolved };
}

function toJsonl(blocks: RawBlock[]): string {
  return blocks
    .map((b, i) => serializeHistoryBlock(i + 1, `t${i + 1}`, b.change, b.structure))
    .join("\n");
}

function replayStartState(base: string, sibling: string): EditorState {
  const initial = baseSiblingToModel(base, sibling);
  return EditorState.create({
    doc: initial.doc,
    extensions: [
      diffPaneExtension({ structure: initial.structure, opts: OPTS, activeEmptyVer: null }),
      // newGroupDelay:0 (§2.3) — same as DiffPane; each replayed block is its
      // own undo step (DEFAULT history would group all synchronous dispatches
      // into ONE step, so a single undo would revert the whole replay).
      history({ newGroupDelay: 0 }),
      structureHistory,
      keymap.of(historyKeymap),
    ],
  });
}

const structOf = (s: EditorState) => s.field(diffPaneStateField)!.structure;
function resolvedOf(s: EditorState): { base: string; sibling: string } {
  const { base, sibling } = split(fromEditorModel({ doc: s.doc.toString(), structure: structOf(s) }));
  return { base: base === "" ? "\n" : base, sibling: sibling === "" ? "\n" : sibling };
}

const BASE = "top\nb1\nmid\nd1\nbot\n";
const SIB = "top\nB1\nmid\nD1\nbot\n"; // two conflict groups

describe("scanHistory / assessHistory (§3.5)", () => {
  const good = serializeHistoryBlock(1, "t", [4, [3, "abc"]], []);
  const good2 = serializeHistoryBlock(2, "t", [2, [1, "Q"]], []);

  it("all-valid → blocks in order, not stopped", () => {
    const r = scanHistory(`${good}\n${good2}\n`);
    expect(r.blocks.length).toBe(2);
    expect(r.stoppedAtCorrupt).toBe(false);
  });

  it("blank lines are skipped", () => {
    const r = scanHistory(`\n${good}\n\n${good2}\n`);
    expect(r.blocks.length).toBe(2);
    expect(r.stoppedAtCorrupt).toBe(false);
  });

  it("mid-stream corruption truncates the trustworthy prefix", () => {
    const r = scanHistory(`${good}\n{ torn\n${good2}\n`);
    expect(r.blocks.length).toBe(1);
    expect(r.stoppedAtCorrupt).toBe(true);
  });

  it("assess: empty log → empty, not firstBlockCorrupt", () => {
    expect(assessHistory("")).toEqual({
      edits: 0,
      stoppedAtCorrupt: false,
      empty: true,
      firstBlockCorrupt: false,
    });
  });

  it("assess: first block corrupt → firstBlockCorrupt, 0 edits", () => {
    const a = assessHistory("{ not json\n");
    expect(a).toEqual({ edits: 0, stoppedAtCorrupt: true, empty: false, firstBlockCorrupt: true });
  });

  it("assess: recovered K of N", () => {
    const a = assessHistory(`${good}\n${good2}\n{ torn`);
    expect(a.edits).toBe(2);
    expect(a.stoppedAtCorrupt).toBe(true);
  });

  it("assessHistory and scanHistory never disagree on the count", () => {
    const jsonl = `${good}\n${good2}\nbad`;
    expect(assessHistory(jsonl).edits).toBe(scanHistory(jsonl).blocks.length);
  });
});

describe("replayHistory — final-state fidelity (§3.3, end-to-end through the writer format)", () => {
  it("mixed free-edit + chunk action: replay reproduces live getResolved", () => {
    const { blocks, liveResolved } = record(BASE, SIB, (pane, view) => {
      view.dispatch({ changes: { from: 1, insert: "Z" } });
      pane.applyToChunk(1, "theirs");
    });
    const r = replayHistory(replayStartState(BASE, SIB), toJsonl(blocks));
    expect(r.stoppedAtCorrupt).toBe(false);
    expect(r.replayed).toBe(blocks.length);
    expect(resolvedOf(r.state)).toEqual(liveResolved);
  });

  it("stops at a corrupt block, restoring the valid prefix", () => {
    const { blocks } = record(BASE, SIB, (pane) => pane.applyToChunk(0, "ours"));
    const jsonl = `${toJsonl(blocks)}\n{ torn block`;
    const r = replayHistory(replayStartState(BASE, SIB), jsonl);
    expect(r.stoppedAtCorrupt).toBe(true);
    expect(r.replayed).toBe(blocks.length);
  });
});

describe("undo-after-replay — Ctrl+Z walks the per-block trajectory (§2.3/§3.3)", () => {
  // Oracle: replay N → undo k  ==  replay (N-k). Verifies structureHistory +
  // format B make post-replay undo land on each prior block's exact state.
  it("undo once == replay one fewer block (mixed free-edit + chunk action)", () => {
    const { blocks } = record(BASE, SIB, (pane, view) => {
      view.dispatch({ changes: { from: 1, insert: "Z" } }); // free edit
      pane.applyToChunk(1, "theirs"); // chunk action (setDiffPaneState)
      // TODO §9 — after a chunk action the caret now lands at the resolved
      // group, not 0,0. Real free edits ALWAYS occur at the caret (collapseGuard
      // → growIndexFor reads selection.main.head), so model that: click at 0,
      // THEN type. (A docChanged edit whose position ≠ caret would mis-tile —
      // but no production path does that; this used to "pass" only because the
      // chunk action left the caret at 0.)
      view.dispatch({ selection: { anchor: 0 } });
      view.dispatch({ changes: { from: 0, insert: "Q" } }); // free edit at caret
    });
    expect(blocks.length).toBeGreaterThanOrEqual(3);

    const full = replayHistory(replayStartState(BASE, SIB), toJsonl(blocks));
    const view = new EditorView({ state: full.state });

    // Undo step-by-step; after k undos the state must equal replay of N-k blocks
    // — doc, structure, resolved, AND the caret (TODO #10: the synthetic caret
    // set during replay lands in the CM6 undo stack, so undo restores it).
    for (let k = 1; k <= blocks.length; k++) {
      expect(undo(view)).toBe(true);
      const oracle = replayHistory(replayStartState(BASE, SIB), toJsonl(blocks.slice(0, blocks.length - k)));
      expect(view.state.doc.toString()).toBe(oracle.state.doc.toString());
      expect(structOf(view.state)).toEqual(structOf(oracle.state));
      expect(resolvedOf(view.state)).toEqual(resolvedOf(oracle.state));
      // #10 oracle: undoing past block (N-k) shows the caret as it was AFTER
      // block (N-k-1) — exactly what replay of (N-k) blocks ends on.
      expect(view.state.selection.main.head).toBe(
        oracle.state.selection.main.head,
      );
    }
    view.destroy();
  });

  it("redo after full undo returns to the replayed end state", () => {
    const { blocks } = record(BASE, SIB, (pane, view) => {
      view.dispatch({ changes: { from: 1, insert: "Z" } });
      pane.applyToChunk(0, "ours");
    });
    const full = replayHistory(replayStartState(BASE, SIB), toJsonl(blocks));
    const endResolved = resolvedOf(full.state);
    const view = new EditorView({ state: full.state });

    for (let k = 0; k < blocks.length; k++) undo(view);
    for (let k = 0; k < blocks.length; k++) redo(view);

    expect(resolvedOf(view.state)).toEqual(endResolved);
    view.destroy();
  });
});
