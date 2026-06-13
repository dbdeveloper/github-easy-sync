// Phase 2 — V2 diff-model build/split round-trip (terminal-inside).
// The gate for the new representation: splitModel(buildModel(a,b)) === (a,b)
// byte-exact across the full case matrix, and the terminal-inside structural
// invariants hold. (DIFF-EDITOR-V2.md §2.1–§2.2.12; contract DIFF-EDITOR.md §0.3.)

import { describe, expect, it } from "vitest";
import { buildModel, serializeModel, splitModel, type VerRange } from "../../src/diff2/diff-model";

function roundtrip(base: string, sibling: string) {
  const m = buildModel(base, sibling);
  return { m, out: splitModel(m.doc, m.ranges) };
}

describe("diff-model — round-trip split(build(a,b)) === (a,b)", () => {
  const cases: Array<[string, string, string]> = [
    ["identical (no diff)", "a\nb\n", "a\nb\n"],
    ["modify-vs-modify", "a\nL\nb\n", "a\nR\nb\n"],
    ["delete-vs-modify (empty ver1)", "a\nb\n", "a\nX\nb\n"],
    ["modify-vs-delete (empty ver2)", "a\nX\nb\n", "a\nb\n"],
    ["0-byte base vs content", "", "x\n"],
    ["content vs 0-byte sibling", "x\n", ""],
    ["both empty", "", ""],
    ["EOL-less last line, both sides", "a\nb", "a\nc"],
    ["EOL-less last line, one side", "a\nb\n", "a\nc"],
    ["multi-line ver blocks", "a\nL1\nL2\nb\n", "a\nR1\nb\n"],
    ["multi-group", "a\nL1\nb\nL2\nc\n", "a\nR1\nb\nR2\nc\n"],
    ["leading diff (doc starts with a ver block)", "L\nb\n", "R\nb\n"],
    ["trailing diff (doc ends with a ver block)", "a\nL\n", "a\nR\n"],
    ["empty line content (not delete)", "a\n\nb\n", "a\nX\nb\n"],
    ["whole file replaced", "one\ntwo\n", "three\nfour\n"],
  ];

  for (const [name, base, sibling] of cases) {
    it(name, () => {
      const { out } = roundtrip(base, sibling);
      expect(out.base).toBe(base);
      expect(out.sibling).toBe(sibling);
    });
  }

  it("identical inputs produce no ranges (no conflict)", () => {
    const m = buildModel("a\nb\nc\n", "a\nb\nc\n");
    expect(m.ranges).toHaveLength(0);
    expect(m.doc).toBe("a\nb\nc\n");
  });
});

describe("serializeModel — V2 joinedDocSha fingerprint input (P6.1)", () => {
  it("is reproducible from (base, sibling) alone — two builds match byte-for-byte", () => {
    const b = "alpha\nA1\ngamma\n";
    const s = "alpha\nA2\ngamma\n";
    expect(serializeModel(buildModel(b, s))).toBe(serializeModel(buildModel(b, s)));
  });

  it("captures the group partition, not just the doc text", () => {
    // Same sibling text reached two ways: identical-to-base (no group) vs a real
    // change (one group). The doc/ranges differ ⇒ the fingerprint must differ.
    const noChange = serializeModel(buildModel("x\ny\n", "x\ny\n"));
    const oneGroup = serializeModel(buildModel("x\ny\n", "x\nY\n"));
    expect(noChange).not.toBe(oneGroup);
  });

  it("different inputs that share no diff region still differ", () => {
    expect(serializeModel(buildModel("a\n", "b\n"))).not.toBe(
      serializeModel(buildModel("a\n", "c\n")),
    );
  });
});

describe("diff-model — terminal-inside structural invariants", () => {
  it("every ver range ends with a terminal \\n at to-1; ver2.from === ver1.to; never zero-width", () => {
    const m = buildModel("a\nL1\nL2\nb\nM\nc\n", "a\nR1\nb\nN1\nN2\nc\n");
    const byG: Record<number, Partial<Record<1 | 2, VerRange>>> = {};
    for (const r of m.ranges) (byG[r.group] ??= {})[r.ver] = r;
    expect(Object.keys(byG).length).toBeGreaterThanOrEqual(2); // multi-group
    for (const g of Object.values(byG)) {
      const v1 = g[1]!;
      const v2 = g[2]!;
      expect(v2.from).toBe(v1.to); // adjacent, no gap/overlap
      expect(m.doc[v1.to - 1]).toBe("\n"); // terminal-inside ver1
      expect(m.doc[v2.to - 1]).toBe("\n"); // terminal-inside ver2
      expect(v1.to - v1.from).toBeGreaterThanOrEqual(1); // never zero-width
      expect(v2.to - v2.from).toBeGreaterThanOrEqual(1);
    }
  });

  it("empty ver-block is exactly width-1 (the terminal \\n), content empty", () => {
    const m = buildModel("a\nb\n", "a\nX\nb\n"); // delete-vs-modify ⇒ ver1 empty
    const v1 = m.ranges.find((r) => r.ver === 1)!;
    expect(v1.to - v1.from).toBe(1);
    expect(m.doc.slice(v1.from, v1.to)).toBe("\n");
    expect(m.doc.slice(v1.from, v1.to - 1)).toBe(""); // content via slice(from,to-1)
  });

  it("content via doc.slice(from, to-1) reconstructs each side", () => {
    const m = buildModel("a\nLEFT\nb\n", "a\nRIGHT\nb\n");
    const v1 = m.ranges.find((r) => r.ver === 1)!;
    const v2 = m.ranges.find((r) => r.ver === 2)!;
    expect(m.doc.slice(v1.from, v1.to - 1)).toBe("LEFT\n");
    expect(m.doc.slice(v2.from, v2.to - 1)).toBe("RIGHT\n");
  });
});
