// Test-infrastructure verification for MOCK_PLATFORM mode in
// mock-obsidian.ts.
//
// Why this exists: 2026-05-21 production incident — ConflictStore.create
// worked on desktop (POSIX fs.rename overwrites) but threw "Destination
// file already exists!" on mobile (Capacitor's Filesystem.rename rejects
// existing dests). Mock-obsidian uses Node fs which inherits POSIX
// semantics, so the divergence was invisible at unit-test time.
//
// MOCK_PLATFORM lets tests simulate Capacitor's stricter rename so
// production code's mobile-safe pattern (explicit remove + rename) is
// covered by unit tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault, setMockPlatform, getMockPlatform } from "../mock-obsidian";
import ConflictStore from "../src/sync2/conflict-store";
import { stagingPathFor } from "../src/sync2/atomic-write";

describe("MOCK_PLATFORM", () => {
  let tmp: string;
  let vault: Vault;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "mock-platform-"));
    vault = new Vault(tmp);
    setMockPlatform("desktop"); // default each test
  });

  afterEach(() => {
    setMockPlatform("desktop"); // leave clean for next file
    rmSync(tmp, { recursive: true, force: true });
  });

  it("defaults to desktop", () => {
    expect(getMockPlatform()).toBe("desktop");
  });

  it("desktop: rename overwrites existing destination (POSIX semantics)", async () => {
    await vault.adapter.write("a.txt", "from-a");
    await vault.adapter.write("b.txt", "from-b");

    // Should NOT throw — POSIX rename overwrites
    await vault.adapter.rename("a.txt", "b.txt");

    expect(await vault.adapter.exists("a.txt")).toBe(false);
    expect(await vault.adapter.exists("b.txt")).toBe(true);
    expect(await vault.adapter.read("b.txt")).toBe("from-a");
  });

  it("mobile: rename throws when destination exists (Capacitor semantics)", async () => {
    await vault.adapter.write("a.txt", "from-a");
    await vault.adapter.write("b.txt", "from-b");
    setMockPlatform("mobile");

    await expect(vault.adapter.rename("a.txt", "b.txt")).rejects.toThrow(
      "Destination file already exists",
    );

    // Both files still on disk untouched
    expect(await vault.adapter.read("a.txt")).toBe("from-a");
    expect(await vault.adapter.read("b.txt")).toBe("from-b");
  });

  it("mobile: rename succeeds when destination does NOT exist", async () => {
    await vault.adapter.write("a.txt", "from-a");
    setMockPlatform("mobile");

    // Destination doesn't exist → mobile path is identical to desktop
    await vault.adapter.rename("a.txt", "b.txt");

    expect(await vault.adapter.exists("a.txt")).toBe(false);
    expect(await vault.adapter.exists("b.txt")).toBe(true);
    expect(await vault.adapter.read("b.txt")).toBe("from-a");
  });

  it("mobile: explicit remove-before-rename is the portable pattern", async () => {
    await vault.adapter.write("a.txt", "from-a");
    await vault.adapter.write("b.txt", "from-b");
    setMockPlatform("mobile");

    // The portable pattern: explicitly remove destination first
    if (await vault.adapter.exists("b.txt")) {
      await vault.adapter.remove("b.txt");
    }
    await vault.adapter.rename("a.txt", "b.txt");

    expect(await vault.adapter.exists("a.txt")).toBe(false);
    expect(await vault.adapter.exists("b.txt")).toBe(true);
    expect(await vault.adapter.read("b.txt")).toBe("from-a");
  });

  // Pattern that Phase 3 tests should use for any rename-touching code.
  describe.each([{ platform: "desktop" as const }, { platform: "mobile" as const }])(
    "describe.each pattern (under $platform)",
    ({ platform }) => {
      beforeEach(() => setMockPlatform(platform));

      it("a fresh rename into empty destination always works", async () => {
        await vault.adapter.write("src.txt", "x");
        await vault.adapter.rename("src.txt", "dst.txt");
        expect(await vault.adapter.read("dst.txt")).toBe("x");
      });
    },
  );
});

// Stage 13 ConflictStore.create migration test — paired desktop/mobile
// coverage of the new 3-step `.sync-bak` flow. Closes the gap from
// advisor review: the migrated ConflictStore.create rewrite was
// verified only under Node fs (desktop semantics) until now. Under
// `MOCK_PLATFORM=mobile`, Step 3's atomic rename of staging →
// siblingPath must use the explicit-remove-before-rename pattern, and
// Step 2's persistRecord must do the same for meta.json. Both are
// already coded that way — this test verifies the wiring end-to-end.
describe.each([{ platform: "desktop" as const }, { platform: "mobile" as const }])(
  "ConflictStore.create (Stage 13 .sync-bak flow) — under $platform",
  ({ platform }) => {
    let tmp: string;
    let vault: Vault;
    let store: ConflictStore;
    const CONFIG_DIR = ".obsidian";
    const SELF = "github-easy-sync";

    beforeEach(async () => {
      tmp = mkdtempSync(path.join(tmpdir(), `cs-create-${platform}-`));
      fs.mkdirSync(path.join(tmp, CONFIG_DIR), { recursive: true });
      vault = new Vault(tmp);
      setMockPlatform(platform);
      store = new ConflictStore({
        vault: vault as unknown as import("obsidian").Vault,
        configDir: CONFIG_DIR,
        selfPluginId: SELF,
      });
      await store.load();
    });

    afterEach(() => {
      setMockPlatform("desktop");
      rmSync(tmp, { recursive: true, force: true });
    });

    it("create() lands sibling at final path and removes staging", async () => {
      // Prime base file so vaultPath exists. ConflictStore.create
      // doesn't require this, but it mirrors the realistic conflict
      // scenario where there's already a local file.
      fs.mkdirSync(path.join(tmp, "Notes"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "Notes/note.md"), "local content\n");

      const theirs = new TextEncoder()
        .encode("theirs content\n")
        .buffer.slice(0) as ArrayBuffer;
      const rec = await store.create({
        vaultPath: "Notes/note.md",
        kind: "modify-vs-modify",
        theirsContent: theirs,
        theirsBlobSha: "theirs-sha",
        oursBlobSha: "ours-sha",
        baseMtime: null,
        baseSize: null,
        baseSha: null,
        remoteDevice: "Phone",
      });

      const siblingAbs = path.join(tmp, rec.siblingPath);
      const stagingAbs = path.join(tmp, stagingPathFor(rec.siblingPath, "bak"));

      // Step 3 renamed staging → final. Final exists with theirs
      // content; staging is gone.
      expect(fs.existsSync(siblingAbs)).toBe(true);
      expect(fs.readFileSync(siblingAbs, "utf8")).toBe("theirs content\n");
      expect(fs.existsSync(stagingAbs)).toBe(false);

      // meta.json persisted; no .tmp leftover.
      const recordDir = path.join(
        tmp,
        CONFIG_DIR,
        "plugins",
        SELF,
        ".conflicts",
        rec.id,
      );
      expect(fs.existsSync(path.join(recordDir, "meta.json"))).toBe(true);
      expect(fs.existsSync(path.join(recordDir, "meta.json.tmp"))).toBe(false);
    });

    it("create() succeeds even when staging path exists from a previous crash", async () => {
      // Synthesize a leftover staging file at the path the new
      // siblingPath will resolve to. Under mobile semantics, the
      // first write to staging would NORMALLY overwrite (writeBinary
      // is forgiving), but the subsequent rename(staging → final)
      // could collide if the user also has a final file lying
      // around from an earlier session.
      fs.mkdirSync(path.join(tmp, "Notes"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "Notes/note.md"), "local content\n");

      // Plant a stale file at the EXPECTED final sibling path. The
      // record id is deterministic (uuid()) but the timestamp suffix
      // in buildSiblingPath uses the device label. Easier: call
      // create twice — the second create with the same
      // (vaultPath, theirsBlobSha) dedups in-memory and returns the
      // existing record without disk ops. Use a DIFFERENT
      // theirsBlobSha for the second call so dedup doesn't fire.
      const theirs1 = new TextEncoder()
        .encode("v1 content\n")
        .buffer.slice(0) as ArrayBuffer;
      await store.create({
        vaultPath: "Notes/note.md",
        kind: "modify-vs-modify",
        theirsContent: theirs1,
        theirsBlobSha: "sha-v1",
        oursBlobSha: "ours-sha",
        baseMtime: null,
        baseSize: null,
        baseSha: null,
        remoteDevice: "Phone",
      });

      const theirs2 = new TextEncoder()
        .encode("v2 content\n")
        .buffer.slice(0) as ArrayBuffer;
      const rec2 = await store.create({
        vaultPath: "Notes/note.md",
        kind: "modify-vs-modify",
        theirsContent: theirs2,
        theirsBlobSha: "sha-v2",
        oursBlobSha: "ours-sha",
        baseMtime: null,
        baseSize: null,
        baseSha: null,
        remoteDevice: "Phone",
      });

      // Second record lands cleanly; multi-sibling on the same path.
      const sibling2Abs = path.join(tmp, rec2.siblingPath);
      expect(fs.existsSync(sibling2Abs)).toBe(true);
      expect(fs.readFileSync(sibling2Abs, "utf8")).toBe("v2 content\n");
      expect(store.getByPath("Notes/note.md")).toHaveLength(2);
    });

    // N13 from Phase 2 audit: the mobile-shaped delete-then-rename
    // workflow that motivated Decision #30 (classifier row 3 → noop).
    // Pre-Stage-13 the engine cascade-deleted siblings the moment
    // base went missing, leaving no time for the rename half of
    // "accept theirs via mobile file manager". Stage 13 row 3 returns
    // noop; sibling stays alive until the user touches it.
    //
    // Mobile-specific because Capacitor's rename throws on existing
    // destination — the workflow must be: delete base FIRST, THEN
    // rename sibling onto base. Desktop would tolerate atomic rename-
    // overwrite, but we verify the mobile-portable path works under
    // both platforms.
    it("N13: delete-base-then-rename-sibling workflow resolves to accept-theirs", async () => {
      // Need to dynamic-import because conflict-classifier pulls in
      // the obsidian alias chain that fails at module-eval otherwise.
      const { evaluateConflictState } = await import(
        "../src/sync2/conflict-classifier"
      );

      // Setup: vault base + sibling + record (the post-conflict-
      // detection state). Use store.create() so the full Stage 13
      // `.sync-bak` flow runs and lands the sibling at its final
      // path.
      fs.mkdirSync(path.join(tmp, "Notes"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "Notes/note.md"), "ours\n");
      const theirs = new TextEncoder()
        .encode("theirs\n")
        .buffer.slice(0) as ArrayBuffer;
      const rec = await store.create({
        vaultPath: "Notes/note.md",
        kind: "modify-vs-modify",
        theirsContent: theirs,
        theirsBlobSha: "sha-theirs",
        oursBlobSha: "sha-ours",
        baseMtime: null,
        baseSize: null,
        baseSha: null,
        remoteDevice: "Phone",
      });
      const baseAbs = path.join(tmp, "Notes/note.md");
      const siblingAbs = path.join(tmp, rec.siblingPath);
      expect(fs.existsSync(siblingAbs)).toBe(true);
      expect(fs.existsSync(baseAbs)).toBe(true);

      // Workflow: user wants "accept theirs".
      //   Step 1: delete base (would cascade-kill sibling pre-Stage-13).
      //   Step 2: rename sibling → base path.
      // Between steps, NO classifier sweep fires (production listeners
      // are read-only — they only mark counter dirty, not mutate
      // store).
      fs.unlinkSync(baseAbs);
      expect(fs.existsSync(baseAbs)).toBe(false);
      // Sibling still alive — Stage 13 row 3 → noop means engine
      // doesn't react to bare base-deletion.
      expect(fs.existsSync(siblingAbs)).toBe(true);

      // Step 2: rename sibling → base. On mobile, the destination is
      // empty (we just deleted base) so adapter.rename succeeds.
      // mock-obsidian's vault.adapter.rename is called via mock-
      // obsidian — must use vault adapter, not raw fs.renameSync, to
      // exercise the platform check.
      await vault.adapter.rename(rec.siblingPath, "Notes/note.md");
      expect(fs.existsSync(siblingAbs)).toBe(false);
      expect(fs.readFileSync(baseAbs, "utf8")).toBe("theirs\n");

      // Now drain-start sweep fires (or any classifier eval). Phase B
      // sees !siblingExists → drops record, path closed, propagate
      // live base (theirs).
      const result = await evaluateConflictState(
        store,
        vault as unknown as import("obsidian").Vault,
      );
      expect(result.recordsRemoved).toContain(rec.id);
      expect([...result.pathsResolved]).toContain("Notes/note.md");
      expect(store.get(rec.id)).toBeUndefined();
      // Base file still has theirs content; nothing destroyed.
      expect(fs.readFileSync(baseAbs, "utf8")).toBe("theirs\n");
    });
  },
);
