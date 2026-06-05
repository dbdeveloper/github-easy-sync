// @vitest-environment happy-dom
//
// §1.6.a.1 (TODO §6.8): a ghost `↵` glyph marks every real newline INSIDE a
// ver1/ver2 block (so a hard break is distinguishable from a soft wrap when
// comparing the two sides). It is NOT drawn on normal lines — there it was just
// noise. The glyph is a widget — not part of the doc, so not selectable/copyable.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiffPane } from "../../src/diff2/diff-pane";

describe("§1.6.a.1 newline glyph (ver-blocks only)", () => {
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

  it("no glyphs when there are NO diff groups (all-normal doc)", () => {
    // ours === theirs → every line is normal → no ↵ at all.
    pane = new DiffPane(container, "a\nb\nc\n", "a\nb\nc\n");
    pane.getView().requestMeasure();
    expect(glyphs().length).toBe(0);
  });

  it("glyph ONLY on ver1/ver2 lines, never on normal lines", () => {
    // doc = "x\nO\nT\nz\n": x normal, O ver1, T ver2, z normal. Only O and T —
    // both followed by a real \n — get a glyph; x and z (normal) do not.
    pane = new DiffPane(container, "x\nO\nz\n", "x\nT\nz\n");
    pane.getView().requestMeasure();
    const g = glyphs();
    expect(g.length).toBe(2);
    expect(g[0].textContent).toBe("↵");
    // Every glyph sits inside a coloured ver line, never a common line.
    for (const el of Array.from(g)) {
      const line = el.closest(".cm-line");
      expect(
        line?.classList.contains("diff2-line-ours") ||
          line?.classList.contains("diff2-line-theirs"),
      ).toBe(true);
    }
  });

  it("a ver line that is EOL-less (no trailing \\n) gets no glyph", () => {
    // ours "a\nM" / theirs "a\nT": last line M/T is the doc's EOL-less tail.
    pane = new DiffPane(container, "a\nM", "a\nT");
    pane.getView().requestMeasure();
    expect(glyphs().length).toBe(0);
  });

  it("glyph is a non-selectable ghost (aria-hidden, not in doc text)", () => {
    pane = new DiffPane(container, "x\nO\nz\n", "x\nT\nz\n");
    pane.getView().requestMeasure();
    const g = glyphs()[0] as HTMLElement;
    expect(g.getAttribute("aria-hidden")).toBe("true");
    expect(pane.getView().state.doc.toString().includes("↵")).toBe(false);
  });
});
