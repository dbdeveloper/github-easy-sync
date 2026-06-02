// @vitest-environment happy-dom
//
// §1.6.a.2 normalization: a ver-block whose last line lost its trailing \n
// (non-empty, mid-document) gets the \n restored — on focus-leave (caret
// exits the block) and at apply-time (resolution) — so its content can't
// merge into the next segment on split(). A genuine last-line-of-file
// (EOL-less, group is the document's last element) is left alone.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiffPane } from "../../src/diff2/diff-pane";
import { diffPaneStateField } from "../../src/diff2/decorations";

describe("§1.6.a.2 focus-leave normalization", () => {
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

  function seg(p: DiffPane, role: string) {
    return p.getView().state.field(diffPaneStateField, false)!.structure.find(
      (s) => s.role === role,
    )!;
  }

  it("restores \\n when the caret leaves a ver1 that lost its trailing \\n (mid-doc)", () => {
    pane = new DiffPane(container, "a\nabc\nc\n", "a\nXYZ\nc\n");
    const view = pane.getView();
    const v1 = seg(pane, "ver1"); // "abc\n" at [2,6)

    // Delete ver1's trailing \n (caret left inside ver1).
    view.dispatch({
      changes: { from: v1.to - 1, to: v1.to, insert: "" },
      selection: { anchor: v1.from + 1 },
    });
    // LIVE doc now shows the merged line (ver1 lost its \n)…
    expect(view.state.doc.toString()).toBe("a\nabcXYZ\nc\n");
    // …but getResolved() is ALREADY correct — commit-boundary normalization
    // (§1.6.a.2 in fromEditorModel) restores the \n regardless of focus.
    expect(pane.getResolved().base).toBe("a\nabc\nc\n");

    // focus-leave normalization is now a VISUAL nicety: it restores the \n
    // in the LIVE doc too when the caret leaves ver1.
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.state.doc.toString()).toBe("a\nabc\nXYZ\nc\n");
    expect(pane.getResolved()).toEqual({
      base: "a\nabc\nc\n",
      sibling: "a\nXYZ\nc\n",
    });
  });

  it("does NOT add \\n when the group is the document's last element", () => {
    // ver1 "abc" (EOL-less, last line of file), ver2 "XYZ".
    pane = new DiffPane(container, "a\nabc", "a\nXYZ");
    const view = pane.getView();
    const v1 = seg(pane, "ver1");
    view.dispatch({ selection: { anchor: v1.from + 1 } }); // enter ver1
    view.dispatch({ selection: { anchor: 0 } }); // leave ver1
    expect(pane.getResolved().base).toBe("a\nabc"); // EOL-less preserved
  });

  it("does NOT fire when the ver already ends with \\n", () => {
    pane = new DiffPane(container, "a\nabc\nc\n", "a\nXYZ\nc\n");
    const view = pane.getView();
    const v1 = seg(pane, "ver1"); // "abc\n"
    view.dispatch({ selection: { anchor: v1.from + 1 } });
    view.dispatch({ selection: { anchor: 0 } });
    expect(pane.getResolved().base).toBe("a\nabc\nc\n"); // unchanged
  });

  describe("apply-time normalization (relayout)", () => {
    it("appends \\n to a resolved mid-doc line that lacks one", () => {
      pane = new DiffPane(container, "a\nabc\nc\n", "a\nXYZ\nc\n");
      const view = pane.getView();
      const v1 = seg(pane, "ver1");
      // Edit ver1 to drop its \n, then apply ours.
      view.dispatch({
        changes: { from: v1.to - 1, to: v1.to, insert: "" },
        selection: { anchor: v1.from + 1 },
      });
      pane.applyToChunk(0, "ours");
      expect(pane.getResolved().base).toBe("a\nabc\nc\n"); // \n restored
      expect(pane.remainingDiffChunkCount()).toBe(0);
    });

    it("keeps an EOL-less tail when the resolved group is the last element", () => {
      pane = new DiffPane(container, "a\nabc", "a\nXYZ");
      pane.applyToChunk(0, "ours");
      expect(pane.getResolved().base).toBe("a\nabc"); // last-line-of-file
    });
  });
});
