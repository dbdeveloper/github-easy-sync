// @vitest-environment happy-dom
//
// §1.9 hotkeys: chunk resolution from the keyboard, active only when the
// caret is in a ver-block. Pure mapping (hotkeyTarget) + a live keydown
// integration through the DiffPane keymap.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiffPane, hotkeyTarget } from "../../src/diff2/diff-pane";
import { baseSiblingToModel } from "../../src/diff2/editor-model";

describe("§1.9 hotkeyTarget (pure mapping)", () => {
  // ver1 "XX\n", ver2 "YY\n".
  const S = baseSiblingToModel("a\nXX\nc\n", "a\nYY\nc\n").structure;
  const v1 = S.find((s) => s.role === "ver1")!;
  const v2 = S.find((s) => s.role === "ver2")!;

  it("caret in ver1: apply→ours, remove→theirs", () => {
    expect(hotkeyTarget(S, v1.from + 1, "apply")).toEqual({ group: 0, choice: "ours" });
    expect(hotkeyTarget(S, v1.from + 1, "remove")).toEqual({ group: 0, choice: "theirs" });
  });
  it("caret in ver2: apply→theirs, remove→ours", () => {
    expect(hotkeyTarget(S, v2.from + 1, "apply")).toEqual({ group: 0, choice: "theirs" });
    expect(hotkeyTarget(S, v2.from + 1, "remove")).toEqual({ group: 0, choice: "ours" });
  });
  it("both / neither / join pass through", () => {
    expect(hotkeyTarget(S, v1.from + 1, "both")?.choice).toBe("both");
    expect(hotkeyTarget(S, v1.from + 1, "neither")?.choice).toBe("neither");
    expect(hotkeyTarget(S, v2.from + 1, "join")?.choice).toBe("join");
  });
  it("caret in normal-space → null (hotkeys inert)", () => {
    expect(hotkeyTarget(S, 0, "apply")).toBeNull();
  });
});

describe("§1.9 hotkeys (live keydown)", () => {
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

  function key(opts: KeyboardEventInit): void {
    pane!.getView().contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { ...opts, bubbles: true, cancelable: true }),
    );
  }
  function caretInVer1(p: DiffPane): void {
    // doc is "a\nXX\nYY\nc\n"; "XX" is ver1 → +1 lands strictly inside it.
    const at = p.getView().state.doc.toString().indexOf("XX") + 1;
    p.getView().dispatch({ selection: { anchor: at } });
  }

  it("Ctrl+Enter in ver1 applies ours", () => {
    pane = new DiffPane(container, "a\nXX\nc\n", "a\nYY\nc\n");
    caretInVer1(pane);
    key({ key: "Enter", ctrlKey: true });
    expect(pane.remainingDiffChunkCount()).toBe(0);
    expect(pane.getResolved().base).toBe("a\nXX\nc\n");
  });

  it("Ctrl+Backspace in ver1 removes ours (keeps theirs)", () => {
    pane = new DiffPane(container, "a\nXX\nc\n", "a\nYY\nc\n");
    caretInVer1(pane);
    key({ key: "Backspace", ctrlKey: true });
    expect(pane.remainingDiffChunkCount()).toBe(0);
    expect(pane.getResolved().base).toBe("a\nYY\nc\n"); // theirs kept
  });

  it("hotkey is inert when the caret is in normal-space", () => {
    pane = new DiffPane(container, "a\nXX\nc\n", "a\nYY\nc\n");
    pane.getView().dispatch({ selection: { anchor: 0 } }); // normal "a\n"
    key({ key: "Enter", ctrlKey: true });
    expect(pane.remainingDiffChunkCount()).toBe(1); // unchanged
  });

  it("[join] hotkey is md-only — inert for non-markdown", () => {
    pane = new DiffPane(container, "a\nXX\nc\n", "a\nYY\nc\n", {
      isMarkdown: false,
    });
    caretInVer1(pane);
    key({ key: ".", ctrlKey: true, shiftKey: true });
    expect(pane.remainingDiffChunkCount()).toBe(1); // not resolved
  });
});
