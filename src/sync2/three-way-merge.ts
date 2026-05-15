// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { merge as diff3Merge } from "node-diff3";

// Outcome of a 3-way merge attempt. "clean" means non-overlapping
// edits or coincident edits that node-diff3 reconciled silently.
// "conflict" means the merger could not pick a side and emitted
// conflict markers in the output, expecting the user to resolve.
export type MergeOutcome =
  | { kind: "clean"; content: string }
  | { kind: "conflict"; conflictMarkedContent: string };

// Three-way text merge.
//   ours   = local content (the user's current work).
//   base   = the version both sides started from (last common ancestor).
//   theirs = the remote-side content we discovered during push.
//
// Returns either a clean merged string or a string with git-style
// conflict markers (<<<<<<<, =======, >>>>>>>) for the user to
// resolve through the conflict modal.
export function mergeText(
  ours: string,
  base: string,
  theirs: string,
): MergeOutcome {
  // node-diff3.merge() argument order: (a=ours, o=base, b=theirs).
  // excludeFalseConflicts collapses "both sides made the identical
  // change" into a clean merge instead of flagging it.
  const result = diff3Merge(ours, base, theirs, {
    excludeFalseConflicts: true,
    stringSeparator: /\r?\n/,
  });
  // result.result is an array of strings (with conflict markers
  // already inlined when result.conflict is true). Join with the
  // newline that the original inputs likely used.
  const sep = pickSeparator(ours, base, theirs);
  const joined = result.result.join(sep);
  if (!result.conflict) {
    return { kind: "clean", content: joined };
  }
  return { kind: "conflict", conflictMarkedContent: joined };
}

// Pick the line-ending the merged text should use. Prefer CRLF if any
// of the inputs uses it (Windows-edited files preserve their style),
// otherwise plain LF.
function pickSeparator(...inputs: string[]): string {
  for (const s of inputs) {
    if (s.includes("\r\n")) return "\r\n";
  }
  return "\n";
}
