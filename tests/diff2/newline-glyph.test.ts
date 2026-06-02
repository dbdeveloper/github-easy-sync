// @vitest-environment happy-dom
//
// §1.6.a.1: a ghost `↵` glyph marks every real newline (all lines except
// the last), so a hard break is distinguishable from a soft wrap. The
// glyph is a widget — not part of the doc, so not selectable/copyable.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiffPane } from "../../src/diff2/diff-pane";

describe("§1.6.a.1 newline glyph", () => {
  let container: HTMLElement;
  let pane: DiffPane | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    if (pane) {
      pane.destroy();
      pane = null;
    }
    container.remove();
  });

  function glyphs(): NodeListOf<Element> {
    return container.querySelectorAll(".diff2-newline-glyph");
  }

  it("renders one ↵ per real newline (identical doc, no diff groups)", () => {
    // ours === theirs → no markers; doc = "a\nb\nc\n" has 3 newlines.
    pane = new DiffPane(container, "a\nb\nc\n", "a\nb\nc\n");
    pane.getView().requestMeasure();
    const g = glyphs();
    expect(g.length).toBe(3);
    expect(g[0].textContent).toBe("↵");
  });

  it("last line without a trailing newline gets no glyph", () => {
    // doc = "a\nb\nc" → 2 newlines → 2 glyphs (the final "c" has none).
    pane = new DiffPane(container, "a\nb\nc", "a\nb\nc");
    pane.getView().requestMeasure();
    expect(glyphs().length).toBe(2);
  });

  it("a single line with no newline gets no glyph", () => {
    pane = new DiffPane(container, "abc", "abc");
    pane.getView().requestMeasure();
    expect(glyphs().length).toBe(0);
  });

  it("glyph is non-selectable ghost (aria-hidden, not in doc text)", () => {
    pane = new DiffPane(container, "a\nb\n", "a\nb\n");
    pane.getView().requestMeasure();
    const g = glyphs()[0] as HTMLElement;
    expect(g.getAttribute("aria-hidden")).toBe("true");
    // The doc itself contains no ↵ — the glyph is a widget overlay.
    expect(pane.getView().state.doc.toString().includes("↵")).toBe(false);
  });

  it("glyphs appear on ver lines too (not only normal)", () => {
    // ours "x\nO\nz\n" vs theirs "x\nT\nz\n": doc "x\nO\nz\nT\nz\n"? no —
    // doc = "x\nO\nT\nz\n" (common x, ver1 O, ver2 T, common z). 4 newlines.
    pane = new DiffPane(container, "x\nO\nz\n", "x\nT\nz\n");
    pane.getView().requestMeasure();
    expect(glyphs().length).toBe(4);
  });
});
