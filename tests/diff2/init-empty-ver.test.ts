// @vitest-environment happy-dom
//
// §1.8.a init activation — when the document STARTS with an empty ver-block
// (a `\1<ver2>` diff: empty ver1 at [0,0]), opening the pane must activate it
// so it expands and the initial caret (0) visibly lands inside, instead of
// sitting at a zero-width invisible spot.

import { describe, it, expect, afterEach } from "vitest";
import { DiffPane, initialEmptyVerAt0 } from "../../src/diff2/diff-pane";
import { diffPaneStateField, type BuildOpts } from "../../src/diff2/decorations";
import type { Segment } from "../../src/diff2/editor-model";

const OPTS: BuildOpts = { oursLabel: "l", theirsLabel: "r", isMarkdown: true, callbacks: {} as never };

const seg = (role: Segment["role"], group: number, from: number, to: number): Segment => ({ role, group, from, to });

describe("initialEmptyVerAt0 (unit)", () => {
  it("leading empty ver1 [0,0] → activates it", () => {
    const st = [seg("ver1", 0, 0, 0), seg("ver2", 0, 0, 6), seg("normal", -1, 6, 13)];
    expect(initialEmptyVerAt0(st)).toEqual({ role: "ver1", group: 0 });
  });
  it("leading NORMAL → null", () => {
    const st = [seg("normal", -1, 0, 5), seg("ver1", 0, 5, 7), seg("ver2", 0, 7, 9)];
    expect(initialEmptyVerAt0(st)).toBeNull();
  });
  it("leading NON-empty ver1 → null (real caret in its content, no activation)", () => {
    const st = [seg("ver1", 0, 0, 2), seg("ver2", 0, 2, 4), seg("normal", -1, 4, 6)];
    expect(initialEmptyVerAt0(st)).toBeNull();
  });
});

describe("DiffPane init: leading empty ver1 is activated on open", () => {
  let pane: DiffPane | null = null;
  afterEach(() => {
    pane?.destroy();
    pane = null;
  });

  it("ours empty at start → empty ver1 activated + caret at 0 inside it", () => {
    // ours has no first line; theirs adds "ADDED" → empty ver1, ver2="ADDED\n".
    pane = mountInBody("common\n", "ADDED\ncommon\n");
    const f = pane.getView().state.field(diffPaneStateField)!;
    expect(f.structure[0]).toMatchObject({ role: "ver1", from: 0, to: 0 }); // empty leading ver1
    expect(f.activeEmptyVer).toEqual({ role: "ver1", group: 0 });
    expect(pane.getView().state.selection.main.head).toBe(0);
  });

  it("conflict NOT at the start → no init activation", () => {
    pane = mountInBody("a\nb\n", "a\nX\nb\n"); // group is on line 1, not line 0
    const f = pane.getView().state.field(diffPaneStateField)!;
    expect(f.activeEmptyVer).toBeNull();
  });

  it("leading NON-empty ver1 → no expand needed; caret 0,0 IS in ver1, typing grows ver1 (base only)", () => {
    pane = mountInBody("A\nc\n", "X\nc\n"); // ver1="A\n" non-empty, ver2="X\n"
    const v = pane.getView();
    const f = v.state.field(diffPaneStateField)!;
    expect(f.activeEmptyVer).toBeNull(); // non-empty needs no expand-widget
    expect(v.state.selection.main.head).toBe(0); // caret at 0,0 = ver1's 0,0 = editor 0,0
    // The user's rule "ver1 is active on init, whatever's in it": typing at the
    // init caret goes into ver1 (base side) ONLY — not both files.
    v.dispatch({ changes: { from: v.state.selection.main.head, insert: "Z" } });
    const r = pane.getResolved();
    expect(r.base).toBe("ZA\nc\n"); // grew ver1
    expect(r.sibling).toBe("X\nc\n"); // sibling untouched
  });
});

let lastContainer: HTMLElement | null = null;
function mountInBody(base: string, sibling: string): DiffPane {
  lastContainer?.remove();
  lastContainer = document.createElement("div");
  document.body.appendChild(lastContainer);
  return new DiffPane(lastContainer, base, sibling, OPTS);
}
