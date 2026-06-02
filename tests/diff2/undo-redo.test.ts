// @vitest-environment happy-dom
//
// Undo/redo correctness (Stage 1.t, "1" — defaultKeymap + history). The risk:
// CM6 history reverts the DOC but not our structure field, so undoing a
// role-changing transaction (chunk action / collapse, dispatched via the
// setDiffPaneState effect) could leave the structure desynced from the doc.
// structureHistory (invertedEffects) versions the field across undo/redo.
// These are the integration tests for that.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redo, undo, deleteLine } from "@codemirror/commands";
import { DiffPane } from "../../src/diff2/diff-pane";
import { diffPaneStateField } from "../../src/diff2/decorations";

describe("undo / redo", () => {
  let container: HTMLElement;
  let pane: DiffPane | null = null;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    pane?.destroy();
    pane = null;
    container.remove();
  });
  function tiles(p: DiffPane): boolean {
    const s = p.getView().state.field(diffPaneStateField, false)!.structure;
    const len = p.getView().state.doc.length;
    if (s.length === 0) return len === 0;
    if (s[0].from !== 0) return false;
    for (let i = 1; i < s.length; i++) if (s[i].from !== s[i - 1].to) return false;
    return s[s.length - 1].to === len;
  }

  it("free edit: undo restores doc + structure + split", () => {
    pane = new DiffPane(container, "a\nold\nc\n", "a\nnew\nc\n");
    const view = pane.getView();
    const v1 = view.state.field(diffPaneStateField, false)!.structure.find(
      (s) => s.role === "ver1",
    )!;
    view.dispatch({ changes: { from: v1.to - 1, insert: "X" } }); // inside ver1
    expect(pane.getResolved().base).toBe("a\noldX\nc\n");
    undo(view);
    expect(pane.getResolved()).toEqual({
      base: "a\nold\nc\n",
      sibling: "a\nnew\nc\n",
    });
    expect(tiles(pane)).toBe(true);
  });

  it("chunk action: undo restores the unresolved group (structure roles revert)", () => {
    pane = new DiffPane(container, "a\nb\nc\n", "a\nX\nc\n");
    const view = pane.getView();
    expect(pane.remainingDiffChunkCount()).toBe(1);
    pane.applyToChunk(0, "ours"); // group → normal (setDiffPaneState)
    expect(pane.remainingDiffChunkCount()).toBe(0);
    expect(pane.getResolved().base).toBe("a\nb\nc\n");

    undo(view);
    // Without structureHistory this would stay 0 (doc reverts, structure
    // doesn't) → desync. With it, the conflict is fully restored.
    expect(pane.remainingDiffChunkCount()).toBe(1);
    expect(pane.getResolved()).toEqual({
      base: "a\nb\nc\n",
      sibling: "a\nX\nc\n",
    });
    expect(tiles(pane)).toBe(true);

    redo(view);
    expect(pane.remainingDiffChunkCount()).toBe(0);
    expect(pane.getResolved().base).toBe("a\nb\nc\n");
    expect(tiles(pane)).toBe(true);
  });

  it("auto-collapse: a single undo reverts BOTH the edit and the collapse", () => {
    pane = new DiffPane(container, "x\nab\ny\n", "x\nabc\ny\n");
    const view = pane.getView();
    const at = view.state.doc.toString().indexOf("ab") + 2;
    view.dispatch({ changes: { from: at, insert: "c" } }); // ver1 == ver2 → collapse
    expect(pane.remainingDiffChunkCount()).toBe(0);
    expect(view.state.doc.toString()).toBe("x\nabc\ny\n");

    undo(view); // ONE undo
    expect(pane.remainingDiffChunkCount()).toBe(1); // group back
    expect(pane.getResolved()).toEqual({
      base: "x\nab\ny\n",
      sibling: "x\nabc\ny\n",
    });
    expect(tiles(pane)).toBe(true);
  });

  it("defaultKeymap command (deleteLine) routes through the pipeline soundly", () => {
    pane = new DiffPane(container, "a\nold\nc\n", "a\nnew\nc\n");
    const view = pane.getView();
    const v1 = view.state.field(diffPaneStateField, false)!.structure.find(
      (s) => s.role === "ver1",
    )!;
    view.dispatch({ selection: { anchor: v1.from + 1 } }); // caret in ver1 line
    deleteLine(view); // bound via defaultKeymap (Shift-Mod-k); call directly here
    const p = pane;
    expect(tiles(p)).toBe(true);
    expect(() => p.getResolved()).not.toThrow();
  });

  it("variant-3 replace (normal + diff-group + normal → plain text) destroys the group; undo restores it", () => {
    // common "A\n", ver1 "M\n", ver2 "N\n", common "Z\n" → doc "A\nM\nN\nZ\n".
    pane = new DiffPane(container, "A\nM\nZ\n", "A\nN\nZ\n");
    const view = pane.getView();
    expect(pane.remainingDiffChunkCount()).toBe(1);
    const original = pane.getResolved();
    expect(original).toEqual({ base: "A\nM\nZ\n", sibling: "A\nN\nZ\n" });

    // Select from inside "A\n" (pos 1) across the group to inside "Z\n"
    // (pos 7) — variant 3 (both ends normal-space, legal) — replace with text.
    view.dispatch({ changes: { from: 1, to: 7, insert: "PLAIN" } });
    expect(pane.remainingDiffChunkCount()).toBe(0); // diff-string gone
    expect(tiles(pane)).toBe(true);
    const after = pane.getResolved();
    expect(after.base).toBe(after.sibling); // both sides now share the plain text
    expect(after.base).toBe("APLAIN\n"); // no spurious blank line

    // UNDO: the normal text AND the diff-string both come back.
    undo(view);
    expect(pane.remainingDiffChunkCount()).toBe(1);
    expect(pane.getResolved()).toEqual(original);
    expect(tiles(pane)).toBe(true);

    // REDO (CM6): the replacement re-applies, group gone again.
    redo(view);
    expect(pane.remainingDiffChunkCount()).toBe(0);
    expect(pane.getResolved().base).toBe("APLAIN\n");
    expect(tiles(pane)).toBe(true);
  });
});
