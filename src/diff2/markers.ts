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

export type MarkerKind = "top" | "middle" | "bottom";

// One widget instance per marker line. Equality based on (kind,
// label) so CM6 reuses DOM nodes across view-updates that produce
// the same logical decoration set.
export class ConflictMarkerWidget extends WidgetType {
  constructor(
    readonly kind: MarkerKind,
    // Device label shown alongside top/bottom markers (R7.2). Empty
    // string for the middle marker (its decoration constructs it
    // with label === "").
    readonly label: string,
  ) {
    super();
  }

  eq(other: ConflictMarkerWidget): boolean {
    return other.kind === this.kind && other.label === this.label;
  }

  toDOM(): HTMLElement {
    const line = document.createElement("div");
    line.className = `diff2-marker diff2-marker-${this.kind}`;

    // Marker glyph: 5 angle brackets per R7.2.
    const glyph = document.createElement("span");
    glyph.className = "diff2-marker-glyph";
    glyph.textContent =
      this.kind === "top"
        ? "<<<<<"
        : this.kind === "bottom"
          ? ">>>>>"
          : "=====";
    line.appendChild(glyph);

    // Phase 3 inserts action-button DOM here. Phase 2 renders the
    // device label only (top/bottom). Use a child slot so Phase 3's
    // patch is a single querySelector + appendChild without touching
    // marker layout.
    const buttons = document.createElement("span");
    buttons.className = "diff2-marker-buttons";
    line.appendChild(buttons);

    if (this.kind !== "middle" && this.label !== "") {
      const lab = document.createElement("span");
      lab.className = "diff2-marker-label";
      lab.textContent = `(${this.label})`;
      line.appendChild(lab);
    }

    return line;
  }

  // R7.8: the marker line is NOT a real document line — the user
  // can't navigate into it with arrow keys or place a cursor there.
  // ignoreEvent + return false from typing handler keeps the widget
  // visually present but cursorless.
  ignoreEvent(): boolean {
    return false;
  }
}
