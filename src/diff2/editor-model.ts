// Editor model for the DiffPane — the "Rep A" representation that CM6
// actually edits (DIFF-EDITOR.md §1.1–§1.8; architecture decided
// 2026-06-01).
//
// The \0/\1 joined string (joined-doc.ts) is OUR internal serialization
// — it never reaches CodeMirror. CM6 receives a CLEAN doc (the joined
// string with all sentinels stripped; lines broken on real \n only),
// plus a parallel STRUCTURE describing which character ranges are
// normal / ver1 / ver2. The structure is the one piece the shipped
// diff-chunks side-field lacked: it is mapped through EVERY transaction
// (not just button effects), so it never desyncs from the doc and the
// commit-time split() stays sound under free editing.
//
// Structure is an ORDERED `Segment[]` in document order — NOT a
// RangeSet. We map endpoints manually (changes.mapPos per endpoint), so
// RangeSet would only serve as sorted storage; and a contiguous tiling
// that contains zero-width ranges (empty ver-blocks) is exactly where
// RangeSet's sort-by-(from, side) needs hand-tuned sides to keep an
// empty ver adjacent to the right neighbour. An array models the tiling
// sequence directly: document order is preserved by construction
// (mapPos is monotonic), with no side-tuning and no ordering-bug class.
// (The CM6 decoration set in Phase 1b.1 is a SEPARATE RangeSet derived
// fresh at render time; this choice doesn't touch it.)
//
// Two-step seam (layers on joined-doc.ts, does not replace it):
//   base/sibling ↔ joined           : build / split            (joined-doc.ts)
//   joined       ↔ (doc, structure) : toEditorModel / fromEditorModel (here)
//   session-start = toEditorModel(build(base, sibling))
//   commit        = split(fromEditorModel(model))
//   invariant     = split(fromEditorModel(toEditorModel(build(a,b)))) === (a,b)
//
// Mapping rule (mapStructure): a structure range is mapped endpoint by
// endpoint via ChangeDesc.mapPos with role-dependent assoc:
//   - the ACTIVE block (where the caret sits): from→−1, to→+1 (INCLUSIVE
//     edges — an insert at either edge GROWS this block; this is what
//     lets an empty ver-block grow when the user types into it, §1.8.a).
//   - every other range: from→+1, to→−1 (EXCLUSIVE edges — an insert at
//     a boundary lands OUTSIDE, so exactly one block (the active one)
//     claims it and neighbours abut without overlap/gap).
// Interior inserts grow their range regardless of assoc. Selection
// rules (§1.7, Phase 1b.3) guarantee a user edit never spans a
// ver1/ver2 boundary, so the active block is always well-defined.
//
// Validated by tests/diff2/spikes/rep-a-editor-model-spike.test.ts and
// pinned by tests/diff2/editor-model.test.ts.
//
// Canonical spec: docs/tasks/DIFF-EDITOR.md §1.

import { ChangeDesc } from "@codemirror/state";
import {
  build,
  emitNormalLines,
  LINE_TERMINATOR,
  split,
  VER_SEPARATOR,
} from "./joined-doc";

export type SegRole = "normal" | "ver1" | "ver2";

// One structure segment. `group` ties a ver1 to its ver2 (same id);
// normal segments use -1. Ranges tile [0, doc.length] contiguously and
// the array is kept in document order.
export interface Segment {
  role: SegRole;
  group: number;
  from: number;
  to: number;
}

// Which diff-block the caret currently sits in. Phase 1b.4 derives this
// from the selection; mapStructure uses it for inclusive-edge growth.
export interface ActiveBlock {
  role: "ver1" | "ver2";
  group: number;
}

export interface EditorModel {
  // Clean text fed to CodeMirror — no \0/\1, lines broken on \n.
  doc: string;
  // Parallel structure in document order; tiles [0, doc.length].
  structure: Segment[];
}

// joined string → (clean doc, structure). The doc is the joined string
// with every sentinel stripped; ranges tile it contiguously (the \n's
// live inside the ranges, so there are no orphan separators).
export function toEditorModel(joined: string): EditorModel {
  let doc = "";
  const structure: Segment[] = [];
  let pos = 0;
  let group = 0;
  const lines = joined.split(LINE_TERMINATOR);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "" && i === lines.length - 1) continue; // trailing after last \0
    const sep = line.indexOf(VER_SEPARATOR);
    if (sep === -1) {
      structure.push({ role: "normal", group: -1, from: pos, to: pos + line.length });
      doc += line;
      pos += line.length;
    } else {
      const v1 = line.slice(0, sep);
      const v2 = line.slice(sep + 1);
      const g = group++;
      structure.push({ role: "ver1", group: g, from: pos, to: pos + v1.length });
      doc += v1;
      pos += v1.length;
      structure.push({ role: "ver2", group: g, from: pos, to: pos + v2.length });
      doc += v2;
      pos += v2.length;
    }
  }
  return { doc, structure };
}

// (clean doc, structure) → joined string. split() (joined-doc.ts) then
// inverts it to (base, sibling) at commit time.
export function fromEditorModel(model: EditorModel): string {
  const { doc, structure } = model;
  // Commit-boundary fail-closed (Stage 1.h / review finding B): the
  // structure MUST tile [0, doc.length] contiguously. Any gap / overlap
  // means a desync somewhere upstream would silently drop or mis-attribute
  // bytes at split(); throw loudly instead of corrupting the vault (§1.3
  // fail-closed philosophy, applied at the write boundary).
  assertTiling(structure, doc.length);

  // §1.6.a.2 normalization at the commit boundary (review findings E + the
  // focus-leave rule), so it holds however the commit was reached. It applies
  // ONLY to ver1/ver2: a ver-block's last line that lacks a trailing \n would,
  // on split(), merge into the following segment on its OWN side (ver1→base,
  // ver2→sibling). NORMAL segments need no such fix — their bytes go to BOTH
  // sides identically, so emitNormalLines + concatenation reproduce the doc
  // verbatim (the \n simply lives in the content or the next normal segment;
  // adding one would inject a spurious blank line, e.g. after a group between
  // two normals is collapsed away). The test is POSITIONAL: normalize a ver
  // only when its group is NOT the document's last element (an EOL-less tail
  // is valid only at end-of-file).
  const lastIdx = structure.length - 1;
  const needsNl = (s: string): boolean => s.length > 0 && !s.endsWith("\n");

  let joined = "";
  for (let i = 0; i < structure.length; i++) {
    const s = structure[i];
    if (s.role === "normal") {
      joined += emitNormalLines(doc.slice(s.from, s.to));
      continue;
    }
    if (s.role === "ver1") {
      const next = structure[i + 1];
      if (!next || next.role !== "ver2" || next.group !== s.group) {
        throw new Error(
          `editor-model.fromEditorModel: ver1 (group ${s.group}) not ` +
            `followed by its ver2 — structure corrupt`,
        );
      }
      // The group's last segment is ver2 (index i+1). Normalize both sides
      // only when the group is NOT the document's final element.
      const groupNotLast = i + 1 < lastIdx;
      let v1 = doc.slice(s.from, s.to);
      let v2 = doc.slice(next.from, next.to);
      if (groupNotLast && needsNl(v1)) v1 += "\n";
      if (groupNotLast && needsNl(v2)) v2 += "\n";
      joined += v1 + VER_SEPARATOR + v2 + LINE_TERMINATOR;
      i++; // consume the paired ver2
      continue;
    }
    // a bare ver2 without a preceding ver1 → corrupt.
    throw new Error(
      `editor-model.fromEditorModel: dangling ver2 (group ${s.group})`,
    );
  }
  return joined;
}

// Verify the structure tiles [0, docLength] with no gap or overlap. Exported so
// the collapseGuard internal path (mapStructure → currentItems) can fail-closed
// too — a mis-tile there silently dropped user text (§1.7.a (0)) instead of
// throwing. `context` names the caller in the error.
export function assertTiling(
  structure: Segment[],
  docLength: number,
  context = "fromEditorModel",
): void {
  if (structure.length === 0) {
    if (docLength !== 0) {
      throw new Error(`editor-model.${context}: empty structure but doc length ${docLength}`);
    }
    return;
  }
  if (structure[0].from !== 0) {
    throw new Error(`editor-model.${context}: structure starts at ${structure[0].from}, not 0`);
  }
  for (let i = 1; i < structure.length; i++) {
    if (structure[i].from !== structure[i - 1].to) {
      throw new Error(
        `editor-model.${context}: gap/overlap before segment ${i} ` +
          `(prev.to=${structure[i - 1].to}, from=${structure[i].from})`,
      );
    }
  }
  const end = structure[structure.length - 1].to;
  if (end !== docLength) {
    throw new Error(`editor-model.${context}: structure ends at ${end}, doc length ${docLength}`);
  }
}

// Map the structure through a transaction's changes (DIFF-EDITOR.md §1.8 —
// must run on EVERY doc-changing transaction). Document order is preserved
// (mapPos is monotonic). The segment at `growIdx` uses INCLUSIVE edges
// (from→−1, to→+1) so an insert at either of its boundaries grows IT; every
// other segment uses EXCLUSIVE edges (from→+1, to→−1) so it never claims a
// boundary insert. `growIdx` is the segment the edit belongs to — the caret's
// segment (growSegmentIndex) or an explicitly-activated empty ver (§1.8.a),
// resolved by growIndexFor. Without a correct growIdx, an insert at a segment
// boundary (e.g. typing at doc start, a line start) would fall into a gap and
// be dropped — caught now by fromEditorModel's tiling assertion.
export function mapStructure(
  structure: Segment[],
  changes: ChangeDesc,
  growIdx = -1,
): Segment[] {
  return structure.map((s, idx) => {
    const grows = idx === growIdx;
    const from = changes.mapPos(s.from, grows ? -1 : 1);
    let to = changes.mapPos(s.to, grows ? 1 : -1);
    // A collapsed range (from === to) is valid: an emptied ver-block
    // awaiting auto-collapse (§1.6). Never let it invert.
    if (to < from) to = from;
    return { role: s.role, group: s.group, from, to };
  });
}

// The index of the segment an edit at `pos` belongs to: the segment whose
// interior contains pos; else a non-empty segment STARTING at pos (caret at
// its start → grow it leftward); else a non-empty segment ENDING at pos
// (caret at doc end); else -1. Never returns a zero-width segment — an empty
// ver-block can only be grown via an explicit activation (growIndexFor).
export function growSegmentIndex(structure: Segment[], pos: number): number {
  for (let i = 0; i < structure.length; i++) {
    if (pos > structure[i].from && pos < structure[i].to) return i;
  }
  for (let i = 0; i < structure.length; i++) {
    if (structure[i].from === pos && structure[i].to > structure[i].from) return i;
  }
  for (let i = structure.length - 1; i >= 0; i--) {
    if (structure[i].to === pos && structure[i].to > structure[i].from) return i;
  }
  return -1;
}

// Resolve the grow target for a doc-changing transaction: an explicitly
// activated empty ver-block (§1.8.a) wins (its position is shared with a
// neighbour, so it can't be found by `caret` alone); otherwise the caret's
// segment. Shared by the structure field and the auto-collapse filter so
// they compute the SAME post-edit structure.
export function growIndexFor(
  structure: Segment[],
  activeEmptyVer: ActiveBlock | null,
  caret: number,
): number {
  if (activeEmptyVer) {
    const i = structure.findIndex(
      (s) => s.role === activeEmptyVer.role && s.group === activeEmptyVer.group,
    );
    if (i >= 0) return i;
  }
  return growSegmentIndex(structure, caret);
}

// Commit convenience: (doc, structure) → (base, sibling).
export function modelToBaseSibling(model: EditorModel): {
  base: string;
  sibling: string;
} {
  return split(fromEditorModel(model));
}

// Build the editor model straight from a (base, sibling) pair.
export function baseSiblingToModel(base: string, sibling: string): EditorModel {
  return toEditorModel(build(base, sibling));
}