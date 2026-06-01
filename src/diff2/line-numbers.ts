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
import type { Segment } from "./editor-model";

class LineNumberMarker extends GutterMarker {
  constructor(readonly text: string) {
    super();
  }
  eq(other: LineNumberMarker): boolean {
    return other.text === this.text;
  }
  toDOM(): Node {
    return document.createTextNode(this.text);
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

// Memoize labels per EditorState (immutable per transaction), so the
// per-line gutter callback doesn't recompute the whole array each call.
const labelCache = new WeakMap<EditorState, string[]>();
function labelsFor(state: EditorState): string[] {
  const cached = labelCache.get(state);
  if (cached) return cached;
  const field = state.field(diffPaneStateField, false);
  const labels = field
    ? computeLineLabels(state.doc, field.structure)
    : new Array(state.doc.lines).fill("");
  labelCache.set(state, labels);
  return labels;
}

export function siblingWinsGutter() {
  return gutter({
    class: "diff2-line-number-gutter",
    lineMarker(view: EditorView, line) {
      const labels = labelsFor(view.state);
      const lineNo = view.state.doc.lineAt(line.from).number;
      const text = labels[lineNo - 1] ?? "";
      return text ? new LineNumberMarker(text) : null;
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
      return new LineNumberMarker("0");
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
