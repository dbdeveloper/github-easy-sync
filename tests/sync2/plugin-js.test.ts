import { describe, it, expect } from "vitest";
import {
  compareSemver,
  isAtomicPluginFile,
  pluginRootOf,
  readPluginVersion,
} from "../../src/sync2/plugin-js";

describe("isAtomicPluginFile", () => {
  const cfg = ".obsidian";
  it("returns true for .js under .obsidian/plugins/<id>/", () => {
    expect(isAtomicPluginFile(".obsidian/plugins/foo/main.js", cfg)).toBe(
      true,
    );
    expect(
      isAtomicPluginFile(".obsidian/plugins/foo/lib/util.js", cfg),
    ).toBe(true);
    expect(
      isAtomicPluginFile(".obsidian/plugins/bar/dist/index.js", cfg),
    ).toBe(true);
  });
  it("returns true for manifest.json under .obsidian/plugins/<id>/", () => {
    expect(
      isAtomicPluginFile(".obsidian/plugins/foo/manifest.json", cfg),
    ).toBe(true);
    // Nested manifest.json too (rare but valid path).
    expect(
      isAtomicPluginFile(".obsidian/plugins/foo/sub/manifest.json", cfg),
    ).toBe(true);
  });
  it("returns false for other text files under a plugin folder", () => {
    expect(isAtomicPluginFile(".obsidian/plugins/foo/styles.css", cfg)).toBe(
      false,
    );
    expect(isAtomicPluginFile(".obsidian/plugins/foo/README.md", cfg)).toBe(
      false,
    );
  });
  it("returns false for .js or manifest.json outside a plugin folder", () => {
    expect(isAtomicPluginFile("scripts/build.js", cfg)).toBe(false);
    expect(isAtomicPluginFile(".obsidian/snippets/x.js", cfg)).toBe(false);
    expect(isAtomicPluginFile(".obsidian/plugins/loose.js", cfg)).toBe(false);
    expect(isAtomicPluginFile("manifest.json", cfg)).toBe(false);
  });
});

describe("pluginRootOf", () => {
  const cfg = ".obsidian";
  it("returns the plugin folder for nested paths", () => {
    expect(pluginRootOf(".obsidian/plugins/foo/main.js", cfg)).toBe(
      ".obsidian/plugins/foo",
    );
    expect(pluginRootOf(".obsidian/plugins/foo/lib/x.js", cfg)).toBe(
      ".obsidian/plugins/foo",
    );
  });
  it("returns null when path is not under plugins/<id>/", () => {
    expect(pluginRootOf(".obsidian/plugins/loose.js", cfg)).toBe(null);
    expect(pluginRootOf("note.md", cfg)).toBe(null);
  });
});

describe("readPluginVersion", () => {
  it("returns the version field on well-formed manifests", () => {
    expect(readPluginVersion('{"version":"1.2.3","id":"x"}')).toBe("1.2.3");
  });
  it("returns null on malformed JSON", () => {
    expect(readPluginVersion("not json")).toBe(null);
  });
  it("returns null when version is missing or non-string", () => {
    expect(readPluginVersion('{"id":"x"}')).toBe(null);
    expect(readPluginVersion('{"version":42}')).toBe(null);
    expect(readPluginVersion('{"version":""}')).toBe(null);
  });
});

describe("compareSemver", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareSemver("1.0.0", "2.0.0")).toBeLessThan(0);
    expect(compareSemver("2.0.0", "1.0.0")).toBeGreaterThan(0);
    expect(compareSemver("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareSemver("1.2.5", "1.2.5")).toBe(0);
  });
  it("treats missing segments as zero", () => {
    expect(compareSemver("1", "1.0.0")).toBe(0);
    expect(compareSemver("1.2", "1.2.0")).toBe(0);
  });
  it("ignores pre-release and build metadata", () => {
    // Tie: caller is expected to fall back to mtime when this returns 0.
    expect(compareSemver("1.0.0-beta", "1.0.0")).toBe(0);
    expect(compareSemver("v1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
  });
  it("treats non-numeric segments as zero", () => {
    expect(compareSemver("1.x.0", "1.0.0")).toBe(0);
  });
});
