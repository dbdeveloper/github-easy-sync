import { describe, it, expect } from "vitest";
import {
  availableChoices,
  type ConflictPromptArgs,
} from "../../src/sync2/views/conflict-modal";

// availableChoices is the pure decision function behind the modal —
// it answers "given this file's type and the batch position, which
// buttons should be on the modal?". DOM rendering is not unit-tested
// (jsdom isn't in the test setup); the rendering layer just calls
// this function and produces the matching widgets.

function args(o: Partial<ConflictPromptArgs> = {}): ConflictPromptArgs {
  return {
    path: "Notes/x.md",
    index: 1,
    total: 1,
    isMarkdown: true,
    ...o,
  };
}

describe("availableChoices", () => {
  it("single markdown conflict: resolve-now + later + merge-into-one (no defer-all)", () => {
    expect(availableChoices(args())).toEqual([
      "resolve-now",
      "later",
      "merge-into-one",
    ]);
  });

  it("single non-markdown conflict: hides merge-into-one (config files don't survive callouts)", () => {
    expect(availableChoices(args({ path: "data.json", isMarkdown: false }))).toEqual([
      "resolve-now",
      "later",
    ]);
  });

  it("first of many markdown conflicts: includes defer-all", () => {
    expect(availableChoices(args({ index: 1, total: 5 }))).toEqual([
      "resolve-now",
      "later",
      "merge-into-one",
      "defer-all",
    ]);
  });

  it("first of many non-markdown conflicts: defer-all but no merge-into-one", () => {
    expect(
      availableChoices(args({ isMarkdown: false, index: 1, total: 5 })),
    ).toEqual(["resolve-now", "later", "defer-all"]);
  });

  it("last conflict in batch (index === total): no defer-all", () => {
    // Nothing more to defer when this is the last file — defer-all
    // would be identical to "later" so we omit it.
    expect(availableChoices(args({ index: 5, total: 5 }))).toEqual([
      "resolve-now",
      "later",
      "merge-into-one",
    ]);
  });

  it("middle conflict: defer-all available (more files come after)", () => {
    expect(availableChoices(args({ index: 3, total: 5 }))).toEqual([
      "resolve-now",
      "later",
      "merge-into-one",
      "defer-all",
    ]);
  });

  it("merge-into-one for plain text without extension is OFF (only .md is markdown)", () => {
    // The caller decides isMarkdown based on hasMarkdownExtension or
    // similar — bare files (LICENSE, README without ext) get the
    // non-markdown path.
    expect(availableChoices(args({ isMarkdown: false }))).not.toContain(
      "merge-into-one",
    );
  });
});
