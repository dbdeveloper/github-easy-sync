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

// Inverse of stagingPathFor: tries to recognize `stagingPath` as a
// `.sync-bak` / `.sync-tmp` staging file and returns its target final
// path. Returns null if `stagingPath` doesn't match the staging shape
// (regular user file). Used by AtomicWriteRecovery.sweep when walking
// the vault for orphan staging entries — we can't determine "is this
// a staging file?" by suffix alone because the pre-suffix form
// (`note.sync-bak.md`) doesn't end in `.sync-bak`.
//
// Recognition logic:
//   1. Pre-suffix form: `<stem>.sync-bak.<ext>` — look for the literal
//      `.sync-bak.` infix in the filename portion (after the last
//      slash). The portion after the infix is a single extension
//      segment with no further slashes.
//   2. Suffix form: `<file>.sync-bak` — filename ends in `.sync-bak`
//      with no further extension (hidden file or extensionless).
// Both forms reconstruct the final path by removing the suffix.
export function parseStagingPath(
  stagingPath: string,
): { finalPath: string; which: "bak" | "tmp" } | null {
  const candidates: Array<{ suffix: string; which: "bak" | "tmp" }> = [
    { suffix: SYNC_BAK_SUFFIX, which: "bak" },
    { suffix: SYNC_TMP_SUFFIX, which: "tmp" },
  ];
  const slashIdx = stagingPath.lastIndexOf("/");
  const fileStart = slashIdx + 1;
  for (const { suffix, which } of candidates) {
    // Pre-suffix form: look for the LAST `.sync-bak.` inside the
    // filename portion. The matched position must be > fileStart
    // (don't allow zero-length stem) and the segment after must
    // contain no `/` AND at least one character.
    const infix = `${suffix}.`;
    const infixIdx = stagingPath.lastIndexOf(infix);
    if (infixIdx > fileStart) {
      const afterStart = infixIdx + infix.length;
      const after = stagingPath.slice(afterStart);
      if (after.length > 0 && !after.includes("/")) {
        const finalPath =
          stagingPath.slice(0, infixIdx) + stagingPath.slice(infixIdx + suffix.length);
        return { finalPath, which };
      }
    }
    // Suffix form: filename ends in `.sync-bak` (no extension after).
    if (
      stagingPath.endsWith(suffix) &&
      stagingPath.length > fileStart + suffix.length
    ) {
      const finalPath = stagingPath.slice(0, -suffix.length);
      return { finalPath, which };
    }
  }
  return null;
}

export async function atomicWriteFile(
  vault: Vault,
  path: string,
  bytes: ArrayBuffer,
  afterCommit?: () => Promise<void>,
): Promise<void> {
  // Stage 13: pre-suffix staging paths so Obsidian's file explorer
  // still recognizes the staging file by extension (a `.md.sync-tmp`
  // file is hidden under "Show all file types: false" but a
  // `note.sync-tmp.md` stays visible). See PSEUDO-MERGE-MODE.md
  // §"Naming convention для staging файлів — `.sync-bak` як pre-suffix".
  const tmpPath = stagingPathFor(path, "tmp");
  const bakPath = stagingPathFor(path, "bak");

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

// Structural view of the ConflictStore dependency used by sweep.
// Sidesteps the conflict-store.ts ↔ atomic-write.ts circular import
// (conflict-store imports `stagingPathFor` from this file).
interface ConflictStoreLike {
  getBySibling(siblingPath: string): { theirsBlobSha: string } | undefined;
}

// Crash-recovery sweep for `atomicWriteFile` AND for ConflictStore's
// vault-level `.sync-tmp` sibling staging. Runs on plugin onload
// BEFORE the engine starts touching the vault — walks the tree for
// any `.sync-tmp` / `.sync-bak` leftovers and reconciles them
// against the snapshot + conflict stores.
//
// Each suffix now has ONE consistent meaning (see PSEUDO-MERGE-MODE.md
// §9 for the rationale):
//
//   `.sync-tmp` = NEW bytes staged for a target (existing or new).
//      Ambiguous between two callsites; dispatch by ownership via
//      conflictStore.getBySibling(finalPath):
//        record exists, finalPath exists                    → drop tmp
//                                                            [Step 3 done,
//                                                             orphan cleanup]
//        record exists, finalPath missing, SHA matches      → rename(tmp →
//                                                             finalPath)
//                                                            [resume Step 3]
//        record exists, finalPath missing, SHA mismatches   → drop tmp
//                                                            [data integrity
//                                                             > resolution;
//                                                             record dropped
//                                                             on next drain
//                                                             Phase B]
//        no record (Path A transient new bytes)              → drop tmp
//
//   `.sync-bak` = OLD bytes backed up before an overwrite.
//      Only produced by atomicWriteFile (Path A); ConflictStore never
//      writes `.sync-bak`. Recovery is snapshot-based, no ownership
//      dispatch needed:
//        finalPath missing                                  → rename(bak
//                                                             → finalPath)
//                                                            [restore]
//        finalPath exists, snapshot.remoteSha === SHA(file) → delete bak
//                                                            [cleanup race]
//        mismatch / no snapshot                             → restore bak
//
// Returns counts so main.ts can log / surface what was recovered.
export class AtomicWriteRecovery {
  constructor(
    private readonly vault: Vault,
    private readonly store: SnapshotStore,
    private readonly conflictStore?: ConflictStoreLike,
  ) {}

  async sweep(): Promise<{ cleaned: number; restored: number }> {
    let cleaned = 0;
    let restored = 0;

    const { syncTmps, syncBaks } = await this.findCandidates();

    // 1. .sync-tmp: forward-direction staging. Dispatch by ownership.
    // Path B (ConflictStore.create) → resume Step 3 by renaming to the
    // final sibling path if SHA matches the record's theirsBlobSha.
    // Path A (atomicWriteFile transient) → drop (next sync repeats).
    for (const { stagingPath: tmpPath, finalPath: originalPath } of syncTmps) {
      try {
        const conflictRecord = this.conflictStore?.getBySibling(originalPath);
        if (conflictRecord !== undefined) {
          const fileExists = await this.vault.adapter.exists(originalPath);
          if (fileExists) {
            // Step 3 completed at some point; the staging is stale.
            await this.vault.adapter.remove(tmpPath);
            cleaned++;
            continue;
          }
          const bytes = await this.vault.adapter.readBinary(tmpPath);
          const sha = await calculateGitBlobSHA(bytes);
          if (sha === conflictRecord.theirsBlobSha) {
            // Resume the interrupted Step 3.
            await this.vault.adapter.rename(tmpPath, originalPath);
            restored++;
          } else {
            // SHA mismatch — disk corruption or a stale staging from
            // some unrelated path that happens to collide. Drop it;
            // the next drain Phase B drops the record on the missing
            // sibling.
            await this.vault.adapter.remove(tmpPath);
            cleaned++;
          }
          continue;
        }
        // No ConflictStore record → Path A transient. Always safe to
        // drop; next sync repeats the operation if still needed.
        await this.vault.adapter.remove(tmpPath);
        cleaned++;
      } catch {
        // Ignore individual failures; sweep is best-effort.
      }
    }

    // 2. .sync-bak: rollback backups, snapshot-based recovery.
    // Produced only by atomicWriteFile (Path A); ConflictStore never
    // writes .sync-bak. No ownership dispatch needed.
    for (const { stagingPath: bakPath, finalPath: originalPath } of syncBaks) {
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

  // Recursively walk the vault for `.sync-tmp` / `.sync-bak` staging
  // files. Both pre-suffix form (`note.sync-bak.md`) and suffix form
  // (`.gitignore.sync-bak`) are recognized via `parseStagingPath`,
  // which encapsulates the inverse of `stagingPathFor`. Files that
  // don't match either form are normal user files and skipped.
  private async findCandidates(): Promise<{
    syncTmps: Array<{ stagingPath: string; finalPath: string }>;
    syncBaks: Array<{ stagingPath: string; finalPath: string }>;
  }> {
    const syncTmps: Array<{ stagingPath: string; finalPath: string }> = [];
    const syncBaks: Array<{ stagingPath: string; finalPath: string }> = [];
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
        const parsed = parseStagingPath(file);
        if (parsed === null) continue;
        const entry = { stagingPath: file, finalPath: parsed.finalPath };
        if (parsed.which === "tmp") syncTmps.push(entry);
        else syncBaks.push(entry);
      }
      stack.push(...listing.folders);
    }
    return { syncTmps, syncBaks };
  }
}
