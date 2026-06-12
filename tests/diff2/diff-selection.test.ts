// Phase 3 — V2 selection legalization (§2.2.4(5) intra-block + §2.2.6 group-atomic).
// Pure legalizeSelection across the case matrix + dispatch-level (the filter in
// the createDiffPaneState pipeline).

import { describe, expect, it } from "vitest";
import { buildModel } from "../../src/diff2/diff-model";
import { groupsOf, legalizeSelection } from "../../src/diff2/diff-selection";
import { createDiffPaneState } from "../../src/diff2/diff-pane-v2";

// two groups: doc "a\nL1\n\nR1\n\nb\nL2\n\nR2\n\nc\n"
//   group0 ver1[2,6) ver2[6,10)  (span [2,10))
//   group1 ver1[12,16) ver2[16,20) (span [12,20))
//   normals "a\n"[0,2) "b\n"[10,12) "c\n"[20,22); docLength 22
const M = buildModel("a\nL1\nb\nL2\nc\n", "a\nR1\nb\nR2\nc\n");
const R = M.ranges;

describe("diff-selection — groupsOf", () => {
  it("pairs ver1/ver2 into group spans, sorted", () => {
    expect(groupsOf(R)).toEqual([
      { group: 0, from: 2, to: 10 },
      { group: 1, from: 12, to: 20 },
    ]);
  });
});

describe("diff-selection — legalizeSelection (§2.2.4(5) intra-block)", () => {
  it("keeps a plain selection within one ver-block unchanged", () => {
    expect(legalizeSelection(R, 2, 4)).toEqual({ anchor: 2, head: 4 }); // inside ver1 content
  });
  it("allows selecting up to (not including) the terminal \\n", () => {
    // ver1 [2,6): content [2,5)="L1\n", terminal \n at index 5. position 5 is the
    // last selectable (before the terminal char) → stays plain.
    expect(legalizeSelection(R, 2, 5)).toEqual({ anchor: 2, head: 5 });
  });
  it("a cursor (anchor===head) is never expanded", () => {
    expect(legalizeSelection(R, 3, 3)).toEqual({ anchor: 3, head: 3 });
    expect(legalizeSelection(R, 0, 0)).toEqual({ anchor: 0, head: 0 });
  });
});

describe("diff-selection — legalizeSelection (§2.2.6 group-atomic)", () => {
  it("crossing from ver1 into its sibling ver2 selects the WHOLE group", () => {
    expect(legalizeSelection(R, 3, 7)).toEqual({ anchor: 2, head: 10 }); // group0 span
  });
  it("a normal-anchored selection that touches a group includes the whole group", () => {
    expect(legalizeSelection(R, 0, 4)).toEqual({ anchor: 0, head: 10 });
  });
  it("preserves direction (upward selection)", () => {
    expect(legalizeSelection(R, 7, 3)).toEqual({ anchor: 10, head: 2 }); // anchor=hi, head=lo
  });
  it("spanning two groups includes both fully", () => {
    expect(legalizeSelection(R, 0, 14)).toEqual({ anchor: 0, head: 20 });
  });
  it("Ctrl+A (whole doc) needs no expansion — groups already contained", () => {
    expect(legalizeSelection(R, 0, 22)).toEqual({ anchor: 0, head: 22 });
  });
  it("a selection ending exactly at a group boundary does NOT pull the group in", () => {
    expect(legalizeSelection(R, 0, 2)).toEqual({ anchor: 0, head: 2 }); // touches no group char
  });
});

describe("diff-selection — dispatch-level (filter in createDiffPaneState)", () => {
  const state = createDiffPaneState("a\nL1\nb\nL2\nc\n", "a\nR1\nb\nR2\nc\n");

  it("a selection from a normal line into a group expands to the whole group", () => {
    const s1 = state.update({ selection: { anchor: 0, head: 4 } }).state;
    expect(s1.selection.main.anchor).toBe(0);
    expect(s1.selection.main.head).toBe(10);
  });
  it("a plain in-block selection passes through unchanged", () => {
    const s1 = state.update({ selection: { anchor: 2, head: 4 } }).state;
    expect(s1.selection.main.anchor).toBe(2);
    expect(s1.selection.main.head).toBe(4);
  });
  it("crossing ver1→ver2 selects the whole group", () => {
    const s1 = state.update({ selection: { anchor: 3, head: 7 } }).state;
    expect([s1.selection.main.from, s1.selection.main.to]).toEqual([2, 10]);
  });
});
