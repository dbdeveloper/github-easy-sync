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

  it("normal line after a diff group keeps its line-decoration (no phantom line)", () => {
    // Regression (DIFF-EDITOR-TODO §1): the bottom `>>>>>` marker was a block
    // widget anchored at the next line's START with side:1, which made CM6
    // split off a PHANTOM empty `diff2-line-common` line before the marker and
    // stole the Decoration.line from the real normal line that follows — the
    // line then rendered with NO class, its gutter number shifted by one, and
    // keyboard nav skipped it. Both ver-blocks use the same data; only the
    // bottom marker was wrong (it used side:1, top/middle correctly use -1).
    pane = new DiffPane(
      container,
      "ours-line\nafter the group\n",
      "theirs-line\nafter the group\n",
    );
    pane.getView().requestMeasure();

    const children = Array.from(
      container.querySelector(".cm-content")!.children,
    ) as HTMLElement[];
    const bottomIdx = children.findIndex((c) =>
      c.classList.contains("diff2-marker-bottom"),
    );
    expect(bottomIdx).toBeGreaterThanOrEqual(0);

    // No phantom: the line immediately BEFORE the bottom marker must be the
    // last `theirs` line, not an empty common line.
    const beforeMarker = children[bottomIdx - 1];
    expect(beforeMarker.classList.contains("diff2-line-theirs")).toBe(true);

    // The line immediately AFTER the bottom marker is the real normal line,
    // and it carries the common class (was unclassed before the fix).
    const afterMarker = children[bottomIdx + 1];
    expect(afterMarker.textContent).toContain("after the group");
    expect(afterMarker.classList.contains("diff2-line-common")).toBe(true);

    // And there is exactly ONE common-classed line with that text — the bug
    // produced a second, empty common line.
    const emptyCommon = children.filter(
      (c) =>
        c.classList.contains("diff2-line-common") &&
        c.classList.contains("cm-line") &&
        c.textContent === "",
    );
    expect(emptyCommon.length).toBe(0);
  });

  it("a legitimate sibling-only trailing blank line stays green + numbered (no phantom)", () => {
    // DIFF-EDITOR-TODO §1 reconciliation: when the SIBLING genuinely has a
    // trailing blank line the diff didn't share (ver2 = `theirs\n\n`), that
    // blank is real sibling-only content → it belongs in ver2 (green) and gets
    // a sibling-wins number. The fix must NOT delete it (it is not the phantom);
    // it must only stop the bottom marker from spawning the WHITE phantom +
    // stealing the next normal line's decoration.
    pane = new DiffPane(
      container,
      "ours\nafter\n",
      "theirs\n\nafter\n", // sibling has a blank line after `theirs`
    );
    pane.getView().requestMeasure();

    const children = Array.from(
      container.querySelector(".cm-content")!.children,
    ) as HTMLElement[];

    // The blank line just before the bottom marker is GREEN (theirs), not a
    // white common phantom.
    const bottomIdx = children.findIndex((c) =>
      c.classList.contains("diff2-marker-bottom"),
    );
    const blankBeforeMarker = children[bottomIdx - 1];
    // Empty content, but it carries the ghost `↵` glyph (a real doc line, so
    // §1.6.a.1 renders the newline glyph); the white phantom had no glyph ("").
    expect(blankBeforeMarker.textContent).toBe("↵");
    expect(blankBeforeMarker.classList.contains("diff2-line-theirs")).toBe(true);

    // The normal line after the marker still carries the common class.
    const afterMarker = children[bottomIdx + 1];
    expect(afterMarker.textContent).toContain("after");
    expect(afterMarker.classList.contains("diff2-line-common")).toBe(true);

    // No WHITE empty common phantom anywhere.
    const emptyCommon = children.filter(
      (c) =>
        c.classList.contains("diff2-line-common") &&
        c.classList.contains("cm-line") &&
        c.textContent === "",
    );
    expect(emptyCommon.length).toBe(0);
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

  it("getResolvedBase returns the BASE side (not the merged doc)", () => {
    pane = new DiffPane(container, "ours-only\n", "theirs-only\n");
    pane.getView().requestMeasure();

    // Unresolved → base is unchanged ours; sibling is theirs. The
    // merged doc would be "ours-only\ntheirs-only" — getResolvedBase
    // must NOT return that (Trap 2: writing merged text as base
    // corrupts the file on a partial [← back]).
    expect(pane.getResolvedBase()).toBe("ours-only\n");
    expect(pane.getResolved()).toEqual({
      base: "ours-only\n",
      sibling: "theirs-only\n",
    });
  });

  it("focus() focuses the editor (TODO §6.1: the owner calls it on mount → caret + Ctrl+Z, no click)", () => {
    pane = new DiffPane(container, "a\nMINE\nc\n", "a\nTHEIRS\nc\n");
    const view = pane.getView();
    view.requestMeasure();
    const stealer = document.body.appendChild(document.createElement("button"));
    stealer.focus();
    expect(view.hasFocus).toBe(false);
    pane.focus(); // mountDiffPane calls this after every mount path
    expect(view.hasFocus).toBe(true);
    stealer.remove();
  });

  it("setCursor restores the caret in a FOCUSED editor (TODO §6.2)", () => {
    pane = new DiffPane(container, "a\nMINE\nc\nmore\n", "a\nTHEIRS\nc\nmore\n");
    const view = pane.getView();
    view.requestMeasure();
    const stealer = document.body.appendChild(document.createElement("button"));
    stealer.focus();
    expect(view.hasFocus).toBe(false);

    pane.setCursor(5, 5);
    expect(view.hasFocus).toBe(true); // restored caret lives in a focused editor
    expect(view.state.selection.main.anchor).toBe(5);
    stealer.remove();
  });

  it("gutter shows − for ours / + for theirs and tints the cell (TODO §6.5/§6.7)", () => {
    pane = new DiffPane(
      container,
      "common\nours-line\ncommon2\n",
      "common\ntheirs-line\ncommon2\n",
    );
    pane.getView().requestMeasure();

    const oursCell = container.querySelector(".cm-gutterElement.diff2-gutter-ours");
    const theirsCell = container.querySelector(".cm-gutterElement.diff2-gutter-theirs");
    expect(oursCell).not.toBeNull();
    expect(theirsCell).not.toBeNull();
    expect(oursCell?.querySelector(".diff2-gutter-glyph")?.textContent).toBe("−");
    expect(theirsCell?.querySelector(".diff2-gutter-glyph")?.textContent).toBe("+");
    // Common lines get a number cell but no side glyph and no tint class.
    const common = container.querySelector(
      ".cm-gutterElement:not(.diff2-gutter-ours):not(.diff2-gutter-theirs) .diff2-gutter-num",
    );
    expect(common).not.toBeNull();
    expect(
      common?.parentElement?.querySelector(".diff2-gutter-glyph"),
    ).toBeNull();
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

    // Dispatch a typed insert at the start of the doc (inside ver1).
    view.dispatch({ changes: { from: 0, insert: "PREFIX " } });
    view.requestMeasure();

    // Live doc reflects the edit, and split() stays sound: the prefix
    // lands on the base side (structure mapped through the transaction).
    expect(view.state.doc.toString()).toContain("PREFIX");
    expect(pane.getResolved().base).toBe("PREFIX a\n");
    expect(pane.getResolved().sibling).toBe("b\n");
  });
});
