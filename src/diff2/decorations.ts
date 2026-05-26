// DiffPane decoration extension — produces a CodeMirror DecorationSet
// from a chunk list (DiffChunk[]) + offsets (ChunkOffset[]).
//
// Decorations produced:
//   - Line backgrounds: red (ours), green (theirs), neutral
//     (common) via Decoration.line with CSS classes.
//   - Word-level overlays: yellow Decoration.mark on character
//     ranges from word-level-diff (R7.4). Mixes visually with the
//     base line color to orange (red+yellow) / salad (green+yellow).
//   - Marker block-widgets: <<<<<, =====, >>>>> at the line
//     boundaries of each diff chunk (R7.2).
//
// Wrapped as a static StateField. Phase 2 builds the decoration set
// once at view construction; Phase 3 will switch to a dynamic field
// that updates as the user resolves chunks (apply/remove).
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.2 + R7.3 (markers + colors)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.4 (word-level highlight)

import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import type { ChunkOffset, DiffChunk } from "./diff-chunks";
import { ConflictMarkerWidget } from "./markers";
import { computeWordDiff } from "./word-level-diff";

export interface BuildOpts {
  // Device label that authored "theirs" (remote side). Used for the
  // top-marker label (R7.2 places local-deviceLabel on top, remote
  // on bottom — but Phase 2 simplifies to "ours" / "theirs" — the
  // R2.7.4 conflict-store + ConflictRecord supply the actual labels;
  // Phase 3 threads them in. Phase 2 placeholder values are fine.)
  oursLabel: string;
  theirsLabel: string;
}

const COMMON_LINE_CLASS = "diff2-line-common";
const OURS_LINE_CLASS = "diff2-line-ours";
const THEIRS_LINE_CLASS = "diff2-line-theirs";
const WORD_MARK_CLASS = "diff2-word-changed";

// Pre-built Decoration objects. Decoration.line is cheap to reuse
// across many ranges; doing so keeps the RangeSet small and the
// view-update cheap.
const lineCommon = Decoration.line({ class: COMMON_LINE_CLASS });
const lineOurs = Decoration.line({ class: OURS_LINE_CLASS });
const lineTheirs = Decoration.line({ class: THEIRS_LINE_CLASS });
const wordMark = Decoration.mark({ class: WORD_MARK_CLASS });

// Build the static DecorationSet covering one (ours, theirs) merge
// view. CM6 requires decorations sorted by `from`; we use a
// RangeSetBuilder + emit deterministic order:
//   1. Walk chunks in document order, emitting all decorations for
//      the current chunk before moving on.
//   2. Within a chunk, emit: top-marker → line-bg (ours) → word-marks
//      (ours) → middle-marker → line-bg (theirs) → word-marks
//      (theirs) → bottom-marker.
//
// `view` is needed to translate char-offsets to line-starts for
// Decoration.line ranges (CM6 requires line-decorations to start at
// a doc-line start, which `view.state.doc.line(n).from` resolves).
export function buildDecorations(
  view: EditorView,
  chunks: DiffChunk[],
  offsets: ChunkOffset[],
  opts: BuildOpts,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const off = offsets[i];

    if (c.kind === "common" && off.kind === "common") {
      // Light common-line tint (visual separation from chunk colors).
      for (let ln = off.lineStart; ln < off.lineEnd; ln++) {
        const lineFrom = doc.line(ln + 1).from; // CM6 lines are 1-indexed
        builder.add(lineFrom, lineFrom, lineCommon);
      }
      continue;
    }
    if (c.kind !== "diff" || off.kind !== "diff") continue; // type guard

    // Top marker — block widget BEFORE the first ours line. CM6
    // semantics: a block widget at offset X with side -1 renders
    // *above* the line containing X. Use ours' first-line start;
    // when ours is empty (delete-vs-modify), use theirs' first-line.
    const topAnchor =
      c.oursLines.length > 0 ? off.oursStart : off.theirsStart;
    builder.add(
      topAnchor,
      topAnchor,
      Decoration.widget({
        widget: new ConflictMarkerWidget("top", opts.oursLabel),
        block: true,
        side: -1,
      }),
    );

    // Ours line-backgrounds.
    for (let ln = off.oursLineStart; ln < off.oursLineEnd; ln++) {
      const lineFrom = doc.line(ln + 1).from;
      builder.add(lineFrom, lineFrom, lineOurs);
    }

    // Ours word-marks (within ours char-range).
    const oursText = doc.sliceString(off.oursStart, off.oursEnd);
    const theirsText = doc.sliceString(off.theirsStart, off.theirsEnd);
    const wordDiff = computeWordDiff(oursText, theirsText);
    for (const span of wordDiff.oursSpans) {
      const from = off.oursStart + span.start;
      const to = off.oursStart + span.end;
      if (to > from) builder.add(from, to, wordMark);
    }

    // Middle marker — between ours and theirs blocks. Anchor at the
    // first theirs line's start; side -1 places it ABOVE that line
    // (which is exactly between the two blocks).
    if (c.theirsLines.length > 0) {
      builder.add(
        off.theirsStart,
        off.theirsStart,
        Decoration.widget({
          widget: new ConflictMarkerWidget("middle", ""),
          block: true,
          side: -1,
        }),
      );
    }

    // Theirs line-backgrounds.
    for (let ln = off.theirsLineStart; ln < off.theirsLineEnd; ln++) {
      const lineFrom = doc.line(ln + 1).from;
      builder.add(lineFrom, lineFrom, lineTheirs);
    }

    // Theirs word-marks.
    for (const span of wordDiff.theirsSpans) {
      const from = off.theirsStart + span.start;
      const to = off.theirsStart + span.end;
      if (to > from) builder.add(from, to, wordMark);
    }

    // Bottom marker — below the last theirs line. Anchor at the
    // line END of theirs (which equals the START of the next line);
    // side +1 places it BELOW that anchor line. Use the end-pos of
    // the last theirs line in the doc.
    const bottomAnchor =
      c.theirsLines.length > 0 ? off.theirsEnd : off.oursEnd;
    builder.add(
      bottomAnchor,
      bottomAnchor,
      Decoration.widget({
        widget: new ConflictMarkerWidget("bottom", opts.theirsLabel),
        block: true,
        side: 1,
      }),
    );
  }

  return builder.finish();
}

// Convenience: emit a Decoration.set extension built from the
// chunk list. Phase 2 wires this into EditorState.create's
// extensions[]; Phase 3 may switch to a StateField that updates on
// chunk-action transactions.
//
// Returns a Decoration.set viewPlugin that re-runs on every view
// update (cheap because the chunk list is constant in Phase 2 —
// recompute would be O(N) and dominated by line iteration, not
// diff cost).
export function decorationsViewPlugin(
  chunks: DiffChunk[],
  offsets: ChunkOffset[],
  opts: BuildOpts,
) {
  return EditorView.decorations.compute(
    [], // depends on doc; provided implicitly via view
    (state) => {
      // We can't access EditorView here directly (compute() gets
      // EditorState only). Build via a synthetic line-walk on the
      // state.doc — same shape as buildDecorations but without
      // needing a view.
      const builder = new RangeSetBuilder<Decoration>();
      const doc = state.doc;
      const lineStartAt = (ln: number): number => doc.line(ln + 1).from;
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const off = offsets[i];
        if (c.kind === "common" && off.kind === "common") {
          for (let ln = off.lineStart; ln < off.lineEnd; ln++) {
            const lineFrom = lineStartAt(ln);
            builder.add(lineFrom, lineFrom, lineCommon);
          }
          continue;
        }
        if (c.kind !== "diff" || off.kind !== "diff") continue;

        const topAnchor =
          c.oursLines.length > 0 ? off.oursStart : off.theirsStart;
        builder.add(
          topAnchor,
          topAnchor,
          Decoration.widget({
            widget: new ConflictMarkerWidget("top", opts.oursLabel),
            block: true,
            side: -1,
          }),
        );
        for (let ln = off.oursLineStart; ln < off.oursLineEnd; ln++) {
          const lineFrom = lineStartAt(ln);
          builder.add(lineFrom, lineFrom, lineOurs);
        }
        const oursText = doc.sliceString(off.oursStart, off.oursEnd);
        const theirsText = doc.sliceString(off.theirsStart, off.theirsEnd);
        const wordDiff = computeWordDiff(oursText, theirsText);
        for (const span of wordDiff.oursSpans) {
          const from = off.oursStart + span.start;
          const to = off.oursStart + span.end;
          if (to > from) builder.add(from, to, wordMark);
        }
        if (c.theirsLines.length > 0) {
          builder.add(
            off.theirsStart,
            off.theirsStart,
            Decoration.widget({
              widget: new ConflictMarkerWidget("middle", ""),
              block: true,
              side: -1,
            }),
          );
        }
        for (let ln = off.theirsLineStart; ln < off.theirsLineEnd; ln++) {
          const lineFrom = lineStartAt(ln);
          builder.add(lineFrom, lineFrom, lineTheirs);
        }
        for (const span of wordDiff.theirsSpans) {
          const from = off.theirsStart + span.start;
          const to = off.theirsStart + span.end;
          if (to > from) builder.add(from, to, wordMark);
        }
        const bottomAnchor =
          c.theirsLines.length > 0 ? off.theirsEnd : off.oursEnd;
        builder.add(
          bottomAnchor,
          bottomAnchor,
          Decoration.widget({
            widget: new ConflictMarkerWidget("bottom", opts.theirsLabel),
            block: true,
            side: 1,
          }),
        );
      }
      return builder.finish();
    },
  );
}
