// Phase 4 — V2 conflict resolution (§2.2.9 scenario-2 region-replace).
// Pure resolveGroup (all 5 choices) + dispatch-level (the spec through the real
// createDiffPaneState pipeline: doc + structure resolve together, caret at start).

import { describe, expect, it } from "vitest";
import { buildModel, splitModel } from "../../src/diff2/diff-model";
import { readStructure } from "../../src/diff2/diff-structure";
import { resolveGroup } from "../../src/diff2/diff-resolve";
import { createDiffPaneState } from "../../src/diff2/diff-pane-v2";

// one group: base "a\nL\nc\n" vs "a\nR\nc\n" ⇒ doc "a\nL\n\nR\n\nc\n"
//   ver1 [2,5) "L\n", ver2 [5,8) "R\n", group span [2,8); normal "c\n" [8,10)
function oneGroup() {
  const m = buildModel("a\nL\nc\n", "a\nR\nc\n");
  return { doc: createDiffPaneState("a\nL\nc\n", "a\nR\nc\n").doc, ranges: m.ranges };
}

describe("diff-resolve — resolveGroup (pure, scenario-2)", () => {
  const { doc, ranges } = oneGroup();
  const insertOf = (choice: Parameters<typeof resolveGroup>[3], opts = {}) =>
    (resolveGroup(doc, ranges, 0, choice, opts)!.changes as { insert: string }).insert;

  it("keep1 → ver1 content; keep2 → ver2 content", () => {
    expect(insertOf("keep1")).toBe("L\n");
    expect(insertOf("keep2")).toBe("R\n");
  });
  it("both → ver1+ver2; neither → empty", () => {
    expect(insertOf("both")).toBe("L\nR\n");
    expect(insertOf("neither")).toBe("");
  });
  it("join → ver1 + quoted ver2 under a header", () => {
    expect(insertOf("join", { label: "dev", date: "2026-06-05 10:31:30" })).toBe(
      "L\n> Changes from `dev` at 2026-06-05 10:31:30:\n> R\n",
    );
  });
  it("replaces the WHOLE group span and puts the caret at its start", () => {
    const spec = resolveGroup(doc, ranges, 0, "keep1")!;
    expect(spec.changes).toMatchObject({ from: 2, to: 8, insert: "L\n" });
    expect(spec.selection).toMatchObject({ anchor: 2 });
  });
  it("returns null for an unknown group", () => {
    expect(resolveGroup(doc, ranges, 99, "keep1")).toBeNull();
  });
});

describe("diff-resolve — dispatch-level (doc + structure resolve together)", () => {
  it("keep1: group becomes ver1 normal text, structure emptied, caret at start", () => {
    const s0 = createDiffPaneState("a\nL\nc\n", "a\nR\nc\n");
    const spec = resolveGroup(s0.doc, readStructure(s0), 0, "keep1")!;
    const s1 = s0.update(spec).state;
    expect(s1.doc.toString()).toBe("a\nL\nc\n");
    expect(readStructure(s1)).toEqual([]); // no more conflict
    expect(s1.selection.main.head).toBe(2);
  });

  it("neither: group deleted; the resolved doc round-trips on split", () => {
    const s0 = createDiffPaneState("a\nL\nc\n", "a\nR\nc\n");
    const spec = resolveGroup(s0.doc, readStructure(s0), 0, "neither")!;
    const s1 = s0.update(spec).state;
    expect(s1.doc.toString()).toBe("a\nc\n");
    // fully resolved ⇒ both sides identical = the doc
    expect(splitModel(s1.doc.toString(), readStructure(s1))).toEqual({
      base: "a\nc\n",
      sibling: "a\nc\n",
    });
  });

  it("multi-group: resolving group 0 leaves group 1 intact (ranges shifted)", () => {
    const s0 = createDiffPaneState("a\nL1\nb\nL2\nc\n", "a\nR1\nb\nR2\nc\n");
    const spec = resolveGroup(s0.doc, readStructure(s0), 0, "keep1")!; // ver1content "L1\n"
    const s1 = s0.update(spec).state;
    expect(s1.doc.toString()).toBe("a\nL1\nb\nL2\n\nR2\n\nc\n");
    expect(readStructure(s1)).toEqual([
      { from: 7, to: 11, ver: 1, group: 1 },
      { from: 11, to: 15, ver: 2, group: 1 },
    ]);
  });
});
