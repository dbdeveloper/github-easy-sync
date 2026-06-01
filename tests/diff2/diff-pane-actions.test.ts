// @vitest-environment happy-dom
//
// DiffPane action-handling tests (Etap 1b.1 model). Chunk-level
// apply/remove/both/neither/join + bulk resolveAll operate on the
// editor-model structure and dispatch a recomputed structure (effect).
// Assertions read getResolved() (the split base/sibling) rather than the
// merged doc — a resolved group is a normal segment, so a fully-resolved
// doc has base === sibling.
//
// `applyToChunk(group, ...)` takes a diff-GROUP id (0-based per group),
// NOT a chunks-array index. "both" = ver1+ver2 with no inserted blank
// line (canonical §1.6 op3).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiffPane } from "../../src/diff2/diff-pane";

describe("DiffPane actions (1b.1 model)", () => {
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
    it("ours: resolves the group to ver1, drops markers", () => {
      pane = new DiffPane(
        container,
        "common1\nours-line\ncommon2\n",
        "common1\ntheirs-line\ncommon2\n",
      );
      pane.getView().requestMeasure();
      expect(container.querySelectorAll(".diff2-marker").length).toBe(3);
      expect(pane.remainingDiffChunkCount()).toBe(1);

      pane.applyToChunk(0, "ours");
      pane.getView().requestMeasure();

      expect(pane.getResolved().base).toBe("common1\nours-line\ncommon2\n");
      expect(pane.getResolved().sibling).toBe("common1\nours-line\ncommon2\n");
      expect(pane.remainingDiffChunkCount()).toBe(0);
      expect(container.querySelectorAll(".diff2-marker").length).toBe(0);
    });

    it("theirs: resolves the group to ver2", () => {
      pane = new DiffPane(
        container,
        "common\nours\ncommon2\n",
        "common\ntheirs\ncommon2\n",
      );
      pane.applyToChunk(0, "theirs");
      expect(pane.getResolved().base).toBe("common\ntheirs\ncommon2\n");
    });

    it("both: ver1 + ver2, no inserted blank (§1.6 op3)", () => {
      pane = new DiffPane(container, "x\nours\ny\n", "x\ntheirs\ny\n");
      pane.applyToChunk(0, "both");
      expect(pane.getResolved().base).toBe("x\nours\ntheirs\ny\n");
    });

    it("neither: group collapses, surrounding lines abut", () => {
      pane = new DiffPane(container, "x\nours\ny\n", "x\ntheirs\ny\n");
      pane.applyToChunk(0, "neither");
      expect(pane.getResolved().base).toBe("x\ny\n");
    });

    it("ignores out-of-range group ids silently", () => {
      pane = new DiffPane(container, "a\n", "b\n");
      const before = pane.getResolved();
      pane.applyToChunk(99, "ours");
      expect(pane.getResolved()).toEqual(before);
    });

    it("ignores actions when there is no diff group", () => {
      pane = new DiffPane(container, "common\n", "common\n");
      pane.applyToChunk(0, "ours");
      expect(pane.getResolved().base).toBe("common\n");
    });
  });

  describe("join action (markdown)", () => {
    it("inserts blockquote callout from joinContext", () => {
      pane = new DiffPane(
        container,
        "x\nours-line\ny\n",
        "x\ntheirs-line\ny\n",
        {
          isMarkdown: true,
          joinContext: {
            remoteDeviceLabel: "Phone",
            timestamp: "2026-05-26T10-30-00Z",
          },
        },
      );
      pane.applyToChunk(0, "join");
      const base = pane.getResolved().base;
      expect(base).toContain("ours-line");
      expect(base).toContain(
        "> Changes from `Phone` at `2026-05-26T10-30-00Z`:",
      );
      expect(base).toContain("> theirs-line");
    });
  });

  describe("resolveAll (bulk)", () => {
    it("ours: every group becomes ver1 in one dispatch", () => {
      pane = new DiffPane(
        container,
        "c1\noA\nc2\noB\nc3\n",
        "c1\ntA\nc2\ntB\nc3\n",
      );
      expect(pane.remainingDiffChunkCount()).toBe(2);
      pane.resolveAll("ours");
      expect(pane.getResolved().base).toBe("c1\noA\nc2\noB\nc3\n");
      expect(pane.remainingDiffChunkCount()).toBe(0);
    });

    it("theirs: every group becomes ver2", () => {
      pane = new DiffPane(
        container,
        "c1\noA\nc2\noB\nc3\n",
        "c1\ntA\nc2\ntB\nc3\n",
      );
      pane.resolveAll("theirs");
      expect(pane.getResolved().base).toBe("c1\ntA\nc2\ntB\nc3\n");
    });
  });

  describe("marker action buttons", () => {
    it("top apply button → ver1", () => {
      pane = new DiffPane(container, "x\nours\ny\n", "x\ntheirs\ny\n");
      pane.getView().requestMeasure();
      const btn = container.querySelector(
        ".diff2-marker-top .diff2-marker-btn-ours",
      ) as HTMLButtonElement;
      expect(btn).toBeTruthy();
      btn.click();
      expect(pane.getResolved().base).toBe("x\nours\ny\n");
    });

    it("bottom apply button → ver2", () => {
      pane = new DiffPane(container, "x\nours\ny\n", "x\ntheirs\ny\n");
      pane.getView().requestMeasure();
      const btn = container.querySelector(
        ".diff2-marker-bottom .diff2-marker-btn-theirs",
      ) as HTMLButtonElement;
      expect(btn).toBeTruthy();
      btn.click();
      expect(pane.getResolved().base).toBe("x\ntheirs\ny\n");
    });

    it("middle [apply both] → ver1 + ver2", () => {
      pane = new DiffPane(container, "x\nours\ny\n", "x\ntheirs\ny\n");
      pane.getView().requestMeasure();
      const btn = container.querySelector(
        ".diff2-marker-middle .diff2-marker-btn-both",
      ) as HTMLButtonElement;
      expect(btn).toBeTruthy();
      btn.click();
      expect(pane.getResolved().base).toBe("x\nours\ntheirs\ny\n");
    });

    it("middle [remove both] → drops the group", () => {
      pane = new DiffPane(container, "x\nours\ny\n", "x\ntheirs\ny\n");
      pane.getView().requestMeasure();
      const btn = container.querySelector(
        ".diff2-marker-middle .diff2-marker-btn-neither",
      ) as HTMLButtonElement;
      btn.click();
      expect(pane.getResolved().base).toBe("x\ny\n");
    });

    it("[join] button hidden for non-markdown", () => {
      pane = new DiffPane(container, "a\n", "b\n", { isMarkdown: false });
      pane.getView().requestMeasure();
      expect(
        container.querySelector(".diff2-marker-middle .diff2-marker-btn-join"),
      ).toBeNull();
    });

    it("[join] button present for markdown", () => {
      pane = new DiffPane(container, "a\n", "b\n", {
        isMarkdown: true,
        joinContext: { remoteDeviceLabel: "X", timestamp: "T" },
      });
      pane.getView().requestMeasure();
      expect(
        container.querySelector(".diff2-marker-middle .diff2-marker-btn-join"),
      ).not.toBeNull();
    });
  });

  describe("multi-group resolution", () => {
    it("group ids stay valid as earlier groups resolve", () => {
      pane = new DiffPane(
        container,
        "c1\noA\nc2\noB\nc3\n",
        "c1\ntA\nc2\ntB\nc3\n",
      );
      pane.applyToChunk(0, "ours"); // first group → ver1
      pane.applyToChunk(1, "theirs"); // second group → ver2
      expect(pane.getResolved().base).toBe("c1\noA\nc2\ntB\nc3\n");
      expect(pane.remainingDiffChunkCount()).toBe(0);
    });
  });
});
