// Bulk chunk resolution — group-toolbar operations (R2.2 / R7.9a).
//
// Applies the same ChunkChoice to every diff chunk in a list:
//   - [Keep all local]     → choice: "ours"
//   - [Apply all remote]   → choice: "theirs"
//   - [Join all changes]   → choice: "join" (markdown only)
//
// Operates on the chunks-list level (not directly on the document)
// — returns a new chunks list where every diff chunk has been
// replaced by a common chunk holding the resolved lines. DiffPane's
// resolveAll method then dispatches one text-replacement to bring
// the document in sync.
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.2 (Conflicts list group toolbar)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.9a (Detail toolbar variant)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.5 (Join blockquote format)
//
// Pure module — no DOM, no CodeMirror.

import {
  chooseLines,
  type ChunkChoice,
  type JoinContext,
} from "./chunk-actions";
import { chunksToText, type DiffChunk } from "./diff-chunks";

// Apply `choice` to every diff chunk in the list. Common chunks
// pass through unchanged. Result: a new chunks list with the same
// length as the input; every diff entry becomes a common entry
// holding the resolved lines (which may be []).
export function resolveAllChunks(
  chunks: DiffChunk[],
  choice: ChunkChoice,
  joinCtx?: JoinContext,
): DiffChunk[] {
  return chunks.map((c) => {
    if (c.kind === "common") return c;
    const resolved = chooseLines(c, choice, joinCtx);
    return { kind: "common", lines: resolved };
  });
}

// Convenience: produce the final resolved document text directly.
// Diff-pane.ts uses this for the "replace whole doc" path of bulk
// operations (one big dispatch instead of N per-chunk dispatches).
export function resolveAllAsText(
  chunks: DiffChunk[],
  choice: ChunkChoice,
  joinCtx?: JoinContext,
): string {
  return chunksToText(resolveAllChunks(chunks, choice, joinCtx));
}

// File-type guard for the [Join all] button visibility. Markdown
// blockquote semantics make no sense in JSON/YAML/CSS/CSV. Match
// the conservative list from R7.9a "Md-only safety".
export function isMarkdownPath(vaultPath: string): boolean {
  const lower = vaultPath.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}
