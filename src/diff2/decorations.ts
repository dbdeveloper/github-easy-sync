// DiffPane decoration extension — derives a DecorationSet from the
// editor-model structure (Segment[]) + the live doc (Etap 1b.1).
//
// Replaces the Phase-3 chunks/offsets side-field. The structure now
// lives in a StateField with TWO update paths (DIFF-EDITOR.md §1):
//   - `setDiffPaneState` effect → a chunk-action recomputed the
//     structure (roles changed: a resolved group became normal). Use
//     the effect's value verbatim.
//   - otherwise, on a doc change → `mapStructure(value, changes,
//     active)` maps POSITIONS only (never roles), so free editing stays
//     in sync. The shipped bug was having ONLY the effect path (free
//     edits desynced); a chunk action must NOT go through mapStructure
//     (it can't change roles), so it always dispatches the effect.
//
// Decorations produced (unchanged visuals, reused widgets/classes):
//   - Line backgrounds: red (ver1/ours), green (ver2/theirs), neutral.
//   - Word-level yellow marks from computeWordDiff (R7.4).
//   - Marker block-widgets <<<<< / ===== / >>>>> per diff group (R7.2).
//
// Built via Decoration.set(array, /*sort*/ true) rather than a
// RangeSetBuilder so decorations may be pushed in any order (word
// marks inside an early ver line vs a later line's background would
// otherwise violate the builder's sorted-input contract).
//
// Canonical specs:
//   - docs/tasks/DIFF-EDITOR.md §1 (model), §1.6.a.1 (markers as widgets)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.2–R7.5

import {
  ChangeDesc,
  Extension,
  StateEffect,
  StateField,
  Text,
} from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import {
  type ActiveBlock,
  mapStructure,
  type Segment,
} from "./editor-model";
import { ConflictMarkerWidget, type MarkerWidgetCallbacks } from "./markers";
import { computeWordDiff } from "./word-level-diff";

export interface BuildOpts {
  oursLabel: string;
  theirsLabel: string;
  isMarkdown: boolean;
  callbacks: MarkerWidgetCallbacks;
}

const COMMON_LINE_CLASS = "diff2-line-common";
const OURS_LINE_CLASS = "diff2-line-ours";
const THEIRS_LINE_CLASS = "diff2-line-theirs";
const WORD_MARK_CLASS = "diff2-word-changed";

const lineCommon = Decoration.line({ class: COMMON_LINE_CLASS });
const lineOurs = Decoration.line({ class: OURS_LINE_CLASS });
const lineTheirs = Decoration.line({ class: THEIRS_LINE_CLASS });
const wordMark = Decoration.mark({ class: WORD_MARK_CLASS });

export interface DiffPaneFieldState {
  structure: Segment[];
  opts: BuildOpts;
}

// Effect carrying a recomputed structure (chunk-action path). DiffPane
// dispatches this alongside the doc change in applyToChunk / resolveAll.
export const setDiffPaneState = StateEffect.define<DiffPaneFieldState>();

// The structure-of-record. See module header for the two update paths.
export const diffPaneStateField = StateField.define<DiffPaneFieldState | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setDiffPaneState)) return e.value;
    }
    if (!value || !tr.docChanged) return value;
    // Free-edit path: map positions only. `active` = the block the
    // caret sat in BEFORE the edit, so an insert at a block edge / into
    // an empty ver grows the right block (§1.8.a). Full §1.8 nav is
    // 1b.4; this minimal derivation keeps typing sound now.
    const active = activeBlockAt(
      value.structure,
      tr.startState.selection.main.head,
    );
    return {
      structure: mapStructure(value.structure, tr.changes as ChangeDesc, active),
      opts: value.opts,
    };
  },
});

const decorationsProvider = EditorView.decorations.compute(
  [diffPaneStateField],
  (state) => {
    const field = state.field(diffPaneStateField);
    if (!field) return Decoration.none;
    return buildDecorationSet(state.doc, field.structure, field.opts);
  },
);

// Find the ver-block (ver1/ver2) whose range contains `pos`, for the
// mapStructure `active` hint. Returns undefined when the caret is in a
// normal segment or at an ambiguous boundary. Prefers an interior match
// (from <= pos < to); falls back to a block ending exactly at pos.
function activeBlockAt(
  structure: Segment[],
  pos: number,
): ActiveBlock | undefined {
  let edgeMatch: ActiveBlock | undefined;
  for (const s of structure) {
    if (s.role === "normal") continue;
    if (pos >= s.from && pos < s.to) {
      return { role: s.role, group: s.group };
    }
    if (pos === s.to) {
      edgeMatch = { role: s.role, group: s.group };
    }
  }
  return edgeMatch;
}

export function buildDecorationSet(
  doc: Text,
  structure: Segment[],
  opts: BuildOpts,
): DecorationSet {
  const decos: ReturnType<typeof lineCommon.range>[] = [];

  for (let i = 0; i < structure.length; i++) {
    const s = structure[i];

    if (s.role === "normal") {
      eachLineStart(doc, s.from, s.to, (from) =>
        decos.push(lineCommon.range(from)),
      );
      continue;
    }

    if (s.role !== "ver1") continue; // ver2 handled with its ver1
    const v1 = s;
    const v2 = structure[i + 1];
    if (!v2 || v2.role !== "ver2" || v2.group !== v1.group) continue;
    i++; // consume the paired ver2

    const v1Empty = v1.to <= v1.from;
    const v2Empty = v2.to <= v2.from;

    // Top marker — anchor at ver1 start, or ver2 start when ver1 empty
    // (zero-width point guard, mirrors the legacy anchor rule).
    const topAnchor = v1Empty ? v2.from : v1.from;
    decos.push(
      Decoration.widget({
        widget: new ConflictMarkerWidget(
          "top",
          opts.oursLabel,
          v1.group,
          opts.isMarkdown,
          opts.callbacks,
        ),
        block: true,
        side: -1,
      }).range(topAnchor),
    );

    // ver1 line backgrounds.
    eachLineStart(doc, v1.from, v1.to, (from) =>
      decos.push(lineOurs.range(from)),
    );

    // Middle marker — only when ver2 has content (legacy behavior).
    if (!v2Empty) {
      decos.push(
        Decoration.widget({
          widget: new ConflictMarkerWidget(
            "middle",
            opts.theirsLabel,
            v1.group,
            opts.isMarkdown,
            opts.callbacks,
          ),
          block: true,
          side: -1,
        }).range(v2.from),
      );
    }

    // ver2 line backgrounds.
    eachLineStart(doc, v2.from, v2.to, (from) =>
      decos.push(lineTheirs.range(from)),
    );

    // Word-level marks on both sides.
    const oursText = doc.sliceString(v1.from, v1.to);
    const theirsText = doc.sliceString(v2.from, v2.to);
    const wd = computeWordDiff(oursText, theirsText);
    for (const span of wd.oursSpans) {
      const from = v1.from + span.start;
      const to = v1.from + span.end;
      if (to > from) decos.push(wordMark.range(from, to));
    }
    for (const span of wd.theirsSpans) {
      const from = v2.from + span.start;
      const to = v2.from + span.end;
      if (to > from) decos.push(wordMark.range(from, to));
    }

    // Bottom marker — below ver2, or below ver1 when ver2 empty.
    const bottomAnchor = v2Empty ? v1.to : v2.to;
    decos.push(
      Decoration.widget({
        widget: new ConflictMarkerWidget(
          "bottom",
          opts.theirsLabel,
          v1.group,
          opts.isMarkdown,
          opts.callbacks,
        ),
        block: true,
        side: 1,
      }).range(bottomAnchor),
    );
  }

  return Decoration.set(decos, /* sort */ true);
}

// Invoke `cb(lineStartPos)` for each doc line that the [from, to) range
// covers. Empty range (to <= from) → no lines. Lines are identified by
// their start position; callers add line decorations there.
function eachLineStart(
  doc: Text,
  from: number,
  to: number,
  cb: (lineFrom: number) => void,
): void {
  if (to <= from) return;
  let pos = from;
  while (pos < to) {
    const line = doc.lineAt(pos);
    cb(line.from);
    if (line.to + 1 > to) break;
    pos = line.to + 1; // next line start (skip the \n)
  }
}

// Public extension factory — seeds the field with the initial structure
// + opts, then layers the decoration provider.
export function diffPaneExtension(initial: DiffPaneFieldState): Extension {
  return [diffPaneStateField.init(() => initial), decorationsProvider];
}
