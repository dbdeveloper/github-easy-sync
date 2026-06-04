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
  | { kind: "discard-fresh"; reason: "corrupt" | "sentinel" | "library-drift" }
  // Valid session, vault unchanged since start → §3.2 ResumeRecoveryModal
  // (Continue = build-from-snapshots + replay; Start over; ×). `meta` is the one
  // classifyReopen already read — threaded so the execute layer never re-reads it.
  | { kind: "resume"; meta: AutosaveMeta }
  // Vault changed under the session → §3.2.a. W4c INTERIM: restore the old work
  // from snapshots + replay, relying on the [←] exit-TOCTOU backstop. The full
  // §3.2.a converged/partial reopen-fork (incl. [Продовжити] sibling-write) is
  // DEFERRED — built as one unit with the sync2 sibling-write.
  | { kind: "restore"; meta: AutosaveMeta };

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
    case "vault-changed":
      return { kind: "restore", meta: status.meta };
    default: {
      // Exhaustiveness guard: a new ReopenStatus kind must add a branch here.
      const _never: never = status;
      return _never;
    }
  }
}
