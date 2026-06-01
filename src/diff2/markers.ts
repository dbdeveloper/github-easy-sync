// Marker block-widgets for DiffPane (R7.2).
//
// CM6 WidgetType subclasses for the three marker lines that frame
// each diff chunk:
//   <<<<< (top, above ours-lines)
//   ===== (middle, between ours and theirs)
//   >>>>> (bottom, below theirs-lines)
//
// These widgets are inserted as `Decoration.widget({block: true})`
// at the line boundaries of the merged document text — they do NOT
// occupy any character range. CM6 renders them as full-line DOM
// nodes that the user cannot type into. Markdown / frontmatter
// parsers don't see them; on write-back to vault, they're simply
// absent from the resolved document content.
//
// Phase 2 ships the visual layout only: marker label + device-label
// suffix (top/bottom carry deviceLabel; middle carries no label).
// Phase 3 will add action buttons (apply/remove/apply both/remove
// both / join) as child elements inside these widget DOMs — keeps
// the marker + buttons as a single positioned line.
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.2 (marker layout)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.5 (Phase 3 action buttons)

import { WidgetType } from "@codemirror/view";
import type { ChunkChoice } from "./chunk-actions";

export type MarkerKind = "top" | "middle" | "bottom";

// Callbacks invoked when the user clicks an action button inside a
// marker widget. Phase 3 wires these via Compartment-reconfigure
// hooks on the DiffPane; Phase 4+ extends with R7.11 exit-protocol.
export interface MarkerWidgetCallbacks {
  // Fired with the chosen resolution for THIS diff group. The DiffPane
  // dispatches the doc replacement + recomputed structure (effect).
  onAction: (group: number, choice: ChunkChoice) => void;
}

// One widget instance per marker line. Equality based on
// (kind, label, chunkIndex, isMarkdown) so CM6 reuses DOM nodes
// across view-updates that produce the same logical decoration
// set. Callbacks are NOT part of equality — they're a stable ref
// (the DiffPane that owns this widget set captures `this`).
export class ConflictMarkerWidget extends WidgetType {
  constructor(
    readonly kind: MarkerKind,
    // Device label shown alongside top/bottom markers (R7.2). Empty
    // string for the middle marker (no label per R7.2).
    readonly label: string,
    // Diff-group id. The chunk-action handler uses this to know which
    // group to resolve.
    readonly group: number,
    // Whether the base file is markdown — controls [join] button
    // visibility on the middle marker per R7.5 + R7.9a.
    readonly isMarkdown: boolean,
    // Action callbacks. Phase 3 always provides these; tests may
    // pass an empty implementation.
    readonly callbacks: MarkerWidgetCallbacks,
  ) {
    super();
  }

  eq(other: ConflictMarkerWidget): boolean {
    return (
      other.kind === this.kind &&
      other.label === this.label &&
      other.group === this.group &&
      other.isMarkdown === this.isMarkdown
    );
  }

  toDOM(): HTMLElement {
    const line = document.createElement("div");
    line.className = `diff2-marker diff2-marker-${this.kind}`;

    // Marker glyph (5 brackets per R7.2).
    const glyph = document.createElement("span");
    glyph.className = "diff2-marker-glyph";
    glyph.textContent =
      this.kind === "top"
        ? "<<<<<"
        : this.kind === "bottom"
          ? ">>>>>"
          : "=====";
    line.appendChild(glyph);

    // Action buttons (R7.5 / R7.6).
    const buttons = document.createElement("span");
    buttons.className = "diff2-marker-buttons";
    this.renderActionButtons(buttons);
    line.appendChild(buttons);

    // Device label (top/bottom only; middle stays unlabeled per R7.2).
    if (this.kind !== "middle" && this.label !== "") {
      const lab = document.createElement("span");
      lab.className = "diff2-marker-label";
      lab.textContent = `(${this.label})`;
      line.appendChild(lab);
    }

    return line;
  }

  private renderActionButtons(parent: HTMLElement): void {
    // R7.5 semantics + R7.6 arrows:
    //   top    — [apply ↓] [remove ↓]
    //              apply on top   = take ours-lines
    //              remove on top  = drop ours, take theirs-lines
    //   bottom — [apply ↑] [remove ↑]
    //              apply on bottom = take theirs-lines
    //              remove on bottom = drop theirs, take ours-lines
    //   middle — [apply both ↓↑] [remove both ↓↑]
    //              plus [join <label>] (markdown only)
    if (this.kind === "top") {
      this.addBtn(parent, "apply ↓", "ours");
      this.addBtn(parent, "remove ↓", "theirs");
      return;
    }
    if (this.kind === "bottom") {
      this.addBtn(parent, "apply ↑", "theirs");
      this.addBtn(parent, "remove ↑", "ours");
      return;
    }
    // middle
    this.addBtn(parent, "apply both ↓↑", "both");
    this.addBtn(parent, "remove both ↓↑", "neither");
    if (this.isMarkdown) {
      this.addBtn(parent, `join ${this.label || "remote"}`, "join");
    }
  }

  private addBtn(
    parent: HTMLElement,
    label: string,
    choice: ChunkChoice,
  ): void {
    const btn = document.createElement("button");
    btn.className = `diff2-btn diff2-marker-btn diff2-marker-btn-${choice}`;
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.callbacks.onAction(this.group, choice);
    });
    parent.appendChild(btn);
  }

  // R7.8: marker is NOT a real document line — events through it
  // shouldn't reach CM6's editing logic. But button clicks DO need
  // to reach our handler (we stopPropagation inside addBtn). Return
  // true: CM6 ignores events bubbling from within this widget.
  ignoreEvent(): boolean {
    return true;
  }
}
