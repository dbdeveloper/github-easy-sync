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
    expect(fs.existsSync(path.join(f.root, "Notes/note.md.sync-tmp"))).toBe(false);
    expect(fs.existsSync(path.join(f.root, "Notes/note.md.sync-bak"))).toBe(false);
  });

  it("existing file: replaces content; old version backed up then cleaned", async () => {
    fs.writeFileSync(path.join(f.root, "x.md"), "v1\n");
    await atomicWriteFile(
      f.vault as unknown as import("obsidian").Vault,
      "x.md",
      bytesOf("v2\n"),
    );
    expect(readText(f.root, "x.md")).toBe("v2\n");
    expect(fs.existsSync(path.join(f.root, "x.md.sync-tmp"))).toBe(false);
    expect(fs.existsSync(path.join(f.root, "x.md.sync-bak"))).toBe(false);
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
          bakExists: fs.existsSync(path.join(f.root, "x.md.sync-bak")),
        });
      },
    );
    expect(observed).toEqual([{ fileContent: "v2", bakExists: true }]);
    // Post-afterCommit: cleanup ran.
    expect(fs.existsSync(path.join(f.root, "x.md.sync-bak"))).toBe(false);
  });

  it("stale .sync-bak from a previous crash is overwritten by the rename-aside step", async () => {
    // Setup: file exists at canonical path AND a leftover .sync-bak
    // from a previous crash sits next to it. atomicWriteFile must
    // not throw on the rename(file → bak) collision.
    fs.writeFileSync(path.join(f.root, "x.md"), "current");
    fs.writeFileSync(path.join(f.root, "x.md.sync-bak"), "leftover");
    await atomicWriteFile(
      f.vault as unknown as import("obsidian").Vault,
      "x.md",
      bytesOf("v3"),
    );
    expect(readText(f.root, "x.md")).toBe("v3");
    expect(fs.existsSync(path.join(f.root, "x.md.sync-bak"))).toBe(false);
  });

  it("stale .sync-tmp from a previous crash is silently overwritten", async () => {
    fs.writeFileSync(path.join(f.root, "x.md.sync-tmp"), "old partial");
    await atomicWriteFile(
      f.vault as unknown as import("obsidian").Vault,
      "x.md",
      bytesOf("fresh"),
    );
    expect(readText(f.root, "x.md")).toBe("fresh");
    expect(fs.existsSync(path.join(f.root, "x.md.sync-tmp"))).toBe(false);
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
    fs.writeFileSync(path.join(f.root, "x.md.sync-tmp"), "partial");
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result.cleaned).toBe(1);
    expect(result.restored).toBe(0);
    expect(fs.existsSync(path.join(f.root, "x.md.sync-tmp"))).toBe(false);
  });

  it("only .sync-bak (no original): restored to canonical path", async () => {
    // Crash between step 2 (rename → bak) and step 3 (rename tmp →
    // file): backup is the only intact copy.
    fs.writeFileSync(path.join(f.root, "x.md.sync-bak"), "previous");
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result.cleaned).toBe(0);
    expect(result.restored).toBe(1);
    expect(readText(f.root, "x.md")).toBe("previous");
    expect(fs.existsSync(path.join(f.root, "x.md.sync-bak"))).toBe(false);
  });

  it("both .sync-bak AND original, file matches snapshot: backup is cleaned up", async () => {
    // Crash between step 4 (recordSync) and step 5 (cleanup .sync-bak):
    // the install is committed AND the snapshot is updated, but the
    // cleanup didn't run. Recovery detects the SHA match and drops
    // the backup.
    fs.writeFileSync(path.join(f.root, "x.md"), "v2");
    fs.writeFileSync(path.join(f.root, "x.md.sync-bak"), "v1");
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
    expect(fs.existsSync(path.join(f.root, "x.md.sync-bak"))).toBe(false);
  });

  it("both files exist, file mismatches snapshot: restore backup", async () => {
    // Crash between step 3 (rename tmp → file) and step 4
    // (recordSync): file is new bytes, snapshot still has OLD sha.
    // The mismatch tells us we can't trust the install — restore.
    fs.writeFileSync(path.join(f.root, "x.md"), "newPartialOrNotCommitted");
    fs.writeFileSync(path.join(f.root, "x.md.sync-bak"), "previous-good");
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
    expect(fs.existsSync(path.join(f.root, "x.md.sync-bak"))).toBe(false);
  });

  it("both files exist, no snapshot entry: conservative restore", async () => {
    // We can't verify; backup is the trustable copy.
    fs.writeFileSync(path.join(f.root, "x.md"), "unverified");
    fs.writeFileSync(path.join(f.root, "x.md.sync-bak"), "known-good");
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
    fs.writeFileSync(path.join(f.root, "Notes/Sub/Deep/a.md.sync-tmp"), "x");
    fs.writeFileSync(path.join(f.root, "Notes/Sub/b.md.sync-bak"), "y");
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result.cleaned).toBe(1); // a.md.sync-tmp
    expect(result.restored).toBe(1); // b.md.sync-bak → b.md
    expect(
      fs.existsSync(path.join(f.root, "Notes/Sub/Deep/a.md.sync-tmp")),
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
