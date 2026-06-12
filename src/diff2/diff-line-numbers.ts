// V2 per-side gutter numbering (DIFF-EDITOR-V2.md §2.2.10, "sibling-wins").
//
// The diff-document is numbered as if it were resolved toward ver2 (sibling):
//   - normal + ver2 lines carry the SIBLING file's line numbers (a continuous
//     sequence); ver2 lines are prefixed `+`.
//   - ver1 lines carry the BASE file's line numbers, prefixed `−` (a separate
//     sequence — they are the "deletions" relative to sibling-wins).
//   - bare terminal `\n` lines (a normal block's hidden line, or an empty
//     ver-block's only line) carry NO number — they are internal, in neither file.
//     An EOL-less last line (terminal that doubles as a content line) DOES carry a
//     number (it's real content).
//
// `computeLineLabels` is the pure §2.2.10 logic (caret-independent ⇒ the gutter
// never renumbers as the cursor moves). The CM6 gutter caches it in a StateField
// (O(lines) per change, O(1) per line lookup) rather than the per-line on-the-fly
// formula — same result; the formula is a future optimisation for huge docs.

import { StateField, type Extension, type Text } from "@codemirror/state";
import { gutter, GutterMarker } from "@codemirror/view";
import type { VerRange } from "./diff-model";
import { fromRangeSet, structureField } from "./diff-structure";

export type LineSide = "normal" | "ver1" | "ver2";
export interface LineLabel {
  text: string; // e.g. "12", "−4", "+7"
  side: LineSide;
}

export function computeLineLabels(doc: Text, ranges: VerRange[]): Map<number, LineLabel> {
  // classify each ver-block line: which side, and whether it's the BARE terminal
  // (an empty terminal line — gets no number). EOL-less terminal lines have
  // content ⇒ not bare ⇒ numbered.
  const role = new Map<number, { ver: 1 | 2; bareTerminal: boolean }>();
  for (const r of ranges) {
    const firstLine = doc.lineAt(r.from).number;
    const termLine = doc.lineAt(r.to - 1).number;
    for (let n = firstLine; n <= termLine; n++) {
      const isTerminal = n === termLine;
      const bareTerminal = isTerminal && doc.line(n).length === 0;
      role.set(n, { ver: r.ver, bareTerminal });
    }
  }
  const out = new Map<number, LineLabel>();
  let ours = 0; // base (ver1 side) running line number
  let theirs = 0; // sibling (ver2 side) running line number
  for (let n = 1; n <= doc.lines; n++) {
    const r = role.get(n);
    if (!r) {
      // normal line — present in both files; sibling-wins ⇒ show the theirs number.
      ours += 1;
      theirs += 1;
      out.set(n, { text: String(theirs), side: "normal" });
    } else if (r.bareTerminal) {
      // hidden terminal — no number, no counter change.
    } else if (r.ver === 1) {
      ours += 1;
      out.set(n, { text: `-${ours}`, side: "ver1" }); // ASCII '-' prefix (deletion side)
    } else {
      theirs += 1;
      out.set(n, { text: `+${theirs}`, side: "ver2" });
    }
  }
  return out;
}

// Cached labels — recomputed on a doc or structure change.
export const lineLabelsField = StateField.define<Map<number, LineLabel>>({
  create: (state) => computeLineLabels(state.doc, fromRangeSet(state.field(structureField))),
  update(value, tr) {
    if (!tr.docChanged && tr.startState.field(structureField) === tr.state.field(structureField)) {
      return value;
    }
    return computeLineLabels(tr.state.doc, fromRangeSet(tr.state.field(structureField)));
  },
});

class LineLabelMarker extends GutterMarker {
  constructor(readonly label: LineLabel) {
    super();
  }
  eq(other: LineLabelMarker): boolean {
    return other.label.text === this.label.text && other.label.side === this.label.side;
  }
  toDOM(): Node {
    const span = document.createElement("span");
    span.className = `diff2-gutter diff2-gutter-${this.label.side}`;
    span.textContent = this.label.text;
    return span;
  }
}

// The per-side gutter. Right-aligned by CSS (`.diff2-gutter`); side classes carry
// the ver1/ver2 colours. Replaces the default lineNumbers().
export const diffLineNumbersGutter: Extension = gutter({
  class: "diff2-line-numbers",
  lineMarker(view, line) {
    const n = view.state.doc.lineAt(line.from).number;
    const label = view.state.field(lineLabelsField).get(n);
    return label ? new LineLabelMarker(label) : null;
  },
  lineMarkerChange: (update) =>
    update.docChanged ||
    update.startState.field(lineLabelsField) !== update.state.field(lineLabelsField),
});

export const diffLineNumbers: Extension = [lineLabelsField, diffLineNumbersGutter];
