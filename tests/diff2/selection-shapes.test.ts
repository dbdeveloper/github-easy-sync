// @vitest-environment happy-dom
//
// §1.7 selection SHAPES (review follow-up): the prior selection-rules test
// covered variants 1–6 on a small fixture; this covers the concrete shapes a
// user actually makes — within one line, whole line, multi-line mid-to-mid —
// in BOTH normal text and a MULTI-LINE ver-block, plus extending a selection
// across a ver boundary up and down. All position-based → unit-testable.
// (Real Shift+arrow KEY events and Shift+PgUp/PgDn need a browser/layout →
// Playwright/manual.)

import { describe, expect, it } from "vitest";
import { EditorSelection } from "@codemirror/state";
import { baseSiblingToModel, type Segment } from "../../src/diff2/editor-model";
import { legalizeRange } from "../../src/diff2/selection-rules";

// Multi-line ver1 fixture.
//   base    "n1\nA1\nA2\nA3\nn2\n"   sibling "n1\nB1\nn2\n"
//   doc     "n1\nA1\nA2\nA3\nB1\nn2\n"
//   normal "n1\n" [0,3) · ver1 "A1\nA2\nA3\n" [3,12) · ver2 "B1\n" [12,15) · normal "n2\n" [15,18)
const S: Segment[] = baseSiblingToModel(
  "n1\nA1\nA2\nA3\nn2\n",
  "n1\nB1\nn2\n",
).structure;
const ver1 = S.find((s) => s.role === "ver1")!; // [3,12)
const ver2 = S.find((s) => s.role === "ver2")!; // [12,15)
const n2 = S[S.length - 1]; // [15,18)

function leg(anchor: number, head: number) {
  const r = legalizeRange(S, EditorSelection.range(anchor, head));
  return { anchor: r.anchor, head: r.head };
}

describe("§1.7 — legal shapes pass through unchanged", () => {
  it("normal: within one line", () => {
    expect(leg(0, 1)).toEqual({ anchor: 0, head: 1 }); // inside "n1"
  });
  it("normal: multi-line, mid-line to mid-line of another normal (across the group)", () => {
    // start mid "n1", end mid "n2" — both normal-space, spans the diff group.
    expect(leg(1, 16)).toEqual({ anchor: 1, head: 16 });
  });
  it("ver-block: within one line", () => {
    expect(leg(4, 5)).toEqual({ anchor: 4, head: 5 }); // inside "A1"
  });
  it("ver-block: multiple lines INSIDE the same ver-block", () => {
    // from inside A1 to inside A3 — all interior to ver1.
    expect(leg(4, 10)).toEqual({ anchor: 4, head: 10 });
  });
});

describe("§1.7 — extending across a ver boundary is clamped/snapped", () => {
  it("from inside ver-block, extend DOWN past its end → clamp to ver end", () => {
    // anchor interior ver1, head into ver2 → stay within ver1.
    expect(leg(4, ver2.from + 1)).toEqual({ anchor: 4, head: ver1.to });
  });
  it("from inside ver-block, extend UP past its start → clamp to ver start", () => {
    // anchor interior ver1, head into the normal above → stay within ver1.
    expect(leg(10, 1)).toEqual({ anchor: 10, head: ver1.from });
  });
  it("start on normal, extend DOWN into the diff-line → snap over the whole group", () => {
    // anchor in "n1", head into ver1 → head jumps to group end (ver2.to).
    expect(leg(1, ver1.from + 2)).toEqual({ anchor: 1, head: ver2.to });
  });
  it("start on normal (below), extend UP into the diff-line → snap to group start", () => {
    // anchor in "n2", head into ver2 → head jumps to group start (ver1.from).
    expect(leg(n2.from + 1, ver2.from + 1)).toEqual({
      anchor: n2.from + 1,
      head: ver1.from,
    });
  });
});

describe("§1.7 — live filter (dispatched selection) on a multi-line ver-block", () => {
  it("an illegal normal→ver selection is snapped in the view", async () => {
    const { DiffPane } = await import("../../src/diff2/diff-pane");
    const c = document.createElement("div");
    document.body.appendChild(c);
    const pane = new DiffPane(c, "n1\nA1\nA2\nA3\nn2\n", "n1\nB1\nn2\n");
    const view = pane.getView();
    // anchor in "n1" (1), head inside ver1 → snap to group end.
    view.dispatch({ selection: EditorSelection.range(1, ver1.from + 2) });
    expect(view.state.selection.main.anchor).toBe(1);
    expect(view.state.selection.main.head).toBe(ver2.to);
    pane.destroy();
    c.remove();
  });
});
