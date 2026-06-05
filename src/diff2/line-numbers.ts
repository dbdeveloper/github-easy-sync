// Sibling-wins line-number gutter for DiffPane (DIFF-EDITOR.md §1.10).
//
// One gutter column. The through-sequence is normal + ver2 (the
// sibling-wins result): every normal/ver2 line advances a running
// counter `n` and shows it. A ver1 (local-only) line is numbered in
// PARALLEL — continuing from the line above — and does NOT advance the
// through counter; the next normal continues from ver2. As conflicts
// resolve, every group becomes normal and the numbering converges to a
// plain 1..N (the final document's real line numbers).
//
// Not the built-in lineNumbers() (that would show a plain through count
// 1..N over the merged buffer); a custom gutter reading the structure
// field is required. Marker block-widgets are not doc lines → no
// number. A wrapped long line shows ONE number; continuation visual
// rows get a blank gutter, which doubles as a wrap indicator (§1.10).
//
// Canonical spec: docs/tasks/DIFF-EDITOR.md §1.10.

import { EditorState, Text } from "@codemirror/state";
import { EditorView, gutter, GutterMarker } from "@codemirror/view";
import { diffPaneStateField } from "./decorations";
import type { Segment, SegRole } from "./editor-model";
import { ConflictMarkerWidget } from "./markers";

// #3 — colour the gutter cell next to a marker BLOCK widget (<<<<< / ===== /
// >>>>>) the same side tint as its lines, so the gutter column reads as one
// continuous ours/theirs band over the whole group. Empty content; the tint is
// the elementClass background.
class MarkerGutterMarker extends GutterMarker {
  constructor(readonly kind: "top" | "middle" | "bottom") {
    super();
    this.elementClass =
      kind === "top"
        ? "diff2-gutter-ours-marker"
        : kind === "bottom"
          ? "diff2-gutter-theirs-marker"
          : "diff2-gutter-split-marker";
  }
  eq(other: MarkerGutterMarker): boolean {
    return other.kind === this.kind;
  }
  toDOM(): Node {
    return document.createTextNode("");
  }
}

class LineNumberMarker extends GutterMarker {
  constructor(
    readonly text: string,
    readonly role: SegRole,
  ) {
    super();
    // §6.7 — tint the whole gutter CELL to the line's side colour. The cell is
    // as tall as the (wrapped) line, so the colour spans every visual row even
    // though the number + glyph render once at the top (§6.5, accepted).
    // elementClass is a GutterMarker property (assigned, not an accessor).
    this.elementClass =
      role === "ver1"
        ? "diff2-gutter-ours"
        : role === "ver2"
          ? "diff2-gutter-theirs"
          : "";
  }
  eq(other: LineNumberMarker): boolean {
    return other.text === this.text && other.role === this.role;
  }
  toDOM(): Node {
    // §6.5 — a `−` for ver1 (ours) / `+` for ver2 (theirs), after the number.
    const cell = document.createElement("span");
    cell.className = "diff2-gutter-cell";
    const num = cell.appendChild(document.createElement("span"));
    num.className = "diff2-gutter-num";
    num.textContent = this.text;
    const glyph = this.role === "ver1" ? "−" : this.role === "ver2" ? "+" : "";
    if (glyph) {
      const g = cell.appendChild(document.createElement("span"));
      g.className = "diff2-gutter-glyph";
      g.textContent = glyph;
    }
    return cell;
  }
}

// label per 1-indexed doc line (index = lineNumber - 1). Empty string
// for any line we don't number (shouldn't happen for content lines).
export function computeLineLabels(doc: Text, structure: Segment[]): string[] {
  const labels: string[] = new Array(doc.lines).fill("");
  let through = 0; // last normal/ver2 number emitted
  for (const s of structure) {
    if (s.to <= s.from) continue; // empty segment → no doc line
    if (s.role === "ver1") {
      // Parallel numbering from the line above; through unchanged.
      let offset = 0;
      eachLineNumber(doc, s.from, s.to, (lineNo) => {
        offset += 1;
        labels[lineNo - 1] = String(through + offset);
      });
    } else {
      // normal or ver2 → advance the through counter.
      eachLineNumber(doc, s.from, s.to, (lineNo) => {
        through += 1;
        labels[lineNo - 1] = String(through);
      });
    }
  }
  return labels;
}

// role per 1-indexed doc line — drives the gutter glyph (§6.5) + colour (§6.7).
// Lines not covered by a content segment (e.g. the trailing empty line) are
// "normal" (no glyph, no tint).
export function computeLineRoles(doc: Text, structure: Segment[]): SegRole[] {
  const roles: SegRole[] = new Array(doc.lines).fill("normal");
  for (const s of structure) {
    if (s.to <= s.from) continue;
    eachLineNumber(doc, s.from, s.to, (lineNo) => {
      roles[lineNo - 1] = s.role;
    });
  }
  return roles;
}

// Memoize labels + roles per EditorState (immutable per transaction), so the
// per-line gutter callback doesn't recompute the whole arrays each call.
const gutterCache = new WeakMap<
  EditorState,
  { labels: string[]; roles: SegRole[] }
>();
function gutterDataFor(state: EditorState): { labels: string[]; roles: SegRole[] } {
  const cached = gutterCache.get(state);
  if (cached) return cached;
  const field = state.field(diffPaneStateField, false);
  const data = field
    ? {
        labels: computeLineLabels(state.doc, field.structure),
        roles: computeLineRoles(state.doc, field.structure),
      }
    : {
        labels: new Array(state.doc.lines).fill(""),
        roles: new Array<SegRole>(state.doc.lines).fill("normal"),
      };
  gutterCache.set(state, data);
  return data;
}

export function siblingWinsGutter() {
  return gutter({
    class: "diff2-line-number-gutter",
    lineMarker(view: EditorView, line) {
      const { labels, roles } = gutterDataFor(view.state);
      const lineNo = view.state.doc.lineAt(line.from).number;
      const text = labels[lineNo - 1] ?? "";
      const role = roles[lineNo - 1] ?? "normal";
      // A content line always has a number; the trailing empty line has neither
      // number nor role → no marker.
      if (!text && role === "normal") return null;
      return new LineNumberMarker(text, role);
    },
    // #3 — tint the gutter cell beside each conflict-marker block widget.
    widgetMarker(_view, widget) {
      return widget instanceof ConflictMarkerWidget
        ? new MarkerGutterMarker(widget.kind)
        : null;
    },
    // Recompute markers when the structure field changes even if the
    // doc length is unchanged (e.g. a same-length chunk resolution).
    lineMarkerChange(update) {
      return (
        update.startState.field(diffPaneStateField, false) !==
        update.state.field(diffPaneStateField, false)
      );
    },
    initialSpacer() {
      return new LineNumberMarker("0", "normal");
    },
  });
}

// Invoke `cb(lineNumber)` (1-indexed) for each doc line the [from, to)
// range covers. Empty range → no calls.
function eachLineNumber(
  doc: Text,
  from: number,
  to: number,
  cb: (lineNumber: number) => void,
): void {
  if (to <= from) return;
  let pos = from;
  while (pos < to) {
    const line = doc.lineAt(pos);
    cb(line.number);
    if (line.to + 1 > to) break;
    pos = line.to + 1;
  }
}
