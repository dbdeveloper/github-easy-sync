// @vitest-environment happy-dom
//
// §1.3 edit-time hardening (review follow-up — the runtime sentinelGuard was
// untested): a transaction that would insert a \0 / \1 sentinel into the doc
// is dropped, so the commit-time split() can never receive one. (Session-start
// collision is covered by build-split-roundtrip's findSentinelCollision tests.)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiffPane } from "../../src/diff2/diff-pane";
import { LINE_TERMINATOR, VER_SEPARATOR } from "../../src/diff2/joined-doc";

describe("§1.3 sentinelGuard (edit-time)", () => {
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

  it("drops an edit that inserts \\1 (VER_SEPARATOR)", () => {
    pane = new DiffPane(container, "a\nb\nc\n", "a\nX\nc\n");
    const view = pane.getView();
    const before = view.state.doc.toString();
    view.dispatch({ changes: { from: 0, insert: `q${VER_SEPARATOR}r` } });
    // transaction rejected → doc unchanged, no sentinel reaches the buffer.
    expect(view.state.doc.toString()).toBe(before);
    expect(view.state.doc.toString().includes(VER_SEPARATOR)).toBe(false);
  });

  it("drops an edit that inserts \\0 (LINE_TERMINATOR)", () => {
    pane = new DiffPane(container, "a\nb\nc\n", "a\nX\nc\n");
    const view = pane.getView();
    const before = view.state.doc.toString();
    view.dispatch({ changes: { from: 0, insert: `q${LINE_TERMINATOR}` } });
    expect(view.state.doc.toString()).toBe(before);
  });

  it("allows an ordinary insert", () => {
    pane = new DiffPane(container, "a\nb\nc\n", "a\nX\nc\n");
    const view = pane.getView();
    view.dispatch({ changes: { from: 0, insert: "HELLO " } });
    expect(view.state.doc.toString().startsWith("HELLO ")).toBe(true);
    // and split stays sentinel-free / sound.
    expect(pane.getResolved().base.includes(VER_SEPARATOR)).toBe(false);
  });
});
