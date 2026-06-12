// @vitest-environment happy-dom
//
// Phase 3 — V2 DiffPane view assembly. State-level: the decorations field
// assembles markers + ver-line classes from the decision functions. Mount-level
// (happy-dom): the extension bundle composes + renders without error and applies
// the classes to the DOM. (Real geometry — height:0=0px, marker non-stealing,
// nav — is the 1a Chromium gate; happy-dom has no layout.)

import { describe, expect, it } from "vitest";
import { createDiffPaneState, decorationsField, mountDiffPaneV2 } from "../../src/diff2/diff-pane-v2";

interface Deco {
  from: number;
  isWidget: boolean;
  cls?: string;
  kind?: string;
}

function readDecos(state: ReturnType<typeof createDiffPaneState>): Deco[] {
  const set = state.field(decorationsField);
  const out: Deco[] = [];
  const it = set.iter();
  while (it.value) {
    const spec = it.value.spec as { class?: string; widget?: { kind?: string } };
    out.push({ from: it.from, isWidget: !!spec.widget, cls: spec.class, kind: spec.widget?.kind });
    it.next();
  }
  return out;
}

describe("diff-pane-v2 — decorations field assembly", () => {
  // base "a\nL1\nb\n" vs "a\nR1\nb\n" ⇒ doc "a\nL1\n\nR1\n\nb\n"
  //   line2 "L1" ver1 content, line3 "" ver1 terminal, line4 "R1" ver2 content,
  //   line5 "" ver2 terminal, line6 "b" normal.
  const state = createDiffPaneState("a\nL1\nb\n", "a\nR1\nb\n");

  it("emits open/mid/close marker widgets for the group", () => {
    const widgets = readDecos(state).filter((d) => d.isWidget);
    expect(widgets.map((w) => w.kind).sort()).toEqual(["close", "mid", "open"]);
  });

  it("ver content lines get colour + glyph; terminal lines get collapse, no glyph", () => {
    const lines = readDecos(state).filter((d) => !d.isWidget && d.cls);
    const byFrom = Object.fromEntries(lines.map((l) => [l.from, l.cls]));
    // offsets: L1 line.from=2, ver1 terminal line.from=5, R1 line.from=6, ver2 terminal line.from=9
    expect(byFrom[2]).toContain("diff2-v1");
    expect(byFrom[2]).toContain("diff2-eol-glyph");
    expect(byFrom[2]).not.toContain("diff2-collapsed");
    expect(byFrom[5]).toContain("diff2-v1");
    expect(byFrom[5]).toContain("diff2-collapsed");
    expect(byFrom[5]).not.toContain("diff2-eol-glyph");
    expect(byFrom[6]).toContain("diff2-v2");
    expect(byFrom[9]).toContain("diff2-collapsed");
  });

  it("focusing an empty ver-block (caret on it) un-collapses that line", () => {
    // delete-vs-modify ⇒ empty ver1. With caret on it, its terminal line is not collapsed.
    const s0 = createDiffPaneState("a\nb\n", "a\nX\nb\n");
    const emptyFrom = 2; // doc "a\n\nX\n\nb\n": ver1 terminal \n at index 2
    const focused = s0.update({ selection: { anchor: emptyFrom } }).state;
    const line2 = readDecos(focused).find((d) => !d.isWidget && d.from === emptyFrom)!;
    expect(line2.cls).not.toContain("diff2-collapsed");
    const line2unfocused = readDecos(s0).find((d) => !d.isWidget && d.from === emptyFrom)!;
    expect(line2unfocused.cls).toContain("diff2-collapsed");
  });
});

describe("diff-pane-v2 — mounts without error (happy-dom)", () => {
  it("renders the doc + applies ver classes + marker elements to the DOM", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = mountDiffPaneV2(parent, "a\nL1\nb\n", "a\nR1\nb\n");
    try {
      expect(view.state.doc.toString()).toBe("a\nL1\n\nR1\n\nb\n");
      expect(view.dom.querySelectorAll(".diff2-marker").length).toBe(3);
      expect(view.dom.querySelectorAll(".cm-line.diff2-v1").length).toBeGreaterThanOrEqual(1);
      expect(view.dom.querySelectorAll(".cm-line.diff2-v2").length).toBeGreaterThanOrEqual(1);
      expect(view.dom.querySelectorAll(".cm-line.diff2-collapsed").length).toBeGreaterThanOrEqual(2);
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});
