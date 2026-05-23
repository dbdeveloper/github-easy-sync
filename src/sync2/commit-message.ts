// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Stage 13 (Decision #36): hardcoded commit-message formats.
//
// Pre-Stage-13 commit messages were user-template-driven: settings
// had a "Commit message" field with `{date}` / `{time}` placeholders,
// rendered via `applyTemplate` and suffixed with `(deviceLabel)`
// via `appendDeviceSuffix`. Stage 13 drops the whole templating
// system — every commit message is now a hardcoded string with
// `{deviceLabel}` as the only substitution. See PSEUDO-MERGE-MODE.md
// §"Commit message formats (Stage 13 — hardcoded)".
//
// Why drop templates: provenance + multi-device disambiguation are
// the only useful signals, both delivered by `(deviceLabel)`. Date
// and time come for free from git commit metadata (authorDate /
// committerDate). Power-user customization was unused and added
// surface area for bugs.

// Sentinel used wherever sync2 needs a stand-in for an unknown device
// — both at READ time (parseDeviceSuffix on a commit with no trailing
// "(label)") and at WRITE time (every formatX function below when
// settings.deviceLabel is empty or missing). One constant, one
// literal "unknown", everywhere.
export const UNKNOWN_DEVICE_LABEL = "unknown";

// Escape parens in the deviceLabel so the trailing-paren regex used
// by parseDeviceSuffix stays unambiguous. `(` → `[`, `)` → `]`.
// Square brackets render naturally in commit messages and stay
// parseable. Spaces and Unicode survive untouched.
function safeLabel(deviceLabel: string): string {
  const raw =
    !deviceLabel || deviceLabel.length === 0
      ? UNKNOWN_DEVICE_LABEL
      : deviceLabel;
  return raw.replace(/\(/g, "[").replace(/\)/g, "]");
}

// User-driven sync batch (syncAll, syncFile). Default for any batch
// the engine doesn't explicitly mark as synthetic / branch-bound /
// merge.
export function formatSyncMessage(deviceLabel: string): string {
  return `sync (${safeLabel(deviceLabel)})`;
}

// Synthetic batch from drain Phase B side-batch synthesis. Marks the
// commit that propagates a closed conflict's live base state to main.
export function formatResolveConflictMessage(deviceLabel: string): string {
  return `resolve conflict (${safeLabel(deviceLabel)})`;
}

// Intermediate commit on the per-device conflict-branch: snapshot of
// the user's local copy at registration time, or edit-while-in-
// conflict push. NOT a main-bound commit; lands on the
// `github-easy-sync-conflicts-<device>-<ts>-<ms>` branch.
export function formatConflictMessage(deviceLabel: string): string {
  return `conflict (${safeLabel(deviceLabel)})`;
}

// Marker commit on the conflict-branch right before the finalize
// merge. Preserves the user's live state as the branch tip.
export function formatFinalStateMessage(deviceLabel: string): string {
  return `final state (${safeLabel(deviceLabel)})`;
}

// Finalize merge-commit on main. Has TWO parents (main.head +
// branch.head); the merge-commit makes branch.head reachable from
// main so the intermediate "conflict" commits stay GC-safe after
// deleteRef.
export function formatMergeConflictBranchMessage(deviceLabel: string): string {
  return `merge conflict-branch (${safeLabel(deviceLabel)})`;
}

// Bare-repo bootstrap commit. Written by the Contents API seed when
// the target branch has no commits yet (`getBranchHeadSha` returns
// 404 / 409). Hardcoded — no template-driven date/time prefix.
export function formatInitMessage(deviceLabel: string): string {
  return `init (${safeLabel(deviceLabel)})`;
}

// Pick the commit message format for a batch at processBatch time
// based on its `synthetic` flag. Synthetic = Phase B side-batch from
// drain conflict-resolution → "resolve conflict ({label})". Non-
// synthetic = user-driven sync click → "sync ({label})". Centralised
// here so the inline derivation in processBatch is a one-liner and
// the formatX choice stays consistent across call sites.
export function commitMessageForBatch(
  synthetic: boolean,
  deviceLabel: string,
): string {
  return synthetic
    ? formatResolveConflictMessage(deviceLabel)
    : formatSyncMessage(deviceLabel);
}

// Inverse of the trailing `(label)` suffix: pulls the device label
// off any commit message produced by sync2. Falls back to
// UNKNOWN_DEVICE_LABEL for hand-edited or non-sync2 commits.
//
// This survives from the pre-Stage-13 commit-templates module
// because the suffix shape didn't change — every Stage 13 formatX
// function above appends `(safeLabel(...))` so the regex still
// matches. Used by sync2-manager to identify the foreign device on
// an existing commit (for the multi-device "who pushed this?"
// observability log line).
export function parseDeviceSuffix(message: string): string {
  const m = /\s\(([^()]+)\)\s*$/.exec(message);
  return m ? m[1] : UNKNOWN_DEVICE_LABEL;
}
