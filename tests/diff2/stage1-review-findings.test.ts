// @vitest-environment happy-dom
//
// Stage 1 deep-review findings, encoded as tests FIRST (TDD): each asserts
// the CORRECT post-fix behavior, so they are RED against the current code
// and go GREEN once the Stage 1.h hardening lands. One describe per finding
// (A–E from the review). F (ver2 loss on partial [← back]) is a known
// Stage-2 gap, intentionally not encoded as a bug here.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiffPane } from "../../src/diff2/diff-pane";
import { diffPaneStateField, buildDecorationSet } from "../../src/diff2/decorations";
import {
  baseSiblingToModel,
  fromEditorModel,
  type Segment,
} from "../../src/diff2/editor-model";

describe("Stage 1 review findings (TDD — should be RED before the fix)", () => {
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

  function structure(p: DiffPane): Segment[] {
    return p.getView().state.field(diffPaneStateField, false)!.structure;
  }
  function tiles(p: DiffPane): boolean {
    const s = structure(p);
    const len = p.getView().state.doc.length;
    if (s.length === 0) return len === 0;
    if (s[0].from !== 0) return false;
    for (let i = 1; i < s.length; i++) if (s[i].from !== s[i - 1].to) return false;
    return s[s.length - 1].to === len;
  }

  // ── Finding A — collapseGuard coordinate-space ──────────────────────
  describe("A — auto-collapse coordinate-space", () => {
    it("A1: type-to-match collapse that GROWS the doc must not throw + collapse cleanly", () => {
      // ver1 "ab\n", ver2 "abc\n". Insert "c" inside ver1 → "abc\n" == ver2.
      pane = new DiffPane(container, "x\nab\ny\n", "x\nabc\ny\n");
      const view = pane.getView();
      const at = view.state.doc.toString().indexOf("ab") + 2; // before ver1's \n
      expect(() =>
        view.dispatch({ changes: { from: at, insert: "c" } }),
      ).not.toThrow();
      expect(pane.remainingDiffChunkCount()).toBe(0);
      expect(view.state.doc.toString()).toBe("x\nabc\ny\n");
      expect(pane.getResolved()).toEqual({
        base: "x\nabc\ny\n",
        sibling: "x\nabc\ny\n",
      });
      expect(tiles(pane)).toBe(true);
    });

    it("A2: delete-collapse (both empty) keeps doc in sync with structure", () => {
      // ver1 "b\n", ver2 "" → delete ver1 → both empty → remove group.
      pane = new DiffPane(container, "a\nb\nc\n", "a\nc\n");
      const view = pane.getView();
      const bAt = view.state.doc.toString().indexOf("b");
      view.dispatch({ changes: { from: bAt, to: bAt + 2, insert: "" } });
      // The live doc must equal the collapsed clean doc — no phantom tail.
      expect(view.state.doc.toString()).toBe("a\nc\n");
      expect(tiles(pane)).toBe(true);
      expect(pane.getResolved()).toEqual({ base: "a\nc\n", sibling: "a\nc\n" });
    });

    it("A3: focus-leave normalization that creates ver1==ver2 collapses without throwing", () => {
      // ver1 "ab\n", ver2 "abc\n". Replace ver1 with "abc" (EOL-less),
      // then move caret out → normalize appends \n → ver1 "abc\n" == ver2.
      pane = new DiffPane(container, "x\nab\ny\n", "x\nabc\ny\n");
      const view = pane.getView();
      const s = structure(pane);
      const v1 = s.find((seg) => seg.role === "ver1")!;
      view.dispatch({
        changes: { from: v1.from, to: v1.to, insert: "abc" },
        selection: { anchor: v1.from + 1 },
      });
      // Move caret out of ver1 (focus-leave) — must not throw.
      expect(() => view.dispatch({ selection: { anchor: 0 } })).not.toThrow();
      expect(pane.getResolved().base).toBe("x\nabc\ny\n");
      expect(tiles(pane)).toBe(true);
    });
  });

  // ── Finding B — commit-boundary fail-closed (tiling assertion) ──────
  describe("B — fromEditorModel fails closed on a broken tiling", () => {
    it("throws on a gap in the structure (instead of silently dropping bytes)", () => {
      const model = {
        doc: "abc",
        structure: [
          { role: "normal", group: -1, from: 0, to: 1 },
          { role: "normal", group: -1, from: 2, to: 3 }, // gap [1,2)
        ] as Segment[],
      };
      expect(() => fromEditorModel(model)).toThrow();
    });

    it("throws on overlapping segments", () => {
      const model = {
        doc: "abc",
        structure: [
          { role: "normal", group: -1, from: 0, to: 2 },
          { role: "normal", group: -1, from: 1, to: 3 }, // overlap
        ] as Segment[],
      };
      expect(() => fromEditorModel(model)).toThrow();
    });

    it("accepts a well-formed contiguous tiling", () => {
      const m = baseSiblingToModel("a\nb\nc\n", "a\nX\nc\n");
      expect(() => fromEditorModel(m)).not.toThrow();
    });
  });

  // ── Finding C — EOL-less differing tail: no mid-line block widget ───
  describe("C — EOL-less differing tail render", () => {
    it("places no block widget strictly inside a line (ver1+ver2 share a line)", () => {
      // base "abc", sibling "XYZ" (both EOL-less) → doc "abcXYZ", one line.
      const model = baseSiblingToModel("abc", "XYZ");
      const view = new DiffPane(container, "abc", "XYZ").getView();
      const decoSet = buildDecorationSet(view.state.doc, model.structure, {
        oursLabel: "L",
        theirsLabel: "R",
        isMarkdown: false,
        callbacks: { onAction() {}, onActivateEmptyVer() {} },
      });
      const doc = view.state.doc;
      const cursor = decoSet.iter();
      const offending: number[] = [];
      while (cursor.value) {
        const spec = cursor.value.spec as { block?: boolean };
        if (spec.block) {
          const line = doc.lineAt(cursor.from);
          const atBoundary = cursor.from === line.from || cursor.from === line.to;
          if (!atBoundary) offending.push(cursor.from);
        }
        cursor.next();
      }
      expect(offending).toEqual([]);
      view.destroy();
    });

    it("round-trips an EOL-less differing tail byte-exact", () => {
      const m = baseSiblingToModel("abc", "XYZ");
      expect(fromEditorModel(m)).toBeDefined();
    });
  });

  // ── Finding D — "both" must not merge EOL-less ver1 with ver2 ───────
  describe("D — 'both' inserts a separator when ver1 lacks a trailing newline", () => {
    it("apply-both on an EOL-less group keeps ver1 and ver2 on separate lines", () => {
      pane = new DiffPane(container, "common\nours", "common\ntheirs");
      pane.applyToChunk(0, "both");
      expect(pane.getResolved().base).toBe("common\nours\ntheirs");
    });
  });

  // ── Finding E — commit-boundary normalization (no focus-leave) ──────
  describe("E — getResolvedBase normalizes a deleted trailing newline", () => {
    it("does not merge ver content into the next segment when caret never left", () => {
      // ver1 "ours\n"; delete its \n (caret stays in ver1, never moves out).
      pane = new DiffPane(container, "ours\ncommon\n", "theirs\ncommon\n");
      const view = pane.getView();
      const v1 = structure(pane).find((s) => s.role === "ver1")!;
      view.dispatch({
        changes: { from: v1.to - 1, to: v1.to, insert: "" },
        selection: { anchor: v1.from + 1 }, // caret stays inside ver1
      });
      // [← Back] reads getResolvedBase directly — no selection-move tx fired.
      expect(pane.getResolvedBase()).toBe("ours\ncommon\n");
    });
  });
});
