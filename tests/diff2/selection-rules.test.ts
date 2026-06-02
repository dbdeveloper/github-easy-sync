// @vitest-environment happy-dom
//
// §1.7 selection rules — legalize/clamp/snap of illegal selections, plus
// the filter integration in a live DiffPane.

import { describe, it, expect } from "vitest";
import { EditorSelection } from "@codemirror/state";
import { baseSiblingToModel, type Segment } from "../../src/diff2/editor-model";
import {
  legalizeRange,
  strictVerBlockAt,
} from "../../src/diff2/selection-rules";

// Fixture: a multi-line ver1 so interior positions exist.
//   base    = "a\nb1\nb2\nc\n"   sibling = "a\nX\nc\n"
//   doc     = "a\nb1\nb2\nX\nc\n"
//   normal "a\n"      [0,2)
//   ver1   "b1\nb2\n" [2,8)   interior 3..7
//   ver2   "X\n"      [8,10)  interior 9
//   normal "c\n"      [10,12)
const model = baseSiblingToModel("a\nb1\nb2\nc\n", "a\nX\nc\n");
const S: Segment[] = model.structure;
const v1 = S.find((s) => s.role === "ver1")!;
const v2 = S.find((s) => s.role === "ver2")!;
const normEnd = S[S.length - 1]; // trailing normal "c\n"

function leg(anchor: number, head: number): { anchor: number; head: number } {
  const r = legalizeRange(S, EditorSelection.range(anchor, head));
  return { anchor: r.anchor, head: r.head };
}

describe("strictVerBlockAt", () => {
  it("matches a strictly-interior ver position", () => {
    expect(strictVerBlockAt(S, v1.from + 1)?.role).toBe("ver1");
    expect(strictVerBlockAt(S, v2.from + 1)?.role).toBe("ver2");
  });
  it("returns null at ver edges (boundary = normal-space)", () => {
    expect(strictVerBlockAt(S, v1.from)).toBeNull();
    expect(strictVerBlockAt(S, v1.to)).toBeNull();
  });
  it("returns null in normal-space", () => {
    expect(strictVerBlockAt(S, 0)).toBeNull();
    expect(strictVerBlockAt(S, normEnd.from)).toBeNull();
  });
});

describe("legalizeRange — legal selections pass through", () => {
  it("variant 1: both ends normal, consecutive", () => {
    expect(leg(0, 1)).toEqual({ anchor: 0, head: 1 });
  });
  it("variant 3: both ends normal, spanning the diff group", () => {
    expect(leg(0, normEnd.to)).toEqual({ anchor: 0, head: normEnd.to });
  });
  it("variant 2: both ends inside the same ver-block", () => {
    expect(leg(v1.from + 1, v1.to - 1)).toEqual({
      anchor: v1.from + 1,
      head: v1.to - 1,
    });
  });
  it("collapsed caret is never touched (even strictly inside a ver)", () => {
    expect(leg(v1.from + 1, v1.from + 1)).toEqual({
      anchor: v1.from + 1,
      head: v1.from + 1,
    });
  });
});

describe("legalizeRange — illegal selections snapped/clamped", () => {
  it("variant 4 (normal→ver1, forward): head snaps to group end", () => {
    // anchor 0 (normal), head inside ver1 → jump over whole group → ver2.to
    expect(leg(0, v1.from + 1)).toEqual({ anchor: 0, head: v2.to });
  });
  it("variant 4 backward (normal→ver1): head snaps to group start", () => {
    expect(leg(normEnd.from, v1.to - 1)).toEqual({
      anchor: normEnd.from,
      head: v1.from,
    });
  });
  it("variant 5 (ver1→ver2): head clamps to ver1 end", () => {
    expect(leg(v1.from + 1, v2.from + 1)).toEqual({
      anchor: v1.from + 1,
      head: v1.to,
    });
  });
  it("variant 6 (ver2→normal): head clamps into ver2", () => {
    expect(leg(v2.from + 1, normEnd.to)).toEqual({
      anchor: v2.from + 1,
      head: v2.to,
    });
  });
});

describe("filter integration (live DiffPane)", () => {
  it("adjusts an illegal selection dispatched into the view", async () => {
    // happy-dom needed for EditorView.
    // @vitest-environment happy-dom is set per-file via the directive
    // below; this block runs under it.
    const { DiffPane } = await import("../../src/diff2/diff-pane");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const pane = new DiffPane(container, "a\nb1\nb2\nc\n", "a\nX\nc\n");
    const view = pane.getView();

    // normal(0) → strictly inside ver1 → must snap to group end.
    view.dispatch({ selection: EditorSelection.single(0, v1.from + 1) });
    expect(view.state.selection.main.anchor).toBe(0);
    expect(view.state.selection.main.head).toBe(v2.to);

    pane.destroy();
    container.remove();
  });
});
