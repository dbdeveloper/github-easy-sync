import { describe, it, expect } from "vitest";
import { __test__ } from "../src/gitignore-cache";

const { stripInvariantRegion, prefixPatterns, INVARIANT_BLOCK, INVARIANT_BEGIN, INVARIANT_END } = __test__;

describe("INVARIANT_BLOCK contents", () => {
  it("contains the manifest must-include rule", () => {
    expect(INVARIANT_BLOCK).toContain("!github-sync-metadata.json");
  });

  it("contains the .gitignore self-include rule", () => {
    expect(INVARIANT_BLOCK).toContain("!.gitignore");
  });

  it("blocks per-device state files", () => {
    expect(INVARIANT_BLOCK).toContain("workspace.json");
    expect(INVARIANT_BLOCK).toContain("workspace-mobile.json");
    expect(INVARIANT_BLOCK).toContain("community-plugins.json");
  });

  it("starts with BEGIN marker and ends with END marker", () => {
    expect(INVARIANT_BLOCK.startsWith(INVARIANT_BEGIN)).toBe(true);
    expect(INVARIANT_BLOCK.endsWith(INVARIANT_END)).toBe(true);
  });
});

describe("stripInvariantRegion", () => {
  it("returns content unchanged when no markers are present", () => {
    const input = "user pattern\n*.tmp\n";
    expect(stripInvariantRegion(input)).toBe(input);
  });

  it("removes a complete invariant block", () => {
    const input = `${INVARIANT_BLOCK}\n\nuser stuff\n`;
    const output = stripInvariantRegion(input);
    expect(output).not.toContain(INVARIANT_BEGIN);
    expect(output).not.toContain(INVARIANT_END);
    expect(output).toContain("user stuff");
  });

  it("removes a tampered block (different rules between markers)", () => {
    const input = `${INVARIANT_BEGIN}
mangled rule
nonsense
${INVARIANT_END}

user content
`;
    const output = stripInvariantRegion(input);
    expect(output).not.toContain("mangled");
    expect(output).toContain("user content");
  });

  it("falls back to truncate-to-BEGIN when END marker is missing", () => {
    // This is the safer assumption — better to drop user content under
    // a half-broken block than to risk leaving a stray block fragment.
    const input = `header\n${INVARIANT_BEGIN}\nbroken rule\nrandom stuff\n`;
    const output = stripInvariantRegion(input);
    expect(output).toBe("header\n");
    expect(output).not.toContain("broken rule");
  });

  it("preserves user content above the block", () => {
    const input = `top user\n${INVARIANT_BLOCK}\nbottom user\n`;
    const output = stripInvariantRegion(input);
    expect(output).toContain("top user");
    expect(output).toContain("bottom user");
  });
});

describe("prefixPatterns", () => {
  it("adds prefix to plain patterns", () => {
    const out = prefixPatterns("foo.json\nbar.txt", ".obsidian/");
    expect(out).toBe(".obsidian/foo.json\n.obsidian/bar.txt");
  });

  it("preserves negation while inserting prefix after !", () => {
    const out = prefixPatterns("!keep.json", ".obsidian/");
    expect(out).toBe("!.obsidian/keep.json");
  });

  it("passes through comments unchanged", () => {
    const out = prefixPatterns("# this is a comment\nfoo", ".obsidian/");
    expect(out).toBe("# this is a comment\n.obsidian/foo");
  });

  it("passes through blank lines unchanged", () => {
    const out = prefixPatterns("foo\n\nbar", ".obsidian/");
    expect(out).toBe(".obsidian/foo\n\n.obsidian/bar");
  });

  it("handles mixed content correctly", () => {
    const input = `# comment
foo
!keep
bar
`;
    const expected = `# comment
.obsidian/foo
!.obsidian/keep
.obsidian/bar
`;
    expect(prefixPatterns(input, ".obsidian/")).toBe(expected);
  });
});
