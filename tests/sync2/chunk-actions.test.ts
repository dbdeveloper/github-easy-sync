import { describe, it, expect } from "vitest";
import { applyAction } from "../../src/sync2/views/chunk-actions";

// Pure-logic unit tests for the chunk-action transform. The CM6
// widget rendering is DOM-side and not testable here without jsdom;
// applyAction is the part that decides what to write into both
// panes for each user click.

describe("applyAction — theirs (use GitHub-side text)", () => {
  it("both panes converge on theirs's chunk", () => {
    expect(applyAction("theirs", "ours-line\n", "theirs-line\n")).toEqual({
      aText: "theirs-line\n",
      bText: "theirs-line\n",
    });
  });

  it("works when ours-side chunk is empty (theirs-only insertion)", () => {
    // CM6 represents an insertion in `b` (theirs) as a chunk where
    // fromA === toA on the `a` side, so oursText slices to "".
    expect(applyAction("theirs", "", "incoming\n")).toEqual({
      aText: "incoming\n",
      bText: "incoming\n",
    });
  });
});

describe("applyAction — ours (keep my Obsidian-side text)", () => {
  it("both panes converge on ours's chunk", () => {
    expect(applyAction("ours", "my-line\n", "their-line\n")).toEqual({
      aText: "my-line\n",
      bText: "my-line\n",
    });
  });

  it("works when theirs-side chunk is empty (ours-only insertion)", () => {
    expect(applyAction("ours", "my-only-line\n", "")).toEqual({
      aText: "my-only-line\n",
      bText: "my-only-line\n",
    });
  });
});

describe("applyAction — both (markdown blockquote injection)", () => {
  it("appends > -prefixed theirs after ours, single line each", () => {
    expect(applyAction("both", "ours-line", "theirs-line")).toEqual({
      aText: "ours-line\n> theirs-line",
      bText: "ours-line\n> theirs-line",
    });
  });

  it("multiline theirs: every line gets > prefix", () => {
    expect(
      applyAction("both", "ours-1\nours-2", "theirs-1\ntheirs-2\ntheirs-3"),
    ).toEqual({
      aText: "ours-1\nours-2\n> theirs-1\n> theirs-2\n> theirs-3",
      bText: "ours-1\nours-2\n> theirs-1\n> theirs-2\n> theirs-3",
    });
  });

  it("blank lines in theirs are preserved as `> ` (space) blockquoted lines", () => {
    expect(
      applyAction("both", "x", "first paragraph\n\nsecond paragraph"),
    ).toEqual({
      aText: "x\n> first paragraph\n> \n> second paragraph",
      bText: "x\n> first paragraph\n> \n> second paragraph",
    });
  });

  it("empty ours: no leading newline before the blockquote", () => {
    // Skip the `\n` separator when ours-side chunk is empty so the
    // result doesn't start with a stray blank line.
    expect(applyAction("both", "", "incoming\n")).toEqual({
      aText: "> incoming\n> ",
      bText: "> incoming\n> ",
    });
  });

  it("returns identical aText and bText (panes always converge)", () => {
    // Invariant: every action produces the SAME content for both
    // panes — that's the whole point of the per-chunk action bar
    // (auto-finalize fires when a and b are byte-equal).
    const out = applyAction("both", "ours\n", "theirs\n");
    expect(out.aText).toBe(out.bText);
  });
});
