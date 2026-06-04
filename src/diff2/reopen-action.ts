// W4c Step A — pure reopen-action dispatch (DIFF-EDITOR.md §3.1 / §3.2 / §3.2.a).
//
// Maps a `classifyReopen` ReopenStatus to the action `mountDiffPane` executes.
// PURE: no ItemView / modal / vault deps — the testable spine of W4c. The
// execute layer turns the action into glue (startSession / rmdir+fresh /
// ResumeRecoveryModal+replay / restore-from-snapshots+replay). Keeping the
// branch decision here (not inline in mountDiffPane) makes the whole 6-status
// matrix unit-testable in one table; the canonical behaviour for each status
// lives in §3.1 / §3.2 / §3.2.a, not restated here.

import type { AutosaveMeta, ReopenStatus } from "./autosave-store";

export type ReopenAction =
  // No prior session dir — create a brand-new one (nothing to clear).
  | { kind: "fresh" }
  // Clear the prior (unusable) dir, then a fresh session. `reason` drives the
  // execute-layer Notice (or silence):
  //   corrupt        — session unrecoverable (meta / snapshot-integrity /
  //                    input-missing); §3.5 cleanup → fresh.
  //   sentinel       — defensive; mount's §1.3 findSentinelCollision already
  //                    bailed before this, so unreachable in practice.
  //   library-drift  — inputs unchanged but build() now yields a different
  //                    joined-doc → replay offsets unsound → start fresh
  //                    (§3.1 gate / §8 #8). No restore (snapshots wouldn't help).
  //   both-changed   — BOTH vault sides changed under the session → the user's
  //                    work is fully stale → silent fresh restart, no dialog
  //                    (§3.2.a). A one-side change is `restore`, not this.
  | {
      kind: "discard-fresh";
      reason: "corrupt" | "sentinel" | "library-drift" | "both-changed";
    }
  // Valid session, vault unchanged since start → §3.2 ResumeRecoveryModal
  // (Continue = build-from-snapshots + replay; Start over; ×). `meta` is the one
  // classifyReopen already read — threaded so the execute layer never re-reads it.
  | { kind: "resume"; meta: AutosaveMeta }
  // EXACTLY ONE vault side changed under the session → §3.2.a. Shows the SAME
  // §3.2 ResumeRecoveryModal (a "*" marks the changed file — it is just crash
  // recovery, no scary "files changed" dialog). On Continue, the user's restored
  // edit for the UNCHANGED side is written onto the new version, then the session
  // is recreated. `changedSide` is the side that changed in the vault (so the
  // OTHER side is written). Symmetric — no privilege of base over sibling.
  | { kind: "restore"; meta: AutosaveMeta; changedSide: "base" | "sibling" };

export function reopenAction(status: ReopenStatus): ReopenAction {
  switch (status.kind) {
    case "fresh":
      return { kind: "fresh" };
    case "corrupt":
      return { kind: "discard-fresh", reason: "corrupt" };
    case "sentinel":
      return { kind: "discard-fresh", reason: "sentinel" };
    case "library-drift":
      return { kind: "discard-fresh", reason: "library-drift" };
    case "resume":
      return { kind: "resume", meta: status.meta };
    case "vault-changed": {
      const baseChanged = status.currentBaseSha !== status.meta.baseShaAtStart;
      const siblingChanged =
        status.currentSiblingSha !== status.meta.siblingShaAtStart;
      // BOTH changed → the user's work is fully stale → silent fresh restart.
      if (baseChanged && siblingChanged) {
        return { kind: "discard-fresh", reason: "both-changed" };
      }
      // Exactly one changed → restore (the §3.2 modal), recording which side.
      return {
        kind: "restore",
        meta: status.meta,
        changedSide: baseChanged ? "base" : "sibling",
      };
    }
    default: {
      // Exhaustiveness guard: a new ReopenStatus kind must add a branch here.
      const _never: never = status;
      return _never;
    }
  }
}
