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
import { Vault } from "../../mock-obsidian";
import SnapshotStore from "../../src/sync2/snapshot-store";
import {
  atomicWriteFile,
  AtomicWriteRecovery,
  SYNC_TMP_SUFFIX,
  SYNC_BAK_SUFFIX,
  stagingPathFor,
} from "../../src/sync2/atomic-write";
import { calculateGitBlobSHA } from "../../src/utils";

// Atomic-write protocol covered here:
//
//   atomicWriteFile(vault, path, bytes, afterCommit?)
//
// Sequence:
//   1. writeBinary(<path>.sync-tmp, bytes)
//   2. if exists(<path>): rename(<path>, <path>.sync-bak)
//   3. rename(<path>.sync-tmp, <path>)
//   4. afterCommit()  ← snapshot.recordSync, typically
//   5. remove(<path>.sync-bak)
//
// Crash-recovery sweep (post-Stage-13, suffix semantics corrected):
//   *.sync-tmp:                           dispatch by ownership via
//                                         ConflictStore.getBySibling
//     no record (Path A transient)        → delete (junk)
//     record + finalPath exists           → delete (Step 3 done, stale)
//     record + finalPath missing, SHA ok  → rename .sync-tmp → finalPath
//     record + finalPath missing, SHA bad → delete (record drops later)
//   *.sync-bak (Path A only, no dispatch):
//     no <file>                           → restore from .sync-bak
//     <file> + SHA == snapshot.remoteSha  → delete .sync-bak [cleanup race]
//     <file> + SHA mismatch               → restore from .sync-bak
//     <file>, no snapshot entry           → restore from .sync-bak (conservative)

function fixture(): {
  root: string;
  vault: Vault;
  store: SnapshotStore;
  cleanup: () => void;
} {
  const root = path.join(
    os.tmpdir(),
    `atomic-write-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
  const vault = new Vault(root);
  const store = new SnapshotStore(
    vault as unknown as import("obsidian").Vault,
  );
  return {
    root,
    vault,
    store,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {}
    },
  };
}

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function readText(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

async function shaOf(text: string): Promise<string> {
  return await calculateGitBlobSHA(bytesOf(text));
}

describe("atomicWriteFile", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    f.cleanup();
  });

  it("brand-new file: writes bytes; .sync-tmp and .sync-bak are gone afterwards", async () => {
    await atomicWriteFile(
      f.vault as unknown as import("obsidian").Vault,
      "Notes/note.md",
      bytesOf("hello\n"),
    );
    expect(readText(f.root, "Notes/note.md")).toBe("hello\n");
    expect(fs.existsSync(path.join(f.root, "Notes/note.sync-tmp.md"))).toBe(false);
    expect(fs.existsSync(path.join(f.root, "Notes/note.sync-bak.md"))).toBe(false);
  });

  it("existing file: replaces content; old version backed up then cleaned", async () => {
    fs.writeFileSync(path.join(f.root, "x.md"), "v1\n");
    await atomicWriteFile(
      f.vault as unknown as import("obsidian").Vault,
      "x.md",
      bytesOf("v2\n"),
    );
    expect(readText(f.root, "x.md")).toBe("v2\n");
    expect(fs.existsSync(path.join(f.root, "x.sync-tmp.md"))).toBe(false);
    expect(fs.existsSync(path.join(f.root, "x.sync-bak.md"))).toBe(false);
  });

  it("afterCommit runs after the file is in place but before backup cleanup", async () => {
    // Strict invariant: at the time afterCommit fires, the install
    // is committed AND .sync-bak still exists. The cleanup is what
    // races against the user-perspective "we're done"; afterCommit
    // sees the canonical post-install state.
    fs.writeFileSync(path.join(f.root, "x.md"), "v1");
    const observed: Array<{
      fileContent: string;
      bakExists: boolean;
    }> = [];
    await atomicWriteFile(
      f.vault as unknown as import("obsidian").Vault,
      "x.md",
      bytesOf("v2"),
      async () => {
        observed.push({
          fileContent: readText(f.root, "x.md"),
          bakExists: fs.existsSync(path.join(f.root, "x.sync-bak.md")),
        });
      },
    );
    expect(observed).toEqual([{ fileContent: "v2", bakExists: true }]);
    // Post-afterCommit: cleanup ran.
    expect(fs.existsSync(path.join(f.root, "x.sync-bak.md"))).toBe(false);
  });

  it("stale .sync-bak from a previous crash is overwritten by the rename-aside step", async () => {
    // Setup: file exists at canonical path AND a leftover .sync-bak
    // from a previous crash sits next to it. atomicWriteFile must
    // not throw on the rename(file → bak) collision.
    fs.writeFileSync(path.join(f.root, "x.md"), "current");
    fs.writeFileSync(path.join(f.root, "x.sync-bak.md"), "leftover");
    await atomicWriteFile(
      f.vault as unknown as import("obsidian").Vault,
      "x.md",
      bytesOf("v3"),
    );
    expect(readText(f.root, "x.md")).toBe("v3");
    expect(fs.existsSync(path.join(f.root, "x.sync-bak.md"))).toBe(false);
  });

  it("stale .sync-tmp from a previous crash is silently overwritten", async () => {
    fs.writeFileSync(path.join(f.root, "x.sync-tmp.md"), "old partial");
    await atomicWriteFile(
      f.vault as unknown as import("obsidian").Vault,
      "x.md",
      bytesOf("fresh"),
    );
    expect(readText(f.root, "x.md")).toBe("fresh");
    expect(fs.existsSync(path.join(f.root, "x.sync-tmp.md"))).toBe(false);
  });
});

describe("AtomicWriteRecovery.sweep", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    f.cleanup();
  });

  it("orphan .sync-tmp without ConflictStore in scope: dropped (Path A transient)", async () => {
    fs.writeFileSync(path.join(f.root, "x.sync-tmp.md"), "partial");
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result.cleaned).toBe(1);
    expect(result.restored).toBe(0);
    expect(fs.existsSync(path.join(f.root, "x.sync-tmp.md"))).toBe(false);
  });

  it("only .sync-bak (no original): restored to canonical path", async () => {
    // Crash between step 2 (rename → bak) and step 3 (rename tmp →
    // file): backup is the only intact copy.
    fs.writeFileSync(path.join(f.root, "x.sync-bak.md"), "previous");
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result.cleaned).toBe(0);
    expect(result.restored).toBe(1);
    expect(readText(f.root, "x.md")).toBe("previous");
    expect(fs.existsSync(path.join(f.root, "x.sync-bak.md"))).toBe(false);
  });

  it("both .sync-bak AND original, file matches snapshot: backup is cleaned up", async () => {
    // Crash between step 4 (recordSync) and step 5 (cleanup .sync-bak):
    // the install is committed AND the snapshot is updated, but the
    // cleanup didn't run. Recovery detects the SHA match and drops
    // the backup.
    fs.writeFileSync(path.join(f.root, "x.md"), "v2");
    fs.writeFileSync(path.join(f.root, "x.sync-bak.md"), "v1");
    f.store.set("x.md", {
      path: "x.md",
      remoteSha: await shaOf("v2"),
      mtime: 0,
      size: 2,
    });
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result.cleaned).toBe(1);
    expect(result.restored).toBe(0);
    expect(readText(f.root, "x.md")).toBe("v2");
    expect(fs.existsSync(path.join(f.root, "x.sync-bak.md"))).toBe(false);
  });

  it("both files exist, file mismatches snapshot: restore backup", async () => {
    // Crash between step 3 (rename tmp → file) and step 4
    // (recordSync): file is new bytes, snapshot still has OLD sha.
    // The mismatch tells us we can't trust the install — restore.
    fs.writeFileSync(path.join(f.root, "x.md"), "newPartialOrNotCommitted");
    fs.writeFileSync(path.join(f.root, "x.sync-bak.md"), "previous-good");
    f.store.set("x.md", {
      path: "x.md",
      remoteSha: await shaOf("previous-good"),
      mtime: 0,
      size: 13,
    });
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result.cleaned).toBe(0);
    expect(result.restored).toBe(1);
    expect(readText(f.root, "x.md")).toBe("previous-good");
    expect(fs.existsSync(path.join(f.root, "x.sync-bak.md"))).toBe(false);
  });

  it("both files exist, no snapshot entry: conservative restore", async () => {
    // We can't verify; backup is the trustable copy.
    fs.writeFileSync(path.join(f.root, "x.md"), "unverified");
    fs.writeFileSync(path.join(f.root, "x.sync-bak.md"), "known-good");
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result.cleaned).toBe(0);
    expect(result.restored).toBe(1);
    expect(readText(f.root, "x.md")).toBe("known-good");
  });

  it("recursive walk: finds artifacts deep in subfolders", async () => {
    // Real vaults have nested folders; sweep must reach them all.
    fs.mkdirSync(path.join(f.root, "Notes/Sub/Deep"), { recursive: true });
    fs.writeFileSync(path.join(f.root, "Notes/Sub/Deep/a.sync-tmp.md"), "x");
    fs.writeFileSync(path.join(f.root, "Notes/Sub/b.sync-bak.md"), "y");
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result.cleaned).toBe(1); // a.sync-tmp.md
    expect(result.restored).toBe(1); // b.sync-bak.md → b.md
    expect(
      fs.existsSync(path.join(f.root, "Notes/Sub/Deep/a.sync-tmp.md")),
    ).toBe(false);
    expect(readText(f.root, "Notes/Sub/b.md")).toBe("y");
  });

  it("no artifacts in vault: sweep is a no-op", async () => {
    fs.writeFileSync(path.join(f.root, "regular.md"), "no artifacts");
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result).toEqual({ cleaned: 0, restored: 0 });
  });

  it("constants exported: SYNC_TMP_SUFFIX / SYNC_BAK_SUFFIX match the file suffixes", () => {
    // Pin the suffix shape so callers (gitignore-invariants etc.)
    // can reference the same constants without drift.
    expect(SYNC_TMP_SUFFIX).toBe(".sync-tmp");
    expect(SYNC_BAK_SUFFIX).toBe(".sync-bak");
  });
});

// ─── Stage 13 Phase 3 RED tests (Group 4: .sync-bak migration) ─────────
//
// stagingPathFor() — pre-suffix insertion algorithm (PSEUDO-MERGE-MODE.md
// §"Naming convention для staging файлів — `.sync-bak` як pre-suffix").
//
// All currently FAIL with "Not implemented" — proper RED state from
// Phase 1.7 stub. Phase 4 Group 4 implementation fills in the body.
describe("stagingPathFor (Stage 13)", () => {
  it("N8: normal file → inserts .sync-bak before the extension", () => {
    expect(stagingPathFor("Folder/note.md")).toBe("Folder/note.sync-bak.md");
    expect(stagingPathFor("Plugins/foo/manifest.json")).toBe(
      "Plugins/foo/manifest.sync-bak.json",
    );
    expect(stagingPathFor("Folder/image.png")).toBe(
      "Folder/image.sync-bak.png",
    );
  });

  it("N8b: hidden file with no extension → appends .sync-bak (no insertion)", () => {
    expect(stagingPathFor(".gitignore")).toBe(".gitignore.sync-bak");
    expect(stagingPathFor(".obsidian/.gitignore")).toBe(
      ".obsidian/.gitignore.sync-bak",
    );
    expect(stagingPathFor(".editorconfig")).toBe(".editorconfig.sync-bak");
  });

  it("N8c: extensionless file → appends .sync-bak (no insertion)", () => {
    expect(stagingPathFor("README")).toBe("README.sync-bak");
    expect(stagingPathFor("Folder/Makefile")).toBe("Folder/Makefile.sync-bak");
  });

  it("N8d: file with multiple dots in name → insertion uses LAST extension", () => {
    expect(stagingPathFor("Folder/file.tar.gz")).toBe(
      "Folder/file.tar.sync-bak.gz",
    );
    // Conflict-from sibling shape from ConflictStore — Phase 4 ConflictStore
    // staging calls this with sibling paths exactly like this.
    expect(
      stagingPathFor("Folder/note.conflict-from-Phone-2026-05-22T15-30-00Z.md"),
    ).toBe(
      "Folder/note.conflict-from-Phone-2026-05-22T15-30-00Z.sync-bak.md",
    );
  });

  it("N8e: `which='tmp'` variant uses .sync-tmp pre-suffix", () => {
    expect(stagingPathFor("Folder/note.md", "tmp")).toBe(
      "Folder/note.sync-tmp.md",
    );
    expect(stagingPathFor(".gitignore", "tmp")).toBe(".gitignore.sync-tmp");
  });
});

// ─── Stage 13 Phase 3 RED tests (Group 4: SHA-verify on recovery) ──────
//
// AtomicWriteRecovery.sweep must validate `.sync-bak` content SHA against
// the ConflictStore record's `theirsBlobSha` (when one exists) before
// promoting it to finalPath. Corrupted / mismatched staging is dropped
// + logged; record is left for next drain Phase B to clean up. See
// PSEUDO-MERGE-MODE.md §"Recovery sweep на onload — vault-level
// `.sync-bak` sweep" → matrix row "SHA(`.sync-bak`) ≠ theirsBlobSha".
//
// Phase 4 Group 4 wires sweep against ConflictStore. For now the sweep
// only consults SnapshotStore; the integration with ConflictStore +
// SHA-verify is new behavior.
//
// Skipped here — N9 requires the full Phase 4 wiring of sweep
// against ConflictStore. RED-test ergonomics dictate: file an it.todo
// placeholder so Phase 4 implementer doesn't miss this. Active
// assertion lives in the Group 4 implementation commit.
describe("AtomicWriteRecovery SHA-verify (Stage 13) — Phase 4 wires sweep against ConflictStore", () => {
  // Fixture that wires AtomicWriteRecovery against both SnapshotStore
  // and ConflictStore so sweep can dispatch by ownership. We plant
  // a ConflictStore record manually (via create + remove final), then
  // place a `.sync-bak` staging file and exercise the sweep.

  let f: ReturnType<typeof fixture>;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    f.cleanup();
  });

  it("N9: sweep finds .sync-tmp with SHA matching record.theirsBlobSha → rename to finalPath", async () => {
    const { default: ConflictStore } = await import(
      "../../src/sync2/conflict-store"
    );
    const conflictStore = new ConflictStore({
      vault: f.vault as unknown as import("obsidian").Vault,
      configDir: ".obsidian",
      selfPluginId: "github-easy-sync",
    });
    await conflictStore.load();
    // create() lands the sibling at its final path via the new
    // `.sync-bak` flow. To simulate the Step 3 crash, we need: meta
    // persisted (record in store), `.sync-bak` content on disk,
    // final sibling missing.
    fs.mkdirSync(path.join(f.root, "Notes"), { recursive: true });
    fs.writeFileSync(path.join(f.root, "Notes/note.md"), "local content\n");
    const rec = await conflictStore.create({
      vaultPath: "Notes/note.md",
      kind: "modify-vs-modify",
      theirsContent: bytesOf("theirs content\n"),
      theirsBlobSha: await shaOf("theirs content\n"),
      oursBlobSha: "ours-sha",
      baseMtime: null,
      baseSize: null,
      baseSha: null,
      remoteDevice: "Phone",
    });
    // Synthesize the mid-Step-3 crash state.
    const siblingAbs = path.join(f.root, rec.siblingPath);
    const stagingAbs = path.join(f.root, stagingPathFor(rec.siblingPath, "tmp"));
    fs.renameSync(siblingAbs, stagingAbs);
    expect(fs.existsSync(siblingAbs)).toBe(false);
    expect(fs.existsSync(stagingAbs)).toBe(true);

    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
      conflictStore,
    );
    const result = await recovery.sweep();
    expect(result.restored).toBe(1);
    expect(fs.existsSync(siblingAbs)).toBe(true);
    expect(fs.existsSync(stagingAbs)).toBe(false);
    expect(fs.readFileSync(siblingAbs, "utf8")).toBe("theirs content\n");
  });

  it("N9b: sweep finds .sync-tmp with SHA NOT matching record.theirsBlobSha → drop, leave record for drain Phase B", async () => {
    const { default: ConflictStore } = await import(
      "../../src/sync2/conflict-store"
    );
    const conflictStore = new ConflictStore({
      vault: f.vault as unknown as import("obsidian").Vault,
      configDir: ".obsidian",
      selfPluginId: "github-easy-sync",
    });
    await conflictStore.load();
    fs.mkdirSync(path.join(f.root, "Notes"), { recursive: true });
    fs.writeFileSync(path.join(f.root, "Notes/note.md"), "local content\n");
    const rec = await conflictStore.create({
      vaultPath: "Notes/note.md",
      kind: "modify-vs-modify",
      theirsContent: bytesOf("theirs content\n"),
      theirsBlobSha: await shaOf("theirs content\n"),
      oursBlobSha: "ours-sha",
      baseMtime: null,
      baseSize: null,
      baseSha: null,
      remoteDevice: "Phone",
    });
    // Synthesize the mid-Step-3 crash, but with CORRUPTED staging
    // content (SHA differs from record.theirsBlobSha — disk
    // corruption / race / unrelated staging collision).
    const siblingAbs = path.join(f.root, rec.siblingPath);
    const stagingAbs = path.join(f.root, stagingPathFor(rec.siblingPath, "tmp"));
    fs.unlinkSync(siblingAbs);
    fs.writeFileSync(stagingAbs, "corrupted bytes");

    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
      conflictStore,
    );
    const result = await recovery.sweep();
    // Staging dropped (cleaned), no restore.
    expect(result.cleaned).toBe(1);
    expect(result.restored).toBe(0);
    expect(fs.existsSync(stagingAbs)).toBe(false);
    // Vault sibling stays missing. Record is still indexed — drain
    // Phase B drops it on the next sync (out of scope for this
    // sweep test).
    expect(fs.existsSync(siblingAbs)).toBe(false);
    expect(conflictStore.get(rec.id)).toBeDefined();
  });

  it("N9c: .sync-tmp at a path with no ConflictStore record → dropped as Path A transient (even when conflictStore is in scope)", async () => {
    // Pin the dispatch: presence of conflictStore in the recovery
    // constructor must NOT cause a Path A transient .sync-tmp (one
    // whose finalPath is just an ordinary user file, not a sibling)
    // to be treated as a forward-finalize candidate.
    const { default: ConflictStore } = await import(
      "../../src/sync2/conflict-store"
    );
    const conflictStore = new ConflictStore({
      vault: f.vault as unknown as import("obsidian").Vault,
      configDir: ".obsidian",
      selfPluginId: "github-easy-sync",
    });
    await conflictStore.load();
    // Place a .sync-tmp at a path that ConflictStore knows nothing
    // about — e.g., from a crashed atomicWriteFile pull-replace.
    fs.mkdirSync(path.join(f.root, "Notes"), { recursive: true });
    fs.writeFileSync(path.join(f.root, "Notes/regular.sync-tmp.md"), "partial");

    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
      conflictStore,
    );
    const result = await recovery.sweep();
    expect(result.cleaned).toBe(1);
    expect(result.restored).toBe(0);
    expect(
      fs.existsSync(path.join(f.root, "Notes/regular.sync-tmp.md")),
    ).toBe(false);
    // The "final" path (Notes/regular.md) was never created — drop is
    // correct because the bytes are transient, not destined.
    expect(fs.existsSync(path.join(f.root, "Notes/regular.md"))).toBe(false);
  });
});
