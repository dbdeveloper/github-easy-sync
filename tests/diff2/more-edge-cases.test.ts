// @vitest-environment happy-dom
//
// Review follow-up edge cases that ARE unit-testable (no layout):
//   - Ctrl/Cmd-A: inside a ver-block selects only that block; on a normal
//     line selects the whole doc (incl. the diff-line content positions).
//   - empty ver-block at the very START (leading empty ver1) and END
//     (trailing empty ver2) of the document — model round-trip + tiling.
// (PgUp/PgDn/Ctrl-Home/End landing on those hidden boundary empties needs a
//  real browser/layout → Playwright/manual.)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiffPane } from "../../src/diff2/diff-pane";
import { diffPaneStateField } from "../../src/diff2/decorations";
import {
  baseSiblingToModel,
  modelToBaseSibling,
  type EditorModel,
} from "../../src/diff2/editor-model";

function tilesModel(m: EditorModel): boolean {
  const s = m.structure;
  if (s.length === 0) return m.doc.length === 0;
  if (s[0].from !== 0) return false;
  for (let i = 1; i < s.length; i++) if (s[i].from !== s[i - 1].to) return false;
  return s[s.length - 1].to === m.doc.length;
}

describe("empty ver-block at a document boundary (model)", () => {
  it("leading empty ver1 (sibling adds content at the very top) round-trips", () => {
    const base = "x\n";
    const sibling = "NEW\nx\n";
    const m = baseSiblingToModel(base, sibling);
    expect(m.structure[0].role).toBe("ver1");
    expect(m.structure[0].from).toBe(m.structure[0].to); // empty, at pos 0
    expect(tilesModel(m)).toBe(true);
    expect(modelToBaseSibling(m)).toEqual({ base, sibling });
  });

  it("trailing empty ver2 (base deletes content at the very end) round-trips", () => {
    const base = "x\nOLD\n";
    const sibling = "x\n";
    const m = baseSiblingToModel(base, sibling);
    const last = m.structure[m.structure.length - 1];
    expect(last.role).toBe("ver2");
    expect(last.from).toBe(last.to); // empty, at doc end
    expect(tilesModel(m)).toBe(true);
    expect(modelToBaseSibling(m)).toEqual({ base, sibling });
  });
});

describe("Ctrl/Cmd-A (§1.7 #3)", () => {
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
  function modA(p: DiffPane): void {
    p.getView().contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  it("inside a ver-block selects only that ver-block", () => {
    pane = new DiffPane(container, "a\nXY\nc\n", "a\nZW\nc\n");
    const view = pane.getView();
    const ver1 = view.state.field(diffPaneStateField, false)!.structure.find(
      (s) => s.role === "ver1",
    )!;
    view.dispatch({ selection: { anchor: ver1.from + 1 } }); // caret inside ver1
    modA(pane);
    const sel = view.state.selection.main;
    expect(sel.from).toBe(ver1.from);
    expect(sel.to).toBe(ver1.to);
  });

  it("on a normal line selects the whole document (incl. diff content)", () => {
    pane = new DiffPane(container, "a\nXY\nc\n", "a\nZW\nc\n");
    const view = pane.getView();
    view.dispatch({ selection: { anchor: 0 } }); // caret in leading normal
    modA(pane);
    const sel = view.state.selection.main;
    expect(sel.from).toBe(0);
    expect(sel.to).toBe(view.state.doc.length);
  });
});
