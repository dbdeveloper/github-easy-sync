import { describe, it, expect } from "vitest";
import {
  chooseLines,
  chunkReplacementRange,
  linesToReplacementText,
} from "../../src/diff2/chunk-actions";
import type { DiffChunk } from "../../src/diff2/diff-chunks";

const sample: DiffChunk = {
  kind: "diff",
  oursLines: ["ours-1", "ours-2"],
  theirsLines: ["theirs-1", "theirs-2"],
};

describe("chooseLines", () => {
  it("returns [] for a common chunk regardless of choice", () => {
    const common: DiffChunk = { kind: "common", lines: ["a", "b"] };
    expect(chooseLines(common, "ours")).toEqual([]);
    expect(chooseLines(common, "theirs")).toEqual([]);
  });

  it("ours: returns ours lines verbatim", () => {
    expect(chooseLines(sample, "ours")).toEqual(["ours-1", "ours-2"]);
  });

  it("theirs: returns theirs lines verbatim", () => {
    expect(chooseLines(sample, "theirs")).toEqual(["theirs-1", "theirs-2"]);
  });

  it("both: concatenates ours + blank line + theirs", () => {
    expect(chooseLines(sample, "both")).toEqual([
      "ours-1",
      "ours-2",
      "",
      "theirs-1",
      "theirs-2",
    ]);
  });

  it("both: drops the blank separator when one side is empty", () => {
    const emptyOurs: DiffChunk = {
      kind: "diff",
      oursLines: [],
      theirsLines: ["t1"],
    };
    expect(chooseLines(emptyOurs, "both")).toEqual(["t1"]);

    const emptyTheirs: DiffChunk = {
      kind: "diff",
      oursLines: ["o1"],
      theirsLines: [],
    };
    expect(chooseLines(emptyTheirs, "both")).toEqual(["o1"]);
  });

  it("neither: returns []", () => {
    expect(chooseLines(sample, "neither")).toEqual([]);
  });

  it("join: throws when no JoinContext provided", () => {
    expect(() => chooseLines(sample, "join")).toThrow(/JoinContext/);
  });

  it("join: produces blockquote callout with header", () => {
    const result = chooseLines(sample, "join", {
      remoteDeviceLabel: "Phone",
      timestamp: "2026-05-26T10-30-00Z",
    });
    expect(result).toEqual([
      "ours-1",
      "ours-2",
      "",
      "> Changes from `Phone` at `2026-05-26T10-30-00Z`:",
      ">",
      "> theirs-1",
      "> theirs-2",
    ]);
  });

  it("join: skips leading blank when ours is empty", () => {
    const result = chooseLines(
      { kind: "diff", oursLines: [], theirsLines: ["t"] },
      "join",
      { remoteDeviceLabel: "X", timestamp: "T" },
    );
    // Should start with the callout (no leading blank).
    expect(result[0]).toBe("> Changes from `X` at `T`:");
  });
});

describe("chunkReplacementRange", () => {
  it("covers ours + sep + theirs when both non-empty", () => {
    const r = chunkReplacementRange(10, 15, 16, 20, true, true);
    expect(r).toEqual({ from: 10, to: 20 });
  });

  it("uses only the non-empty side when the other is empty", () => {
    expect(chunkReplacementRange(10, 15, 15, 15, true, false)).toEqual({
      from: 10,
      to: 15,
    });
    expect(chunkReplacementRange(10, 10, 11, 16, false, true)).toEqual({
      from: 11,
      to: 16,
    });
  });

  it("zero-length range when both empty", () => {
    expect(chunkReplacementRange(5, 5, 5, 5, false, false)).toEqual({
      from: 5,
      to: 5,
    });
  });
});

describe("linesToReplacementText", () => {
  it("joins with \\n, no leading/trailing newline", () => {
    expect(linesToReplacementText(["a", "b", "c"])).toBe("a\nb\nc");
  });
  it("returns '' for empty input", () => {
    expect(linesToReplacementText([])).toBe("");
  });
});
