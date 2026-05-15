// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
import {
  applyAction,
  chunkActions,
  chunkActionKeymap,
  chunkAtCursor,
  chunkCount,
  chunkNavKeymap,
  ChunkAction,
} from "./chunk-actions";

// Reusable diff/merge component (Stage 6.5). Wraps `@codemirror/merge`
// with two operating modes:
//
//   - merge mode (conflict view): both panes editable, auto-finalize
//                                 fires when the two sides are byte-
//                                 equal, the user converges them via
//                                 CM's built-in revert controls or by
//                                 typing.
//   - reference mode (Stage 8 file history): theirs pane is read-only,
//                                 the user browses an old version and
//                                 selects+copies; ours pane is still
//                                 editable.
//
// Responsive: side-by-side at ≥768px, stacked unified diff at <768px,
// switching live as the workspace leaf is resized.
//
// What this component DOES NOT do (yet):
//   - Per-chunk action bar with ours/theirs/both buttons. CM6's
//     MergeView ships its own "revert chunk" widgets (one-direction);
//     the three-button + "both"-with-blockquote injection lives in a
//     follow-up enhancement that adds Decoration-based widgets. For
//     now `both` is supported via free-form editing in the ours pane
//     (user copies the theirs chunk in manually).
//   - Keyboard shortcuts beyond CM6 defaults. Block navigation is
//     scroll-by-fold; explicit n/N bindings come with the per-chunk
//     widgets.

export interface DiffPaneState {
  ours: string;
  theirs: string;
  bytesEqual: boolean;
}

export interface DiffPaneProps {
  // Vault-relative path of the file being merged. Used to apply
  // markdown highlighting selectively (a `.md` file gets the
  // `markdown()` extension; everything else stays plain).
  path: string;
  // Initial pane content. Caller is responsible for normalizing
  // line endings ahead of time (Stage 6.6 already does this for
  // bytes coming through the sync pipeline).
  oursText: string;
  theirsText: string;
  // Pane labels shown above each editor (and reused as button
  // labels when per-chunk widgets land). Default: "GitHub" for the
  // remote side, "{deviceLabel}" for the local — caller passes the
  // actual device label from settings, e.g. "Obsidian" / "Phone".
  oursLabel?: string;
  theirsLabel?: string;
  // When true, the theirs (GitHub-side) pane is read-only — for the
  // file history viewer (Stage 8). Conflict view sets this to false
  // so the user can edit either side as needed.
  theirsReadOnly?: boolean;
  // Fired on every keystroke / chunk-revert in either pane. Caller
  // can show "unsaved" state, run validation, etc.
  onChange?(state: DiffPaneState): void;
  // Fired exactly once when the two panes become byte-identical.
  // Conflict view uses this to auto-finalize — close the conflict
  // and unblock the path for push. File history viewer omits it.
  onByteEqual?(finalText: string): void;
}

const DEFAULT_OURS_LABEL = "Obsidian";
const DEFAULT_THEIRS_LABEL = "GitHub";

const NARROW_THRESHOLD_PX = 768;

export class DiffPane {
  private container: HTMLElement;
  private view: MergeView | EditorView | null = null;
  private isUnified = false;
  private byteEqualFired = false;
  private resizeObserver: ResizeObserver | null = null;
  private currentOurs: string;
  private currentTheirs: string;
  // Status bar pinned under the merge view. Shows "N conflicts left"
  // plus a one-line keyboard-shortcut hint. Updated on every
  // notifyChange so the count tracks chunk resolution in real time.
  private footerEl: HTMLElement | null = null;

  constructor(
    parent: HTMLElement,
    private readonly props: DiffPaneProps,
  ) {
    this.container = parent.createDiv({ cls: "sync2-diff-pane" });
    // Vertical flex layout so header / merge body / footer stack
    // top-to-bottom and the merge view (the only flex: 1 child) eats
    // all the remaining height. Without this the body collapses to
    // its CodeMirror auto-height (≈ content rows × line height) and
    // when the parent is large the editor becomes a thin strip — or
    // invisible if content is empty.
    this.container.style.height = "100%";
    this.container.style.display = "flex";
    this.container.style.flexDirection = "column";
    this.container.style.minHeight = "0";
    this.currentOurs = props.oursText;
    this.currentTheirs = props.theirsText;
    this.render();
    this.observeResize();
  }

  // Snapshot the current state of both panes. Useful for callers
  // that want the latest content outside the onChange callback.
  getState(): DiffPaneState {
    return {
      ours: this.currentOurs,
      theirs: this.currentTheirs,
      bytesEqual: this.currentOurs === this.currentTheirs,
    };
  }

  // ── public command surface ──────────────────────────────────────────
  // The same operations the Alt-N / Alt-1/2/3 keymaps perform inside
  // the editor's keymap scope, exposed as plain methods so main.ts
  // can wire them as Obsidian commands. That makes them assignable
  // through Obsidian's hotkey panel and reachable from external
  // mappings (vim-mode, Commander, etc.). All four return `true` on
  // a successful invocation, `false` if the precondition wasn't met
  // (no merge view, cursor not in a chunk, etc.).

  nextChunk(): boolean {
    if (!(this.view instanceof MergeView)) return false;
    return goToNextChunk(this.view.b);
  }

  previousChunk(): boolean {
    if (!(this.view instanceof MergeView)) return false;
    return goToPreviousChunk(this.view.b);
  }

  // Apply theirs/ours/both to the chunk under the cursor in the `b`
  // (ours/device) editor. Mirrors the keymap binding's semantics —
  // including the markdown-only restriction on `both` (returns
  // false for non-markdown files so callers can show a Notice if
  // they want).
  applyAtCursor(action: ChunkAction): boolean {
    if (!(this.view instanceof MergeView)) return false;
    if (action === "both" && !this.isMarkdownPath()) return false;
    const idx = chunkAtCursor(this.view.b.state, "b");
    if (idx === null) return false;
    this.handleChunkAction(idx, action);
    return true;
  }

  // Tear down all CM views and detach observers. Idempotent.
  destroy(): void {
    if (this.view instanceof MergeView) {
      this.view.destroy();
    } else if (this.view instanceof EditorView) {
      this.view.destroy();
    }
    this.view = null;
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.container.empty();
  }

  // ── internal ────────────────────────────────────────────────────────

  private render(): void {
    this.container.empty();
    this.footerEl = null;
    const wide =
      this.container.clientWidth === 0 ||
      this.container.clientWidth >= NARROW_THRESHOLD_PX;
    this.isUnified = !wide;
    this.renderHeader();
    if (this.isUnified) this.renderUnified();
    else this.renderSideBySide();
    this.renderFooter();
    this.updateFooter();
  }

  private renderFooter(): void {
    this.footerEl = this.container.createDiv({ cls: "sync2-diff-footer" });
    this.footerEl.style.padding = "4px 8px";
    this.footerEl.style.fontSize = "0.85em";
    this.footerEl.style.color = "var(--text-muted)";
    this.footerEl.style.borderTop =
      "1px solid var(--background-modifier-border)";
    this.footerEl.style.background = "var(--background-secondary)";
  }

  private updateFooter(): void {
    if (!this.footerEl) return;
    if (!(this.view instanceof MergeView)) {
      // Unified mode — CM6's own gutter buttons are visible; we
      // skip the keyboard hint there to avoid promising shortcuts
      // that need a different cursor model.
      this.footerEl.setText("");
      return;
    }
    const count = chunkCount(this.view.b.state);
    const hint =
      this.props.theirsReadOnly === true
        ? "Alt-N next · Alt-Shift-N prev · Alt-3 take this version into mine"
        : (this.isMarkdownPath()
            ? "Alt-N next · Alt-Shift-N prev · Alt-1/2/3 take theirs/both/ours"
            : "Alt-N next · Alt-Shift-N prev · Alt-1/3 take theirs/ours");
    if (count === 0) {
      this.footerEl.setText("All chunks resolved.");
    } else {
      const word = count === 1 ? "conflict" : "conflicts";
      this.footerEl.setText(`${count} ${word} left · ${hint}`);
    }
  }

  private isMarkdownPath(): boolean {
    return this.props.path.endsWith(".md");
  }

  // Two-column header above the merge view: theirs label on the
  // left, ours label on the right (matches the side-by-side pane
  // order — `a: theirs`, `b: ours`). Stays visible in unified mode
  // too as a one-line "X vs Y" caption.
  private renderHeader(): void {
    const theirs =
      this.props.theirsLabel ?? DEFAULT_THEIRS_LABEL;
    const ours = this.props.oursLabel ?? DEFAULT_OURS_LABEL;
    const header = this.container.createDiv({ cls: "sync2-diff-header" });
    header.style.display = "flex";
    header.style.padding = "4px 0";
    header.style.fontSize = "0.85em";
    header.style.color = "var(--text-muted)";
    if (this.isUnified) {
      // Single-line caption — no two-column split when stacked.
      header.createSpan({ text: `${theirs}  →  ${ours}` });
    } else {
      const left = header.createSpan({ text: theirs });
      left.style.flex = "1";
      const right = header.createSpan({ text: ours });
      right.style.flex = "1";
      right.style.textAlign = "right";
    }
  }

  // CM6 editors auto-size to content height by default, so without a
  // theme telling them to fill the parent they collapse on empty /
  // short docs. Apply at the per-editor level so it's effective for
  // both halves of the MergeView and the unified single-editor.
  //
  // The chain matters for scrolling: the flex column in
  // DiffPane.container gives `.cm-mergeView` (or unified `.cm-editor`)
  // `flex: 1` height. We then need each `.cm-editor` to be 100% of
  // its parent and its `.cm-scroller` to scroll within that. The
  // explicit `height: 100%` on `.cm-scroller` is what makes it
  // smaller than its content (and therefore scrollable) when the
  // doc is taller than the viewport.
  private fillParentTheme = EditorView.theme({
    "&": { height: "100%" },
    ".cm-scroller": { overflow: "auto", height: "100%" },
  });

  private renderSideBySide(): void {
    const isMd = this.props.path.endsWith(".md");
    const langExt = isMd ? [markdown()] : [];
    const oursLabel = this.props.oursLabel ?? DEFAULT_OURS_LABEL;
    const theirsLabel = this.props.theirsLabel ?? DEFAULT_THEIRS_LABEL;
    // Pane convention (Stage 6.5): theirs (GitHub) on the LEFT (a),
    // ours (device) on the RIGHT (b). Matches the header labels
    // and the natural reading order "incoming → local". For the
    // file-history viewer (Stage 8) the left pane (a, theirs/GitHub)
    // becomes read-only so the user can browse history without
    // accidentally mutating it.
    //
    // The chunkActions extension on `a` renders a [← Theirs] [Both?]
    // [Ours →] button bar above each diverging chunk; clicks fall
    // through to handleChunkAction which mutates BOTH editor docs
    // so the chunk converges and the diff recomputes.
    const onAction = (idx: number, action: ChunkAction) =>
      this.handleChunkAction(idx, action);
    const view = new MergeView({
      a: {
        doc: this.currentTheirs,
        extensions: [
          this.fillParentTheme,
          lineNumbers(),
          ...langExt,
          EditorState.readOnly.of(this.props.theirsReadOnly === true),
          chunkActions({
            side: "a",
            oursLabel,
            theirsLabel,
            isMarkdown: isMd,
            onAction,
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            this.currentTheirs = update.state.doc.toString();
            this.notifyChange();
          }),
        ],
      },
      b: {
        doc: this.currentOurs,
        extensions: [
          this.fillParentTheme,
          lineNumbers(),
          ...langExt,
          // Keymaps live on the editable side. Alt-n/Shift-Alt-N
          // jump between chunks; Alt-1/2/3 apply theirs/both/ours
          // at the cursor. Alt is chosen so digit/letter typing
          // stays unaffected.
          chunkNavKeymap(),
          chunkActionKeymap("b", isMd, onAction),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            this.currentOurs = update.state.doc.toString();
            this.notifyChange();
          }),
        ],
      },
      parent: this.container,
      // Built-in revert buttons disabled — our chunk-actions widget
      // replaces them with the three-button bar (Take Theirs / Both /
      // Take Ours).
    });
    // Pin the merge wrapper into the flex column so it eats the
    // remaining height after header + footer. Without this CM6's
    // .cm-mergeView is a non-flex block and the inner editors stay
    // at their auto-content height (= 0 for empty docs, tiny for
    // short ones), leaving a blank pane below the header.
    view.dom.style.flex = "1";
    view.dom.style.minHeight = "0";
    view.dom.style.overflow = "hidden";
    this.view = view;
  }

  // Mutate both panes so the chunk at `idx` converges per the
  // chosen action. CM6 dispatches independent transactions on each
  // editor; the merge view re-diffs automatically on the next
  // update tick, so the resolved chunk vanishes from getChunks() and
  // the corresponding action bar disappears with it.
  //
  // Caveat: undo is per-pane (each EditorView has its own history).
  // A click here writes to both panes; reversing it requires an
  // undo on each. Acceptable trade-off — the alternative (stitching
  // a single shared transaction) is awkward in CM6 and we already
  // accept that ad-hoc edits in either pane bypass the central
  // action bar.
  private handleChunkAction(
    chunkIdx: number,
    action: ChunkAction,
  ): void {
    if (!(this.view instanceof MergeView)) return;
    const chunks = this.view.chunks;
    if (chunkIdx >= chunks.length) return;
    const chunk = chunks[chunkIdx];
    const a = this.view.a;
    const b = this.view.b;
    const theirsText = a.state.doc.sliceString(chunk.fromA, chunk.toA);
    const oursText = b.state.doc.sliceString(chunk.fromB, chunk.toB);
    const { aText, bText } = applyAction(action, oursText, theirsText);
    if (!this.props.theirsReadOnly) {
      a.dispatch({
        changes: { from: chunk.fromA, to: chunk.toA, insert: aText },
      });
    }
    b.dispatch({
      changes: { from: chunk.fromB, to: chunk.toB, insert: bText },
    });
  }

  private renderUnified(): void {
    // Narrow layout — single editor showing the diff inline. The
    // user edits the "main" doc (ours), and CM displays theirs as
    // change markers (additions/deletions) above each modified line.
    // theirsReadOnly is implicit for unified view (the only editable
    // doc IS ours).
    const isMd = this.props.path.endsWith(".md");
    const langExt = isMd ? [markdown()] : [];
    const state = EditorState.create({
      doc: this.currentOurs,
      extensions: [
        this.fillParentTheme,
        lineNumbers(),
        ...langExt,
        unifiedMergeView({
          original: this.currentTheirs,
          mergeControls: !this.props.theirsReadOnly,
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          this.currentOurs = update.state.doc.toString();
          this.notifyChange();
        }),
      ],
    });
    const view = new EditorView({ state, parent: this.container });
    view.dom.style.flex = "1";
    view.dom.style.minHeight = "0";
    view.dom.style.overflow = "hidden";
    this.view = view;
  }

  private notifyChange(): void {
    const state = this.getState();
    // Footer count tracks chunk resolution in real time — every
    // keystroke or chunk-action click rebuilds the diff and may
    // shrink the chunk list.
    this.updateFooter();
    if (this.props.onChange) this.props.onChange(state);
    if (
      state.bytesEqual &&
      !this.byteEqualFired &&
      this.props.onByteEqual !== undefined
    ) {
      this.byteEqualFired = true;
      // Defer to the next microtask — gives CM6 time to settle the
      // transaction before the caller starts mutating the DOM (e.g.
      // closing the leaf, removing the conflict record).
      Promise.resolve().then(() => {
        this.props.onByteEqual?.(state.ours);
      });
    } else if (!state.bytesEqual) {
      // Re-arm the byte-equal hook in case the user edits further
      // after a transient match (rare but possible mid-typing).
      this.byteEqualFired = false;
    }
  }

  private observeResize(): void {
    if (typeof ResizeObserver === "undefined") return;
    let lastWide =
      this.container.clientWidth === 0 ||
      this.container.clientWidth >= NARROW_THRESHOLD_PX;
    this.resizeObserver = new ResizeObserver(() => {
      const nowWide =
        this.container.clientWidth >= NARROW_THRESHOLD_PX;
      if (nowWide === lastWide) return;
      lastWide = nowWide;
      // Layout switched across the threshold — tear down the current
      // CM view and re-render in the other shape, preserving content.
      if (this.view instanceof MergeView) this.view.destroy();
      else if (this.view instanceof EditorView) this.view.destroy();
      this.render();
    });
    this.resizeObserver.observe(this.container);
  }
}
