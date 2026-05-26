// Per-chunk resolution actions (R7.5).
//
// Pure logic: given a diff-chunk and a user choice, produce the
// lines that should replace the chunk's range in the document.
// All six chunk-level choices from R7.5 enumerated below; the
// "join" variant (markdown only) adds a blockquote callout per
// R2.2 / R7.5 format.
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.5 (action-button semantics)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.2 (Join all blockquote format)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.6 (visual arrows; pure-logic
//     module doesn't render — just supplies the result lines.)
//
// No DOM, no CodeMirror — these helpers compose with diff-pane.ts'
// transaction dispatch.

import type { DiffChunk } from "./diff-chunks";

// Six possible resolutions per chunk. Naming follows R7.5's button
// labels rather than directional "top/bottom".
export type ChunkChoice =
  | "ours"     // top [apply]  / bottom [remove]
  | "theirs"   // top [remove] / bottom [apply]
  | "both"     // middle [apply both]
  | "neither"  // middle [remove both]
  | "join";    // middle [join <remote>] — markdown only

// Context the "join" variant needs to format the blockquote header.
// Passed by DiffPane through to chunk-actions.
export interface JoinContext {
  // Remote-device label as it appears in the sibling filename
  // (bracket-sanitized form is acceptable for display).
  remoteDeviceLabel: string;
  // Human-friendly timestamp for the blockquote header. Caller may
  // pass the raw filename ISO ("YYYY-MM-DDTHH-MM-SSZ") or any
  // formatted variant; chooseLines doesn't interpret it.
  timestamp: string;
}

// Return the lines that should replace the diff chunk's combined
// range (ours+theirs) in the document. Returns an empty array when
// the choice resolves to "no content at all" (e.g., "neither" or
// when both sides were empty).
export function chooseLines(
  chunk: DiffChunk,
  choice: ChunkChoice,
  joinCtx?: JoinContext,
): string[] {
  if (chunk.kind !== "diff") return [];

  switch (choice) {
    case "ours":
      return [...chunk.oursLines];
    case "theirs":
      return [...chunk.theirsLines];
    case "both":
      // R7.5: "конкатенація обох сторін (ours, потім theirs; порожня
      // лінія між ними, якщо обидва закінчуються на текст)". The
      // blank-line separator only appears when BOTH sides have at
      // least one line.
      if (chunk.oursLines.length === 0) return [...chunk.theirsLines];
      if (chunk.theirsLines.length === 0) return [...chunk.oursLines];
      return [...chunk.oursLines, "", ...chunk.theirsLines];
    case "neither":
      // Chunk collapses to empty — surrounding common lines abut.
      return [];
    case "join": {
      if (!joinCtx) {
        throw new Error(
          "chooseLines: 'join' choice requires JoinContext (deviceLabel + timestamp)",
        );
      }
      return joinAsBlockquote(chunk, joinCtx);
    }
  }
}

// Render theirs-lines as a Markdown blockquote callout under
// ours-lines. Format per R2.2 / R7.5:
//
//   <ours-line-1>
//   <ours-line-2>
//
//   > Changes from <remote deviceLabel> at <timestamp>:
//   >
//   > <theirs-line-1>
//   > <theirs-line-2>
//
// Single blank line between ours block and the callout, with the
// callout header on its own ">" line for the visual separator.
// Diff-chunk narrow alias so the helper is type-safe inside its body
// (the caller already narrowed via the kind-guard).
type DiffOnly = Extract<DiffChunk, { kind: "diff" }>;

function joinAsBlockquote(chunk: DiffOnly, ctx: JoinContext): string[] {
  const out: string[] = [];
  out.push(...chunk.oursLines);
  // Visual gap between ours block and the callout. If ours was
  // empty (delete-vs-modify edge case rendered as md callout), skip
  // the leading blank — the callout opens at the chunk's start.
  if (chunk.oursLines.length > 0) out.push("");
  out.push(`> Changes from \`${ctx.remoteDeviceLabel}\` at \`${ctx.timestamp}\`:`);
  out.push(">");
  for (const line of chunk.theirsLines) out.push(`> ${line}`);
  return out;
}

// Helper used by diff-pane.ts to determine the text-replacement
// range for a chunk action. Given a diff-chunk's offset entry,
// return the [from, to] document range that should be replaced.
// Covers both ours+theirs runs INCLUDING the "\n" separator between
// them when both sides are non-empty.
export function chunkReplacementRange(
  oursStart: number,
  oursEnd: number,
  theirsStart: number,
  theirsEnd: number,
  oursNonEmpty: boolean,
  theirsNonEmpty: boolean,
): { from: number; to: number } {
  // When both are non-empty, the union covers ours + "\n" + theirs.
  // When only one side has content, that side's range alone.
  // When both are empty, zero-length range at the chunk position.
  if (oursNonEmpty && theirsNonEmpty) {
    return { from: oursStart, to: theirsEnd };
  }
  if (oursNonEmpty) {
    return { from: oursStart, to: oursEnd };
  }
  if (theirsNonEmpty) {
    return { from: theirsStart, to: theirsEnd };
  }
  // Both empty — shouldn't happen for a real diff chunk, but
  // safe-default to a zero-length range at theirsStart.
  return { from: theirsStart, to: theirsStart };
}

// Serialize a lines-array into the text replacement string. Lines
// are joined with "\n" — no leading or trailing newline (the doc's
// surrounding context provides the boundary).
export function linesToReplacementText(lines: string[]): string {
  return lines.join("\n");
}
