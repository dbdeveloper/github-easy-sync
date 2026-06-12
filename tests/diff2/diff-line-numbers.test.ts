// Phase 3 — V2 per-side gutter numbering (§2.2.10 "sibling-wins").
// Pure computeLineLabels across the numbering matrix.

import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { buildModel } from "../../src/diff2/diff-model";
import { computeLineLabels } from "../../src/diff2/diff-line-numbers";

function labels(base: string, sibling: string) {
  const m = buildModel(base, sibling);
  return computeLineLabels(Text.of(m.doc.split("\n")), m.ranges);
}

describe("diff-line-numbers — computeLineLabels (§2.2.10 sibling-wins)", () => {
  it("ver1 → '-ours', ver2 → '+theirs', normal → theirs; bare terminals get NO number", () => {
    // base "a\nL\nc\n" (a,L,c) vs sibling "a\nR1\nR2\nc\n" (a,R1,R2,c)
    // doc "a\nL\n\nR1\nR2\n\nc\n":
    //   1 "a" normal | 2 "L" ver1 | 3 "" ver1-term | 4 "R1" ver2 | 5 "R2" ver2 |
    //   6 "" ver2-term | 7 "c" normal | 8 "" trailing normal
    const l = labels("a\nL\nc\n", "a\nR1\nR2\nc\n");
    expect(l.get(1)).toEqual({ text: "1", side: "normal" }); // a → sibling line 1
    expect(l.get(2)).toEqual({ text: "-2", side: "ver1" }); // L → base line 2 (deletion)
    expect(l.has(3)).toBe(false); // bare terminal
    expect(l.get(4)).toEqual({ text: "+2", side: "ver2" }); // R1 → sibling line 2
    expect(l.get(5)).toEqual({ text: "+3", side: "ver2" }); // R2 → sibling line 3
    expect(l.has(6)).toBe(false); // bare terminal
    expect(l.get(7)).toEqual({ text: "4", side: "normal" }); // c → sibling line 4 (sibling-wins)
  });

  it("identical inputs (no diff): plain 1..n normal numbering", () => {
    const l = labels("x\ny\nz\n", "x\ny\nz\n");
    expect(l.get(1)).toEqual({ text: "1", side: "normal" });
    expect(l.get(2)).toEqual({ text: "2", side: "normal" });
    expect(l.get(3)).toEqual({ text: "3", side: "normal" });
  });

  it("delete-vs-modify (empty ver1): the empty ver-block line gets no number", () => {
    // base "a\nb\n" vs sibling "a\nX\nb\n" ⇒ doc "a\n\nX\n\nb\n"
    //   1 "a" normal | 2 "" empty ver1 (bare) | 3 "X" ver2 | 4 "" ver2-term | 5 "b" normal
    const l = labels("a\nb\n", "a\nX\nb\n");
    expect(l.get(1)).toEqual({ text: "1", side: "normal" });
    expect(l.has(2)).toBe(false); // empty ver1 → no number
    expect(l.get(3)).toEqual({ text: "+2", side: "ver2" });
    expect(l.has(4)).toBe(false);
    expect(l.get(5)).toEqual({ text: "3", side: "normal" });
  });

  it("EOL-less last group: the EOL-less content line IS numbered (it's real content)", () => {
    // base "a\nL" vs "a\nR" ⇒ doc "a\nL\nR\n": 1 "a" normal | 2 "L" ver1 (EOL-less) | 3 "R" ver2 (EOL-less)
    const l = labels("a\nL", "a\nR");
    expect(l.get(1)).toEqual({ text: "1", side: "normal" });
    expect(l.get(2)).toEqual({ text: "-2", side: "ver1" }); // EOL-less but real content
    expect(l.get(3)).toEqual({ text: "+2", side: "ver2" });
  });
});
