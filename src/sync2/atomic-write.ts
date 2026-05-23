// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { Vault } from "obsidian";
import { calculateGitBlobSHA } from "../utils";
import type SnapshotStore from "./snapshot-store";

// Atomic-with-backup write of a vault file. Crash-safe sequence:
//
//   1. writeBinary(<path>.sync-tmp, newBytes)
//   2. if exists(<path>): rename(<path>, <path>.sync-bak)
//   3. rename(<path>.sync-tmp, <path>)
//   4. caller's afterCommit() — typically recordSync, so snapshot
//      matches the just-installed bytes BEFORE cleanup
//   5. remove(<path>.sync-bak)
//
// Why this order: with `recordSync` between rename-into-place and
// backup cleanup, the recovery sweep on plugin onload can use the
// snapshot's `remoteSha` to disambiguate "write succeeded but
// cleanup didn't run" from "write was partial / recordSync didn't
// run". See AtomicWriteRecovery below.
//
// Files involved are always within the same vault directory, so the
// renames are POSIX-atomic on the underlying filesystem. ConflictStore
// uses the same primitive at `conflict-store.ts:persistRecord`.

export const SYNC_TMP_SUFFIX = ".sync-tmp";
export const SYNC_BAK_SUFFIX = ".sync-bak";

// Stage 13: pre-suffix staging path. Phase 4 Group 4 implementation.
//
// Computes the staging path for a target file by inserting `.sync-bak`
// (or `.sync-tmp` if `which="tmp"`) BEFORE the file extension instead
// of appending after it. This preserves the original extension's
// visibility in Obsidian's file explorer (a `.md.sync-bak` file is
// hidden under "Show all file types: false" but a `note.sync-bak.md`
// is still indexed as markdown).
//
// Examples (from PSEUDO-MERGE-MODE.md §"Naming convention для staging
// файлів — `.sync-bak` як pre-suffix"):
//   - "Folder/note.md"                  → "Folder/note.sync-bak.md"
//   - "Plugins/foo/manifest.json"       → "Plugins/foo/manifest.sync-bak.json"
//   - ".gitignore"                      → ".gitignore.sync-bak"
//   - "README" (no ext)                 → "README.sync-bak"
//   - ".obsidian/.gitignore"            → ".obsidian/.gitignore.sync-bak"
//   - "note.conflict-from-Phone-X.md"   → "note.conflict-from-Phone-X.sync-bak.md"
//   - "file.tar.gz"                     → "file.tar.sync-bak.gz"  (uses LAST extension)
//
// Hidden + extensionless files append the suffix (no extension to
// insert before). Files like ".gitignore" or "README" can't be
// extensioned without becoming a different filename shape, so the
// suffix appends.
export function stagingPathFor(
  finalPath: string,
  which: "bak" | "tmp" = "bak",
): string {
  const suffix = which === "tmp" ? SYNC_TMP_SUFFIX : SYNC_BAK_SUFFIX;
  const slashIdx = finalPath.lastIndexOf("/");
  const dotIdx = finalPath.lastIndexOf(".");

  // Conditions that mean "no extension to insert before":
  //   - dotIdx < 0 → no dot at all (e.g., "README", "Folder/Makefile")
  //   - dotIdx <= slashIdx → the only dot is in a directory segment
  //     above the file, not in the filename itself
  //   - dotIdx === slashIdx + 1 → the dot is the leading character of
  //     the filename (hidden file like ".gitignore")
  if (dotIdx < 0 || dotIdx <= slashIdx || dotIdx === slashIdx + 1) {
    return finalPath + suffix;
  }

  // Normal file with extension. Insert suffix before the LAST extension.
  const stem = finalPath.slice(0, dotIdx);
  const ext = finalPath.slice(dotIdx);
  return stem + suffix + ext;
}

export async function atomicWriteFile(
  vault: Vault,
  path: string,
  bytes: ArrayBuffer,
  afterCommit?: () => Promise<void>,
): Promise<void> {
  const tmpPath = `${path}${SYNC_TMP_SUFFIX}`;
  const bakPath = `${path}${SYNC_BAK_SUFFIX}`;

  // Step 1: stage new bytes in .sync-tmp. A previous crash may have
  // left a stale .sync-tmp behind — overwrite silently; the file is
  // transient by definition.
  await vault.adapter.writeBinary(tmpPath, bytes);

  try {
    // Step 2: move the live path aside under .sync-bak. Skipped when
    // the file doesn't exist (brand-new file case).
    if (await vault.adapter.exists(path)) {
      // Drop a stale .sync-bak if one survives from an earlier crash
      // — rename's destination must be free.
      if (await vault.adapter.exists(bakPath)) {
        await vault.adapter.remove(bakPath);
      }
      await vault.adapter.rename(path, bakPath);
    }

    // Step 3: atomic promote .sync-tmp → live path.
    await vault.adapter.rename(tmpPath, path);

    // Step 4: caller updates snapshot so subsequent recovery sweeps
    // can match file ↔ snapshot SHA.
    if (afterCommit) {
      await afterCommit();
    }

    // Step 5: cleanup .sync-bak. No-op when the file didn't exist
    // before (no rename happened in step 2).
    if (await vault.adapter.exists(bakPath)) {
      await vault.adapter.remove(bakPath);
    }
  } catch (err) {
    // Best-effort rollback. Restoring from .sync-bak gives us the
    // pre-write state. .sync-tmp goes to the trash either way.
    try {
      if (await vault.adapter.exists(bakPath)) {
        if (await vault.adapter.exists(path)) {
          await vault.adapter.remove(path);
        }
        await vault.adapter.rename(bakPath, path);
      }
    } catch {
      // Ignore secondary errors — best-effort rollback.
    }
    try {
      if (await vault.adapter.exists(tmpPath)) {
        await vault.adapter.remove(tmpPath);
      }
    } catch {
      // Ignore.
    }
    throw err;
  }
}

// Crash-recovery sweep for `atomicWriteFile`. Runs on plugin onload
// BEFORE the engine starts touching the vault — walks the tree for
// any `*.sync-tmp` and `*.sync-bak` leftovers and reconciles them
// against the snapshot store. Outcomes:
//
//   *.sync-tmp                       → delete (stale write artifact)
//   *.sync-bak (no <file> exists)    → rename(bak → file) [restore]
//   *.sync-bak (with <file>):
//     snapshot.remoteSha === SHA(file) → delete bak [crash 4: write
//                                       done + recordSync done +
//                                       cleanup didn't run]
//     mismatch                       → restore bak [crash 3: write
//                                       partial OR recordSync didn't
//                                       run — next sync will re-pull]
//
// Returns counts so main.ts can log / surface what was recovered.
export class AtomicWriteRecovery {
  constructor(
    private readonly vault: Vault,
    private readonly store: SnapshotStore,
  ) {}

  async sweep(): Promise<{ cleaned: number; restored: number }> {
    let cleaned = 0;
    let restored = 0;

    const { syncTmps, syncBaks } = await this.findCandidates();

    // 1. .sync-tmp: always safe to drop. Either the write was
    // interrupted before promotion, or someone left stale staging.
    for (const tmpPath of syncTmps) {
      try {
        await this.vault.adapter.remove(tmpPath);
        cleaned++;
      } catch {
        // Ignore individual failures; sweep is best-effort.
      }
    }

    // 2. .sync-bak: state-driven recovery.
    for (const bakPath of syncBaks) {
      const originalPath = bakPath.slice(0, -SYNC_BAK_SUFFIX.length);
      try {
        const fileExists = await this.vault.adapter.exists(originalPath);
        if (!fileExists) {
          // Crash between step 2 and step 3: only backup survived.
          // Restore it to the canonical path.
          await this.vault.adapter.rename(bakPath, originalPath);
          restored++;
          continue;
        }
        // Both files exist. Disambiguate via snapshot SHA.
        const expectedSha = this.store.get(originalPath)?.remoteSha;
        if (expectedSha === undefined) {
          // No snapshot entry → can't verify the install. Conservative:
          // keep the previous version (we own a known-good backup,
          // worth more than an unverified file).
          await this.vault.adapter.remove(originalPath);
          await this.vault.adapter.rename(bakPath, originalPath);
          restored++;
          continue;
        }
        const bytes = await this.vault.adapter.readBinary(originalPath);
        const actualSha = await calculateGitBlobSHA(bytes);
        if (actualSha === expectedSha) {
          // Install was committed (snapshot matches) — only the
          // cleanup didn't run. Drop the backup.
          await this.vault.adapter.remove(bakPath);
          cleaned++;
        } else {
          // File at original path doesn't match the snapshot. Either
          // the write was partial OR recordSync never fired. Either
          // way, the backup is the trustable copy; restore.
          await this.vault.adapter.remove(originalPath);
          await this.vault.adapter.rename(bakPath, originalPath);
          restored++;
        }
      } catch {
        // Individual failure — keep sweeping.
      }
    }

    return { cleaned, restored };
  }

  // Recursively walk the vault for *.sync-tmp / *.sync-bak files.
  // Splits the result into two lists so the sweep can process them
  // in order.
  private async findCandidates(): Promise<{
    syncTmps: string[];
    syncBaks: string[];
  }> {
    const syncTmps: string[] = [];
    const syncBaks: string[] = [];
    const stack: string[] = [""];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      let listing: { files: string[]; folders: string[] };
      try {
        listing = await this.vault.adapter.list(dir);
      } catch {
        continue;
      }
      for (const file of listing.files) {
        if (file.endsWith(SYNC_TMP_SUFFIX)) syncTmps.push(file);
        else if (file.endsWith(SYNC_BAK_SUFFIX)) syncBaks.push(file);
      }
      stack.push(...listing.folders);
    }
    return { syncTmps, syncBaks };
  }
}
