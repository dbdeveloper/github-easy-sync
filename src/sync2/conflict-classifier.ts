// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { Vault } from "obsidian";
import { calculateGitBlobSHA } from "../utils";
import ConflictStore, { ConflictRecord } from "./conflict-store";

// Pseudo-merge ConflictState classifier (PSEUDO-MERGE-MODE.md, stage 3).
//
// Single algorithm, 11-row classification per ConflictRecord. Reads
// the live vault + ConflictStore record cache to derive (baseExists,
// siblingExists, baseSha, siblingSha) and decides one of six
// resolution outcomes (Decision below) or no-op.
//
// Per spec §"Trigger points" this is invoked from 4 places:
//   - drain-start sweep
//   - drain-end sweep
//   - UI op on conflict-related view
//   - vault.on(...) fast-path hit (Stage 4)
//
// Stage 3 ships the algorithm only — it is NOT wired to any trigger
// point yet. Drain orchestration lands in stages 5–6.

// ── Decision (output of the pure classify() function) ─────────────────

export type Decision =
  // No state change yet — record stays, classifier just bumps
  // lastEvaluated.
  | { type: "noop" }
  // Cases 1 + 2 of the spec: !siblingExists.
  // User deleted the sibling file → accept ours. Drop the record;
  // vault sibling already gone so no removal needed.
  | { type: "accept-ours" }
  // Case 6: siblingExists, baseExists, baseSha === siblingSha
  // (modify-vs-modify OR delete-vs-modify).
  // User copied sibling content onto the base. Drop the record AND
  // the vault sibling. Drain will propagate baseSha content to main
  // on path-close.
  | { type: "accept-theirs" }
  // Case 3: siblingExists, !baseExists, kind=modify-vs-modify.
  // User deleted the base → delete-wins. SPECIAL: this is a
  // path-level cascade — every record for the path gets dropped, every
  // sibling file removed. Drain propagates "delete from main".
  | { type: "delete-wins-cascade" }
  // Case 4: siblingExists, !baseExists, kind=modify-vs-delete.
  // User deleted the base → accept theirs (confirm the remote delete).
  // Drop record + .deleted sibling. Drain propagates delete on
  // path-close.
  | { type: "confirm-remote-delete" }
  // Case 11: siblingExists (.deleted placeholder), baseExists,
  // baseSize === 0, kind=modify-vs-delete.
  // User stared at the .deleted sibling, blanked the base file
  // entirely — "fine, delete it". Drop record + .deleted sibling.
  // Drain propagates delete on path-close.
  | { type: "intentional-delete" };

// Pure classifier. No I/O. All inputs are already-fetched stat/hash
// values. Spec table rows are commented inline so a future reader can
// cross-reference.
export function classify(
  record: ConflictRecord,
  baseExists: boolean,
  baseSha: string | null,
  baseSize: number | null,
  siblingExists: boolean,
  siblingSha: string | null,
): Decision {
  const { kind } = record;

  // Row 1 + 2: !siblingExists → accept ours regardless of kind.
  // The merge of the two rows (modify-vs-modify + delete-vs-modify
  // collapse into the same "accept ours" action) and the
  // modify-vs-delete twin row both reduce to "drop record". Only
  // path-level direction (push-content vs push-delete) differs and
  // that's a drain-side concern.
  if (!siblingExists) {
    return { type: "accept-ours" };
  }

  // siblingExists from here on.

  if (!baseExists) {
    // Row 3: modify-vs-modify, base deleted → cascade delete-wins.
    if (kind === "modify-vs-modify") {
      return { type: "delete-wins-cascade" };
    }
    // Row 4: modify-vs-delete, base deleted → confirm remote delete.
    if (kind === "modify-vs-delete") {
      return { type: "confirm-remote-delete" };
    }
    // Row 5: delete-vs-modify, base absent → initial state, no-op.
    return { type: "noop" };
  }

  // siblingExists AND baseExists from here on.

  // Row 6: SHA match between base and sibling. User converged the two
  // — accept that variant. Applies to modify-vs-modify AND
  // delete-vs-modify (for delete-vs-modify, ours was "delete" but
  // user reified base from sibling content; same outcome).
  if (
    baseSha !== null &&
    siblingSha !== null &&
    baseSha === siblingSha &&
    (kind === "modify-vs-modify" || kind === "delete-vs-modify")
  ) {
    return { type: "accept-theirs" };
  }

  // modify-vs-delete branch (sibling = 0-byte .deleted placeholder).
  if (kind === "modify-vs-delete") {
    // Row 11: base emptied → user signal "yes, delete this".
    if (baseSize === 0) {
      return { type: "intentional-delete" };
    }
    // Rows 10, 12: base unchanged from ours OR user editing base ≠ ours
    // — both no-ops (the user is still deliberating).
    return { type: "noop" };
  }

  // Rows 7, 8, 9 (and any leftover modify-vs-modify / delete-vs-modify
  // state where the SHAs don't line up): the user is in the middle of
  // resolving but hasn't converged yet. Wait.
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
//
// Stage 3 deliverable — this function is exported but not yet
// wired to drain / vault events. Tests instantiate it directly
// against a real ConflictStore + a fixture vault.
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
      // removed as part of this resolution.
      const siblingShouldBeRemoved =
        // Case 6: user copied sibling onto base, sibling is dead weight.
        decision.type === "accept-theirs" ||
        // Case 4 + 11: modify-vs-delete resolution sweeps the
        // .deleted placeholder along with the record.
        decision.type === "confirm-remote-delete" ||
        decision.type === "intentional-delete";
      // (delete-wins-cascade is handled at path level above, never
      // reaches here.)

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
