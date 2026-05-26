// DiffPane — CM6 EditorView wrapper for the unified diff editor.
//
// Phase 2 ships:
//   - Mount EditorView at the supplied container.
//   - Document built from (ours, theirs) text via chunksToText.
//   - Decorations: line backgrounds + word-level marks + marker
//     block-widgets (R7.2, R7.3, R7.4).
//   - Free editing on every line (R7.8) — CM6 default behavior.
//
// Phase 3 will add:
//   - Action callbacks (apply/remove/apply-both/remove-both/join)
//     wired into the marker widgets.
//   - Group toolbar with [Keep all local] / [Apply all remote] /
//     [Join all].
//   - SHA-compare check on `[←]` exit (R7.11) — proactive sibling
//     cleanup when SHA(base) === SHA(sibling).
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7 (DiffPane form)
//   - R12.0 Spike 1 result: happy-dom env supports CM6 widget DOM
//     so tests can verify rendering.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  ChunkOffset,
  chunksToText,
  computeChunkOffsets,
  computeChunks,
  DiffChunk,
} from "./diff-chunks";
import { decorationsViewPlugin } from "./decorations";

export interface DiffPaneOpts {
  // Device label for the "ours" side (top marker label).
  oursLabel: string;
  // Device label for the "theirs" side (bottom marker label).
  theirsLabel: string;
}

const DEFAULT_OPTS: DiffPaneOpts = {
  oursLabel: "ours",
  theirsLabel: "theirs",
};

export class DiffPane {
  private view: EditorView;
  // Cached chunks + offsets — Phase 3 will read these when
  // dispatching chunk-action transactions.
  readonly chunks: DiffChunk[];
  readonly offsets: ChunkOffset[];

  constructor(
    parent: HTMLElement,
    ours: string,
    theirs: string,
    opts: Partial<DiffPaneOpts> = {},
  ) {
    const fullOpts: DiffPaneOpts = { ...DEFAULT_OPTS, ...opts };
    this.chunks = computeChunks(ours, theirs);
    this.offsets = computeChunkOffsets(this.chunks);
    const docText = chunksToText(this.chunks);

    this.view = new EditorView({
      state: EditorState.create({
        doc: docText,
        extensions: [
          // Decorations: lines + word-marks + markers.
          decorationsViewPlugin(this.chunks, this.offsets, {
            oursLabel: fullOpts.oursLabel,
            theirsLabel: fullOpts.theirsLabel,
          }),
          // Editable by default (R7.8). No explicit
          // EditorView.editable.of(true) needed — CM6's default.
          EditorView.lineWrapping,
        ],
      }),
      parent,
    });
  }

  // Returns the live document text (post user edits). Phase 3 will
  // call this on `[←]` exit to write back to vault.
  getDocText(): string {
    return this.view.state.doc.toString();
  }

  // Programmatic access to the underlying EditorView. Phase 3 needs
  // this for dispatching transactions from chunk-action callbacks.
  getView(): EditorView {
    return this.view;
  }

  destroy(): void {
    this.view.destroy();
  }
}
