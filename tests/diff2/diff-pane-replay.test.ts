// @vitest-environment happy-dom
//
// W4a — DiffPane.replayFrom (§3.3 recovery replay) + setCursor.
//
// The faithful test (advisor): drive a REAL DiffPane through edits, capture one
// block per transaction (the exact {change, structure} shape W2's listener will
// feed HistoryWriter), serialize through the Stage-3a writer, then replay into a
// TWIN built from the SAME snapshot bytes and assert the resolved state matches.
// That exercises offset-correctness — the thing that breaks if replay is fed a
// doc built from anything other than the session-start snapshot bytes.

import { afterEach, describe, expect, it } from "vitest";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { DiffPane } from "../../src/diff2/diff-pane";
import {
  diffPaneStateField,
  setDiffPaneState,
} from "../../src/diff2/decorations";
import { serializeHistoryBlock } from "../../src/diff2/history-log";
import type { Segment } from "../../src/diff2/editor-model";

const containers: HTMLElement[] = [];
function mount(): HTMLElement {
  const c = document.createElement("div");
  document.body.appendChild(c);
  containers.push(c);
  return c;
}
afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
});

// Build a DiffPane from (base, sibling), run `ops`, and return the faithful
// history.jsonl (one block per recordable transaction) + the live resolved
// state to compare against.
function recordJsonl(
  base: string,
  sibling: string,
  ops: (pane: DiffPane, view: EditorView) => void,
): { jsonl: string; liveResolved: { base: string; sibling: string } } {
  const pane = new DiffPane(mount(), base, sibling);
  const view = pane.getView();
  const blocks: { change: unknown; structure: Segment[] }[] = [];
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((u) => {
        for (const tr of u.transactions) {
          if (
            !tr.docChanged &&
            !tr.effects.some((e) => e.is(setDiffPaneState))
          ) {
            continue;
          }
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
  const jsonl = blocks
    .map((b, i) =>
      serializeHistoryBlock(i + 1, "2026-06-04T00:00:00.000Z", b.change, b.structure),
    )
    .join("\n");
  pane.destroy();
  return { jsonl, liveResolved: { ...liveResolved } };
}

describe("DiffPane.replayFrom — §3.3 (W4a)", () => {
  it("replay into a twin from the SAME snapshot bytes reproduces resolved state", () => {
    const base = "a\nMINE\nc\n";
    const sibling = "a\nTHEIRS\nc\n";
    const { jsonl, liveResolved } = recordJsonl(base, sibling, (pane) =>
      pane.resolveAll("ours"),
    );
    expect(jsonl.length).toBeGreaterThan(0); // resolveAll produced ≥1 block

    const twin = new DiffPane(mount(), base, sibling);
    const r = twin.replayFrom(jsonl);

    expect(r.stoppedAtCorrupt).toBe(false);
    expect(r.replayed).toBeGreaterThan(0);
    expect(twin.getResolved()).toEqual(liveResolved);
  });

  it("multi-step free edits replay byte-identically", () => {
    const base = "x\nMINE\ny\nZZZ\n";
    const sibling = "x\nTHEIRS\ny\nZZZ\n";
    const { jsonl, liveResolved } = recordJsonl(base, sibling, (pane, view) => {
      pane.resolveAll("theirs");
      // a free edit on top of the resolution. TODO §9 — resolveAll now parks the
      // caret at the first resolved group; a real free edit happens AT the caret
      // (growIndexFor reads selection.main.head), so click at 0 THEN type.
      view.dispatch({ selection: { anchor: 0 } });
      view.dispatch({ changes: { from: 0, insert: "HEADER\n" } });
    });

    const twin = new DiffPane(mount(), base, sibling);
    twin.replayFrom(jsonl);
    expect(twin.getResolved()).toEqual(liveResolved);
  });

  it("empty jsonl is a no-op (the per-transaction feed is W2)", () => {
    const pane = new DiffPane(mount(), "a\nMINE\nc\n", "a\nTHEIRS\nc\n");
    const before = pane.getResolved();
    expect(pane.replayFrom("")).toEqual({ replayed: 0, stoppedAtCorrupt: false });
    expect(pane.getResolved()).toEqual(before);
  });

  it("setCursor clamps anchor/head past EOF", () => {
    const pane = new DiffPane(mount(), "a\nb\n", "a\nb\n");
    const len = pane.getView().state.doc.length;
    pane.setCursor(9999, 9999);
    const sel = pane.getView().state.selection.main;
    expect(sel.anchor).toBeLessThanOrEqual(len);
    expect(sel.head).toBeLessThanOrEqual(len);
  });
});
