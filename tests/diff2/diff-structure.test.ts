// Phase 3 — V2 structure spine (StateField<RangeSet> + terminal protection +
// cursorVert target). Pins the state-level logic that the 1a/1b browser spikes
// validated, as durable in-repo regression coverage (no geometry needed).

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { buildModel } from "../../src/diff2/diff-model";
import {
  cursorVertTarget,
  fromRangeSet,
  readStructure,
  setStructure,
  structureField,
  terminalProtected,
  toRangeSet,
} from "../../src/diff2/diff-structure";

function seed(base: string, sibling: string) {
  const m = buildModel(base, sibling);
  const state = EditorState.create({
    doc: m.doc,
    extensions: [structureField],
  }).update({ effects: setStructure.of(toRangeSet(m.ranges)) }).state;
  return { m, state };
}

describe("diff-structure — RangeSet conversion", () => {
  it("toRangeSet ∘ fromRangeSet round-trips the ranges (sorted, with ver/group)", () => {
    const m = buildModel("a\nL\nb\nM\nc\n", "a\nR\nb\nN\nc\n");
    const back = fromRangeSet(toRangeSet(m.ranges));
    expect(back).toEqual([...m.ranges].sort((a, b) => a.from - b.from));
  });
});

describe("diff-structure — structureField maps through transactions", () => {
  it("typing into an empty ver-block grows ITS range (no activeEmptyVer hint)", () => {
    // delete-vs-modify ⇒ ver1 empty (width-1)
    const { m, state } = seed("a\nb\n", "a\nX\nb\n");
    const v1 = m.ranges.find((r) => r.ver === 1)!;
    expect(v1.to - v1.from).toBe(1);
    // type "Y\n" at the empty ver's position (auto-\n'd content)
    const next = state.update({ changes: { from: v1.from, insert: "Y\n" } }).state;
    const g1v1 = readStructure(next).find((r) => r.ver === 1)!;
    expect(g1v1.from).toBe(v1.from);
    expect(g1v1.to).toBe(v1.to + 2); // grew over "Y\n"
    expect(next.doc.sliceString(g1v1.from, g1v1.to - 1)).toBe("Y\n"); // content
  });

  it("interior edit grows the containing range; later ranges shift", () => {
    const { m, state } = seed("a\nL1\nb\n", "a\nR1\nb\n");
    const v1 = m.ranges.find((r) => r.ver === 1)!;
    const v2 = m.ranges.find((r) => r.ver === 2)!;
    const next = state.update({ changes: { from: v1.from + 1, insert: "Z" } }).state; // inside ver1 content
    const a1 = readStructure(next).find((r) => r.ver === 1)!;
    const a2 = readStructure(next).find((r) => r.ver === 2)!;
    expect(a1.to - a1.from).toBe(v1.to - v1.from + 1); // grew by 1
    expect(a2.from).toBe(v2.from + 1); // ver2 shifted by the insert
  });

  it("setStructure replaces the whole RangeSet (resolution / replay)", () => {
    const { state } = seed("a\nL\nb\n", "a\nR\nb\n");
    const replaced = state.update({ effects: setStructure.of(toRangeSet([])) }).state;
    expect(readStructure(replaced)).toEqual([]);
  });
});

describe("diff-structure — terminal protection", () => {
  it("rejects deleting a terminal \\n; allows deleting content (→ width-1 empty)", () => {
    const { m, state } = seed("a\nL1\nb\n", "a\nR1\nb\n");
    const v1 = m.ranges.find((r) => r.ver === 1)!; // content "L1\n" + terminal at to-1
    const ranges = readStructure(state);

    // delete the terminal \n (index to-1) → rejected
    const delTerminal = state.changes({ from: v1.to - 1, to: v1.to });
    expect(terminalProtected(ranges, delTerminal)).toBe(false);

    // delete the content [from, to-1) (keep terminal) → allowed
    const delContent = state.changes({ from: v1.from, to: v1.to - 1 });
    expect(terminalProtected(ranges, delContent)).toBe(true);
  });
});

describe("diff-structure — cursorVertTarget (empty-ver stop, Up/Down)", () => {
  // empty ver at from=F; native motion that skips it must stop at F.
  const ranges = [{ from: 19, to: 20, ver: 1 as const, group: 1 }];

  it("forward: stops at the empty ver in the jumped span", () => {
    expect(cursorVertTarget(ranges, 14, 25, true)).toBe(19);
  });
  it("forward: no empty ver in span → native landing unchanged", () => {
    expect(cursorVertTarget(ranges, 0, 6, true)).toBe(6);
  });
  it("backward: stops at the empty ver", () => {
    expect(cursorVertTarget(ranges, 25, 14, false)).toBe(19);
  });
  it("does not re-stop when already ON the empty ver (strict inequality)", () => {
    expect(cursorVertTarget(ranges, 19, 25, true)).toBe(25); // leaving downward
  });
  it("picks the FIRST empty ver when several are skipped", () => {
    const multi = [
      { from: 19, to: 20, ver: 1 as const, group: 1 },
      { from: 30, to: 31, ver: 1 as const, group: 2 },
    ];
    expect(cursorVertTarget(multi, 10, 40, true)).toBe(19);
    expect(cursorVertTarget(multi, 40, 10, false)).toBe(30);
  });
});
