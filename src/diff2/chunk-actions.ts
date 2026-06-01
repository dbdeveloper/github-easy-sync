// Per-chunk resolution types (R7.5).
//
// The chunk-action SEMANTICS now live in diff-pane.ts' resolveText
// (operating on the editor-model's ver texts, which carry their own \n
// terminators) — the legacy line-array helpers (chooseLines /
// chunkReplacementRange) didn't fit the Rep A model and were removed in
// Etap 1b.1. This module keeps the shared CHOICE + JOIN-CONTEXT types.
//
// Canonical specs:
//   - docs/tasks/DIFF-EDITOR.md §1.6 (resolution operations)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.5 (action-button semantics)

// Six possible resolutions per diff group. Naming follows R7.5's button
// labels rather than directional "top/bottom".
export type ChunkChoice =
  | "ours"     // top [apply]  / bottom [remove]  → keep ver1 (local)
  | "theirs"   // top [remove] / bottom [apply]   → keep ver2 (remote)
  | "both"     // middle [apply both]             → ver1 + ver2
  | "neither"  // middle [remove both]            → drop the group
  | "join";    // middle [join <remote>]          → md blockquote (md only)

// Context the "join" variant needs to format the blockquote header.
export interface JoinContext {
  // Remote-device label as it appears in the sibling filename
  // (bracket-sanitized form is acceptable for display).
  remoteDeviceLabel: string;
  // Human-friendly timestamp for the blockquote header (raw filename
  // ISO "YYYY-MM-DDTHH-MM-SSZ" or any formatted variant).
  timestamp: string;
}
