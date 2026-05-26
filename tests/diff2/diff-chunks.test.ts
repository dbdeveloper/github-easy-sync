import { describe, it, expect } from "vitest";
import {
  chunksToText,
  computeChunks,
  computeChunkOffsets,
} from "../../src/diff2/diff-chunks";

// Pure unit tests for the line-level diff chunking module.

describe("computeChunks", () => {
  it("returns one common chunk when ours === theirs", () => {
    const chunks = computeChunks("line1\nline2\n", "line1\nline2\n");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ kind: "common", lines: ["line1", "line2"] });
  });

  it("collapses sequential add/remove into one diff chunk", () => {
    const chunks = computeChunks("a\nb\n", "x\ny\n");
    // Single diff chunk: ours = [a, b], theirs = [x, y].
    const diffChunks = chunks.filter((c) => c.kind === "diff");
    expect(diffChunks).toHaveLength(1);
    if (diffChunks[0].kind === "diff") {
      expect(diffChunks[0].oursLines).toEqual(["a", "b"]);
      expect(diffChunks[0].theirsLines).toEqual(["x", "y"]);
    }
  });

  it("separates common runs around a diff", () => {
    const chunks = computeChunks(
      "common1\nours-only\ncommon2\n",
      "common1\ntheirs-only\ncommon2\n",
    );
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ kind: "common", lines: ["common1"] });
    if (chunks[1].kind === "diff") {
      expect(chunks[1].oursLines).toEqual(["ours-only"]);
      expect(chunks[1].theirsLines).toEqual(["theirs-only"]);
    }
    expect(chunks[2]).toEqual({ kind: "common", lines: ["common2"] });
  });

  it("handles delete-vs-modify (empty ours)", () => {
    const chunks = computeChunks("", "new content\n");
    const diff = chunks.find((c) => c.kind === "diff");
    if (diff && diff.kind === "diff") {
      expect(diff.oursLines).toEqual([]);
      expect(diff.theirsLines).toEqual(["new content"]);
    } else {
      expect(diff).toBeDefined();
    }
  });

  it("handles modify-vs-delete (empty theirs)", () => {
    const chunks = computeChunks("old content\n", "");
    const diff = chunks.find((c) => c.kind === "diff");
    if (diff && diff.kind === "diff") {
      expect(diff.oursLines).toEqual(["old content"]);
      expect(diff.theirsLines).toEqual([]);
    } else {
      expect(diff).toBeDefined();
    }
  });

  it("handles trailing-newline absence consistently", () => {
    const chunks = computeChunks("line1\nline2", "line1\nline2");
    expect(chunks).toEqual([
      { kind: "common", lines: ["line1", "line2"] },
    ]);
  });
});

describe("chunksToText", () => {
  it("flattens common-only chunks back to original text", () => {
    const chunks = computeChunks("a\nb\nc", "a\nb\nc");
    const text = chunksToText(chunks);
    expect(text).toBe("a\nb\nc");
  });

  it("emits ours first then theirs within a diff chunk", () => {
    const chunks = [
      { kind: "diff" as const, oursLines: ["o1", "o2"], theirsLines: ["t1", "t2"] },
    ];
    expect(chunksToText(chunks)).toBe("o1\no2\nt1\nt2");
  });

  it("preserves order across common + diff chunks", () => {
    const chunks = [
      { kind: "common" as const, lines: ["c1"] },
      { kind: "diff" as const, oursLines: ["o"], theirsLines: ["t"] },
      { kind: "common" as const, lines: ["c2"] },
    ];
    expect(chunksToText(chunks)).toBe("c1\no\nt\nc2");
  });
});

describe("computeChunkOffsets", () => {
  it("computes correct char ranges for a mixed sequence", () => {
    // doc: "c1\no\nt\nc2"
    //      0  3 5 7
    // c1: chars 0–2
    // \n: 2
    // o : 3
    // \n: 4
    // t : 5
    // \n: 6
    // c2: 7-8
    const chunks = [
      { kind: "common" as const, lines: ["c1"] },
      { kind: "diff" as const, oursLines: ["o"], theirsLines: ["t"] },
      { kind: "common" as const, lines: ["c2"] },
    ];
    const offsets = computeChunkOffsets(chunks);
    expect(offsets[0]).toEqual({
      kind: "common",
      start: 0,
      end: 2,
      lineStart: 0,
      lineEnd: 1,
    });
    expect(offsets[1]).toEqual({
      kind: "diff",
      oursStart: 3,
      oursEnd: 4,
      theirsStart: 5,
      theirsEnd: 6,
      oursLineStart: 1,
      oursLineEnd: 2,
      theirsLineStart: 2,
      theirsLineEnd: 3,
    });
    expect(offsets[2]).toEqual({
      kind: "common",
      start: 7,
      end: 9,
      lineStart: 3,
      lineEnd: 4,
    });

    // Sanity check: chunksToText length matches last offset's end.
    expect(chunksToText(chunks).length).toBe(9);
  });

  it("handles empty-ours diff chunk (delete-vs-modify)", () => {
    const chunks = [
      { kind: "common" as const, lines: ["c"] },
      { kind: "diff" as const, oursLines: [], theirsLines: ["t"] },
    ];
    const offsets = computeChunkOffsets(chunks);
    // doc: "c\nt" (len 3)
    expect(offsets[0]).toMatchObject({ start: 0, end: 1, lineEnd: 1 });
    if (offsets[1].kind === "diff") {
      // Empty ours has zero-length range at char 1 (after "c"),
      // theirs starts at 2 (after the "\n" separator).
      expect(offsets[1].oursStart).toBe(1);
      expect(offsets[1].oursEnd).toBe(1);
      expect(offsets[1].theirsStart).toBe(2);
      expect(offsets[1].theirsEnd).toBe(3);
    }
    expect(chunksToText(chunks)).toBe("c\nt");
  });

  it("handles empty-theirs diff chunk (modify-vs-delete)", () => {
    const chunks = [
      { kind: "diff" as const, oursLines: ["o"], theirsLines: [] },
      { kind: "common" as const, lines: ["c"] },
    ];
    const offsets = computeChunkOffsets(chunks);
    expect(chunksToText(chunks)).toBe("o\nc");
    if (offsets[0].kind === "diff") {
      expect(offsets[0].oursStart).toBe(0);
      expect(offsets[0].oursEnd).toBe(1);
      expect(offsets[0].theirsStart).toBe(1);
      expect(offsets[0].theirsEnd).toBe(1);
    }
  });
});
