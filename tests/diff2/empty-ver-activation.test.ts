// @vitest-environment happy-dom
//
// §1.8.a empty-ver activation (Stage 1b.4a): marker `data-action` routing,
// click → activate, typing into an activated empty ver grows THAT ver, and
// the activation clear-lifecycle (content gain / caret leave).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiffPane } from "../../src/diff2/diff-pane";
import { diffPaneStateField } from "../../src/diff2/decorations";

describe("§1.8.a empty-ver activation", () => {
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

  // base "a\nc\n" vs sibling "a\nb\nc\n": ver1 EMPTY, ver2 "b\n".
  function emptyVer1Pane(): DiffPane {
    return new DiffPane(container, "a\nc\n", "a\nb\nc\n");
  }
  function glyph(kind: "top" | "bottom"): HTMLElement {
    return container.querySelector(
      `.diff2-marker-${kind} .diff2-marker-glyph`,
    ) as HTMLElement;
  }
  function field(p: DiffPane) {
    return p.getView().state.field(diffPaneStateField, false);
  }

  it("marker chars carry data-action only for the EMPTY ver", () => {
    pane = emptyVer1Pane();
    pane.getView().requestMeasure();
    expect(glyph("top").dataset.action).toBe("focus-ver1"); // ver1 empty
    expect(glyph("bottom").dataset.action).toBe("none"); // ver2 has content
  });

  it("non-empty ver-blocks → both markers inert (data-action none)", () => {
    pane = new DiffPane(container, "a\nold\nc\n", "a\nnew\nc\n");
    pane.getView().requestMeasure();
    expect(glyph("top").dataset.action).toBe("none");
    expect(glyph("bottom").dataset.action).toBe("none");
  });

  it("clicking the empty-ver1 marker activates it + places the caret", () => {
    pane = emptyVer1Pane();
    pane.getView().requestMeasure();
    expect(field(pane)?.activeEmptyVer).toBeNull();

    glyph("top").click();

    const f = field(pane);
    expect(f?.activeEmptyVer).toEqual({ group: 0, role: "ver1" });
    // caret placed at the empty ver's point (== ver2.from).
    const v1 = f!.structure.find((s) => s.role === "ver1" && s.group === 0)!;
    expect(pane.getView().state.selection.main.head).toBe(v1.from);
    expect(pane.getView().state.selection.main.empty).toBe(true); // collapsed
  });

  it("typing after activation grows ver1 (not ver2); split stays sound", () => {
    pane = emptyVer1Pane();
    pane.getView().requestMeasure();
    glyph("top").click();
    const v1from = field(pane)!.structure.find((s) => s.role === "ver1")!.from;

    pane.getView().dispatch({ changes: { from: v1from, insert: "Q" } });

    expect(pane.getResolved()).toEqual({
      // ver1 grew to "Q"; §1.6.a.2 commit normalization gives it a \n (group
      // not last), so "Q" is its own base line, not merged into "c".
      base: "a\nQ\nc\n",
      sibling: "a\nb\nc\n", // ver2 untouched
    });
    // activation cleared once ver1 gained content.
    expect(field(pane)?.activeEmptyVer).toBeNull();
  });

  it("activation clears when the caret leaves without typing", () => {
    pane = emptyVer1Pane();
    pane.getView().requestMeasure();
    glyph("top").click();
    expect(field(pane)?.activeEmptyVer).not.toBeNull();

    // Move the caret to the document start (selection-only) → clears.
    pane.getView().dispatch({ selection: { anchor: 0 } });
    expect(field(pane)?.activeEmptyVer).toBeNull();
  });

  it("activation caret is not clobbered by the §1.7 selection filter", () => {
    // The activation caret is collapsed (anchor==head); the 1b.3 filter
    // only adjusts ranges, so it must pass through untouched.
    pane = emptyVer1Pane();
    pane.getView().requestMeasure();
    glyph("top").click();
    const sel = pane.getView().state.selection.main;
    expect(sel.empty).toBe(true);
    expect(field(pane)?.activeEmptyVer).toEqual({ group: 0, role: "ver1" });
  });
});
