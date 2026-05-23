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
// Crash-recovery sweep:
//   *.sync-tmp                             → delete (junk)
//   *.sync-bak (no <file>)                 → restore from .sync-bak
//   *.sync-bak (with <file>):
//     file SHA matches snapshot.remoteSha  → delete .sync-bak [cleanup race]
//     mismatch                             → restore from .sync-bak
//     no snapshot entry                    → restore from .sync-bak (conservative)

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

  it("orphan .sync-tmp: deleted on sweep (transient write artifact)", async () => {
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
describe.skip("AtomicWriteRecovery SHA-verify (Stage 13) — Phase 4 wires sweep against ConflictStore", () => {
  it.todo(
    "N9: sweep finds .sync-bak with SHA matching record.theirsBlobSha → rename to finalPath",
  );
  it.todo(
    "N9b: sweep finds .sync-bak with SHA NOT matching record.theirsBlobSha → drop, leave record for drain Phase B",
  );
});
