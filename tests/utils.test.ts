import { describe, it, expect } from "vitest";
import {
  calculateGitBlobSHA,
  classifyForConflict,
  compareSemver,
  conflictBackupPath,
  hasTextExtension,
  isMergeFriendlyText,
  isSyncable,
  pluginIdFromPath,
} from "../src/utils";

const CONFIG_DIR = ".obsidian";
const PLUGIN_ID = "github-gitless-sync"; // matches manifest.json's id

// A tiny stand-in for the GitignoreCache. Pass a set of paths to ignore;
// isIgnored() returns true for any path in the set. Lets us verify that
// isSyncable defers to the matcher without spinning up the full cache
// (which needs a vault).
function fakeMatcher(ignored: string[]) {
  const set = new Set(ignored);
  return { isIgnored: (p: string) => set.has(p) };
}

describe("isSyncable hardcoded rules", () => {
  it("always syncs the manifest, even when a matcher would ignore it", () => {
    const path = `${CONFIG_DIR}/github-easy-sync-metadata.json`;
    expect(isSyncable(path, CONFIG_DIR, true)).toBe(true);
    expect(isSyncable(path, CONFIG_DIR, false)).toBe(true);
    // Even if matcher claims to ignore — manifest stays allowed.
    expect(isSyncable(path, CONFIG_DIR, false, fakeMatcher([path]))).toBe(true);
  });

  it("never syncs our own plugin's data.json (security backstop)", () => {
    const path = `${CONFIG_DIR}/plugins/${PLUGIN_ID}/data.json`;
    expect(isSyncable(path, CONFIG_DIR, true)).toBe(false);
    expect(isSyncable(path, CONFIG_DIR, false)).toBe(false);
  });

  it("never syncs anything inside a .git directory at any depth", () => {
    expect(isSyncable(".git/HEAD", CONFIG_DIR, true)).toBe(false);
    expect(isSyncable(".git/objects/abc", CONFIG_DIR, true)).toBe(false);
    expect(isSyncable("subdir/.git/HEAD", CONFIG_DIR, true)).toBe(false);
    expect(
      isSyncable("project/sub/.git/refs/heads/main", CONFIG_DIR, true),
    ).toBe(false);
  });

  it(".gitignore and .gitattributes are NOT blocked by the .git rule", () => {
    // Distinct segments — the .git rule matches the directory name only.
    expect(isSyncable(".gitignore", CONFIG_DIR, true)).toBe(true);
    expect(isSyncable(".gitattributes", CONFIG_DIR, true)).toBe(true);
    expect(isSyncable(`${CONFIG_DIR}/.gitignore`, CONFIG_DIR, true)).toBe(true);
  });
});

describe("isSyncable gitignore matcher integration", () => {
  it("rejects paths that the matcher reports as ignored", () => {
    const matcher = fakeMatcher(["Notes/.DS_Store", "node_modules/foo.js"]);
    expect(isSyncable("Notes/.DS_Store", CONFIG_DIR, false, matcher)).toBe(
      false,
    );
    expect(isSyncable("node_modules/foo.js", CONFIG_DIR, false, matcher)).toBe(
      false,
    );
  });

  it("allows paths the matcher doesn't ignore", () => {
    const matcher = fakeMatcher(["Notes/.DS_Store"]);
    expect(isSyncable("Notes/foo.md", CONFIG_DIR, false, matcher)).toBe(true);
  });

  it("works without a matcher (no rule 4 applied)", () => {
    expect(isSyncable("Notes/foo.md", CONFIG_DIR, false)).toBe(true);
    expect(isSyncable("Notes/.DS_Store", CONFIG_DIR, false)).toBe(true);
  });
});

describe("isSyncable configDir gating", () => {
  it("rejects configDir paths when syncConfigDir is off", () => {
    expect(isSyncable(`${CONFIG_DIR}/app.json`, CONFIG_DIR, false)).toBe(false);
    expect(
      isSyncable(`${CONFIG_DIR}/plugins/foo/main.js`, CONFIG_DIR, false),
    ).toBe(false);
  });

  it("allows configDir paths when syncConfigDir is on", () => {
    expect(isSyncable(`${CONFIG_DIR}/app.json`, CONFIG_DIR, true)).toBe(true);
    expect(
      isSyncable(`${CONFIG_DIR}/plugins/foo/main.js`, CONFIG_DIR, true),
    ).toBe(true);
  });

  it("allows root vault content regardless of syncConfigDir", () => {
    expect(isSyncable("Notes/foo.md", CONFIG_DIR, false)).toBe(true);
    expect(isSyncable("project/code.js", CONFIG_DIR, false)).toBe(true);
    // Hidden basenames in vault root are NOT auto-blocked. .obsidian.vimrc
    // is a real file users want synced (Vim bindings for the
    // obsidian-vimrc-support plugin).
    expect(isSyncable(".obsidian.vimrc", CONFIG_DIR, false)).toBe(true);
  });
});

describe("hasTextExtension", () => {
  it("recognizes common text formats", () => {
    expect(hasTextExtension("notes/foo.md")).toBe(true);
    expect(hasTextExtension("data.json")).toBe(true);
    expect(hasTextExtension("config.yml")).toBe(true);
    expect(hasTextExtension("script.ts")).toBe(true);
  });

  it("returns false for binary extensions", () => {
    expect(hasTextExtension("image.png")).toBe(false);
    expect(hasTextExtension("doc.pdf")).toBe(false);
    expect(hasTextExtension("audio.mp3")).toBe(false);
  });

  it("returns false for unknown extensions", () => {
    expect(hasTextExtension("file.xyz")).toBe(false);
  });
});

describe("isMergeFriendlyText", () => {
  const encode = (s: string) =>
    new TextEncoder().encode(s).buffer as ArrayBuffer;

  it("accepts ordinary short text", () => {
    expect(isMergeFriendlyText(encode("hello\nworld\n"))).toBe(true);
  });

  it("rejects content with null bytes", () => {
    const buf = new Uint8Array([97, 0, 98]).buffer; // "a\0b"
    expect(isMergeFriendlyText(buf)).toBe(false);
  });

  it("rejects single line longer than the threshold", () => {
    expect(isMergeFriendlyText(encode("a".repeat(5000)))).toBe(false);
  });

  it("accepts many normal-length lines", () => {
    expect(isMergeFriendlyText(encode("hello world\n".repeat(2000)))).toBe(
      true,
    );
  });

  it("rejects files larger than 2 MB", () => {
    const big = new Uint8Array(3 * 1024 * 1024 + 1);
    expect(isMergeFriendlyText(big.buffer)).toBe(false);
  });
});

describe("classifyForConflict", () => {
  it("plugin .js is always plugin-js", () => {
    expect(
      classifyForConflict(`${CONFIG_DIR}/plugins/x/main.js`, CONFIG_DIR),
    ).toBe("plugin-js");
  });

  it("non-text by extension is binary", () => {
    expect(classifyForConflict("img/photo.png", CONFIG_DIR)).toBe("binary");
    expect(classifyForConflict("file.pdf", CONFIG_DIR)).toBe("binary");
  });

  it("text without buffer is text", () => {
    expect(classifyForConflict("notes/foo.md", CONFIG_DIR)).toBe("text");
  });

  it("text with diff-friendly buffer is text", () => {
    const buf = new TextEncoder().encode("hello\nworld\n").buffer;
    expect(
      classifyForConflict("notes/foo.md", CONFIG_DIR, buf as ArrayBuffer),
    ).toBe("text");
  });

  it("text with merge-hostile buffer is downgraded to binary", () => {
    const buf = new TextEncoder().encode("a".repeat(5000)).buffer;
    expect(
      classifyForConflict("notes/foo.md", CONFIG_DIR, buf as ArrayBuffer),
    ).toBe("binary");
  });
});

describe("pluginIdFromPath", () => {
  it("extracts plugin id from plugin folder paths", () => {
    expect(
      pluginIdFromPath(`${CONFIG_DIR}/plugins/foo/main.js`, CONFIG_DIR),
    ).toBe("foo");
    expect(
      pluginIdFromPath(`${CONFIG_DIR}/plugins/foo/sub/main.js`, CONFIG_DIR),
    ).toBe("foo");
  });

  it("returns null for non-plugin paths", () => {
    expect(pluginIdFromPath("notes/foo.md", CONFIG_DIR)).toBe(null);
    expect(pluginIdFromPath(`${CONFIG_DIR}/app.json`, CONFIG_DIR)).toBe(null);
  });

  it("returns null for malformed plugin paths", () => {
    expect(pluginIdFromPath(`${CONFIG_DIR}/plugins/`, CONFIG_DIR)).toBe(null);
    expect(pluginIdFromPath(`${CONFIG_DIR}/plugins`, CONFIG_DIR)).toBe(null);
  });
});

describe("compareSemver", () => {
  it("returns 0 for equal versions", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("2.3.4", "2.3.4")).toBe(0);
  });

  it("returns 1 when first is higher", () => {
    expect(compareSemver("1.0.1", "1.0.0")).toBe(1);
    expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
    expect(compareSemver("1.10.0", "1.9.0")).toBe(1);
  });

  it("returns -1 when first is lower", () => {
    expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
    expect(compareSemver("0.99.99", "1.0.0")).toBe(-1);
  });

  it("treats missing components as zero", () => {
    expect(compareSemver("1.0", "1.0.0")).toBe(0);
    expect(compareSemver("1", "1.0.1")).toBe(-1);
  });

  it("strips pre-release suffix before compare", () => {
    expect(compareSemver("1.0.7-beta", "1.0.7")).toBe(0);
    expect(compareSemver("1.0.7-beta", "1.0.6")).toBe(1);
  });
});

describe("conflictBackupPath", () => {
  const fixedDate = new Date("2026-04-25T19:30:00.000Z");

  it("inserts the loser tag and timestamp before the extension", () => {
    expect(conflictBackupPath("notes/foo.md", "remote", fixedDate)).toBe(
      "notes/foo.conflict-remote-2026-04-25T19-30-00.000Z.md",
    );
  });

  it("handles 'local' loser side", () => {
    expect(conflictBackupPath("img/pic.png", "local", fixedDate)).toBe(
      "img/pic.conflict-local-2026-04-25T19-30-00.000Z.png",
    );
  });

  it("handles paths without an extension", () => {
    expect(conflictBackupPath("README", "remote", fixedDate)).toBe(
      "README.conflict-remote-2026-04-25T19-30-00.000Z",
    );
  });

  it("only treats a dot in the basename as an extension", () => {
    expect(
      conflictBackupPath("dir.with.dots/file", "remote", fixedDate),
    ).toBe("dir.with.dots/file.conflict-remote-2026-04-25T19-30-00.000Z");
  });
});

describe("calculateGitBlobSHA", () => {
  it("matches git hash-object for empty blob", async () => {
    const sha = await calculateGitBlobSHA(new ArrayBuffer(0));
    expect(sha).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("matches git hash-object for 'hello'", async () => {
    const buf = new TextEncoder().encode("hello").buffer;
    const sha = await calculateGitBlobSHA(buf as ArrayBuffer);
    expect(sha).toBe("b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
  });

  it("matches git hash-object for 'hello\\n'", async () => {
    const buf = new TextEncoder().encode("hello\n").buffer;
    const sha = await calculateGitBlobSHA(buf as ArrayBuffer);
    expect(sha).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});
