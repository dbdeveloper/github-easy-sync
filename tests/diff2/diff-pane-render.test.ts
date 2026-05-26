// @vitest-environment happy-dom
//
// DiffPane render smoke test — verifies the CM6 EditorView mounts,
// produces a DOM tree containing marker block-widgets, and that
// line-decoration classes land on the expected lines.
//
// Per R12.0 Spike 1: vitest's default node env has no DOM; this
// file opts into happy-dom via the directive above. Existing
// non-DOM unit tests stay on node env.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiffPane } from "../../src/diff2/diff-pane";

describe("DiffPane render", () => {
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

  it("mounts an EditorView under the given parent", () => {
    pane = new DiffPane(container, "line1\nline2\n", "line1\nline2\n");
    pane.getView().requestMeasure();

    // CM6 mounts under a .cm-editor wrapper.
    expect(container.querySelector(".cm-editor")).not.toBeNull();
  });

  it("renders three marker block-widgets per diff chunk", () => {
    pane = new DiffPane(
      container,
      "common\nours-line\ncommon2\n",
      "common\ntheirs-line\ncommon2\n",
    );
    pane.getView().requestMeasure();

    const top = container.querySelectorAll(".diff2-marker-top");
    const middle = container.querySelectorAll(".diff2-marker-middle");
    const bottom = container.querySelectorAll(".diff2-marker-bottom");

    expect(top.length).toBe(1);
    expect(middle.length).toBe(1);
    expect(bottom.length).toBe(1);

    // Marker text matches R7.2 (5 angle brackets).
    expect(top[0].querySelector(".diff2-marker-glyph")?.textContent).toBe("<<<<<");
    expect(middle[0].querySelector(".diff2-marker-glyph")?.textContent).toBe("=====");
    expect(bottom[0].querySelector(".diff2-marker-glyph")?.textContent).toBe(">>>>>");
  });

  it("includes device label in top + bottom markers, not middle", () => {
    pane = new DiffPane(container, "a\n", "b\n", {
      oursLabel: "Phone",
      theirsLabel: "Laptop",
    });
    pane.getView().requestMeasure();

    const topLabel = container
      .querySelector(".diff2-marker-top .diff2-marker-label")?.textContent;
    const bottomLabel = container
      .querySelector(".diff2-marker-bottom .diff2-marker-label")?.textContent;
    const middleLabel = container.querySelector(
      ".diff2-marker-middle .diff2-marker-label",
    );

    expect(topLabel).toBe("(Phone)");
    expect(bottomLabel).toBe("(Laptop)");
    expect(middleLabel).toBeNull();
  });

  it("applies ours / theirs line-decoration classes to expected lines", () => {
    pane = new DiffPane(container, "ours line\n", "theirs line\n");
    pane.getView().requestMeasure();

    // Each CM6 line is a .cm-line element. Decoration.line attaches
    // the class to that line's <div>.
    const oursLines = container.querySelectorAll(".cm-line.diff2-line-ours");
    const theirsLines = container.querySelectorAll(".cm-line.diff2-line-theirs");
    expect(oursLines.length).toBe(1);
    expect(theirsLines.length).toBe(1);
    expect((oursLines[0] as HTMLElement).textContent).toContain("ours");
    expect((theirsLines[0] as HTMLElement).textContent).toContain("theirs");
  });

  it("applies word-changed mark decorations within diff lines", () => {
    pane = new DiffPane(container, "line from local file\n", "line from github repo\n");
    pane.getView().requestMeasure();

    // Word-level marks land as <span class="diff2-word-changed"> in
    // the rendered HTML.
    const wordMarks = container.querySelectorAll(".diff2-word-changed");
    expect(wordMarks.length).toBeGreaterThan(0);
  });

  it("emits no markers when ours === theirs (no diff chunks)", () => {
    pane = new DiffPane(container, "identical\n", "identical\n");
    pane.getView().requestMeasure();

    expect(container.querySelectorAll(".diff2-marker").length).toBe(0);
  });

  it("getDocText returns the merged document content", () => {
    pane = new DiffPane(container, "ours-only\n", "theirs-only\n");
    pane.getView().requestMeasure();

    // Doc text = ours lines + theirs lines (per chunksToText). No
    // markers in the text — they're block-widgets, not chars.
    expect(pane.getDocText()).toBe("ours-only\ntheirs-only");
  });

  it("destroy() removes the CM6 DOM from the parent", () => {
    pane = new DiffPane(container, "a\n", "b\n");
    expect(container.querySelector(".cm-editor")).not.toBeNull();
    pane.destroy();
    pane = null;
    expect(container.querySelector(".cm-editor")).toBeNull();
  });

  it("supports free editing (R7.8) — typing dispatches and updates doc", () => {
    pane = new DiffPane(container, "a\n", "b\n");
    const view = pane.getView();
    view.requestMeasure();

    // Dispatch a typed insert at the start of the doc.
    view.dispatch({ changes: { from: 0, insert: "PREFIX " } });
    view.requestMeasure();

    expect(pane.getDocText()).toContain("PREFIX");
  });
});
