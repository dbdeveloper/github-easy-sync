import { describe, it, expect } from "vitest";
import {
  isMarkdownPath,
  resolveAllAsText,
  resolveAllChunks,
} from "../../src/diff2/conflict-merge-all";
import type { DiffChunk } from "../../src/diff2/diff-chunks";

describe("resolveAllChunks", () => {
  it("passes common chunks through unchanged", () => {
    const chunks: DiffChunk[] = [
      { kind: "common", lines: ["c1"] },
      { kind: "diff", oursLines: ["o"], theirsLines: ["t"] },
      { kind: "common", lines: ["c2"] },
    ];
    const result = resolveAllChunks(chunks, "ours");
    expect(result[0]).toEqual({ kind: "common", lines: ["c1"] });
    expect(result[2]).toEqual({ kind: "common", lines: ["c2"] });
  });

  it("ours: every diff chunk becomes common with ours lines", () => {
    const chunks: DiffChunk[] = [
      { kind: "diff", oursLines: ["o1"], theirsLines: ["t1"] },
      { kind: "diff", oursLines: ["o2"], theirsLines: ["t2"] },
    ];
    const result = resolveAllChunks(chunks, "ours");
    expect(result).toEqual([
      { kind: "common", lines: ["o1"] },
      { kind: "common", lines: ["o2"] },
    ]);
  });

  it("theirs: every diff chunk becomes common with theirs lines", () => {
    const chunks: DiffChunk[] = [
      { kind: "diff", oursLines: ["o1"], theirsLines: ["t1"] },
      { kind: "diff", oursLines: ["o2"], theirsLines: ["t2"] },
    ];
    const result = resolveAllChunks(chunks, "theirs");
    expect(result).toEqual([
      { kind: "common", lines: ["t1"] },
      { kind: "common", lines: ["t2"] },
    ]);
  });

  it("join: every diff chunk gets blockquote callout under ours", () => {
    const chunks: DiffChunk[] = [
      { kind: "diff", oursLines: ["o1"], theirsLines: ["t1"] },
    ];
    const result = resolveAllChunks(chunks, "join", {
      remoteDeviceLabel: "P",
      timestamp: "T",
    });
    expect(result[0]).toEqual({
      kind: "common",
      lines: [
        "o1",
        "",
        "> Changes from `P` at `T`:",
        ">",
        "> t1",
      ],
    });
  });
});

describe("resolveAllAsText", () => {
  it("emits the flattened post-resolution document text", () => {
    const chunks: DiffChunk[] = [
      { kind: "common", lines: ["c1"] },
      { kind: "diff", oursLines: ["o"], theirsLines: ["t"] },
      { kind: "common", lines: ["c2"] },
    ];
    expect(resolveAllAsText(chunks, "ours")).toBe("c1\no\nc2");
    expect(resolveAllAsText(chunks, "theirs")).toBe("c1\nt\nc2");
  });
});

describe("isMarkdownPath", () => {
  it("matches *.md (any case)", () => {
    expect(isMarkdownPath("note.md")).toBe(true);
    expect(isMarkdownPath("Folder/note.MD")).toBe(true);
  });
  it("matches *.markdown", () => {
    expect(isMarkdownPath("doc.markdown")).toBe(true);
  });
  it("rejects non-markdown extensions", () => {
    expect(isMarkdownPath("data.json")).toBe(false);
    expect(isMarkdownPath("style.css")).toBe(false);
    expect(isMarkdownPath("image.png")).toBe(false);
    expect(isMarkdownPath("README")).toBe(false);
  });
});
