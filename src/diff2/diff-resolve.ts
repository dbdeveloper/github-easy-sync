// V2 conflict resolution (DIFF-EDITOR-V2.md §2.2.9 ОСНОВНИЙ scenario / scenario-2).
//
// Resolving a diff-group is a single region-replace: swap the WHOLE group span
// [ver1.from, ver2.to) for the chosen plain text, drop the group's two ranges
// from the structure (it is now normal text), and drop the caret at the START of
// the resolved content (§2.2.9 / TODO #9 — covers keep1/keep2/both/join: start of
// the inserted text; neither: start of what follows the deleted group).
//
// One transaction ⇒ one undo step (history newGroupDelay:0) and one history.jsonl
// block on replay (scenario-2, validated by v2-resolution-paste-spike). The
// auto-\n and selection filters skip setStructure transactions, so this drives
// the doc + structure together cleanly.
//
// Pure `resolveGroup` (unit-tested) + `applyResolve` (dispatch) + a click handler
// that wires the marker buttons.

import { EditorView } from "@codemirror/view";
import type { Extension, Text, TransactionSpec } from "@codemirror/state";
import type { VerRange } from "./diff-model";
import { readStructure, setStructure, toRangeSet } from "./diff-structure";

export type ResolveChoice = "keep1" | "keep2" | "both" | "neither" | "join";

export interface ResolveOpts {
  label?: string; // remote deviceLabel (for join)
  date?: string; // formatted date (for join)
}

// "> "-quote each ver2 line under a header (§2.2.9(7) / TODO #13). Empty ver2 ⇒
// nothing inserted.
function joinText(ver2content: string, opts: ResolveOpts): string {
  if (ver2content === "") return "";
  const label = opts.label ?? "remote";
  const date = opts.date ?? "";
  const header = `> Changes from \`${label}\` at ${date}:\n`;
  const hadTrailingNl = ver2content.endsWith("\n");
  const body = hadTrailingNl ? ver2content.slice(0, -1) : ver2content;
  const quoted = body.split("\n").map((l) => `> ${l}`).join("\n") + (hadTrailingNl ? "\n" : "");
  return header + quoted;
}

// Build the resolution transaction for one group, or null if the group is absent.
export function resolveGroup(
  doc: Text,
  ranges: VerRange[],
  group: number,
  choice: ResolveChoice,
  opts: ResolveOpts = {},
): TransactionSpec | null {
  const v1 = ranges.find((r) => r.group === group && r.ver === 1);
  const v2 = ranges.find((r) => r.group === group && r.ver === 2);
  if (!v1 || !v2) return null;
  const groupFrom = v1.from;
  const groupTo = v2.to;
  const ver1content = doc.sliceString(v1.from, v1.to - 1); // drop terminal \n
  const ver2content = doc.sliceString(v2.from, v2.to - 1);

  let insert: string;
  switch (choice) {
    case "keep1":
      insert = ver1content;
      break;
    case "keep2":
      insert = ver2content;
      break;
    case "both":
      insert = ver1content + ver2content;
      break;
    case "neither":
      insert = "";
      break;
    case "join":
      insert = ver1content + joinText(ver2content, opts);
      break;
  }

  // structure after the replace: drop this group; ranges after the span shift by
  // delta (groups never overlap, so others are wholly before groupFrom or after
  // groupTo — those before are unchanged, the change starts at groupFrom).
  const delta = insert.length - (groupTo - groupFrom);
  const remaining = ranges
    .filter((r) => r.group !== group)
    .map((r) => (r.from >= groupTo ? { ...r, from: r.from + delta, to: r.to + delta } : r));

  return {
    changes: { from: groupFrom, to: groupTo, insert },
    effects: setStructure.of(toRangeSet(remaining)),
    selection: { anchor: groupFrom }, // §2.2.9 / TODO #9 — start of the resolved content
    scrollIntoView: true,
  };
}

export function applyResolve(
  view: EditorView,
  group: number,
  choice: ResolveChoice,
  opts: ResolveOpts = {},
): boolean {
  const spec = resolveGroup(view.state.doc, readStructure(view.state), group, choice, opts);
  if (!spec) return false;
  view.dispatch(spec);
  view.focus(); // keep keyboard focus after a button click (undo/redo reach CM6)
  return true;
}

// A marker button carries `data-diff2-resolve="<choice>"` + `data-diff2-group`.
// This handler catches the click and applies the resolution. Resolve options
// (deviceLabel/date for join) are supplied by the view config at wiring time
// (Phase 6); a default keeps the editor usable standalone.
export function resolveClickHandler(opts: ResolveOpts = {}): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as HTMLElement | null;
      const btn = target?.closest?.("[data-diff2-resolve]") as HTMLElement | null;
      if (!btn) return false;
      event.preventDefault();
      const group = Number(btn.getAttribute("data-diff2-group"));
      const choice = btn.getAttribute("data-diff2-resolve") as ResolveChoice;
      return applyResolve(view, group, choice, opts);
    },
  });
}
