// @vitest-environment happy-dom
//
// Emptying the whole document (select-all + delete) must commit "\n", not ""
// (review finding #3). A diff2 base/sibling always had content, so a 0-byte
// commit would trip SYNC2 §2.9's zero-byte-restore guard and resurrect the
// old content — silently reverting the user's "clear the file" intent. "\n"
// is the canonical minimal non-empty file (matches sync2 normalizeText).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiffPane } from "../../src/diff2/diff-pane";

describe("empty commit → \\n (SYNC2 §2.9 zero-byte-restore avoidance)", () => {
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

  it("select-all + delete commits \\n on both sides, not an empty string", () => {
    pane = new DiffPane(container, "a\nb\nc\n", "a\nX\nc\n");
    const view = pane.getView();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    expect(view.state.doc.length).toBe(0); // live buffer is empty…
    // …but the committed bytes are "\n", never "".
    expect(pane.getResolvedBase()).toBe("\n");
    expect(pane.getResolved()).toEqual({ base: "\n", sibling: "\n" });
  });

  it("a non-empty resolution is unaffected by the guard", () => {
    pane = new DiffPane(container, "a\nb\nc\n", "a\nb\nc\n"); // identical
    expect(pane.getResolvedBase()).toBe("a\nb\nc\n");
  });
});
