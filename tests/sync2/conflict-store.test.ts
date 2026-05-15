import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import ConflictStore, {
  buildId,
  buildSiblingPath,
  extensionOf,
  ConflictRecord,
} from "../../src/sync2/conflict-store";
import { Vault } from "../../mock-obsidian";

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "github-easy-sync";
const DEVICE_LABEL = "test-device";

function fixture(): {
  root: string;
  vault: Vault;
  store: ConflictStore;
  conflictsRoot: string;
  clock: { tick: () => Date; set: (d: Date) => void };
} {
  const root = path.join(
    os.tmpdir(),
    `conflict-store-test-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  let current = new Date("2026-05-08T15:30:00.000Z");
  const clock = {
    tick: () => {
      const d = new Date(current);
      current = new Date(current.getTime() + 1000);
      return d;
    },
    set: (d: Date) => {
      current = d;
    },
  };
  const store = new ConflictStore({
    vault: vault as unknown as import("obsidian").Vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    now: () => clock.tick(),
  });
  const conflictsRoot = path.join(
    root,
    CONFIG_DIR,
    "plugins",
    SELF_PLUGIN_ID,
    ".conflicts",
  );
  return { root, vault, store, conflictsRoot, clock };
}

function writeVaultFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("buildId — push-queue-compatible 17-char timestamp", () => {
  it("formats as YYYYMMDDhhmmssfff in UTC", () => {
    const ts = Date.UTC(2026, 4, 8, 15, 30, 0, 123);
    expect(buildId(ts)).toBe("20260508153000123");
  });

  it("zero-pads each component", () => {
    const ts = Date.UTC(2026, 0, 1, 0, 0, 0, 5);
    expect(buildId(ts)).toBe("20260101000000005");
  });
});

describe("buildSiblingPath", () => {
  it("inserts label + iso-timestamp before the extension", () => {
    const ts = Date.UTC(2026, 4, 8, 15, 30, 0);
    expect(
      buildSiblingPath("Notes/note.md", "Phone", ts),
    ).toBe("Notes/note.conflict-from-Phone-2026-05-08T15-30-00Z.md");
  });

  it("colons in the ISO timestamp become dashes (Windows-safe)", () => {
    const ts = Date.UTC(2026, 4, 8, 15, 30, 0);
    const out = buildSiblingPath("note.md", "Phone", ts);
    expect(out).not.toContain(":");
  });

  it("milliseconds are dropped from the timestamp", () => {
    const ts = Date.UTC(2026, 4, 8, 15, 30, 0, 999);
    expect(buildSiblingPath("note.md", "Phone", ts)).toBe(
      "note.conflict-from-Phone-2026-05-08T15-30-00Z.md",
    );
  });

  it("preserves extension and parent directory verbatim", () => {
    const ts = Date.UTC(2026, 4, 8, 15, 30, 0);
    expect(buildSiblingPath("Folder/Sub/x.json", "P", ts)).toBe(
      "Folder/Sub/x.conflict-from-P-2026-05-08T15-30-00Z.json",
    );
  });

  it("file with no extension: suffix appended without a trailing dot", () => {
    const ts = Date.UTC(2026, 4, 8, 15, 30, 0);
    expect(buildSiblingPath("LICENSE", "P", ts)).toBe(
      "LICENSE.conflict-from-P-2026-05-08T15-30-00Z",
    );
  });

  it("device label with spaces / unicode is sanitized for filesystem", () => {
    const ts = Date.UTC(2026, 4, 8, 15, 30, 0);
    const out = buildSiblingPath("note.md", "My Phone (старий)", ts);
    // Anything not [a-zA-Z0-9_-] collapses to "_". The metadata keeps
    // the original label; only the filename is normalized.
    expect(out).toContain("My_Phone_");
    expect(out).not.toContain(" ");
    expect(out).not.toContain("(");
  });

  it("empty label falls back to 'unknown' (no `.conflict-from--`)", () => {
    const ts = Date.UTC(2026, 4, 8, 15, 30, 0);
    expect(buildSiblingPath("note.md", "", ts)).toBe(
      "note.conflict-from-unknown-2026-05-08T15-30-00Z.md",
    );
  });

  it("label of all-unsafe-chars sanitizes to '_' which we promote to 'unknown'", () => {
    const ts = Date.UTC(2026, 4, 8, 15, 30, 0);
    expect(buildSiblingPath("note.md", "***", ts)).toContain(
      "conflict-from-unknown-",
    );
  });

  it("uses LAST dot for extension split (`archive.tar.gz` → `.gz`)", () => {
    const ts = Date.UTC(2026, 4, 8, 15, 30, 0);
    expect(buildSiblingPath("archive.tar.gz", "P", ts)).toBe(
      "archive.tar.conflict-from-P-2026-05-08T15-30-00Z.gz",
    );
  });
});

describe("extensionOf", () => {
  it("returns extension with leading dot", () => {
    expect(extensionOf("note.md")).toBe(".md");
    expect(extensionOf("Folder/x.json")).toBe(".json");
  });

  it("empty for files without extension", () => {
    expect(extensionOf("LICENSE")).toBe("");
    expect(extensionOf("Folder/README")).toBe("");
  });

  it("dot in directory name does not count as extension", () => {
    expect(extensionOf("dot.dir/file")).toBe("");
  });

  it("uses last dot for multi-extension filenames", () => {
    expect(extensionOf("archive.tar.gz")).toBe(".gz");
  });
});

describe("ConflictStore", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  describe("create", () => {
    it("writes meta.json + base + theirs and a sibling vault file", async () => {
      writeVaultFile(f.root, "Notes/note.md", "ours\n");

      const r = await f.store.create({
        vaultPath: "Notes/note.md",
        baseContent: "shared\n",
        theirsContent: "theirs version\n",
        baseCommitSha: "deadbeef",
        theirsBlobSha: "cafef00d",
        theirsAuthor: DEVICE_LABEL,
      });

      expect(r.id).toMatch(/^\d{17}$/);
      expect(r.vaultPath).toBe("Notes/note.md");
      expect(r.deviceLabel).toBe(DEVICE_LABEL);
      expect(r.baseCommitSha).toBe("deadbeef");
      expect(r.theirsBlobSha).toBe("cafef00d");

      // Sibling exists in the vault with theirs content.
      const sibling = path.join(f.root, r.siblingPath);
      expect(fs.existsSync(sibling)).toBe(true);
      expect(fs.readFileSync(sibling, "utf8")).toBe("theirs version\n");

      // .conflicts/<id>/ has meta.json + base.md + theirs.md.
      const dir = path.join(f.conflictsRoot, r.id);
      expect(fs.existsSync(path.join(dir, "meta.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "base.md"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "theirs.md"))).toBe(true);

      expect(fs.readFileSync(path.join(dir, "base.md"), "utf8")).toBe(
        "shared\n",
      );
      expect(fs.readFileSync(path.join(dir, "theirs.md"), "utf8")).toBe(
        "theirs version\n",
      );

      // Original vault file untouched (ours stays put).
      expect(
        fs.readFileSync(path.join(f.root, "Notes/note.md"), "utf8"),
      ).toBe("ours\n");
    });

    it("indexes the record so hasPending / forPath / list see it immediately", async () => {
      const r = await f.store.create({
        vaultPath: "x.md",
        baseContent: "b",
        theirsContent: "t",
        baseCommitSha: null,
        theirsBlobSha: "sha",
        theirsAuthor: DEVICE_LABEL,
      });

      expect(f.store.hasPending("x.md")).toBe(true);
      expect(f.store.hasPending("y.md")).toBe(false);
      expect(f.store.forPath("x.md")).toEqual([r]);
      expect(f.store.list()).toEqual([r]);
      expect(f.store.get(r.id)).toEqual(r);
      expect(f.store.pendingPaths()).toEqual(["x.md"]);
    });

    it("two conflicts on the same path: both indexed, forPath returns both ordered by ts", async () => {
      writeVaultFile(f.root, "x.md", "ours\n");
      const r1 = await f.store.create({
        vaultPath: "x.md",
        baseContent: "b1",
        theirsContent: "t1",
        baseCommitSha: null,
        theirsBlobSha: "sha1",
        theirsAuthor: DEVICE_LABEL,
      });
      const r2 = await f.store.create({
        vaultPath: "x.md",
        baseContent: "b2",
        theirsContent: "t2",
        baseCommitSha: null,
        theirsBlobSha: "sha2",
        theirsAuthor: DEVICE_LABEL,
      });
      const list = f.store.forPath("x.md");
      expect(list.map((r) => r.id)).toEqual([r1.id, r2.id]);
      expect(r1.siblingPath).not.toBe(r2.siblingPath); // distinct timestamps
    });

    it("colliding millisecond ids step forward, both directories survive", async () => {
      // Lock the clock so two creates see the same timestamp; the
      // store should bump the second id forward by a millisecond.
      const fixed = new Date("2026-06-01T00:00:00.000Z");
      f.clock.set(fixed);
      const r1 = await f.store.create({
        vaultPath: "a.md",
        baseContent: "b",
        theirsContent: "t",
        baseCommitSha: null,
        theirsBlobSha: "sha",
        theirsAuthor: DEVICE_LABEL,
      });
      f.clock.set(fixed);
      const r2 = await f.store.create({
        vaultPath: "b.md",
        baseContent: "b",
        theirsContent: "t",
        baseCommitSha: null,
        theirsBlobSha: "sha",
        theirsAuthor: DEVICE_LABEL,
      });
      expect(r2.id).not.toBe(r1.id);
      expect(r2.id > r1.id).toBe(true);
      expect(fs.existsSync(path.join(f.conflictsRoot, r1.id))).toBe(true);
      expect(fs.existsSync(path.join(f.conflictsRoot, r2.id))).toBe(true);
    });
  });

  describe("load", () => {
    it("re-loading after fresh construction sees previously-created records", async () => {
      const r = await f.store.create({
        vaultPath: "x.md",
        baseContent: "b",
        theirsContent: "t",
        baseCommitSha: null,
        theirsBlobSha: "sha",
        theirsAuthor: DEVICE_LABEL,
      });

      // Spin up a second store against the same vault, simulating
      // plugin reload.
      const store2 = new ConflictStore({
        vault: f.vault as unknown as import("obsidian").Vault,
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
      });
      await store2.load();

      expect(store2.hasPending("x.md")).toBe(true);
      expect(store2.list().map((rec) => rec.id)).toEqual([r.id]);
      expect(store2.get(r.id)?.theirsBlobSha).toBe("sha");
    });

    it("orphan record (sibling file gone) is cleaned up on load", async () => {
      // Create a conflict, then delete the sibling file outside any
      // listener (simulating "user deleted via vim/cli while Obsidian
      // was closed"). On the next plugin load, the conflict-store
      // should treat the record as implicitly resolved.
      const r = await f.store.create({
        vaultPath: "x.md",
        baseContent: "b",
        theirsContent: "t",
        baseCommitSha: null,
        theirsBlobSha: "sha",
        theirsAuthor: DEVICE_LABEL,
      });
      fs.rmSync(path.join(f.root, r.siblingPath));

      const store2 = new ConflictStore({
        vault: f.vault as unknown as import("obsidian").Vault,
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
      });
      await store2.load();

      expect(store2.hasPending("x.md")).toBe(false);
      expect(store2.list()).toEqual([]);
      // Conflict folder physically gone.
      expect(
        fs.existsSync(path.join(f.conflictsRoot, r.id)),
      ).toBe(false);
    });

    it("ignores non-conflict folders inside .conflicts/ root", async () => {
      // Drop a stray dir that doesn't match the 17-digit pattern.
      fs.mkdirSync(path.join(f.conflictsRoot, "scratch"), { recursive: true });
      fs.writeFileSync(
        path.join(f.conflictsRoot, "scratch", "meta.json"),
        "{}",
      );
      await f.store.load();
      expect(f.store.list()).toEqual([]);
    });

    it("malformed meta.json is skipped silently", async () => {
      const id = "20260508153000000";
      fs.mkdirSync(path.join(f.conflictsRoot, id), { recursive: true });
      fs.writeFileSync(
        path.join(f.conflictsRoot, id, "meta.json"),
        "not-valid-json",
      );
      await expect(f.store.load()).resolves.not.toThrow();
      expect(f.store.list()).toEqual([]);
    });

    it("incomplete meta.json (missing fields) is skipped silently", async () => {
      const id = "20260508153000001";
      fs.mkdirSync(path.join(f.conflictsRoot, id), { recursive: true });
      fs.writeFileSync(
        path.join(f.conflictsRoot, id, "meta.json"),
        JSON.stringify({ id, vaultPath: "x.md" /* missing rest */ }),
      );
      await f.store.load();
      expect(f.store.list()).toEqual([]);
    });

    it("re-load() after in-memory state was populated discards stale entries", async () => {
      await f.store.create({
        vaultPath: "x.md",
        baseContent: "b",
        theirsContent: "t",
        baseCommitSha: null,
        theirsBlobSha: "sha",
        theirsAuthor: DEVICE_LABEL,
      });
      // Wipe the on-disk state without going through resolve().
      fs.rmSync(f.conflictsRoot, { recursive: true });
      await f.store.load();
      expect(f.store.list()).toEqual([]);
      expect(f.store.hasPending("x.md")).toBe(false);
    });
  });

  describe("readBase / readTheirs", () => {
    it("returns the captured snapshots verbatim", async () => {
      const r = await f.store.create({
        vaultPath: "x.md",
        baseContent: "BASE-content\n",
        theirsContent: "THEIRS-content\n",
        baseCommitSha: null,
        theirsBlobSha: "sha",
        theirsAuthor: DEVICE_LABEL,
      });
      expect(await f.store.readBase(r.id)).toBe("BASE-content\n");
      expect(await f.store.readTheirs(r.id)).toBe("THEIRS-content\n");
    });

    it("throws on unknown id", async () => {
      await expect(f.store.readBase("does-not-exist")).rejects.toThrow();
    });
  });

  describe("resolve", () => {
    it("removes the .conflicts/<id>/ dir and the sibling file", async () => {
      const r = await f.store.create({
        vaultPath: "x.md",
        baseContent: "b",
        theirsContent: "t",
        baseCommitSha: null,
        theirsBlobSha: "sha",
        theirsAuthor: DEVICE_LABEL,
      });
      expect(fs.existsSync(path.join(f.root, r.siblingPath))).toBe(true);
      expect(fs.existsSync(path.join(f.conflictsRoot, r.id))).toBe(true);

      await f.store.resolve(r.id);

      expect(fs.existsSync(path.join(f.root, r.siblingPath))).toBe(false);
      expect(fs.existsSync(path.join(f.conflictsRoot, r.id))).toBe(false);
      expect(f.store.hasPending("x.md")).toBe(false);
    });

    it("is a no-op for unknown ids", async () => {
      await expect(f.store.resolve("does-not-exist")).resolves.not.toThrow();
    });

    it("only removes the resolved record; siblings of other conflicts on the same path stay", async () => {
      const r1 = await f.store.create({
        vaultPath: "x.md",
        baseContent: "b1",
        theirsContent: "t1",
        baseCommitSha: null,
        theirsBlobSha: "sha1",
        theirsAuthor: DEVICE_LABEL,
      });
      const r2 = await f.store.create({
        vaultPath: "x.md",
        baseContent: "b2",
        theirsContent: "t2",
        baseCommitSha: null,
        theirsBlobSha: "sha2",
        theirsAuthor: DEVICE_LABEL,
      });
      await f.store.resolve(r1.id);
      expect(f.store.hasPending("x.md")).toBe(true);
      expect(f.store.list().map((r) => r.id)).toEqual([r2.id]);
      expect(fs.existsSync(path.join(f.root, r2.siblingPath))).toBe(true);
    });

    it("survives a sibling that the user already deleted by hand", async () => {
      // If the user manually deletes the sibling file before resolve()
      // is called, resolve must not throw — it only cleans whatever's
      // still on disk.
      const r = await f.store.create({
        vaultPath: "x.md",
        baseContent: "b",
        theirsContent: "t",
        baseCommitSha: null,
        theirsBlobSha: "sha",
        theirsAuthor: DEVICE_LABEL,
      });
      fs.rmSync(path.join(f.root, r.siblingPath));
      await expect(f.store.resolve(r.id)).resolves.not.toThrow();
      expect(fs.existsSync(path.join(f.conflictsRoot, r.id))).toBe(false);
    });
  });

  describe("notifySiblingDeleted", () => {
    it("returns true and clears the record when a known sibling path is deleted", async () => {
      const r = await f.store.create({
        vaultPath: "x.md",
        baseContent: "b",
        theirsContent: "t",
        baseCommitSha: null,
        theirsBlobSha: "sha",
        theirsAuthor: DEVICE_LABEL,
      });

      // Simulate user-driven delete: remove sibling from disk first
      // (mirroring vault.on("delete") timing), then notify.
      fs.rmSync(path.join(f.root, r.siblingPath));
      const result = await f.store.notifySiblingDeleted(r.siblingPath);

      expect(result).toBe(true);
      expect(fs.existsSync(path.join(f.conflictsRoot, r.id))).toBe(false);
      expect(f.store.hasPending("x.md")).toBe(false);
    });

    it("returns false for a path that is not a known sibling", async () => {
      const result = await f.store.notifySiblingDeleted(
        "Notes/random.md",
      );
      expect(result).toBe(false);
    });

    it("survives if .conflicts/<id>/ was already cleaned up out of band", async () => {
      const r = await f.store.create({
        vaultPath: "x.md",
        baseContent: "b",
        theirsContent: "t",
        baseCommitSha: null,
        theirsBlobSha: "sha",
        theirsAuthor: DEVICE_LABEL,
      });
      fs.rmSync(path.join(f.conflictsRoot, r.id), { recursive: true });
      fs.rmSync(path.join(f.root, r.siblingPath));
      await expect(
        f.store.notifySiblingDeleted(r.siblingPath),
      ).resolves.toBe(true);
      expect(f.store.hasPending("x.md")).toBe(false);
    });
  });

  describe("siblingPath naming follows extension and label rules", () => {
    it("preserves the original .json extension on the sibling and snapshot files", async () => {
      const r = await f.store.create({
        vaultPath: "config.json",
        baseContent: "{}\n",
        theirsContent: '{"x":1}\n',
        baseCommitSha: null,
        theirsBlobSha: "sha",
        theirsAuthor: DEVICE_LABEL,
      });
      expect(r.siblingPath.endsWith(".json")).toBe(true);
      expect(
        fs.existsSync(path.join(f.conflictsRoot, r.id, "base.json")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(f.conflictsRoot, r.id, "theirs.json")),
      ).toBe(true);
    });

    it("file with no extension: snapshot files have no extension either", async () => {
      const r = await f.store.create({
        vaultPath: "LICENSE",
        baseContent: "MIT\n",
        theirsContent: "Apache-2.0\n",
        baseCommitSha: null,
        theirsBlobSha: "sha",
        theirsAuthor: DEVICE_LABEL,
      });
      expect(r.siblingPath).toMatch(/^LICENSE\.conflict-from-/);
      expect(
        fs.existsSync(path.join(f.conflictsRoot, r.id, "base")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(f.conflictsRoot, r.id, "theirs")),
      ).toBe(true);
    });

    it("theirsAuthor with parens / spaces survives in metadata; sanitized in the sibling filename", async () => {
      const f2 = fixture();
      try {
        const r = await f2.store.create({
          vaultPath: "x.md",
          baseContent: "b",
          theirsContent: "t",
          baseCommitSha: null,
          theirsBlobSha: "sha",
          // Per-conflict author — typically parsed by the caller
          // from the GitHub HEAD commit's " (label)" suffix. The
          // raw label survives unchanged in metadata; the filename
          // gets the buildSiblingPath sanitisation.
          theirsAuthor: "My Phone (старий)",
        });
        expect(r.deviceLabel).toBe("My Phone (старий)");
        expect(r.siblingPath).toContain("My_Phone_");
        expect(r.siblingPath).not.toContain(" ");
      } finally {
        fs.rmSync(f2.root, { recursive: true, force: true });
      }
    });

    it("empty theirsAuthor falls back to 'unknown' in both metadata and sibling filename", async () => {
      const f2 = fixture();
      try {
        const r = await f2.store.create({
          vaultPath: "x.md",
          baseContent: "b",
          theirsContent: "t",
          baseCommitSha: null,
          theirsBlobSha: "sha",
          // Empty string — happens when parseDeviceSuffix runs on
          // a hand-edited GitHub commit that didn't end with the
          // " (label)" suffix sync2 normally appends.
          theirsAuthor: "",
        });
        // One sentinel everywhere — same string in metadata and in
        // the filename — so a viewer reading either surface gets a
        // consistent answer.
        expect(r.deviceLabel).toBe("unknown");
        expect(r.siblingPath).toContain("conflict-from-unknown-");
      } finally {
        fs.rmSync(f2.root, { recursive: true, force: true });
      }
    });
  });
});
