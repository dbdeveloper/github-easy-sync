// Line-level diff chunking for DiffPane.
//
// Given (ours, theirs) text, compute a sequence of chunks describing
// how the two diverge. The DiffPane renders these as a unified
// merged document with marker block-widgets between them.
//
// Diff strategy: `diff.diffLines` from the `diff` npm package
// (Myers-based; ~30 KB minified; the leading lightweight choice for
// mobile bundles compared to diff-match-patch's ~70 KB). Returns an
// array of parts; each part has `value` (string), `added` (boolean),
// `removed` (boolean). We collapse sequential added/removed parts
// into one "diff" chunk and keep unchanged spans as "common" chunks.
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.1 (unified-only)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.2 (marker layout)
//
// Pure module — no DOM, no CodeMirror.

import { diffLines } from "diff";

export type DiffChunk =
  | { kind: "common"; lines: string[] }
  | { kind: "diff"; oursLines: string[]; theirsLines: string[] };

// Run line-level diff between two strings and group the output into
// a chunk list. Newlines belong to the lines they terminate; the
// last line may be empty if the source ended with a newline. Per
// `diff` package semantics, each part's `value` includes the
// trailing newline(s).
export function computeChunks(ours: string, theirs: string): DiffChunk[] {
  const parts = diffLines(ours, theirs);
  const chunks: DiffChunk[] = [];

  let bufOurs: string[] = [];
  let bufTheirs: string[] = [];

  const flushDiff = (): void => {
    if (bufOurs.length === 0 && bufTheirs.length === 0) return;
    chunks.push({ kind: "diff", oursLines: bufOurs, theirsLines: bufTheirs });
    bufOurs = [];
    bufTheirs = [];
  };

  for (const part of parts) {
    const lines = splitToLines(part.value);
    if (part.added) {
      bufTheirs.push(...lines);
    } else if (part.removed) {
      bufOurs.push(...lines);
    } else {
      flushDiff();
      if (lines.length > 0) chunks.push({ kind: "common", lines });
    }
  }
  flushDiff();

  return chunks;
}

// Split a part's value into individual lines, preserving the
// trailing-newline shape. Each output entry is a line WITHOUT the
// trailing newline (consumers add separators when joining). An
// empty trailing entry (from a value ending in "\n") is dropped so
// the array length matches the visible line count.
function splitToLines(value: string): string[] {
  if (value === "") return [];
  const out = value.split("\n");
  // Trim a trailing empty entry produced when value ended with "\n"
  // (split("a\nb\n", "\n") → ["a", "b", ""]).
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

// Re-flatten a chunk list back to merged-document text (no markers).
// The resulting string is what gets fed to CodeMirror as the
// EditorState.doc; marker block-widgets are layered on top as
// decorations, not inserted as real text.
//
// Layout per chunk: common lines first, then ours lines, then
// theirs lines — exactly what R7.2's diagram shows.
export function chunksToText(chunks: DiffChunk[]): string {
  const segs: string[] = [];
  for (const c of chunks) {
    if (c.kind === "common") {
      segs.push(...c.lines);
    } else {
      segs.push(...c.oursLines);
      segs.push(...c.theirsLines);
    }
  }
  return segs.join("\n");
}

// Per-chunk byte offsets within the flattened document text.
//   ChunkOffsets entry shape (one per source chunk):
//     - kind === "common": { start, end } of the run
//     - kind === "diff":
//         oursStart/oursEnd — char range of the ours lines
//         theirsStart/theirsEnd — char range of the theirs lines
//
// Computed via the same flattening rule as chunksToText so callers
// (decorations.ts, markers.ts) can derive line-level + char-level
// positions without re-tokenizing the document.
export type ChunkOffset =
  | { kind: "common"; start: number; end: number; lineStart: number; lineEnd: number }
  | {
      kind: "diff";
      oursStart: number;
      oursEnd: number;
      theirsStart: number;
      theirsEnd: number;
      // Line-number bounds (0-indexed) for gutter / decoration use.
      oursLineStart: number;
      oursLineEnd: number;
      theirsLineStart: number;
      theirsLineEnd: number;
    };

export function computeChunkOffsets(chunks: DiffChunk[]): ChunkOffset[] {
  const offsets: ChunkOffset[] = [];
  let charPos = 0;
  let linePos = 0;

  // chunksToText joins lines with "\n" (inside a run) AND between
  // adjacent runs. Track "we just emitted lines" so the next non-
  // empty run knows to skip its leading char-offset by 1.
  let needsSep = false;
  const emitSepIfNeeded = (nonEmpty: boolean): void => {
    if (nonEmpty && needsSep) charPos += 1;
  };

  for (const c of chunks) {
    if (c.kind === "common") {
      const nonEmpty = c.lines.length > 0;
      emitSepIfNeeded(nonEmpty);
      const startChar = charPos;
      const startLine = linePos;
      charPos += lineRunLength(c.lines);
      linePos += c.lines.length;
      offsets.push({
        kind: "common",
        start: startChar,
        end: charPos,
        lineStart: startLine,
        lineEnd: linePos,
      });
      if (nonEmpty) needsSep = true;
    } else {
      // Ours sub-run.
      const oursNonEmpty = c.oursLines.length > 0;
      emitSepIfNeeded(oursNonEmpty);
      const oursStart = charPos;
      const oursLineStart = linePos;
      charPos += lineRunLength(c.oursLines);
      linePos += c.oursLines.length;
      const oursEnd = charPos;
      const oursLineEnd = linePos;
      if (oursNonEmpty) needsSep = true;

      // Theirs sub-run.
      const theirsNonEmpty = c.theirsLines.length > 0;
      emitSepIfNeeded(theirsNonEmpty);
      const theirsStart = charPos;
      const theirsLineStart = linePos;
      charPos += lineRunLength(c.theirsLines);
      linePos += c.theirsLines.length;
      const theirsEnd = charPos;
      const theirsLineEnd = linePos;
      if (theirsNonEmpty) needsSep = true;

      offsets.push({
        kind: "diff",
        oursStart,
        oursEnd,
        theirsStart,
        theirsEnd,
        oursLineStart,
        oursLineEnd,
        theirsLineStart,
        theirsLineEnd,
      });
    }
  }

  return offsets;
}

function lineRunLength(lines: string[]): number {
  if (lines.length === 0) return 0;
  let total = 0;
  for (const l of lines) total += l.length;
  total += lines.length - 1; // inter-line newlines
  return total;
}
