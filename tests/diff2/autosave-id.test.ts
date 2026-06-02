// Stage 2.0 — conflict-id derivation (DIFF-EDITOR.md §2.4 / §2.4.1).
//
// The id must be DETERMINISTIC (no Date.now / mtime / random) and
// ORDER-INDEPENDENT so the same pair of paths reopens the same autosave
// dir regardless of which file the caller names "base". fnv1a64 is the
// load-bearing primitive: a plain-number 64-bit FNV silently overflows
// 2^53, so we pin it against PUBLISHED FNV-1a-64 vectors (not against our
// own output, which would be circular).

import { describe, expect, it } from "vitest";
import {
  deriveAutosaveId,
  fnv1a64,
  trackedAutosaveId,
} from "../../src/diff2/autosave-store";

describe("fnv1a64 — published FNV-1a-64 vectors", () => {
  // Canonical Landon Noll / reference-suite test vectors.
  it('"" → offset basis', () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325");
  });
  it('"a"', () => {
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
  });
  it('"foobar"', () => {
    expect(fnv1a64("foobar")).toBe("85944171f73967e8");
  });

  it("always emits 16 lowercase hex chars (zero-padded)", () => {
    for (const s of ["", "a", "x", "the quick brown fox", "\x00\x01\x00"]) {
      expect(fnv1a64(s)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("hashes UTF-8 bytes, so non-ASCII is stable and distinct", () => {
    // "café" and "cafe" differ; a UTF-16-code-unit hash would still
    // differ but the POINT is stability — recompute must be identical.
    const a = fnv1a64("café");
    expect(fnv1a64("café")).toBe(a);
    expect(fnv1a64("cafe")).not.toBe(a);
  });
});

describe("deriveAutosaveId — §2.4.1", () => {
  it("is deterministic", () => {
    expect(deriveAutosaveId("synthetic", "a.md", "b.md")).toBe(
      deriveAutosaveId("synthetic", "a.md", "b.md"),
    );
  });

  it("is order-independent (symmetric in the two paths)", () => {
    expect(deriveAutosaveId("synthetic", "a.md", "b.md")).toBe(
      deriveAutosaveId("synthetic", "b.md", "a.md"),
    );
    expect(deriveAutosaveId("compare", "z/y.md", "a/b.md")).toBe(
      deriveAutosaveId("compare", "a/b.md", "z/y.md"),
    );
  });

  it("carries the kind as a prefix", () => {
    expect(deriveAutosaveId("synthetic", "a", "b")).toMatch(/^synthetic-[0-9a-f]{16}$/);
    expect(deriveAutosaveId("compare", "a", "b")).toMatch(/^compare-[0-9a-f]{16}$/);
  });

  it("the \\0 delimiter prevents path-boundary collisions", () => {
    // Without a delimiter, ("foo","bar") and ("foob","ar") both hash
    // "foobar". The \0 separator keeps them distinct.
    expect(deriveAutosaveId("synthetic", "foo", "bar")).not.toBe(
      deriveAutosaveId("synthetic", "foob", "ar"),
    );
  });

  it("distinct pairs → distinct ids", () => {
    const ids = new Set([
      deriveAutosaveId("synthetic", "a.md", "b.md"),
      deriveAutosaveId("synthetic", "a.md", "c.md"),
      deriveAutosaveId("synthetic", "x/a.md", "x/b.md"),
    ]);
    expect(ids.size).toBe(3);
  });

  it("kind discriminates the same path pair", () => {
    expect(deriveAutosaveId("synthetic", "a", "b")).not.toBe(
      deriveAutosaveId("compare", "a", "b"),
    );
  });
});

describe("trackedAutosaveId — §2.4", () => {
  it("wraps the ConflictStore record UUID", () => {
    expect(trackedAutosaveId("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "tracked-550e8400-e29b-41d4-a716-446655440000",
    );
  });
});
