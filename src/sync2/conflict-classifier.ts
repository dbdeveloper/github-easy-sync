// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { Vault } from "obsidian";
import { calculateGitBlobSHA } from "../utils";
import ConflictStore, { ConflictRecord } from "./conflict-store";

// Pseudo-merge ConflictState classifier (PSEUDO-MERGE-MODE.md, stage 3).
//
// Single algorithm, per-ConflictRecord classification. Reads the live
// vault + ConflictStore record cache to derive (baseExists,
// siblingExists, baseSha, siblingSha) and decides one of four
// outcomes (Decision below) or no-op. modify-vs-delete is NOT a
// conflict kind — it auto-resolves at push-time in favor of local
// modify (see conflict-detection.ts → attemptAutoMerge's "modify-
// wins" outcome); the classifier never sees it.
//
// Per spec §"Trigger points" this is invoked from 4 places:
//   - drain-start sweep (Sync2Manager.drain)
//   - drain-end sweep   (Sync2Manager.drain)
//   - UI op on conflict-related view
//   - ConflictWatcher fast-path hit (vault.on event)

// ── Decision (output of the pure classify() function) ─────────────────

export type Decision =
  // No state change yet — record stays, classifier just bumps
  // lastEvaluated.
  | { type: "noop" }
  // !siblingExists: user deleted the sibling file → accept ours.
  // Drop the record; vault sibling already gone so no removal
  // needed.
  | { type: "accept-ours" }
  // siblingExists, baseExists, baseSha === siblingSha (both
  // remaining kinds). User copied sibling content onto the base.
  // Drop the record AND the vault sibling. Drain will propagate
  // baseSha content to main on path-close.
  | { type: "accept-theirs" }
  // siblingExists, !baseExists, kind=modify-vs-modify.
  // User deleted the base → delete-wins. SPECIAL: this is a
  // path-level cascade — every record for the path gets dropped, every
  // sibling file removed. Drain propagates "delete from main".
  | { type: "delete-wins-cascade" };

// Pure classifier. No I/O. All inputs are already-fetched stat/hash
// values.
export function classify(
  record: ConflictRecord,
  baseExists: boolean,
  baseSha: string | null,
  _baseSize: number | null,
  siblingExists: boolean,
  siblingSha: string | null,
): Decision {
  const { kind } = record;

  // !siblingExists → accept ours regardless of kind. Both
  // modify-vs-modify and delete-vs-modify collapse to "drop record;
  // push live local state". Direction (push-content vs push-delete)
  // is the drain's job.
  if (!siblingExists) {
    return { type: "accept-ours" };
  }

  // siblingExists from here on.

  if (!baseExists) {
    // modify-vs-modify, base deleted → cascade delete-wins.
    if (kind === "modify-vs-modify") {
      return { type: "delete-wins-cascade" };
    }
    // delete-vs-modify, base absent → initial state, no-op.
    return { type: "noop" };
  }

  // siblingExists AND baseExists from here on.

  // SHA match between base and sibling — user converged the two.
  // Drop record + sweep sibling; base already holds theirs.
  if (
    baseSha !== null &&
    siblingSha !== null &&
    baseSha === siblingSha
  ) {
    return { type: "accept-theirs" };
  }

  // Base exists, SHAs don't line up — user is in the middle of
  // resolving but hasn't converged yet. Wait for the next sweep.
  return { type: "noop" };
}

// ── Orchestrator: full sweep across the ConflictStore ─────────────────

export interface EvaluationResult {
  // Records that were dropped from the store during this evaluation
  // (by id, in insertion order).
  recordsRemoved: string[];
  // Vault paths whose entire conflict set cleared during this
  // evaluation. Drain (later stage) consumes this to synthesize
  // "propagate current vault state to main" side-batches. Direction
  // (push content vs push delete) is determined by drain at
  // synthesis time from a fresh stat — classifier doesn't try to
  // pre-compute it.
  pathsResolved: Set<string>;
  // Records whose mtime/size/SHA cache was refreshed because the live
  // vault file's mtime+size no longer matched the cached pair. These
  // had a real read+hash performed; the rest were either pure no-ops
  // (cache hit, no resolution) or got removed.
  recordsRefreshed: string[];
}

// Run a full classification + apply sweep over every record in the
// ConflictStore. Side-effects: removes resolved records, deletes
// vault siblings where the resolution dictates, refreshes cache
// fields on records that survived.
export async function evaluateConflictState(
  store: ConflictStore,
  vault: Vault,
  now: () => number = () => Date.now(),
): Promise<EvaluationResult> {
  const result: EvaluationResult = {
    recordsRemoved: [],
    pathsResolved: new Set(),
    recordsRefreshed: [],
  };

  // Group records by vaultPath so the base-side stat + hash is done
  // at most once per path (multi-sibling case).
  const byPath = new Map<string, ConflictRecord[]>();
  for (const r of store.getAll()) {
    const arr = byPath.get(r.vaultPath);
    if (arr) arr.push(r);
    else byPath.set(r.vaultPath, [r]);
  }

  for (const [vaultPath, recordsOnPath] of byPath) {
    // Per-path base stat + lazy SHA.
    const baseStat = await vault.adapter.stat(vaultPath);
    const baseExists = baseStat !== null && baseStat.type === "file";
    const baseSize = baseExists ? baseStat!.size : null;

    // Quick check for Row 3 cascade BEFORE per-record loop: if base
    // is absent AND any record on this path is modify-vs-modify, the
    // whole path collapses to delete-wins. The cascade short-circuits
    // all per-record work for this path.
    if (!baseExists && recordsOnPath.some((r) => r.kind === "modify-vs-modify")) {
      for (const r of recordsOnPath) {
        if (await vault.adapter.exists(r.siblingPath)) {
          await vault.adapter.remove(r.siblingPath);
        }
        await store.delete(r.id);
        result.recordsRemoved.push(r.id);
      }
      result.pathsResolved.add(vaultPath);
      continue;
    }

    // Lazy base SHA: computed (or cache-hit) on first record that
    // needs it. After computation it's cached in `baseShaCached` for
    // the rest of this path's records.
    let baseShaCached: string | null = null;
    let baseShaResolved = false;
    const ensureBaseSha = async (
      sample: ConflictRecord,
    ): Promise<string | null> => {
      if (baseShaResolved) return baseShaCached;
      if (!baseExists) {
        baseShaCached = null;
        baseShaResolved = true;
        return null;
      }
      if (
        sample.baseSha !== null &&
        baseStat!.mtime === sample.baseMtime &&
        baseStat!.size === sample.baseSize
      ) {
        baseShaCached = sample.baseSha;
      } else {
        const content = await vault.adapter.readBinary(vaultPath);
        baseShaCached = await calculateGitBlobSHA(content);
      }
      baseShaResolved = true;
      return baseShaCached;
    };

    let recordsResolvedThisPath = 0;

    for (const record of recordsOnPath) {
      // ── Sibling stat + SHA (with cache) ────────────────────────────
      const siblingStat = await vault.adapter.stat(record.siblingPath);
      const siblingExists = siblingStat !== null && siblingStat.type === "file";

      let siblingSha: string | null = null;
      let cacheRefreshNeeded = false;
      let freshSiblingMtime = record.siblingMtime;
      let freshSiblingSize = record.siblingSize;
      if (siblingExists) {
        if (
          siblingStat!.mtime === record.siblingMtime &&
          siblingStat!.size === record.siblingSize
        ) {
          // Cache hit — trust the persisted siblingSha as-is.
          siblingSha = record.siblingSha;
        } else {
          const content = await vault.adapter.readBinary(record.siblingPath);
          siblingSha = await calculateGitBlobSHA(content);
          freshSiblingMtime = siblingStat!.mtime;
          freshSiblingSize = siblingStat!.size;
          cacheRefreshNeeded = true;
        }
      }

      // ── Base SHA (per-path lazy) ───────────────────────────────────
      const baseSha = baseExists ? await ensureBaseSha(record) : null;

      // ── Classify ───────────────────────────────────────────────────
      const decision = classify(
        record,
        baseExists,
        baseSha,
        baseSize,
        siblingExists,
        siblingSha,
      );

      // ── Apply ──────────────────────────────────────────────────────
      if (decision.type === "noop") {
        if (cacheRefreshNeeded) {
          await store.updateCache(record.id, {
            siblingMtime: freshSiblingMtime,
            siblingSize: freshSiblingSize,
            siblingSha: siblingSha ?? "",
            // Refresh base cache too while we're here, so subsequent
            // sweeps see the same (path, base) pair as a cache-hit.
            // Note: for multi-sibling paths the base cache is shared,
            // so the first record to refresh it carries everyone.
            baseMtime: baseExists ? baseStat!.mtime : null,
            baseSize: baseExists ? baseStat!.size : null,
            baseSha: baseSha,
            lastEvaluated: now(),
          });
          result.recordsRefreshed.push(record.id);
        } else {
          await store.updateCache(record.id, { lastEvaluated: now() });
        }
        continue;
      }

      // Resolution: figure out whether the vault sibling should be
      // removed as part of this resolution. Only accept-theirs
      // sweeps the sibling here — accept-ours fires only when the
      // sibling is already gone, and delete-wins-cascade is handled
      // at path level above.
      const siblingShouldBeRemoved = decision.type === "accept-theirs";

      if (siblingShouldBeRemoved && siblingExists) {
        await vault.adapter.remove(record.siblingPath);
      }
      await store.delete(record.id);
      result.recordsRemoved.push(record.id);
      recordsResolvedThisPath++;
    }

    // Path-close detection: every record for this path got resolved
    // during this sweep AND no fresh records exist (none added mid-
    // loop because we don't fire create() here). Translate to
    // pathsResolved set for drain consumption.
    if (
      recordsResolvedThisPath === recordsOnPath.length &&
      recordsResolvedThisPath > 0
    ) {
      result.pathsResolved.add(vaultPath);
    }
  }

  return result;
}
