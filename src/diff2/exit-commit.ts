// Stage 2.1 — the `[← back]` 7-step pair-atomic commit + crash recovery
// (DIFF-EDITOR.md §5.0–§5.0.e).
//
// `[← back]` commits BOTH sides of a conflict back to the vault at once:
// the resolved base and the resolved sibling (from `split(fromEditorModel)`,
// surfaced by DiffPane.getResolved()). A naive "two sequential
// atomicWriteFile" loses ver2 edits on a crash between the two writes. This
// protocol records the expected SHAs in a `done.json` commit barrier FIRST,
// then stages + renames both files, so recovery on the next launch is a
// deterministic function of what's on disk — it can always roll forward to
// the committed state or cleanly roll back to the autosave session.
//
// SCOPE: this module is the commit engine + TOCTOU detector + per-dir
// recovery. WIRED into the view as of W1: `commit7Step` is the `[←]` save
// (DiffEditView.exitDetailView), `classifyToctou` gates it, and `recoverCommit`
// runs at onload via `onload-recovery.ts` (before AtomicWriteRecovery.sweep).
// Still Phase-6 polish: the §5.0.e resolution MODAL (W5), the `committing` UI
// guard (Step 0), and Step 8 (detachLeaf + historyClear). The naive
// `exit-protocol.ts` is deleted — W1's swap replaced it.
//
// Canonical spec: docs/tasks/DIFF-EDITOR.md §5.0 (7 steps), §5.0.a/b
// (recovery sweep + A–K matrix), §5.0.c (orphan discrimination), §5.0.e
// (TOCTOU). atomic-write.ts staging-path convention (SYNC2 §2.4 / PSEUDO-
// MERGE-MODE §9.2/§9.3).

import type { Vault } from "obsidian";
import { atomicWriteFile, stagingPathFor } from "../sync2/atomic-write";
import { safeRename } from "../sync2/cross-platform";
import { calculateGitBlobSHA } from "../utils";
import { autosaveDir, readMeta, type AutosaveMeta } from "./autosave-store";

const utf8 = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;

const donePath = (autosaveId: string): string =>
  `${autosaveDir(autosaveId)}/done.json`;

// done.json — commit barrier with pre-computed expected SHAs (§5.0).
// Present ⇒ "commit in progress, roll forward via recovery". Absent ⇒
// "no commit started" (the dir is a plain autosave session — Stage 3 owns it).
export interface DoneJson {
  v: 1;
  writtenAt: string;
  expectedBaseSha: string;
  expectedSiblingSha: string;
}

// ── Step 1.5 — TOCTOU detection (§5.0 Step 1.5) ──────────────────────

// Did the input files change externally since session start? DETECTION ONLY —
// the §5.0.e resolution modal is Phase 6. The caller runs this before
// commit7Step; on "mismatch" it shows the modal and only then calls
// commit7Step (default paths for "force overwrite", or alt paths for "save to
// alternative"). Throws if a file was deleted externally (readBinary rejects);
// the Phase-6 caller handles that like classifyReopen's input-missing case.
export type ToctouStatus =
  | { kind: "ok" }
  | {
      kind: "mismatch";
      currentBaseSha: string;
      currentSiblingSha: string;
      baseChanged: boolean;
      siblingChanged: boolean;
    };

export async function classifyToctou(
  vault: Vault,
  meta: AutosaveMeta,
): Promise<ToctouStatus> {
  const currentBaseSha = await calculateGitBlobSHA(
    await vault.adapter.readBinary(meta.basePath),
  );
  const currentSiblingSha = await calculateGitBlobSHA(
    await vault.adapter.readBinary(meta.siblingPath),
  );
  const baseChanged = currentBaseSha !== meta.baseShaAtStart;
  const siblingChanged = currentSiblingSha !== meta.siblingShaAtStart;
  if (!baseChanged && !siblingChanged) return { kind: "ok" };
  return {
    kind: "mismatch",
    currentBaseSha,
    currentSiblingSha,
    baseChanged,
    siblingChanged,
  };
}

// ── §5.0 — the 7-step commit ─────────────────────────────────────────

export interface ResolvedSides {
  base: string;
  sibling: string;
}

export interface Commit7Options {
  // Target paths default to the conflict's real paths (meta.basePath /
  // siblingPath). The §5.0.e "save to alternative paths" branch passes fresh
  // paths here; Step 4 self-skips for any target that doesn't pre-exist, so
  // new-file and save-to-alt are handled uniformly. (Alt-path NAMING is the
  // Phase-6 caller's job — this core stays naming-agnostic.)
  targetBasePath?: string;
  targetSiblingPath?: string;
  now?: string; // injectable for deterministic tests
}

export interface Commit7Result {
  basePath: string;
  siblingPath: string;
  expectedBaseSha: string;
  expectedSiblingSha: string;
  // Step 6.5 fired: the resolved sides were byte-identical AND we committed
  // onto the real conflict sibling, so the now-redundant sibling was removed.
  siblingRemoved: boolean;
}

// Assumes the caller already ran classifyToctou (this does NOT re-check) and,
// for a mismatch, resolved it via the §5.0.e modal. `resolved` MUST be the
// exact bytes to commit (DiffPane.getResolved() output, with its empty→"\n"
// guard already applied) — done.json hashes the same buffers we stage, so a
// pre-guard buffer here would make every recovery SHA-match fail.
export async function commit7Step(
  vault: Vault,
  autosaveId: string,
  meta: AutosaveMeta,
  resolved: ResolvedSides,
  opts: Commit7Options = {},
): Promise<Commit7Result> {
  const now = opts.now ?? new Date().toISOString();
  const targetBase = opts.targetBasePath ?? meta.basePath;
  const targetSibling = opts.targetSiblingPath ?? meta.siblingPath;

  const baseBytes = utf8(resolved.base);
  const siblingBytes = utf8(resolved.sibling);
  const expectedBaseSha = await calculateGitBlobSHA(baseBytes);
  const expectedSiblingSha = await calculateGitBlobSHA(siblingBytes);

  // Step 2 — write done.json (commit barrier) BEFORE any file write, atomic.
  const done: DoneJson = { v: 1, writtenAt: now, expectedBaseSha, expectedSiblingSha };
  await atomicWriteFile(vault, donePath(autosaveId), utf8(JSON.stringify(done)));

  const baseTmp = stagingPathFor(targetBase, "tmp");
  const siblingTmp = stagingPathFor(targetSibling, "tmp");
  const baseBak = stagingPathFor(targetBase, "bak");
  const siblingBak = stagingPathFor(targetSibling, "bak");

  // Step 3 — stage both new versions in .sync-tmp. Parallel: distinct paths.
  await Promise.all([
    vault.adapter.writeBinary(baseTmp, baseBytes),
    vault.adapter.writeBinary(siblingTmp, siblingBytes),
  ]);

  // Step 4 — move live originals aside to .sync-bak. Skipped per-file when the
  // target doesn't exist (brand-new / save-to-alt path).
  // SEQUENTIAL by design — see DIFF-EDITOR.md §5.0.b E vs F. Do not Promise.all.
  if (await vault.adapter.exists(targetBase)) {
    await safeRename(vault.adapter, targetBase, baseBak);
  }
  if (await vault.adapter.exists(targetSibling)) {
    await safeRename(vault.adapter, targetSibling, siblingBak);
  }

  // Step 5 — promote .sync-tmp → final. This is the commit point.
  // SEQUENTIAL by design — see DIFF-EDITOR.md §5.0.b H vs I. Do not Promise.all.
  await safeRename(vault.adapter, baseTmp, targetBase);
  await safeRename(vault.adapter, siblingTmp, targetSibling);

  // Step 6 — drop the backups. Parallel.
  await Promise.all([removeIfExists(vault, baseBak), removeIfExists(vault, siblingBak)]);

  // Step 6.5 — R7.11 proactive sibling cleanup. Only when we committed onto
  // the REAL conflict sibling (not a save-to-alt fresh path) AND both sides
  // resolved to identical bytes: the sibling is now redundant. adapter-level
  // remove (not vault.delete) so it covers .obsidian/* and bypasses TrashStore.
  let siblingRemoved = false;
  if (
    targetSibling === meta.siblingPath &&
    expectedBaseSha === expectedSiblingSha &&
    (await vault.adapter.exists(meta.siblingPath))
  ) {
    await vault.adapter.remove(meta.siblingPath);
    siblingRemoved = true;
  }

  // Step 7 — tear down the autosave dir (meta + history + cursor + done.json).
  await vault.adapter.rmdir(autosaveDir(autosaveId), true);

  return {
    basePath: targetBase,
    siblingPath: targetSibling,
    expectedBaseSha,
    expectedSiblingSha,
    siblingRemoved,
  };
}

// ── §5.0.a / §5.0.b — per-dir crash recovery ─────────────────────────

export type RecoverResult =
  | { kind: "no-commit" } // done.json absent — a plain autosave dir (Stage 3 owns it)
  | { kind: "rolled-forward"; siblingRemoved: boolean } // D–K: completed the commit
  | { kind: "rolled-back" } // A–C: abandoned the commit, session preserved
  | { kind: "fallback"; reason: string }; // foreign/corrupt: session destroyed, vault intact

// SHA-classified state of one file's three slots (DIFF-EDITOR.md §5.0.b
// columns). Each is a PURE function of disk bytes — recovery never needs to
// know "which step crashed", only what's on disk now.
type FinalState = "absent" | "old" | "new" | "foreign";
type TmpState = "absent" | "tmpNew" | "tmpTorn";

interface SideState {
  finalPath: string;
  tmpPath: string;
  bakPath: string;
  final: FinalState;
  tmp: TmpState;
  bak: boolean;
}

// Recover one `.diff2-autosave/<autosaveId>/` dir per §5.0.a/b. Returns the
// action taken. Iterating over all dirs at onload (and merging with §4.2
// autosave cleanup) is Phase 11; this is the single-dir unit the sweep calls.
// Per §5.0.c we only ever touch `.sync-{tmp,bak}` files derived from THIS
// dir's meta paths — orphans without a matching meta are sync2's sweep.
export async function recoverCommit(
  vault: Vault,
  autosaveId: string,
): Promise<RecoverResult> {
  const done = await readDoneJson(vault, autosaveId);
  if (!done) return { kind: "no-commit" }; // §5.0.a: no commit started

  const meta = await readMeta(vault, autosaveId);
  if (!meta) {
    // done.json without meta is unrecoverable (no paths to resolve). Drop the
    // dir; any vault-level staging orphans fall to sync2's sweep (§5.0.c).
    await vault.adapter.rmdir(autosaveDir(autosaveId), true);
    return { kind: "fallback", reason: "meta-missing" };
  }

  const base = await classifySide(vault, meta.basePath, meta.baseShaAtStart, done.expectedBaseSha);
  const sibling = await classifySide(
    vault,
    meta.siblingPath,
    meta.siblingShaAtStart,
    done.expectedSiblingSha,
  );

  // A final slot that matches NEITHER the session-start bytes NOR the
  // committed bytes was written by something else (another device's sync, a
  // manual edit) — external modification. Rolling forward would step-4-rename
  // it to .bak and then delete it, losing that content. Bail to fallback. Note
  // this is correctly SCOPED by classification: post-commit rows (H/I/J/K)
  // have final === "new", which is NOT foreign, so they still roll forward.
  if (base.final === "foreign" || sibling.final === "foreign") {
    await cleanupStagingAndDir(vault, autosaveId, base, sibling);
    return { kind: "fallback", reason: "external-modification" };
  }

  const baseHasNew = base.final === "new" || base.tmp === "tmpNew";
  const siblingHasNew = sibling.final === "new" || sibling.tmp === "tmpNew";

  if (baseHasNew && siblingHasNew) {
    // ROLL FORWARD (rows D–K): a committed version of each side exists.
    await rollForwardSide(vault, base);
    await rollForwardSide(vault, sibling);
    // Step 6.5 — proactive sibling cleanup if both sides committed identical.
    let siblingRemoved = false;
    if (
      done.expectedBaseSha === done.expectedSiblingSha &&
      (await vault.adapter.exists(meta.siblingPath))
    ) {
      await vault.adapter.remove(meta.siblingPath);
      siblingRemoved = true;
    }
    await vault.adapter.rmdir(autosaveDir(autosaveId), true); // step 7
    return { kind: "rolled-forward", siblingRemoved };
  }

  // ROLL BACK (rows A–C): the commit never produced a usable version of both
  // sides (pre-write, or a torn .sync-tmp). Originals are untouched at their
  // final paths (.sync-bak only ever appears once both tmp✓, i.e. in the
  // forward states). Drop the partial staging + done.json; the autosave
  // session survives so the user can re-resolve.
  //
  // CLOSURE: this branch is provably correct only over crash-REACHABLE states
  // — for every real crash, a .sync-bak implies both tmps completed ⇒ both
  // hasNew ⇒ forward, so a rollback state can never carry a bak. We therefore
  // leave any bak untouched (it still holds the original — no data loss even
  // in an externally-corrupted, unreachable shape; the file is just at .bak).
  // We do NOT attempt restore-from-bak for such shapes (speculative; would add
  // code for a state no crash produces).
  await removeIfExists(vault, base.tmpPath);
  await removeIfExists(vault, sibling.tmpPath);
  await removeIfExists(vault, donePath(autosaveId));
  return { kind: "rolled-back" };
}

// Bring one side to its committed end-state from any forward (D–K) disk state.
// Idempotent and crash-safe — re-running after a crash mid-recovery converges.
async function rollForwardSide(vault: Vault, s: SideState): Promise<void> {
  if (s.final !== "new") {
    // hasNew && final≠new ⇒ tmp is tmpNew. safeRename removes the (old/absent)
    // final then promotes the tmp — mobile-safe.
    await safeRename(vault.adapter, s.tmpPath, s.finalPath);
  } else {
    // final already committed; drop any stray tmp defensively.
    await removeIfExists(vault, s.tmpPath);
  }
  await removeIfExists(vault, s.bakPath); // step 6 cleanup
}

async function cleanupStagingAndDir(
  vault: Vault,
  autosaveId: string,
  base: SideState,
  sibling: SideState,
): Promise<void> {
  // §5.0.b default fallback: remove our staging files + the session dir; leave
  // the (foreign) final bytes in place. Vault stays consistent; session lost.
  await removeIfExists(vault, base.tmpPath);
  await removeIfExists(vault, base.bakPath);
  await removeIfExists(vault, sibling.tmpPath);
  await removeIfExists(vault, sibling.bakPath);
  await vault.adapter.rmdir(autosaveDir(autosaveId), true);
}

// ── internals ────────────────────────────────────────────────────────

async function classifySide(
  vault: Vault,
  finalPath: string,
  oldSha: string,
  newSha: string,
): Promise<SideState> {
  const tmpPath = stagingPathFor(finalPath, "tmp");
  const bakPath = stagingPathFor(finalPath, "bak");

  let final: FinalState = "absent";
  if (await vault.adapter.exists(finalPath)) {
    const sha = await calculateGitBlobSHA(await vault.adapter.readBinary(finalPath));
    final = sha === newSha ? "new" : sha === oldSha ? "old" : "foreign";
  }

  let tmp: TmpState = "absent";
  if (await vault.adapter.exists(tmpPath)) {
    const sha = await calculateGitBlobSHA(await vault.adapter.readBinary(tmpPath));
    tmp = sha === newSha ? "tmpNew" : "tmpTorn";
  }

  const bak = await vault.adapter.exists(bakPath);
  return { finalPath, tmpPath, bakPath, final, tmp, bak };
}

async function readDoneJson(vault: Vault, autosaveId: string): Promise<DoneJson | null> {
  const p = donePath(autosaveId);
  if (!(await vault.adapter.exists(p))) return null;
  try {
    return JSON.parse(await vault.adapter.read(p)) as DoneJson;
  } catch {
    return null; // corrupt barrier → treat as no commit started
  }
}

async function removeIfExists(vault: Vault, path: string): Promise<void> {
  if (await vault.adapter.exists(path)) await vault.adapter.remove(path);
}
