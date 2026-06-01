// §1.5 round-trip invariant for the joined-document model.
//
//   split(build(base, sibling)) === { base, sibling }   byte-exact
//
// for any collision-free (base, sibling). This invariant is
// load-bearing: Phase 5 replays the history-log on top of a
// freshly-rebuilt joined doc, so build() must be deterministic and
// split() must invert it exactly, or recovery yields garbage (§1.5).
//
// Corpus: 30+ pairs spanning markdown notes, code, configs,
// README-style prose, and the §1.5 edge cases (empty files, no
// trailing \n, only \n, emoji multi-byte, CRLF, blank-line runs).
//
// Canonical spec: docs/tasks/DIFF-EDITOR.md §1.4 (build/split), §1.5
// (round-trip + corpus), §1.3 (collision fail-closed).

import { describe, it, expect } from "vitest";
import {
  build,
  split,
  findSentinelCollision,
  LINE_TERMINATOR,
  VER_SEPARATOR,
} from "../../src/diff2/joined-doc";

// [name, base, sibling]
const CORPUS: Array<[string, string, string]> = [
  // ── identical / trivial ──────────────────────────────────────────
  ["identical-multiline", "a\nb\nc\n", "a\nb\nc\n"],
  ["identical-single", "only line\n", "only line\n"],
  ["empty-both", "", ""],
  ["empty-base", "", "hello\nworld\n"],
  ["empty-sibling", "hello\nworld\n", ""],

  // ── single-line edits ────────────────────────────────────────────
  ["middle-change", "a\nb\nc\n", "a\nX\nc\n"],
  ["first-line-change", "a\nb\nc\n", "Z\nb\nc\n"],
  ["last-line-change", "a\nb\nc\n", "a\nb\nZ\n"],

  // ── insertions / deletions ───────────────────────────────────────
  ["sibling-appends", "a\nb\n", "a\nb\nc\n"],
  ["sibling-prepends", "b\nc\n", "a\nb\nc\n"],
  ["base-deletes-tail", "a\nb\nc\n", "a\nb\n"],
  ["base-deletes-head", "a\nb\nc\n", "b\nc\n"],
  ["insert-block-middle", "a\nz\n", "a\nb\nc\nd\nz\n"],
  ["delete-block-middle", "a\nb\nc\nd\nz\n", "a\nz\n"],

  // ── trailing-newline shape ───────────────────────────────────────
  ["no-eol-base", "a\nb", "a\nX"],
  ["no-eol-both-same", "a\nb", "a\nb"],
  ["base-eol-sibling-no-eol", "a\nb\n", "a\nb"],
  ["base-no-eol-sibling-eol", "a\nb", "a\nb\n"],
  ["single-no-eol", "no newline here", "no newline here either!"],

  // ── empty / blank lines ──────────────────────────────────────────
  ["only-newline", "\n", "\n"],
  ["only-newline-grow", "\n", "\n\n"],
  ["blank-run-shrinks", "a\n\n\n\nb\n", "a\n\nb\n"],
  ["blank-run-grows", "a\nb\n", "a\n\n\nb\n"],
  ["leading-blank", "\n\na\n", "a\n"],
  ["trailing-blank", "a\n\n\n", "a\n"],

  // ── unicode / multibyte ──────────────────────────────────────────
  ["emoji-change", "héllo 🚀\nbye\n", "héllo 🌍\nbye\n"],
  ["cyrillic", "привіт\nсвіт\n", "привіт\nКлод\n"],
  ["diaeresis-y", "café\nnaïve\nÿ row\n", "café\nnaïve\nÿ changed\n"],

  // ── CRLF (byte-exact must hold even though sync2 normalizes upstream)
  ["crlf-change", "a\r\nb\r\nc\r\n", "a\r\nX\r\nc\r\n"],
  ["crlf-vs-lf", "a\r\nb\r\n", "a\nb\n"],

  // ── realistic blobs ──────────────────────────────────────────────
  [
    "markdown-note",
    "# Title\n\nA paragraph with **bold**.\n\n- item one\n- item two\n",
    "# Title\n\nA paragraph with *italics*.\n\n- item one\n- item two\n- item three\n",
  ],
  [
    "code-file",
    "function f(x) {\n  return x + 1;\n}\n",
    "function f(x) {\n  // adjust\n  return x + 2;\n}\n",
  ],
  [
    "json-config",
    '{\n  "a": 1,\n  "b": 2\n}\n',
    '{\n  "a": 1,\n  "b": 3,\n  "c": 4\n}\n',
  ],
  [
    "readme-prose",
    "Install with pnpm.\nThen run build.\nDone.\n",
    "Install with pnpm.\nRun the test suite.\nThen run build.\nDone.\n",
  ],
  [
    "fully-disjoint",
    "alpha\nbeta\ngamma\n",
    "one\ntwo\nthree\nfour\n",
  ],
];

describe("§1.5 build/split round-trip — byte-exact", () => {
  for (const [name, base, sibling] of CORPUS) {
    it(`round-trips: ${name}`, () => {
      const joined = build(base, sibling);
      const out = split(joined);
      expect(out.base).toBe(base);
      expect(out.sibling).toBe(sibling);
    });
  }

  it(`corpus has 30+ pairs (§1.5 requirement) — got ${CORPUS.length}`, () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(30);
  });

  it("joined doc carries the sentinels for a divergent pair", () => {
    // A changed line must materialise as a \1-separated diff-line, and
    // every line ends in \0.
    const joined = build("a\nb\nc\n", "a\nX\nc\n");
    expect(joined.includes(VER_SEPARATOR)).toBe(true);
    expect(joined.endsWith(LINE_TERMINATOR)).toBe(true);
  });

  it("identical inputs produce only normal lines (no \\1 separators)", () => {
    const joined = build("a\nb\nc\n", "a\nb\nc\n");
    expect(joined.includes(VER_SEPARATOR)).toBe(false);
    // one \0 per line.
    const terminators = joined.split(LINE_TERMINATOR).length - 1;
    expect(terminators).toBe(3);
  });
});

describe("§1.2 build() output structural invariants", () => {
  // These pin the structural rules the Phase 1b editor depends on
  // (no empty lines, ver-separator discipline). Round-trip alone can't
  // catch a future build() refactor that violates them, because split()
  // would invert the broken shape just as faithfully.
  for (const [name, base, sibling] of CORPUS) {
    it(`conforms: ${name}`, () => {
      const joined = build(base, sibling);
      // No empty line: build never emits a bare \0 (every line has ≥1
      // char before its terminator) nor a leading \0.
      expect(joined.includes(LINE_TERMINATOR + LINE_TERMINATOR)).toBe(false);
      expect(joined.startsWith(LINE_TERMINATOR)).toBe(false);
      // Every line (segment between \0s) carries at most one \1, and a
      // \1-bearing line is a diff-line with exactly one separator.
      const segments = joined.split(LINE_TERMINATOR);
      for (let i = 0; i < segments.length; i++) {
        if (segments[i] === "" && i === segments.length - 1) continue;
        const count = segments[i].split(VER_SEPARATOR).length - 1;
        expect(count).toBeLessThanOrEqual(1);
      }
    });
  }
});

describe("§1.3 collision detection — fail-closed", () => {
  it("clean inputs → null", () => {
    expect(findSentinelCollision("a\nb\n", "a\nX\n")).toBeNull();
  });

  it("detects \\1 (SOH) in base", () => {
    expect(findSentinelCollision(`a${VER_SEPARATOR}b`, "ok")).toEqual({
      side: "base",
      char: "VER_SEPARATOR",
    });
  });

  it("detects \\1 (SOH) in sibling", () => {
    expect(findSentinelCollision("ok", `x${VER_SEPARATOR}y`)).toEqual({
      side: "sibling",
      char: "VER_SEPARATOR",
    });
  });

  it("detects \\0 (NUL terminator) too — spec-gap hardening", () => {
    expect(findSentinelCollision(`a${LINE_TERMINATOR}b`, "ok")).toEqual({
      side: "base",
      char: "LINE_TERMINATOR",
    });
  });

  it("build() throws if a sentinel slips past the caller's check", () => {
    expect(() => build(`a${VER_SEPARATOR}b`, "ok")).toThrow(/sentinel/);
  });
});
