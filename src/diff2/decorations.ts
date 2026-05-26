// DiffPane decoration extension — produces a CodeMirror DecorationSet
// from a chunk list (DiffChunk[]) + offsets (ChunkOffset[]).
//
// Phase 3 implementation uses a StateField + custom StateEffect so
// the chunks/offsets state and the document text update atomically
// in one transaction. (Phase 2's Compartment.reconfigure approach
// fired in two stages — the old extension re-ran against the new
// doc with stale offsets and threw "Invalid line number" when
// resolutions emitted empty chunks.)
//
// Decorations produced:
//   - Line backgrounds: red (ours), green (theirs), neutral (common).
//   - Word-level overlays: yellow Decoration.mark on character ranges
//     from word-level-diff (R7.4).
//   - Marker block-widgets: <<<<<, =====, >>>>> at chunk boundaries
//     (R7.2). Phase 3 widgets carry action buttons (R7.5).
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.2 + R7.3 (markers + colors)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.4 (word-level highlight)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.5 (action buttons)

import {
  Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import type { ChunkOffset, DiffChunk } from "./diff-chunks";
import { ConflictMarkerWidget, type MarkerWidgetCallbacks } from "./markers";
import { computeWordDiff } from "./word-level-diff";

export interface BuildOpts {
  oursLabel: string;
  theirsLabel: string;
  isMarkdown: boolean;
  callbacks: MarkerWidgetCallbacks;
}

const COMMON_LINE_CLASS = "diff2-line-common";
const OURS_LINE_CLASS = "diff2-line-ours";
const THEIRS_LINE_CLASS = "diff2-line-theirs";
const WORD_MARK_CLASS = "diff2-word-changed";

const lineCommon = Decoration.line({ class: COMMON_LINE_CLASS });
const lineOurs = Decoration.line({ class: OURS_LINE_CLASS });
const lineTheirs = Decoration.line({ class: THEIRS_LINE_CLASS });
const wordMark = Decoration.mark({ class: WORD_MARK_CLASS });

// Diff-pane state held inside the EditorState. Updated via the
// `setDiffPaneState` effect together with the doc-change transaction
// so the new offsets are visible to the field's compute step running
// against the new doc.
interface DiffPaneFieldState {
  chunks: DiffChunk[];
  offsets: ChunkOffset[];
  opts: BuildOpts;
}

// Effect carrying the new state. DiffPane dispatches this effect
// alongside the document change in `applyToChunk` / `resolveAll`.
export const setDiffPaneState = StateEffect.define<DiffPaneFieldState>();

// Internal field — tracks the chunks/offsets/opts. Decoration set
// derives from this field plus the current doc.
const diffPaneStateField = StateField.define<DiffPaneFieldState | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setDiffPaneState)) return e.value;
    }
    return value;
  },
});

// Decoration provider — derives a DecorationSet from the
// (state.doc, diffPaneStateField) tuple. The state.doc reference
// inside the compute callback is automatically the post-transition
// doc, so line numbers and char positions resolve against the
// current chunks/offsets.
const decorationsProvider = EditorView.decorations.compute(
  [diffPaneStateField],
  (state) => {
    const field = state.field(diffPaneStateField);
    if (!field) return Decoration.none;
    return buildDecorationSet(state.doc, field);
  },
);

function buildDecorationSet(
  doc: import("@codemirror/state").Text,
  field: DiffPaneFieldState,
): DecorationSet {
  const { chunks, offsets, opts } = field;
  const builder = new RangeSetBuilder<Decoration>();
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

    // Top marker.
    const topAnchor =
      c.oursLines.length > 0 ? off.oursStart : off.theirsStart;
    builder.add(
      topAnchor,
      topAnchor,
      Decoration.widget({
        widget: new ConflictMarkerWidget(
          "top",
          opts.oursLabel,
          i,
          opts.isMarkdown,
          opts.callbacks,
        ),
        block: true,
        side: -1,
      }),
    );

    // Ours line-backgrounds + word-marks.
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

    // Middle marker — only when theirs has content.
    if (c.theirsLines.length > 0) {
      builder.add(
        off.theirsStart,
        off.theirsStart,
        Decoration.widget({
          widget: new ConflictMarkerWidget(
            "middle",
            opts.theirsLabel,
            i,
            opts.isMarkdown,
            opts.callbacks,
          ),
          block: true,
          side: -1,
        }),
      );
    }

    // Theirs line-backgrounds + word-marks.
    for (let ln = off.theirsLineStart; ln < off.theirsLineEnd; ln++) {
      const lineFrom = lineStartAt(ln);
      builder.add(lineFrom, lineFrom, lineTheirs);
    }
    for (const span of wordDiff.theirsSpans) {
      const from = off.theirsStart + span.start;
      const to = off.theirsStart + span.end;
      if (to > from) builder.add(from, to, wordMark);
    }

    // Bottom marker.
    const bottomAnchor =
      c.theirsLines.length > 0 ? off.theirsEnd : off.oursEnd;
    builder.add(
      bottomAnchor,
      bottomAnchor,
      Decoration.widget({
        widget: new ConflictMarkerWidget(
          "bottom",
          opts.theirsLabel,
          i,
          opts.isMarkdown,
          opts.callbacks,
        ),
        block: true,
        side: 1,
      }),
    );
  }

  return builder.finish();
}

// Public extension that DiffPane plugs into the initial EditorState
// extensions array. Initialises with the supplied chunks/offsets/opts
// (via a setDiffPaneState effect on the create-state path is awkward
// — instead the field defaults to null and we seed via a follow-up
// dispatch).
export function diffPaneExtension(
  initial: DiffPaneFieldState,
): Extension {
  return [
    diffPaneStateField.init(() => initial),
    decorationsProvider,
  ];
}
