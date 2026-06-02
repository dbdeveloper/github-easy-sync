// @vitest-environment happy-dom
//
// §1.8 / §1.8.a (1b.4b): plain ↑/↓ caret nav STOPS at an empty ver-block
// instead of skipping it. The geometry ("where the arrow lands") is
// delegated to CM6's moveVertically (wrap-aware, needs real layout →
// verified manually), so unit tests pin the pure findEmptyVerSkipped
// decision + the activation-state transitions.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiffPane, findEmptyVerSkipped } from "../../src/diff2/diff-pane";
import { baseSiblingToModel } from "../../src/diff2/editor-model";
import { diffPaneStateField } from "../../src/diff2/decorations";

describe("findEmptyVerSkipped (pure)", () => {
  // empty ver1: structure normal[0,2) ver1[2,2) ver2[2,4) normal[4,6).
  const EMPTY_V1 = baseSiblingToModel("a\nc\n", "a\nb\nc\n").structure;
  // empty ver2: structure normal[0,2) ver1[2,4) ver2[4,4) normal[4,6).
  const EMPTY_V2 = baseSiblingToModel("a\nb\nc\n", "a\nc\n").structure;
  // non-empty both.
  const NONEMPTY = baseSiblingToModel("a\nX\nc\n", "a\nY\nc\n").structure;

  it("↓ from the line above an empty ver1 → returns ver1", () => {
    expect(findEmptyVerSkipped(EMPTY_V1, 1, 3)).toEqual({
      group: 0,
      role: "ver1",
      point: 2,
    });
  });

  it("↑ from ver2 across an empty ver1 → returns ver1", () => {
    expect(findEmptyVerSkipped(EMPTY_V1, 3, 1)).toEqual({
      group: 0,
      role: "ver1",
      point: 2,
    });
  });

  it("↓ from ver1 into an empty ver2 → returns ver2", () => {
    expect(findEmptyVerSkipped(EMPTY_V2, 3, 5)).toEqual({
      group: 0,
      role: "ver2",
      point: 4,
    });
  });

  it("no empty ver in the move span → null", () => {
    expect(findEmptyVerSkipped(EMPTY_V1, 0, 1)).toBeNull(); // within "a\n"
    expect(findEmptyVerSkipped(NONEMPTY, 0, 5)).toBeNull(); // no empty vers
  });

  it("no movement (target === caret) → null", () => {
    expect(findEmptyVerSkipped(EMPTY_V1, 2, 2)).toBeNull();
  });
});

describe("arrow nav — activation-state transition (live)", () => {
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

  function field(p: DiffPane) {
    return p.getView().state.field(diffPaneStateField, false);
  }

  it("an arrow LEAVES an activated empty ver (clears the state)", () => {
    pane = new DiffPane(container, "a\nc\n", "a\nb\nc\n");
    pane.getView().requestMeasure();
    // Activate empty ver1 via the marker click (1b.4a).
    (container.querySelector(
      ".diff2-marker-top .diff2-marker-glyph",
    ) as HTMLElement).click();
    expect(field(pane)?.activeEmptyVer).toEqual({ group: 0, role: "ver1" });

    // ArrowDown → the nav handler's "leave" branch clears the activation.
    pane.getView().contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(field(pane)?.activeEmptyVer).toBeNull();
  });
});
