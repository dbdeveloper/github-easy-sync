// Phase 3 — V2 editing-behaviour filters (§2.2.4(2) auto-\n, §2.2.5(1) guard).
// Pure decisions + dispatch-level (the filters in the real createDiffPaneState
// pipeline): typing into a ver-block restores the trailing \n; deleting a
// group-preceding separator \n is blocked.

import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { splitModel } from "../../src/diff2/diff-model";
import { readStructure } from "../../src/diff2/diff-structure";
import { autoNewlineInserts, externalGuardOk } from "../../src/diff2/diff-edits";
import { createDiffPaneState } from "../../src/diff2/diff-pane-v2";

describe("diff-edits — autoNewlineInserts (§2.2.4(2))", () => {
  it("inserts \\n before the terminal when content lost its trailing \\n", () => {
    // block "w\n": content "w" (no \n) + terminal "\n" → range [0,2)
    const doc = Text.of(["w", ""]); // "w\n"
    expect(autoNewlineInserts(doc, [{ from: 0, to: 2, ver: 1, group: 0 }])).toEqual([
      { from: 1, insert: "\n" },
    ]);
  });
  it("no insert when content already ends with \\n (valid '.*\\n\\n')", () => {
    const doc = Text.of(["w", "", ""]); // "w\n\n"
    expect(autoNewlineInserts(doc, [{ from: 0, to: 3, ver: 1, group: 0 }])).toEqual([]);
  });
  it("no insert for an empty ver-block (width-1 '\\n')", () => {
    const doc = Text.of(["", ""]); // "\n"
    expect(autoNewlineInserts(doc, [{ from: 0, to: 1, ver: 1, group: 0 }])).toEqual([]);
  });

  it("§2.2.12(a): EXEMPTS the last group (ends doc, no trailing normal) — EOL-less allowed", () => {
    // doc "L\nR\n": group [0,4) ends the doc (ver2.to === docLen). Both EOL-less.
    const doc = Text.of("L\nR\n".split("\n")); // "L\nR\n"
    const ranges = [
      { from: 0, to: 2, ver: 1 as const, group: 0 },
      { from: 2, to: 4, ver: 2 as const, group: 0 },
    ];
    expect(doc.length).toBe(4);
    expect(autoNewlineInserts(doc, ranges)).toEqual([]); // exempt — no \n forced
  });

  it("NOT exempt when a normal line follows the group → auto-\\n still fires", () => {
    // same group but with "tail\n" after it ⇒ ver2.to < docLen
    const doc = Text.of("L\nR\ntail\n".split("\n")); // len 9
    const ranges = [
      { from: 0, to: 2, ver: 1 as const, group: 0 },
      { from: 2, to: 4, ver: 2 as const, group: 0 },
    ];
    expect(doc.length).toBe(9);
    expect(autoNewlineInserts(doc, ranges)).toEqual([
      { from: 1, insert: "\n" },
      { from: 3, insert: "\n" },
    ]);
  });
});

describe("diff-edits — externalGuardOk (§2.2.5(1))", () => {
  // doc "a\nL\n\nR\n\nb\n": group's ver1.from=2 ⇒ separator \n at index 1 (the "a\n").
  const doc = Text.of("a\nL\n\nR\n\nb\n".split("\n"));
  const ranges = [
    { from: 2, to: 5, ver: 1 as const, group: 0 },
    { from: 5, to: 8, ver: 2 as const, group: 0 },
  ];
  it("blocks a single-char Delete of the separator \\n (non-empty normal line)", () => {
    const cs = ChangeSet.of([{ from: 1, to: 2 }], doc.length);
    expect(externalGuardOk(doc, ranges, cs)).toBe(false);
  });
  it("allows deleting elsewhere (not the separator)", () => {
    const cs = ChangeSet.of([{ from: 3, to: 4 }], doc.length);
    expect(externalGuardOk(doc, ranges, cs)).toBe(true);
  });
  it("allows a larger (selection) deletion that spans the separator", () => {
    const cs = ChangeSet.of([{ from: 0, to: 2 }], doc.length);
    expect(externalGuardOk(doc, ranges, cs)).toBe(true); // not a single-char Delete
  });
});

describe("diff-edits — dispatch-level (filters in createDiffPaneState pipeline)", () => {
  it("typing into an empty ver-block auto-restores the trailing \\n; split round-trips", () => {
    const s0 = createDiffPaneState("a\nb\n", "a\nX\nb\n"); // ver1 empty
    const v1 = readStructure(s0).find((r) => r.ver === 1)!;
    const s1 = s0.update({
      changes: { from: v1.from, insert: "w" },
      selection: { anchor: v1.from + 1 },
      userEvent: "input",
    }).state;
    const ranges = readStructure(s1);
    const nv1 = ranges.find((r) => r.ver === 1)!;
    expect(s1.doc.sliceString(nv1.from, nv1.to)).toBe("w\n\n"); // valid block
    expect(s1.doc.sliceString(nv1.from, nv1.to - 1)).toBe("w\n"); // content ends with \n
    expect(s1.selection.main.head).toBe(v1.from + 1); // caret after "w"
    const sp = splitModel(s1.doc.toString(), ranges);
    expect(sp).toEqual({ base: "a\nw\nb\n", sibling: "a\nX\nb\n" });
  });

  it("Delete of the group-preceding separator \\n is rejected (doc unchanged)", () => {
    const s0 = createDiffPaneState("a\nL\nb\n", "a\nR\nb\n");
    // separator \n is at index 1 (end of "a")
    const s1 = s0.update({ changes: { from: 1, to: 2 } }).state;
    expect(s1.doc.toString()).toBe(s0.doc.toString());
  });
});
