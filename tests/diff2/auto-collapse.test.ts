// @vitest-environment happy-dom
//
// §1.6 auto-collapse: a free edit that makes a diff group's ver1 === ver2
// byte-exact collapses it in the SAME transaction (both-empty → remove;
// same non-empty → apply ver1). Collapse is synchronous within the one
// dispatch (proxy for the §1.6.a.3 single-Ctrl+Z requirement; history
// itself lands in Phase 5).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiffPane } from "../../src/diff2/diff-pane";
import { diffPaneStateField } from "../../src/diff2/decorations";

describe("§1.6 auto-collapse on ver1 === ver2", () => {
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

  function structure(p: DiffPane) {
    return p.getView().state.field(diffPaneStateField, false)!.structure;
  }
  function seg(p: DiffPane, role: string) {
    return structure(p).find((s) => s.role === role)!;
  }

  it("(c) same non-empty content → apply ver1 (group → normal)", () => {
    // ver1 "yXy\n", ver2 "yZy\n"; change the Z to X → equal → collapse.
    pane = new DiffPane(container, "a\nyXy\nc\n", "a\nyZy\nc\n");
    expect(pane.remainingDiffChunkCount()).toBe(1);
    const z = pane.getView().state.doc.toString().indexOf("Z");
    pane.getView().dispatch({ changes: { from: z, to: z + 1, insert: "X" } });

    expect(pane.remainingDiffChunkCount()).toBe(0); // collapsed synchronously
    expect(pane.getResolved()).toEqual({
      base: "a\nyXy\nc\n",
      sibling: "a\nyXy\nc\n",
    });
  });

  it("(d) editing ver1 to match ver2 collapses too", () => {
    pane = new DiffPane(container, "a\nyZy\nc\n", "a\nyXy\nc\n");
    const z = pane.getView().state.doc.toString().indexOf("Z");
    pane.getView().dispatch({ changes: { from: z, to: z + 1, insert: "X" } });
    expect(pane.remainingDiffChunkCount()).toBe(0);
    expect(pane.getResolved().base).toBe("a\nyXy\nc\n");
  });

  it("(a) both empty → remove (diff-line disappears)", () => {
    // ver1 "b\n", ver2 "" (sibling-only delete). Delete ver1 → both empty.
    pane = new DiffPane(container, "a\nb\nc\n", "a\nc\n");
    expect(pane.remainingDiffChunkCount()).toBe(1);
    const v1 = seg(pane, "ver1");
    pane.getView().dispatch({ changes: { from: v1.from, to: v1.to, insert: "" } });

    expect(pane.remainingDiffChunkCount()).toBe(0);
    expect(pane.getResolved()).toEqual({ base: "a\nc\n", sibling: "a\nc\n" });
  });

  it("(b) symmetric: empty ver1, delete ver2 → both empty → remove", () => {
    pane = new DiffPane(container, "a\nc\n", "a\nb\nc\n");
    const v2 = seg(pane, "ver2");
    pane.getView().dispatch({ changes: { from: v2.from, to: v2.to, insert: "" } });
    expect(pane.remainingDiffChunkCount()).toBe(0);
    expect(pane.getResolved()).toEqual({ base: "a\nc\n", sibling: "a\nc\n" });
  });

  it("does NOT collapse while the vers still differ", () => {
    pane = new DiffPane(container, "a\nyXy\nc\n", "a\nyZy\nc\n");
    const z = pane.getView().state.doc.toString().indexOf("Z");
    // change Z → Q: still differs from ver1's X.
    pane.getView().dispatch({ changes: { from: z, to: z + 1, insert: "Q" } });
    expect(pane.remainingDiffChunkCount()).toBe(1);
    expect(pane.getResolved()).toEqual({
      base: "a\nyXy\nc\n",
      sibling: "a\nyQy\nc\n",
    });
  });

  it("only the equal group collapses; others remain", () => {
    // Two groups: g0 (X/Z), g1 (m/n). Collapse only g0.
    pane = new DiffPane(
      container,
      "a\nyXy\nc\nm\ne\n",
      "a\nyZy\nc\nn\ne\n",
    );
    expect(pane.remainingDiffChunkCount()).toBe(2);
    const z = pane.getView().state.doc.toString().indexOf("Z");
    pane.getView().dispatch({ changes: { from: z, to: z + 1, insert: "X" } });
    expect(pane.remainingDiffChunkCount()).toBe(1); // g1 still a conflict
    expect(pane.getResolved()).toEqual({
      base: "a\nyXy\nc\nm\ne\n",
      sibling: "a\nyXy\nc\nn\ne\n",
    });
  });
});
