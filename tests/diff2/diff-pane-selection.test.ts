// @vitest-environment happy-dom
//
// W3 — DiffPane.onSelectionChange feed (the cursor-timer's nav signal, §2.9).
// A PURE caret move (selectionSet && !docChanged) fires it, but ONLY while
// recording is enabled — so a restore-time setCursor (always BEFORE
// enableRecording in the owner) never triggers a spurious cursor flush. Doc
// edits route through onRecord, not this feed.

import { afterEach, describe, expect, it } from "vitest";
import { DiffPane } from "../../src/diff2/diff-pane";

const containers: HTMLElement[] = [];
function mount(): HTMLElement {
  const c = document.createElement("div");
  document.body.appendChild(c);
  containers.push(c);
  return c;
}
afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
});

describe("DiffPane.onSelectionChange — W3 cursor feed", () => {
  it("silent before enableRecording; fires on a pure caret move after", () => {
    const moves: Array<{ anchor: number; head: number; scrollTop: number }> = [];
    const pane = new DiffPane(mount(), "a\nMINE\nc\n", "a\nTHEIRS\nc\n", {
      onSelectionChange: (anchor, head, scrollTop) =>
        moves.push({ anchor, head, scrollTop }),
    });
    const view = pane.getView();

    // Before recording (the construct/replay/setCursor window): no fire.
    view.dispatch({ selection: { anchor: 1, head: 1 } });
    expect(moves).toHaveLength(0);

    pane.enableRecording();

    // A pure caret move now fires the feed (selectionSet && !docChanged). The
    // exact landing offset is selectionRules' business; we assert it fired with
    // numeric coordinates.
    view.dispatch({ selection: { anchor: 2, head: 2 } });
    expect(moves).toHaveLength(1);
    expect(typeof moves[0].anchor).toBe("number");
    expect(typeof moves[0].scrollTop).toBe("number");

    pane.destroy();
  });

  it("is inert when no onSelectionChange is supplied", () => {
    const pane = new DiffPane(mount(), "a\nM\nc\n", "a\nT\nc\n", {});
    pane.enableRecording();
    // Must not throw with the callback absent.
    expect(() =>
      pane.getView().dispatch({ selection: { anchor: 1, head: 1 } }),
    ).not.toThrow();
    pane.destroy();
  });
});
