// @vitest-environment happy-dom
//
// DiffPane Phase 3 action-handling tests. Verifies that chunk-level
// apply/remove/etc, plus bulk resolveAll, mutate the doc + the
// decoration state correctly so the post-action view is consistent.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiffPane } from "../../src/diff2/diff-pane";

describe("DiffPane Phase 3 actions", () => {
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

  describe("applyToChunk", () => {
    it("ours: replaces chunk range with ours-lines, drops markers", () => {
      pane = new DiffPane(
        container,
        "common1\nours-line\ncommon2\n",
        "common1\ntheirs-line\ncommon2\n",
      );
      pane.getView().requestMeasure();
      // Pre-state: 1 diff chunk → 3 markers (top, middle, bottom).
      expect(container.querySelectorAll(".diff2-marker").length).toBe(3);
      expect(pane.remainingDiffChunkCount()).toBe(1);

      pane.applyToChunk(1, "ours");
      pane.getView().requestMeasure();

      expect(pane.getDocText()).toBe("common1\nours-line\ncommon2");
      expect(pane.remainingDiffChunkCount()).toBe(0);
      // Markers gone — the resolved chunk is now a common chunk.
      expect(container.querySelectorAll(".diff2-marker").length).toBe(0);
    });

    it("theirs: replaces chunk range with theirs-lines", () => {
      pane = new DiffPane(container, "common\nours\ncommon2\n", "common\ntheirs\ncommon2\n");
      pane.applyToChunk(1, "theirs");
      expect(pane.getDocText()).toBe("common\ntheirs\ncommon2");
    });

    it("both: emits ours + blank + theirs", () => {
      pane = new DiffPane(container, "x\nours\ny\n", "x\ntheirs\ny\n");
      pane.applyToChunk(1, "both");
      expect(pane.getDocText()).toBe("x\nours\n\ntheirs\ny");
    });

    it("neither: chunk collapses to empty", () => {
      pane = new DiffPane(container, "x\nours\ny\n", "x\ntheirs\ny\n");
      pane.applyToChunk(1, "neither");
      // Common-x + empty resolved + common-y → "x\n\ny" because
      // the resolved chunk is a zero-line common entry; join("\n")
      // between two common runs (x and y) still inserts one "\n".
      // Resolved-empty chunk contributes nothing → "x\ny" expected.
      expect(pane.getDocText()).toBe("x\ny");
    });

    it("ignores out-of-range chunk indexes silently", () => {
      pane = new DiffPane(container, "a\n", "b\n");
      const before = pane.getDocText();
      pane.applyToChunk(99, "ours");
      expect(pane.getDocText()).toBe(before);
    });

    it("ignores actions on already-resolved (common) chunks", () => {
      pane = new DiffPane(container, "common\n", "common\n");
      // Only common chunk, no diffs.
      pane.applyToChunk(0, "ours");
      expect(pane.getDocText()).toBe("common");
    });
  });

  describe("join action (markdown)", () => {
    it("inserts blockquote callout from joinContext", () => {
      pane = new DiffPane(container, "x\nours-line\ny\n", "x\ntheirs-line\ny\n", {
        isMarkdown: true,
        joinContext: {
          remoteDeviceLabel: "Phone",
          timestamp: "2026-05-26T10-30-00Z",
        },
      });
      pane.applyToChunk(1, "join");
      const text = pane.getDocText();
      expect(text).toContain("ours-line");
      expect(text).toContain(
        "> Changes from `Phone` at `2026-05-26T10-30-00Z`:",
      );
      expect(text).toContain("> theirs-line");
    });
  });

  describe("resolveAll (bulk)", () => {
    it("ours: every diff chunk becomes ours-lines in one dispatch", () => {
      pane = new DiffPane(
        container,
        "c1\noA\nc2\noB\nc3\n",
        "c1\ntA\nc2\ntB\nc3\n",
      );
      expect(pane.remainingDiffChunkCount()).toBe(2);
      pane.resolveAll("ours");
      expect(pane.getDocText()).toBe("c1\noA\nc2\noB\nc3");
      expect(pane.remainingDiffChunkCount()).toBe(0);
    });

    it("theirs: every diff chunk becomes theirs-lines", () => {
      pane = new DiffPane(
        container,
        "c1\noA\nc2\noB\nc3\n",
        "c1\ntA\nc2\ntB\nc3\n",
      );
      pane.resolveAll("theirs");
      expect(pane.getDocText()).toBe("c1\ntA\nc2\ntB\nc3");
    });
  });

  describe("marker action buttons", () => {
    it("top apply button dispatches 'ours' to applyToChunk", () => {
      pane = new DiffPane(container, "x\nours\ny\n", "x\ntheirs\ny\n");
      pane.getView().requestMeasure();
      const topBtn = container.querySelector(
        ".diff2-marker-top .diff2-marker-btn-ours",
      ) as HTMLButtonElement;
      expect(topBtn).toBeTruthy();
      topBtn.click();
      expect(pane.getDocText()).toBe("x\nours\ny");
    });

    it("bottom apply button dispatches 'theirs'", () => {
      pane = new DiffPane(container, "x\nours\ny\n", "x\ntheirs\ny\n");
      pane.getView().requestMeasure();
      const bottomBtn = container.querySelector(
        ".diff2-marker-bottom .diff2-marker-btn-theirs",
      ) as HTMLButtonElement;
      expect(bottomBtn).toBeTruthy();
      bottomBtn.click();
      expect(pane.getDocText()).toBe("x\ntheirs\ny");
    });

    it("middle [apply both] button merges ours + theirs", () => {
      pane = new DiffPane(container, "x\nours\ny\n", "x\ntheirs\ny\n");
      pane.getView().requestMeasure();
      const bothBtn = container.querySelector(
        ".diff2-marker-middle .diff2-marker-btn-both",
      ) as HTMLButtonElement;
      expect(bothBtn).toBeTruthy();
      bothBtn.click();
      expect(pane.getDocText()).toBe("x\nours\n\ntheirs\ny");
    });

    it("middle [remove both] button drops both sides", () => {
      pane = new DiffPane(container, "x\nours\ny\n", "x\ntheirs\ny\n");
      pane.getView().requestMeasure();
      const neitherBtn = container.querySelector(
        ".diff2-marker-middle .diff2-marker-btn-neither",
      ) as HTMLButtonElement;
      neitherBtn.click();
      expect(pane.getDocText()).toBe("x\ny");
    });

    it("[join] button is hidden for non-markdown files", () => {
      pane = new DiffPane(container, "a\n", "b\n", { isMarkdown: false });
      pane.getView().requestMeasure();
      const joinBtn = container.querySelector(
        ".diff2-marker-middle .diff2-marker-btn-join",
      );
      expect(joinBtn).toBeNull();
    });

    it("[join] button is present for markdown files", () => {
      pane = new DiffPane(container, "a\n", "b\n", {
        isMarkdown: true,
        joinContext: { remoteDeviceLabel: "X", timestamp: "T" },
      });
      pane.getView().requestMeasure();
      const joinBtn = container.querySelector(
        ".diff2-marker-middle .diff2-marker-btn-join",
      );
      expect(joinBtn).not.toBeNull();
    });
  });

  describe("multi-chunk resolution", () => {
    it("indexes remain valid as earlier chunks are resolved", () => {
      // Two diff chunks. Resolve the first via applyToChunk(1, "ours").
      // The remaining diff chunk should now be at index 3 (after
      // common-c1, resolved-as-common, common-c2). Resolve it via
      // applyToChunk(3, "theirs"). Doc should reflect both choices.
      pane = new DiffPane(
        container,
        "c1\noA\nc2\noB\nc3\n",
        "c1\ntA\nc2\ntB\nc3\n",
      );
      pane.applyToChunk(1, "ours"); // first diff → ours
      pane.applyToChunk(3, "theirs"); // second diff → theirs
      expect(pane.getDocText()).toBe("c1\noA\nc2\ntB\nc3");
      expect(pane.remainingDiffChunkCount()).toBe(0);
    });
  });
});
