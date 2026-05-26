// Intra-chunk word-level diff highlighting (R7.4).
//
// For a `diff` chunk that has both ours and theirs sides, compute
// character-range spans on each side marking words that DIFFER from
// the other side. The DiffPane overlays these spans with a yellow
// background that visually mixes with the base red (ours) or green
// (theirs) line decoration to give orange / salad colors.
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.4 (word-level highlighting)
//
// Pure module — no DOM, no CodeMirror.

import { diffWords } from "diff";

export interface WordSpan {
  // Character offsets within the side's joined text (oursText or
  // theirsText respectively). Use these to build Decoration.mark
  // ranges relative to each side's start offset in the merged doc.
  start: number;
  end: number;
}

export interface WordDiffResult {
  oursSpans: WordSpan[];   // words present in ours but not in theirs (or different)
  theirsSpans: WordSpan[]; // words present in theirs but not in ours (or different)
}

// Compute word-level diff between two text fragments. The result
// describes which character ranges on each side are visually
// "different" — those get the yellow overlay highlight per R7.4.
//
// `diff.diffWords` returns parts with `value`, `added`, `removed`.
// We walk twice:
//   - To compute ours-side spans, track a running offset across all
//     non-added parts (added = "in theirs but not ours" → skip).
//     `removed` ranges become ours-spans.
//   - To compute theirs-side spans, track a running offset across
//     all non-removed parts. `added` ranges become theirs-spans.
export function computeWordDiff(
  oursText: string,
  theirsText: string,
): WordDiffResult {
  const parts = diffWords(oursText, theirsText);
  const oursSpans: WordSpan[] = [];
  const theirsSpans: WordSpan[] = [];

  let oursPos = 0;
  let theirsPos = 0;

  for (const part of parts) {
    const len = part.value.length;
    if (part.added) {
      theirsSpans.push({ start: theirsPos, end: theirsPos + len });
      theirsPos += len;
    } else if (part.removed) {
      oursSpans.push({ start: oursPos, end: oursPos + len });
      oursPos += len;
    } else {
      oursPos += len;
      theirsPos += len;
    }
  }

  return {
    oursSpans: mergeAdjacent(oursSpans),
    theirsSpans: mergeAdjacent(theirsSpans),
  };
}

// Merge spans that abut each other (end of one === start of next).
// `diff.diffWords` sometimes splits a single visual change across
// multiple part records (whitespace-only fragments produced as
// separate "common" parts inside an otherwise-modified run); a
// single mark-decoration is cheaper to render than many.
function mergeAdjacent(spans: WordSpan[]): WordSpan[] {
  if (spans.length === 0) return spans;
  const out: WordSpan[] = [spans[0]];
  for (let i = 1; i < spans.length; i++) {
    const prev = out[out.length - 1];
    const cur = spans[i];
    if (cur.start === prev.end) {
      prev.end = cur.end;
    } else {
      out.push(cur);
    }
  }
  return out;
}
