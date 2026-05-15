import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
  keymap,
} from "@codemirror/view";
import {
  EditorState,
  Extension,
  RangeSetBuilder,
  StateField,
} from "@codemirror/state";
import {
  getChunks,
  goToNextChunk,
  goToPreviousChunk,
} from "@codemirror/merge";

// Per-chunk action bar mounted on the THEIRS side of a CM6 MergeView
// (Stage 6.5 conflict resolver UX). For each diverging chunk, renders
// a 2- or 3-button block widget directly above the chunk:
//
//     ┌──────────────────────────────────────────┐
//     │ [← GitHub]  [ Both ]  [ Obsidian → ]     │
//     └──────────────────────────────────────────┘
//     <chunk text on the THEIRS pane>
//
// "Both" is markdown-only — for other text formats the third button
// would produce invalid syntax (a JSON file with a blockquote-prefixed
// section is not JSON, etc.) so the bar renders only the two side
// buttons there.
//
// Click semantics (the calling DiffPane provides the actual mutation):
//   - theirs: both panes converge on a's chunk text. "Take the
//             remote/GitHub version for this part."
//   - ours:   both panes converge on b's chunk text. "Keep mine."
//   - both:   both panes converge on `b's text + > "-prefixed a's
//             text` — markdown blockquote of theirs appended below
//             ours.
//
// Once a click resolves a chunk, the diff recomputes, the chunk
// disappears from getChunks(), and the widget is rebuilt without it
// → buttons vanish naturally.

export type ChunkAction = "ours" | "theirs" | "both";

export interface ChunkActionsConfig {
  // Which side of the merge view this extension is mounted on.
  // Decorations attach to chunk.fromA when "a", chunk.fromB when "b".
  // DiffPane mounts on "a" (theirs/GitHub) so the bar appears once
  // per chunk above the GitHub-side text — visually anchors the
  // "incoming" version.
  side: "a" | "b";
  // Visible button labels. Match DiffPane's pane headers so the user
  // mentally connects "click GitHub button" → "this chunk now reads
  // like the GitHub pane above".
  oursLabel: string;
  theirsLabel: string;
  // Hide the "Both" button for non-markdown files where blockquote
  // injection would corrupt the format.
  isMarkdown: boolean;
  // Click handler. Receives the chunk index (into MergeView.chunks)
  // plus the action; the receiver mutates BOTH editor docs in
  // coordinated transactions so the diff converges visibly.
  onAction(chunkIdx: number, action: ChunkAction): void;
}

class ChunkActionsWidget extends WidgetType {
  constructor(
    private readonly chunkIdx: number,
    private readonly cfg: ChunkActionsConfig,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof ChunkActionsWidget &&
      other.chunkIdx === this.chunkIdx &&
      other.cfg.oursLabel === this.cfg.oursLabel &&
      other.cfg.theirsLabel === this.cfg.theirsLabel &&
      other.cfg.isMarkdown === this.cfg.isMarkdown
    );
  }

  toDOM(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "sync2-chunk-actions";
    bar.style.display = "flex";
    bar.style.gap = "6px";
    bar.style.padding = "4px 8px";
    bar.style.background = "var(--background-secondary)";
    bar.style.borderTop = "1px solid var(--background-modifier-border)";
    bar.style.borderBottom = "1px solid var(--background-modifier-border)";
    bar.style.fontSize = "0.85em";

    const mkBtn = (
      label: string,
      action: ChunkAction,
      cls: string,
    ): HTMLButtonElement => {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = `sync2-chunk-btn ${cls}`;
      b.style.padding = "2px 8px";
      b.style.cursor = "pointer";
      b.style.border = "1px solid var(--background-modifier-border)";
      b.style.borderRadius = "4px";
      b.style.background = "var(--interactive-normal)";
      b.style.color = "var(--text-normal)";
      b.addEventListener("mouseenter", () => {
        b.style.background = "var(--interactive-hover)";
      });
      b.addEventListener("mouseleave", () => {
        b.style.background = "var(--interactive-normal)";
      });
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.cfg.onAction(this.chunkIdx, action);
      });
      return b;
    };

    bar.appendChild(
      mkBtn(`← ${this.cfg.theirsLabel}`, "theirs", "sync2-chunk-theirs"),
    );
    if (this.cfg.isMarkdown) {
      bar.appendChild(mkBtn("Both", "both", "sync2-chunk-both"));
    }
    bar.appendChild(
      mkBtn(`${this.cfg.oursLabel} →`, "ours", "sync2-chunk-ours"),
    );
    return bar;
  }

  // Allow click handlers inside the widget to fire — CM6 swallows
  // events from widgets by default.
  ignoreEvent(): boolean {
    return false;
  }
}

// CM6 StateField rebuilding the action-bar decorations on every
// transaction. We MUST use a StateField (not a ViewPlugin) because
// block decorations — `Decoration.widget({block: true, …})` — are
// only legal when sourced from a state field. CM6 throws
// `RangeError: Block decorations may not be specified via plugins`
// otherwise, killing the MergeView before the body can render.
//
// Runs in the merge view's `a` or `b` editor as a regular state
// extension. Rebuild cost is negligible (decorations are O(N) over
// the chunk count, typically <50) so we don't bother short-circuiting
// "nothing changed" transactions.
export function chunkActions(cfg: ChunkActionsConfig): Extension {
  return StateField.define<DecorationSet>({
    create(state) {
      return buildFromState(state, cfg);
    },
    update(_deco, tr) {
      return buildFromState(tr.state, cfg);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

function buildFromState(
  state: EditorState,
  cfg: ChunkActionsConfig,
): DecorationSet {
  const info = getChunks(state);
  if (!info) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  info.chunks.forEach((chunk, i) => {
    const pos = cfg.side === "a" ? chunk.fromA : chunk.fromB;
    builder.add(
      pos,
      pos,
      Decoration.widget({
        widget: new ChunkActionsWidget(i, cfg),
        side: -1,
        block: true,
      }),
    );
  });
  return builder.finish();
}

// Number of pending diverging chunks in the given state. Used by the
// DiffPane footer to render "N conflicts left" and to detect the
// transition to "all resolved".
export function chunkCount(state: EditorState): number {
  return getChunks(state)?.chunks.length ?? 0;
}

// Find the chunk containing the cursor's main head, looked up on
// either the "a" or "b" side of the merge view. Returns null if the
// cursor isn't inside any diverging chunk — keymap commands then
// no-op rather than picking the nearest chunk arbitrarily. Exported
// because DiffPane reuses the same lookup for the public
// applyAtCursor() method that backs the Obsidian command-palette
// entries (so vim-mode bindings can fire the same actions from
// outside the editor's keymap scope).
export function chunkAtCursor(
  state: EditorState,
  side: "a" | "b",
): number | null {
  const info = getChunks(state);
  if (!info) return null;
  const head = state.selection.main.head;
  for (let i = 0; i < info.chunks.length; i++) {
    const c = info.chunks[i];
    const from = side === "a" ? c.fromA : c.fromB;
    const to = side === "a" ? c.toA : c.toB;
    if (head >= from && head <= to) return i;
  }
  return null;
}

// Keymap: Alt-n / Alt-Shift-N navigate next/prev chunk. Modifier
// (Alt) chosen so the bindings don't collide with regular typing —
// users edit text in either pane freely without triggering
// navigation. CM6 ships goToNextChunk / goToPreviousChunk as
// commands; we just bind them.
export function chunkNavKeymap(): Extension {
  return keymap.of([
    { key: "Alt-n", run: goToNextChunk },
    { key: "Alt-Shift-n", run: goToPreviousChunk },
  ]);
}

// Keymap: Alt-1 / Alt-2 / Alt-3 apply theirs / both / ours to the
// chunk under the cursor. `side` is which doc the cursor's position
// is interpreted against — DiffPane mounts this on `b` (ours/device)
// because that's where the user types resolution edits. If the
// cursor isn't inside any chunk the binding no-ops (returns false
// so CM6 falls through to default key handling).
export function chunkActionKeymap(
  side: "a" | "b",
  isMarkdown: boolean,
  onAction: (chunkIdx: number, action: ChunkAction) => void,
): Extension {
  const fire = (action: ChunkAction) => (view: EditorView): boolean => {
    const idx = chunkAtCursor(view.state, side);
    if (idx === null) return false;
    onAction(idx, action);
    return true;
  };
  return keymap.of([
    { key: "Alt-1", run: fire("theirs") },
    // "Both" shortcut only registers for markdown — non-markdown
    // documents drop the entry so Alt-2 falls through to whatever
    // CM6 / Obsidian have bound.
    ...(isMarkdown ? [{ key: "Alt-2", run: fire("both") }] : []),
    { key: "Alt-3", run: fire("ours") },
  ]);
}

// Pure helpers exported for unit-testing the chunk transform logic
// independently of CM6/DOM. DiffPane uses these inside its action
// handler when constructing the new pane content.

// Take a chunk's content from one side and produce the replacement
// strings for both panes such that they end up byte-equal for that
// chunk. Returns { aText, bText } where aText replaces a[fromA..toA]
// and bText replaces b[fromB..toB].
export function applyAction(
  action: ChunkAction,
  oursText: string,
  theirsText: string,
): { aText: string; bText: string } {
  if (action === "theirs") {
    // Pull theirs into ours: both panes get theirs's text.
    return { aText: theirsText, bText: theirsText };
  }
  if (action === "ours") {
    // Pull ours into theirs: both panes get ours's text.
    return { aText: oursText, bText: oursText };
  }
  // both: ours stays, theirs appended below as markdown blockquote.
  // Each line of theirs gets `> ` prefix. Empty lines become "> "
  // (with trailing space) so the blockquote stays unbroken in
  // markdown preview.
  const quotedTheirs = theirsText
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  // Newline between ours and the blockquote keeps them as separate
  // markdown blocks. If oursText is empty (rare — chunk was an
  // insertion-only on theirs side), skip the leading newline.
  const merged =
    oursText.length === 0 ? quotedTheirs : `${oursText}\n${quotedTheirs}`;
  return { aText: merged, bText: merged };
}
