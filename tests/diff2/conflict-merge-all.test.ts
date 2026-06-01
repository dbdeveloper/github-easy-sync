import { describe, it, expect } from "vitest";
import { isMarkdownPath } from "../../src/diff2/conflict-merge-all";

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
