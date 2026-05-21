import { describe, it, expect } from "vitest";
import {
  classifyConflictKind,
  attemptAutoMerge,
  type AutoMergeResult,
  type PluginJsContext,
} from "../../src/sync2/conflict-detection";

// Pseudo-merge conflict-detection tests (PSEUDO-MERGE-MODE.md, 5b).

const CONFIG_DIR = ".obsidian";

function arr(text: string): ArrayBuffer {
  const u = new TextEncoder().encode(text);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

function decode(content: ArrayBuffer): string {
  return new TextDecoder().decode(content);
}

// ── classifyConflictKind ──────────────────────────────────────────────

describe("classifyConflictKind", () => {
  it("modified + modified → modify-vs-modify", () => {
    expect(classifyConflictKind("modified", "modified")).toBe("modify-vs-modify");
  });

  it("deleted + modified → delete-vs-modify (ours deleted, theirs modified)", () => {
    expect(classifyConflictKind("deleted", "modified")).toBe("delete-vs-modify");
  });

  it("modified + deleted → null (auto-resolves at push: local-modify wins, file resurrects)", () => {
    // modify-vs-delete is no longer a registered conflict kind — it
    // routes through attemptAutoMerge's "modify-wins" branch.
    // classifyConflictKind returns null for this pair so the caller
    // does NOT call ConflictStore.create.
    expect(classifyConflictKind("modified", "deleted")).toBeNull();
  });

  it("deleted + deleted → null (both agree, not a conflict)", () => {
    expect(classifyConflictKind("deleted", "deleted")).toBeNull();
  });
});

// ── attemptAutoMerge: text 3-way ──────────────────────────────────────

describe("attemptAutoMerge — text 3-way", () => {
  it("clean merge (non-overlapping edits) → returns merged content", () => {
    const base = "alpha\nbeta\ngamma\n";
    const ours = "alpha-edited\nbeta\ngamma\n";
    const theirs = "alpha\nbeta\ngamma-edited\n";
    const r = attemptAutoMerge({
      path: "Notes/note.md",
      ours: arr(ours),
      theirs: arr(theirs),
      base: arr(base),
      configDir: CONFIG_DIR,
    });
    expect(r.type).toBe("clean");
    if (r.type === "clean") {
      expect(decode(r.content)).toBe("alpha-edited\nbeta\ngamma-edited\n");
    }
  });

  it("overlapping edits → register-conflict (markers would appear)", () => {
    const base = "alpha\nbeta\ngamma\n";
    const ours = "alpha\nOURS-LINE\ngamma\n";
    const theirs = "alpha\nTHEIRS-LINE\ngamma\n";
    const r = attemptAutoMerge({
      path: "Notes/note.md",
      ours: arr(ours),
      theirs: arr(theirs),
      base: arr(base),
      configDir: CONFIG_DIR,
    });
    expect(r.type).toBe("register-conflict");
  });

  it("same edit both sides → clean (excludeFalseConflicts collapses)", () => {
    const base = "alpha\nbeta\ngamma\n";
    const ours = "alpha\nBOTH-CHANGE\ngamma\n";
    const theirs = "alpha\nBOTH-CHANGE\ngamma\n";
    const r = attemptAutoMerge({
      path: "Notes/note.md",
      ours: arr(ours),
      theirs: arr(theirs),
      base: arr(base),
      configDir: CONFIG_DIR,
    });
    expect(r.type).toBe("clean");
    if (r.type === "clean") {
      expect(decode(r.content)).toBe("alpha\nBOTH-CHANGE\ngamma\n");
    }
  });

  it("null base (no shared ancestor) → register-conflict", () => {
    const r = attemptAutoMerge({
      path: "Notes/note.md",
      ours: arr("ours\n"),
      theirs: arr("theirs\n"),
      base: null,
      configDir: CONFIG_DIR,
    });
    expect(r.type).toBe("register-conflict");
  });
});

// ── attemptAutoMerge: plugin-js atomic semver ────────────────────────

const PLUGIN_PATH = ".obsidian/plugins/my-plugin/main.js";

function pluginCtx(over: Partial<PluginJsContext> = {}): PluginJsContext {
  return {
    oursVersion: "1.0.0",
    theirsVersion: "1.0.0",
    oursMtime: 100,
    theirsMtime: 100,
    ...over,
  };
}

describe("attemptAutoMerge — plugin-js semver", () => {
  it("ours version higher → atomic ours", () => {
    const r = attemptAutoMerge({
      path: PLUGIN_PATH,
      ours: arr("//ours\n"),
      theirs: arr("//theirs\n"),
      base: arr("//base\n"),
      configDir: CONFIG_DIR,
      pluginJs: pluginCtx({ oursVersion: "1.2.0", theirsVersion: "1.1.0" }),
    });
    expect(r).toEqual({ type: "atomic", side: "ours" });
  });

  it("theirs version higher → atomic theirs", () => {
    const r = attemptAutoMerge({
      path: PLUGIN_PATH,
      ours: arr("//ours\n"),
      theirs: arr("//theirs\n"),
      base: null,
      configDir: CONFIG_DIR,
      pluginJs: pluginCtx({ oursVersion: "1.0.0", theirsVersion: "2.0.0" }),
    });
    expect(r).toEqual({ type: "atomic", side: "theirs" });
  });

  it("versions tied, ours mtime newer → atomic ours", () => {
    const r = attemptAutoMerge({
      path: PLUGIN_PATH,
      ours: arr("//ours\n"),
      theirs: arr("//theirs\n"),
      base: null,
      configDir: CONFIG_DIR,
      pluginJs: pluginCtx({ oursMtime: 200, theirsMtime: 100 }),
    });
    expect(r).toEqual({ type: "atomic", side: "ours" });
  });

  it("versions tied, theirs mtime newer → atomic theirs", () => {
    const r = attemptAutoMerge({
      path: PLUGIN_PATH,
      ours: arr("//ours\n"),
      theirs: arr("//theirs\n"),
      base: null,
      configDir: CONFIG_DIR,
      pluginJs: pluginCtx({ oursMtime: 100, theirsMtime: 200 }),
    });
    expect(r).toEqual({ type: "atomic", side: "theirs" });
  });

  it("both versions parseable, semver tie, mtime tie → register-conflict (spec R5)", () => {
    const r = attemptAutoMerge({
      path: PLUGIN_PATH,
      ours: arr("//ours\n"),
      theirs: arr("//theirs\n"),
      base: null,
      configDir: CONFIG_DIR,
      pluginJs: pluginCtx(),
    });
    expect(r).toEqual({ type: "register-conflict" });
  });

  it("only ours version available → atomic ours", () => {
    const r = attemptAutoMerge({
      path: PLUGIN_PATH,
      ours: arr("//ours\n"),
      theirs: arr("//theirs\n"),
      base: null,
      configDir: CONFIG_DIR,
      pluginJs: pluginCtx({ oursVersion: "1.0.0", theirsVersion: null }),
    });
    expect(r).toEqual({ type: "atomic", side: "ours" });
  });

  it("only theirs version available → atomic theirs", () => {
    const r = attemptAutoMerge({
      path: PLUGIN_PATH,
      ours: arr("//ours\n"),
      theirs: arr("//theirs\n"),
      base: null,
      configDir: CONFIG_DIR,
      pluginJs: pluginCtx({ oursVersion: null, theirsVersion: "1.0.0" }),
    });
    expect(r).toEqual({ type: "atomic", side: "theirs" });
  });

  it("both versions unparseable, mtimes differ → atomic by mtime", () => {
    const r = attemptAutoMerge({
      path: PLUGIN_PATH,
      ours: arr("//ours\n"),
      theirs: arr("//theirs\n"),
      base: null,
      configDir: CONFIG_DIR,
      pluginJs: pluginCtx({
        oursVersion: null,
        theirsVersion: null,
        oursMtime: 50,
        theirsMtime: 200,
      }),
    });
    expect(r).toEqual({ type: "atomic", side: "theirs" });
  });

  it("missing pluginJs context for a plugin path → register-conflict (defensive)", () => {
    const r = attemptAutoMerge({
      path: PLUGIN_PATH,
      ours: arr("//ours\n"),
      theirs: arr("//theirs\n"),
      base: null,
      configDir: CONFIG_DIR,
    });
    expect(r).toEqual({ type: "register-conflict" });
  });

  it("manifest.json is also routed to plugin-js (not text merge)", () => {
    const path = ".obsidian/plugins/my-plugin/manifest.json";
    const r = attemptAutoMerge({
      path,
      ours: arr('{"version":"1.0.0"}\n'),
      theirs: arr('{"version":"2.0.0"}\n'),
      base: arr('{"version":"1.0.0"}\n'),
      configDir: CONFIG_DIR,
      pluginJs: pluginCtx({ oursVersion: "1.0.0", theirsVersion: "2.0.0" }),
    });
    expect(r).toEqual({ type: "atomic", side: "theirs" });
  });
});

// ── attemptAutoMerge: binary always-register ─────────────────────────

describe("attemptAutoMerge — binary", () => {
  it("PNG → register-conflict (no silent atomic mtime)", () => {
    const r = attemptAutoMerge({
      path: "attachments/photo.png",
      ours: new Uint8Array([0x89, 0x50, 0x4e]).buffer as ArrayBuffer,
      theirs: new Uint8Array([0x89, 0x50, 0x4e, 0xff]).buffer as ArrayBuffer,
      base: new Uint8Array([0x89]).buffer as ArrayBuffer,
      configDir: CONFIG_DIR,
    });
    expect(r).toEqual({ type: "register-conflict" });
  });

  it("PDF → register-conflict", () => {
    const r = attemptAutoMerge({
      path: "docs/report.pdf",
      ours: new Uint8Array([0x25, 0x50, 0x44]).buffer as ArrayBuffer,
      theirs: new Uint8Array([0x25, 0x50, 0x44, 0xff]).buffer as ArrayBuffer,
      base: null,
      configDir: CONFIG_DIR,
    });
    expect(r).toEqual({ type: "register-conflict" });
  });

  it("mp4 → register-conflict", () => {
    const r = attemptAutoMerge({
      path: "video.mp4",
      ours: new Uint8Array([0x00, 0x00, 0x00, 0x18]).buffer as ArrayBuffer,
      theirs: new Uint8Array([0x00, 0x00, 0x00, 0x20]).buffer as ArrayBuffer,
      base: null,
      configDir: CONFIG_DIR,
    });
    expect(r).toEqual({ type: "register-conflict" });
  });
});

// ── strategy dispatch sanity ─────────────────────────────────────────

describe("attemptAutoMerge — strategy dispatch", () => {
  it("text path (.md) takes the text branch even when adjacent to a plugin folder", () => {
    const r = attemptAutoMerge({
      path: ".obsidian/plugins/foo/styles.css",
      ours: arr("a { color: red; }\n"),
      theirs: arr("a { color: red; }\n"),
      base: arr("a { color: red; }\n"),
      configDir: CONFIG_DIR,
    });
    // CSS counts as text. Identical content → clean merge.
    expect(r.type).toBe("clean");
  });

  it("non-text extension outside plugin folder → binary branch", () => {
    const r = attemptAutoMerge({
      path: "Vault/asset.bin",
      ours: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
      theirs: new Uint8Array([4, 5, 6]).buffer as ArrayBuffer,
      base: new Uint8Array([0]).buffer as ArrayBuffer,
      configDir: CONFIG_DIR,
    });
    expect(r).toEqual({ type: "register-conflict" });
  });

  it("plugin-js path under a different configDir is recognized", () => {
    const r = attemptAutoMerge({
      path: ".obs-custom/plugins/foo/main.js",
      ours: arr("//ours\n"),
      theirs: arr("//theirs\n"),
      base: null,
      configDir: ".obs-custom",
      pluginJs: pluginCtx({ oursVersion: "1.0.0", theirsVersion: "1.0.1" }),
    });
    expect(r).toEqual({ type: "atomic", side: "theirs" });
  });
});

// ── type-system sanity for AutoMergeResult ───────────────────────────

describe("AutoMergeResult type", () => {
  it("discriminated union is exhaustively narrowable", () => {
    const cases: AutoMergeResult[] = [
      { type: "clean", content: arr("") },
      { type: "atomic", side: "ours" },
      { type: "modify-wins" },
      { type: "register-conflict" },
    ];
    for (const c of cases) {
      if (c.type === "clean") {
        expect(c.content).toBeInstanceOf(ArrayBuffer);
      } else if (c.type === "atomic") {
        expect(["ours", "theirs"]).toContain(c.side);
      } else if (c.type === "modify-wins") {
        // no payload — its presence in the union is the assertion
      } else {
        // exhaustiveness
        const _exhaust: "register-conflict" = c.type;
        void _exhaust;
      }
    }
  });

  it("theirs === null → modify-wins (modify-vs-delete branch)", () => {
    const r = attemptAutoMerge({
      path: "Notes/note.md",
      ours: arr("local edit\n"),
      theirs: null,
      base: arr("shared\n"),
      configDir: ".obsidian",
    });
    expect(r).toEqual({ type: "modify-wins" });
  });
});
