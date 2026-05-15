import { describe, it, expect } from "vitest";
import {
  mergeIntoOne,
  ConflictCopyForMerge,
} from "../../src/sync2/conflict-merge-all";

// Stage 6.5 "Merge into one" — markdown-only auto-merge that folds every
// conflict-copy under the original via `> [!info]` callouts. Pure
// function, no I/O, deterministic with the given timestamp inputs.
//
// Output contract:
//   <original (ends with \n)>
//   \n
//   > [!info] Changing N — from <device>, <iso seconds>
//   > <copy line 1>
//   > <copy line 2>
//   > ...
//   \n
//   (next callout, blank-line-separated)

const MAY8 = Date.UTC(2026, 4, 8, 15, 30, 0);   // 2026-05-08T15:30:00Z
const MAY9 = Date.UTC(2026, 4, 9, 18, 0, 0);    // 2026-05-09T18:00:00Z

function copy(content: string, deviceLabel: string, ts: number): ConflictCopyForMerge {
  return { content, deviceLabel, ts };
}

describe("mergeIntoOne — empty / no-op cases", () => {
  it("zero copies → original returned unchanged", () => {
    expect(mergeIntoOne("hello\n", [])).toBe("hello\n");
  });

  it("zero copies + empty original → empty string", () => {
    expect(mergeIntoOne("", [])).toBe("");
  });
});

describe("mergeIntoOne — single copy", () => {
  it("appends one callout under the original", () => {
    const out = mergeIntoOne(
      "# Notes\n\n- buy milk\n",
      [copy("# Notes\n\n- milk + eggs\n", "Phone", MAY8)],
    );
    expect(out).toBe(
      "# Notes\n\n- buy milk\n" +
      "\n" +
      "> [!info] Changing 1 — from Phone, 2026-05-08T15:30:00Z\n" +
      "> # Notes\n" +
      "> \n" +
      "> - milk + eggs\n",
    );
  });

  it("missing trailing newline on original is added before the callout", () => {
    // Real callers feed canonical content (always trailing \n), but
    // the function is defensive so hand-crafted inputs don't break it.
    const out = mergeIntoOne(
      "no trailing nl",
      [copy("body\n", "Phone", MAY8)],
    );
    expect(out).toBe(
      "no trailing nl\n" +
      "\n" +
      "> [!info] Changing 1 — from Phone, 2026-05-08T15:30:00Z\n" +
      "> body\n",
    );
  });

  it("empty original + one copy → just the callout, no leading blank line", () => {
    const out = mergeIntoOne("", [copy("body\n", "Phone", MAY8)]);
    expect(out).toBe(
      "> [!info] Changing 1 — from Phone, 2026-05-08T15:30:00Z\n" +
      "> body\n",
    );
  });

  it("empty copy content → callout with header only", () => {
    const out = mergeIntoOne(
      "original\n",
      [copy("", "Phone", MAY8)],
    );
    expect(out).toBe(
      "original\n" +
      "\n" +
      "> [!info] Changing 1 — from Phone, 2026-05-08T15:30:00Z\n",
    );
  });
});

describe("mergeIntoOne — multiple copies", () => {
  it("two callouts, blank-line-separated, ordinals incremented", () => {
    const out = mergeIntoOne(
      "# Notes\n",
      [
        copy("# Notes A\n", "Phone", MAY8),
        copy("# Notes B\n", "Tablet", MAY9),
      ],
    );
    expect(out).toBe(
      "# Notes\n" +
      "\n" +
      "> [!info] Changing 1 — from Phone, 2026-05-08T15:30:00Z\n" +
      "> # Notes A\n" +
      "\n" +
      "> [!info] Changing 2 — from Tablet, 2026-05-09T18:00:00Z\n" +
      "> # Notes B\n",
    );
  });

  it("three copies maintain order from input array", () => {
    const out = mergeIntoOne(
      "x\n",
      [
        copy("a\n", "A", MAY8),
        copy("b\n", "B", MAY8),
        copy("c\n", "C", MAY8),
      ],
    );
    expect(out).toContain("Changing 1 — from A");
    expect(out).toContain("Changing 2 — from B");
    expect(out).toContain("Changing 3 — from C");
    // Order: A before B before C in the output.
    expect(out.indexOf("Changing 1")).toBeLessThan(out.indexOf("Changing 2"));
    expect(out.indexOf("Changing 2")).toBeLessThan(out.indexOf("Changing 3"));
  });
});

describe("mergeIntoOne — content shape", () => {
  it("multiline copy body is fully blockquoted", () => {
    const out = mergeIntoOne(
      "head\n",
      [copy("line one\nline two\nline three\n", "X", MAY8)],
    );
    expect(out).toContain("> line one\n> line two\n> line three\n");
  });

  it("blank lines inside copy body become `> ` (space) lines, preserving paragraph breaks", () => {
    const out = mergeIntoOne(
      "head\n",
      [copy("first paragraph\n\nsecond paragraph\n", "X", MAY8)],
    );
    // Three lines of body: first, blank, second. Trailing blank from
    // the canonical newline is dropped (see implementation comment).
    expect(out).toContain(
      "> first paragraph\n> \n> second paragraph\n",
    );
  });

  it("copy with a markdown header is preserved as a quoted header (still valid)", () => {
    const out = mergeIntoOne(
      "main\n",
      [copy("# Header\n\nbody\n", "X", MAY8)],
    );
    // > # Header is a valid blockquoted markdown header — Obsidian
    // renders it as a header inside the callout.
    expect(out).toContain("> # Header\n");
  });

  it("copy with code-fence content is preserved verbatim inside blockquote", () => {
    const fenced = "```ts\nconst x = 1;\n```\n";
    const out = mergeIntoOne(
      "main\n",
      [copy(fenced, "X", MAY8)],
    );
    expect(out).toContain("> ```ts\n> const x = 1;\n> ```\n");
  });

  it("copy that does not end with newline has its tail preserved (no synthetic trailing line)", () => {
    const out = mergeIntoOne(
      "head\n",
      [copy("trailing without nl", "X", MAY8)],
    );
    // No trailing "> " because there's no trailing \n in the source.
    expect(out).toContain("> trailing without nl\n");
    expect(out.endsWith("> trailing without nl\n")).toBe(true);
  });
});

describe("mergeIntoOne — header format", () => {
  it("ISO timestamp drops milliseconds", () => {
    const tsWithMs = Date.UTC(2026, 4, 8, 15, 30, 0) + 123; // …000Z + 123ms
    const out = mergeIntoOne("x\n", [copy("y\n", "Phone", tsWithMs)]);
    expect(out).toContain("2026-05-08T15:30:00Z");
    expect(out).not.toContain("2026-05-08T15:30:00.123Z");
  });

  it("device labels with spaces / unicode / weird chars are passed through verbatim in header", () => {
    // The header is plain-text inside markdown — anything goes. The
    // sibling-file naming separately sanitizes for filesystem safety;
    // the callout header is just for human reading.
    const out = mergeIntoOne(
      "x\n",
      [copy("y\n", "My Phone (старий)", MAY8)],
    );
    expect(out).toContain("from My Phone (старий)");
  });

  it("ordinal counter starts at 1, not 0", () => {
    const out = mergeIntoOne("x\n", [copy("y\n", "P", MAY8)]);
    expect(out).toContain("Changing 1");
    expect(out).not.toContain("Changing 0");
  });
});
