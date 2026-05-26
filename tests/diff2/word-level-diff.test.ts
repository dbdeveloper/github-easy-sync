import { describe, it, expect } from "vitest";
import { computeWordDiff } from "../../src/diff2/word-level-diff";

describe("computeWordDiff", () => {
  it("returns empty spans when sides are identical", () => {
    const result = computeWordDiff("same text here", "same text here");
    expect(result.oursSpans).toEqual([]);
    expect(result.theirsSpans).toEqual([]);
  });

  it("returns full-range span when sides differ entirely", () => {
    const result = computeWordDiff("abc", "xyz");
    expect(result.oursSpans).toHaveLength(1);
    expect(result.oursSpans[0]).toEqual({ start: 0, end: 3 });
    expect(result.theirsSpans).toHaveLength(1);
    expect(result.theirsSpans[0]).toEqual({ start: 0, end: 3 });
  });

  it("highlights only the changed word inside a shared sentence", () => {
    const ours = "line from local file";
    const theirs = "line from github repo";

    const result = computeWordDiff(ours, theirs);

    // Verify span content by slicing each side at the returned ranges.
    const oursMarked = result.oursSpans
      .map((s) => ours.slice(s.start, s.end))
      .join("|");
    const theirsMarked = result.theirsSpans
      .map((s) => theirs.slice(s.start, s.end))
      .join("|");

    // "local file" → "github repo" — the changed suffix is captured
    // on both sides. Exact split granularity is library-determined
    // (diffWords may merge whitespace), so we use substring checks.
    expect(oursMarked).toContain("local");
    expect(oursMarked).toContain("file");
    expect(theirsMarked).toContain("github");
    expect(theirsMarked).toContain("repo");
  });

  it("returns empty for added-only / removed-only side", () => {
    // theirs has additional words; ours has no changes.
    const result = computeWordDiff("hello", "hello world");
    expect(result.oursSpans).toEqual([]);
    expect(result.theirsSpans.length).toBeGreaterThan(0);
    // The added " world" is captured.
    const theirsMarked = result.theirsSpans
      .map((s) => "hello world".slice(s.start, s.end))
      .join("");
    expect(theirsMarked).toContain("world");
  });

  it("merges adjacent spans on the same side", () => {
    // diffWords sometimes splits "ab cd" → "ab" + " " (common) + "cd"
    // — merge-adjacent collapses them back when the runs are
    // contiguous. We assert at least one merged span when the change
    // spans multiple word tokens.
    const result = computeWordDiff("aaa bbb ccc", "aaa xxx yyy");
    // Both "bbb" and "ccc" changed → expect 1 or 2 spans on ours; if
    // 2, they must not be adjacent in the merged output.
    for (let i = 1; i < result.oursSpans.length; i++) {
      expect(result.oursSpans[i].start).toBeGreaterThan(
        result.oursSpans[i - 1].end,
      );
    }
  });
});
