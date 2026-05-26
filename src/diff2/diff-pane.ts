// DiffPane — CM6 EditorView wrapper for the unified diff editor.
//
// Phase 2 shipped: rendering + free editing.
// Phase 3 adds: chunk actions (apply/remove/both/neither/join) +
// bulk operations (keep-all-local / apply-all-remote / join-all).
//
// State model: chunks/offsets/opts live inside the EditorState via
// a StateField (see decorations.ts). Each chunk-action transaction
// dispatches BOTH the doc-change AND a `setDiffPaneState` effect in
// one atomic update; the decoration provider reads the post-change
// doc together with the new chunks/offsets, so line numbers and
// char positions stay consistent.
//
// The Phase 2 Compartment-reconfigure approach was abandoned because
// CM6 re-runs the OLD extension's compute callback against the NEW
// doc before applying effects, which threw "Invalid line number" on
// any chunk action that produced an empty-line resolved chunk.
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7 (DiffPane form)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.5 (chunk-action semantics)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R9.1 Phase 3 row

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  chooseLines,
  type ChunkChoice,
  type JoinContext,
} from "./chunk-actions";
import { resolveAllChunks } from "./conflict-merge-all";
import {
  ChunkOffset,
  chunksToText,
  computeChunkOffsets,
  computeChunks,
  type DiffChunk,
} from "./diff-chunks";
import { diffPaneExtension, setDiffPaneState } from "./decorations";
import type { MarkerWidgetCallbacks } from "./markers";

export interface DiffPaneOpts {
  oursLabel: string;
  theirsLabel: string;
  isMarkdown: boolean;
  joinContext?: JoinContext;
}

const DEFAULT_OPTS: DiffPaneOpts = {
  oursLabel: "ours",
  theirsLabel: "theirs",
  isMarkdown: false,
};

export class DiffPane {
  private view: EditorView;
  private chunks: DiffChunk[];
  private offsets: ChunkOffset[];
  private readonly opts: DiffPaneOpts;

  constructor(
    parent: HTMLElement,
    ours: string,
    theirs: string,
    opts: Partial<DiffPaneOpts> = {},
  ) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this.chunks = computeChunks(ours, theirs);
    this.offsets = computeChunkOffsets(this.chunks);

    const callbacks = this.makeCallbacks();
    const docText = chunksToText(this.chunks);

    this.view = new EditorView({
      state: EditorState.create({
        doc: docText,
        extensions: [
          diffPaneExtension({
            chunks: this.chunks,
            offsets: this.offsets,
            opts: {
              oursLabel: this.opts.oursLabel,
              theirsLabel: this.opts.theirsLabel,
              isMarkdown: this.opts.isMarkdown,
              callbacks,
            },
          }),
          EditorView.lineWrapping,
        ],
      }),
      parent,
    });
  }

  // Apply a single-chunk resolution. Public API used by:
  //   - Marker-widget action buttons (per-chunk apply/remove/etc).
  //
  // Implementation: mutate `chunks` first, then dispatch a full-doc
  // replacement using chunksToText together with the
  // setDiffPaneState effect. CM6 processes both atomically so
  // decorations re-derive against the new doc + new chunks.
  // Cursor reset on action click is acceptable — buttons are
  // explicit user actions, not typing.
  applyToChunk(chunkIndex: number, choice: ChunkChoice): void {
    const chunk = this.chunks[chunkIndex];
    if (!chunk || chunk.kind !== "diff") return;

    const resolvedLines = chooseLines(chunk, choice, this.opts.joinContext);
    this.chunks = this.chunks.map((c, i) =>
      i === chunkIndex ? { kind: "common", lines: resolvedLines } : c,
    );
    this.offsets = computeChunkOffsets(this.chunks);

    this.dispatchUpdate();
  }

  // Apply a single choice to every diff chunk at once. Used by the
  // R7.9a toolbar buttons [Keep all local] / [Apply all remote] /
  // [Join all]. Single text-replacement instead of N — cheaper for
  // large diffs.
  resolveAll(choice: ChunkChoice): void {
    this.chunks = resolveAllChunks(
      this.chunks,
      choice,
      this.opts.joinContext,
    );
    this.offsets = computeChunkOffsets(this.chunks);
    this.dispatchUpdate();
  }

  // Returns the live document text. DiffEditView calls this on `[←]`
  // to write the resolved content back to the base file via
  // atomicWriteFile (R7.7.c step 1).
  getDocText(): string {
    return this.view.state.doc.toString();
  }

  getView(): EditorView {
    return this.view;
  }

  // Number of UNRESOLVED diff chunks remaining. The detail-view
  // footer (Phase 6) will use this for the live "N unresolved
  // chunks" counter.
  remainingDiffChunkCount(): number {
    return this.chunks.filter((c) => c.kind === "diff").length;
  }

  destroy(): void {
    this.view.destroy();
  }

  // ── internals ─────────────────────────────────────────────────────

  private makeCallbacks(): MarkerWidgetCallbacks {
    return {
      onAction: (chunkIndex: number, choice: ChunkChoice) => {
        this.applyToChunk(chunkIndex, choice);
      },
    };
  }

  // Atomically replace the doc + update the StateField holding
  // chunks/offsets/opts. CM6 processes changes and effects in one
  // state transition; the decoration provider derives from the
  // post-state, so line/char positions resolve cleanly.
  private dispatchUpdate(): void {
    const newText = chunksToText(this.chunks);
    this.view.dispatch({
      changes: {
        from: 0,
        to: this.view.state.doc.length,
        insert: newText,
      },
      effects: setDiffPaneState.of({
        chunks: this.chunks,
        offsets: this.offsets,
        opts: {
          oursLabel: this.opts.oursLabel,
          theirsLabel: this.opts.theirsLabel,
          isMarkdown: this.opts.isMarkdown,
          callbacks: this.makeCallbacks(),
        },
      }),
    });
  }
}
