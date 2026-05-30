// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { TFile, Vault } from "obsidian";
import { calculateGitBlobSHA } from "../utils";
import type SnapshotStore from "./snapshot-store";
import { safeRename } from "./cross-platform";

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

// Stage 7 modify-in-place marker. Zero-byte file in the same
// folder as the target. Format:
//
//   `.<filename-with-ext>.sync-tmp.`
//
// Examples:
//   `notes/folder/note.md`   → `notes/folder/.note.md.sync-tmp.`
//   `.obsidian/.gitignore`    → `.obsidian/..gitignore.sync-tmp.`
//
// Two distinguishing signals:
//   - LEADING dot — file is invisible in Obsidian's file
//     explorer (which hides dotfiles by default).
//   - TRAILING dot — makes the marker syntactically distinct
//     from the existing staging-file shape `.eslintrc.json.sync-tmp`
//     (no trailing dot). The existing `parseStagingPath` /
//     `findCandidates` recognisers won't claim a marker as a
//     staging file because both forms it checks (`<stem>.sync-tmp.<ext>`
//     and `<file>.sync-tmp`) require NO trailing dot after
//     `.sync-tmp`.
//
// Semantics: the marker's PRESENCE is the signal. Empty bytes
// intentionally; the actual rollback bytes live in the matching
// `.sync-bak` sibling (existing convention). Recovery:
//   - marker present, bak present → restore in-place via
//     modifyBinary (rollback to pre-modify state).
//   - marker present, bak missing → defensive cleanup of marker.
//   - marker missing, bak present → existing
//     snapshot-SHA-based recovery handles the orphan bak.
//
// Cross-platform note: trailing dot in filenames is supported by
// POSIX (Linux, macOS, iOS APFS, Android ext4). Windows strips
// trailing dots in the WinAPI layer; Obsidian on Windows desktop
// would silently drop the trailing dot and we'd lose the
// disambiguation. Acceptable tradeoff for the rework — the
// target user is Capacitor mobile + macOS/Linux desktop where
// trailing dots work cleanly.
export const SYNC_MOD_MARKER_SUFFIX = ".sync-tmp.";

// modifyMarkerPathFor: returns the modify-in-place marker path
// for a given target. Same folder, dot-prefixed basename,
// `.sync-tmp.` suffix.
export function modifyMarkerPathFor(targetPath: string): string {
  const slashIdx = targetPath.lastIndexOf("/");
  const dir = slashIdx >= 0 ? targetPath.slice(0, slashIdx + 1) : "";
  const basename = slashIdx >= 0 ? targetPath.slice(slashIdx + 1) : targetPath;
  return `${dir}.${basename}${SYNC_MOD_MARKER_SUFFIX}`;
}

// Inverse of modifyMarkerPathFor. Recognises a marker by its
// shape — basename starts with `.`, ends with `.sync-tmp.` (literal
// trailing dot), middle slice non-empty.
//
// Note: the atomic-rename strategy does NOT use a marker — the
// presence of `.sync-bak` itself signals "rename in progress",
// and the existing SHA-based recovery handles it correctly.
// Adding a parallel `.sync-bak.` marker would be redundant.
export function parseModifyMarkerPath(markerPath: string): string | null {
  if (!markerPath.endsWith(SYNC_MOD_MARKER_SUFFIX)) return null;
  const slashIdx = markerPath.lastIndexOf("/");
  const dir = slashIdx >= 0 ? markerPath.slice(0, slashIdx + 1) : "";
  const basename = slashIdx >= 0 ? markerPath.slice(slashIdx + 1) : markerPath;
  if (!basename.startsWith(".")) return null;
  // strip leading dot and trailing .sync-tmp.
  const inner = basename.slice(1, -SYNC_MOD_MARKER_SUFFIX.length);
  if (inner.length === 0) return null;
  return `${dir}${inner}`;
}

// Computes the staging path for a target file by inserting `.sync-bak`
// (or `.sync-tmp` if `which="tmp"`) BEFORE the file extension instead
// of appending after it. This preserves the original extension's
// visibility in Obsidian's file explorer (a `.md.sync-bak` file is
// hidden under "Show all file types: false" but a `note.sync-bak.md`
// is still indexed as markdown).
//
// See docs/PSEUDO-MERGE-MODE.md §9.2 for the naming convention.
// Examples:
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
  // Editor-friendly fast path: when the target file already exists
  // in the vault (TFile present) and the runtime exposes the
  // Obsidian-idiomatic vault.modifyBinary API, write in place. This
  // crucially preserves any open MarkdownView's cursor + scroll
  // position — the rename strategy below would otherwise close the
  // view because Obsidian sees the rename as "the file at this path
  // disappeared". The atomic-rename safety only matters for creating
  // brand-new files; for modify-in-place, `modifyBinary` is what
  // Obsidian's own pull/sync flows use.
  //
  // Defensive: mock-obsidian (unit tests) doesn't expose
  // getAbstractFileByPath / modifyBinary, so the typeof checks
  // gate the fast path. Production Obsidian on desktop + mobile
  // ships both APIs.
  const getter = (
    vault as { getAbstractFileByPath?: (p: string) => unknown }
  ).getAbstractFileByPath;
  const modBin = (
    vault as { modifyBinary?: (f: TFile, b: ArrayBuffer) => Promise<void> }
  ).modifyBinary;
  if (typeof getter === "function" && typeof modBin === "function") {
    const existing = getter.call(vault, path);
    if (existing instanceof TFile) {
      // Crash-safe modify protocol — forward-complete recovery:
      //
      //   1. writeBinary(`.sync-tmp`, newBytes) — stage the NEW
      //      bytes (the FUTURE state). Marker is NOT yet present,
      //      so a crash here looks like a Path A transient sync-tmp
      //      and the existing orphan sweep drops it on next onload.
      //   2. write(marker, "") — the marker's presence signals to
      //      recovery: "the sync-tmp next to me is the authoritative
      //      target state — forward-complete by renaming it."
      //   3. modifyBinary(target, newBytes) — in-place write that
      //      preserves any open editor's cursor + scroll.
      //   4. afterCommit() — caller updates snapshot.
      //   5. remove(`.sync-tmp`) — staging file no longer needed.
      //   6. remove(marker) — flips recovery's signal off LAST,
      //      so the marker is a true "this was in progress" signal
      //      throughout its lifetime (never present without
      //      forward-recovery context).
      //
      // Crash recovery (AtomicWriteRecovery.sweep):
      //   - marker + sync-tmp present → remove(target), rename
      //     sync-tmp → target, remove(marker). Forward-completes
      //     the operation. (Recovery runs at onload before any
      //     editor is open, so the rename's side-effect of closing
      //     the editor is moot.)
      //   - marker without sync-tmp → just remove(marker). Step 5
      //     ran (sync-tmp gone) but step 6 crashed; the modify
      //     completed successfully and the marker is a stale
      //     leftover.
      //   - sync-tmp without marker → existing Path A logic drops
      //     it as a transient (crash before step 2).
      const tmpPath = stagingPathFor(path, "tmp");
      const markerPath = modifyMarkerPathFor(path);
      // Step 1: stage new bytes in .sync-tmp. Existing transient
      // staging path / file shape, reused — the marker is the
      // signal that distinguishes this from a rename-strategy
      // in-flight tmp.
      await vault.adapter.writeBinary(tmpPath, bytes);
      // Step 2: drop the marker. From this point on, recovery
      // treats the tmp as forward-complete material.
      await vault.adapter.write(markerPath, "");
      try {
        // Step 3: write new bytes in place. Editor stays attached.
        await modBin.call(vault, existing, bytes);
        // Step 4: caller updates snapshot.
        if (afterCommit) {
          await afterCommit();
        }
        // Step 5: remove staging FIRST. If we crash between this
        // and step 6, the marker alone remains and recovery's
        // "marker without sync-tmp → cleanup" branch drops it.
        await vault.adapter.remove(tmpPath);
        // Step 6: remove marker last. The marker's presence has
        // always been a true "in progress" signal up to this point.
        await vault.adapter.remove(markerPath);
      } catch (err) {
        // Best-effort cleanup; sweep handles whatever's left.
        try {
          await vault.adapter.remove(markerPath);
        } catch {
          // ignore
        }
        try {
          await vault.adapter.remove(tmpPath);
        } catch {
          // ignore
        }
        throw err;
      }
      return;
    }
  }

  // Pre-suffix staging paths so Obsidian's file explorer still
  // recognizes the staging file by extension (a `.md.sync-tmp`
  // file is hidden under "Show all file types: false" but a
  // `note.sync-tmp.md` stays visible). See stagingPathFor above
  // and docs/PSEUDO-MERGE-MODE.md §9.2.
  const tmpPath = stagingPathFor(path, "tmp");
  const bakPath = stagingPathFor(path, "bak");

  // Step 1: stage new bytes in .sync-tmp. A previous crash may have
  // left a stale .sync-tmp behind — overwrite silently; the file is
  // transient by definition.
  await vault.adapter.writeBinary(tmpPath, bytes);

  try {
    // Step 2: move the live path aside under .sync-bak. Skipped when
    // the file doesn't exist (brand-new file case). safeRename
    // handles the "drop stale .sync-bak from a previous crash"
    // step (cross-platform.ts § safeRename).
    if (await vault.adapter.exists(path)) {
      await safeRename(vault.adapter, path, bakPath);
    }

    // Step 3: atomic promote .sync-tmp → live path. Plain rename:
    // step 2 just moved any live file aside, so `path` is empty.
    // No safeRename — the invariant "path is empty here" matters
    // and we want to fail loudly if it isn't.
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
        await safeRename(vault.adapter, bakPath, path);
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
// Each suffix has ONE consistent meaning (see
// docs/PSEUDO-MERGE-MODE.md §9 for the full rationale):
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

    const { syncTmps, syncBaks, syncModifyMarkers } = await this.findCandidates();

    // 1. .sync-tmp: forward-direction staging. Dispatch by ownership.
    // Path B (ConflictStore.create) → resume Step 3 by renaming to the
    // final sibling path if SHA matches the record's theirsBlobSha.
    // Path A (atomicWriteFile transient — rename strategy) → drop
    // (next sync repeats).
    // Path C (atomicWriteFile modify-in-place strategy — Stage 7):
    // marker is also present, recovery branch 3 below owns the rename.
    // Skip these here to avoid double-handling.
    const markedTmpPaths = new Set<string>(
      syncModifyMarkers.map(({ finalPath }) =>
        stagingPathFor(finalPath, "tmp"),
      ),
    );
    for (const { stagingPath: tmpPath, finalPath: originalPath } of syncTmps) {
      if (markedTmpPaths.has(tmpPath)) {
        // Modify-in-place owns this tmp — sweep branch 3 handles it.
        continue;
      }
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
    // Produced only by atomicWriteFile's rename strategy (Path A);
    // ConflictStore never writes .sync-bak. The modify-in-place
    // strategy (Stage 7) doesn't touch .sync-bak — it uses
    // forward-recovery via the paired .sync-tmp.
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

    // 3. `.sync-tmp.` modify-in-place markers. The marker tells us
    // "this path's modify-in-place was started but the cleanup
    // step never ran." Forward-complete: rename the matching
    // `.sync-tmp` over the target. (Recovery happens at onload
    // before any editor is open, so the rename's side-effect of
    // closing an editor on the target is moot.)
    //
    //   - marker + .sync-tmp present → remove target, rename
    //     sync-tmp → target. Forward-completes the modify.
    //   - marker without .sync-tmp → defensive cleanup of marker
    //     (we have no bytes to land; something unexpected
    //     happened upstream).
    for (const { markerPath, finalPath } of syncModifyMarkers) {
      try {
        const tmpPath = stagingPathFor(finalPath, "tmp");
        const tmpExists = await this.vault.adapter.exists(tmpPath);
        if (tmpExists) {
          // remove target (if present) THEN rename — Capacitor on
          // iOS/Android does not overwrite via rename, so the
          // remove is necessary; on POSIX it's a tiny overhead.
          if (await this.vault.adapter.exists(finalPath)) {
            await this.vault.adapter.remove(finalPath);
          }
          await this.vault.adapter.rename(tmpPath, finalPath);
          restored++;
        } else {
          cleaned++;
        }
        try {
          await this.vault.adapter.remove(markerPath);
        } catch {
          // ignore — sweep is best-effort
        }
      } catch {
        // Individual failure — keep sweeping.
      }
    }

    return { cleaned, restored };
  }

  // Recursively walk the vault for `.sync-tmp` / `.sync-bak` staging
  // files AND `.<basename>.sync-tmp.` modify-in-place markers.
  //
  // Staging files: both pre-suffix form (`note.sync-bak.md`) and
  // suffix form (`.gitignore.sync-bak`) are recognized via
  // `parseStagingPath`.
  //
  // Modify-in-place markers: recognized by the dot-prefix +
  // `.sync-tmp.` trailing-dot pattern via parseModifyMarkerPath.
  // Files that don't match any pattern are normal user files and
  // skipped.
  private async findCandidates(): Promise<{
    syncTmps: Array<{ stagingPath: string; finalPath: string }>;
    syncBaks: Array<{ stagingPath: string; finalPath: string }>;
    syncModifyMarkers: Array<{ markerPath: string; finalPath: string }>;
  }> {
    const syncTmps: Array<{ stagingPath: string; finalPath: string }> = [];
    const syncBaks: Array<{ stagingPath: string; finalPath: string }> = [];
    const syncModifyMarkers: Array<{
      markerPath: string;
      finalPath: string;
    }> = [];
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
        // Check marker first — staging-shape parseStagingPath
        // doesn't recognise the trailing-dot suffix, but to keep
        // the dispatch unambiguous we order marker → staging.
        const markerTarget = parseModifyMarkerPath(file);
        if (markerTarget !== null) {
          syncModifyMarkers.push({ markerPath: file, finalPath: markerTarget });
          continue;
        }
        const parsed = parseStagingPath(file);
        if (parsed === null) continue;
        const entry = { stagingPath: file, finalPath: parsed.finalPath };
        if (parsed.which === "tmp") syncTmps.push(entry);
        else syncBaks.push(entry);
      }
      stack.push(...listing.folders);
    }
    return { syncTmps, syncBaks, syncModifyMarkers };
  }
}
