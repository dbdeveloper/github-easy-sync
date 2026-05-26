// Exit protocol for the DiffPane detail view (R7.11).
//
// When the user clicks `[← Back to list]`, two distinct effects
// happen, in order:
//
//   Step 1 — Write the resolved document buffer into the base file
//            via the crash-safe 5-step `atomicWriteFile` protocol
//            (PSEUDO-MERGE-MODE.md §9.3).
//
//   Step 2 — **Proactive sibling cleanup (R7.11).** After step 1
//            succeeds, compute SHA(baseBytes) and SHA(siblingBytes)
//            for every sibling whose filename derives back to this
//            base path. For each SHA match → `vault.adapter.remove`.
//            Adapter-level rather than the high-level `vault.delete`
//            because vault.delete cannot handle paths in
//            `.obsidian/*` — config-dir siblings exist when the user
//            has `syncConfigDir=true`. `adapter.remove` is the only
//            API that covers both regular vault files AND config-dir
//            files. Side effect: this path is NOT captured by
//            TrashWatcher (which patches only user-initiated
//            `vault.delete`); the sibling is permanently removed.
//            No information loss — sibling bytes are identical to
//            the base bytes just committed in step 1 (SHA match is
//            the precondition for delete).
//
//   Steps 3–5 (autosave-dir cleanup, CM6-history null, view-state
//   transition) are caller responsibilities — Phase 5 (autosave)
//   adds 3, Phase 1+ already handles 4 via pane destroy and 5 via
//   list-mode re-render.
//
// Idempotent by construction: after a successful run, no sibling
// matches base by SHA anymore (it either had its bytes replaced or
// was removed). A second call is a no-op.
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.11 (proactive cleanup)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.7.c (exit-protocol steps)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R9.1 Phase 4 row

import type { Vault } from "obsidian";
import { atomicWriteFile } from "../sync2/atomic-write";
import { calculateGitBlobSHA } from "../utils";
import { parseSiblingFilename } from "./strip-conflict-suffix";

export interface ExitProtocolResult {
  // True when atomicWriteFile completed without throwing. False
  // means step 2 was skipped and the caller should stay in detail
  // view to avoid losing edits.
  written: boolean;
  // Paths of siblings that were removed in step 2. Empty array
  // when no SHA matched. Useful for "saved + cleaned N siblings"
  // success notifications.
  siblingsRemoved: string[];
}

export interface ExitProtocolDeps {
  vault: Vault;
  // Optional callback invoked after the base-file write commits.
  // Pass undefined in the diff2 path — sibling cleanup + snapshot
  // bookkeeping happen on the next [Sync] click via Phase A
  // (R7.7.c). Plumbed through to atomicWriteFile's afterCommit.
  afterCommit?: () => Promise<void>;
}

// Perform R7.11 exit protocol. Returns a result object describing
// which side-effects fired. Throws only on step-1 failure (the
// caller should keep the detail view open so the user doesn't lose
// work); step-2 failures (e.g., one sibling can't be deleted) are
// swallowed and logged best-effort — they don't roll back the base
// write that already succeeded.
export async function executeExitProtocol(
  deps: ExitProtocolDeps,
  basePath: string,
  newOursText: string,
  logger?: { warn: (msg: string, ctx?: Record<string, unknown>) => void },
): Promise<ExitProtocolResult> {
  const baseBytes = new TextEncoder().encode(newOursText).buffer as ArrayBuffer;

  // Step 1 — atomic write base. Throws on failure; caller stays in
  // detail view.
  await atomicWriteFile(
    deps.vault,
    basePath,
    baseBytes,
    deps.afterCommit,
  );

  // Step 2 — proactive sibling cleanup.
  const baseSha = await calculateGitBlobSHA(baseBytes);
  const removed: string[] = [];
  const siblingPaths = await findSiblingPaths(deps.vault, basePath);
  for (const siblingPath of siblingPaths) {
    try {
      const siblingBytes = await deps.vault.adapter.readBinary(siblingPath);
      const siblingSha = await calculateGitBlobSHA(siblingBytes);
      if (siblingSha !== baseSha) continue;
      // Adapter-level remove: works on both regular files and
      // .obsidian/* config-dir paths. NOT captured by TrashWatcher
      // (which patches only user-initiated `vault.delete`). The
      // sibling bytes are identical to the base bytes just
      // committed, so no information is lost.
      await deps.vault.adapter.remove(siblingPath);
      removed.push(siblingPath);
    } catch (err) {
      // Best-effort — log + continue. Phase A on the next drain is
      // a safety net for any sibling we couldn't remove here.
      logger?.warn?.("exit-protocol: sibling cleanup failed", {
        sibling: siblingPath,
        err: String(err),
      });
    }
  }

  return { written: true, siblingsRemoved: removed };
}

// Find every sibling path of the supplied basePath by listing the
// containing directory via adapter.list. Adapter-level listing
// covers BOTH regular vault files AND `.obsidian/*` config-dir
// files — vault.getFiles() skips configDir by design. Returns
// string paths (vault-root-relative, forward-slash).
export async function findSiblingPaths(
  vault: Vault,
  basePath: string,
): Promise<string[]> {
  const dir = dirnameOf(basePath);
  let listing: { files: string[]; folders: string[] };
  try {
    listing = await vault.adapter.list(dir);
  } catch {
    // adapter.list throws when the directory doesn't exist (e.g.,
    // basePath itself was just deleted between view-open and exit).
    // Treat as "no siblings" — Phase A on next drain is the safety
    // net.
    return [];
  }
  const out: string[] = [];
  for (const file of listing.files) {
    const parsed = parseSiblingFilename(file);
    if (parsed && parsed.basePath === basePath) out.push(file);
  }
  return out;
}

// Pure helper — return the directory portion of a vault path.
// Empty string when the path is at the vault root.
function dirnameOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  if (slash <= 0) return "";
  return filePath.slice(0, slash);
}
