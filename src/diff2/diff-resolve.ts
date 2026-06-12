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

import { EditorView, keymap } from "@codemirror/view";
import { Prec, type Extension, type Text, type TransactionSpec } from "@codemirror/state";
import type { VerRange } from "./diff-model";
import { readStructure, setStructure, toRangeSet } from "./diff-structure";
import { groupsOf } from "./diff-selection";

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

// The resolved plain text for one group's two contents (terminal \n already dropped).
function resolvedInsert(
  choice: ResolveChoice,
  ver1content: string,
  ver2content: string,
  opts: ResolveOpts,
): string {
  switch (choice) {
    case "keep1":
      return ver1content;
    case "keep2":
      return ver2content;
    case "both":
      return ver1content + ver2content;
    case "neither":
      return "";
    case "join":
      return ver1content + joinText(ver2content, opts);
  }
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
  const insert = resolvedInsert(
    choice,
    doc.sliceString(v1.from, v1.to - 1), // ver1 content (terminal \n dropped)
    doc.sliceString(v2.from, v2.to - 1), // ver2 content
    opts,
  );

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
  const ranges = readStructure(view.state);
  const v1 = ranges.find((r) => r.group === group && r.ver === 1);
  if (!v1) return false;
  const spec = resolveGroup(view.state.doc, ranges, group, choice, opts);
  if (!spec) return false;
  // §2.2.9 — imitate select-copy-paste cursor handling: FIRST anchor the caret at
  // the group start (a selection-only transaction — NOT a history step), so CM6
  // history records THIS as the resolution's before-selection. Then undo restores
  // the caret to the group start (where the group reappears) and redo maps it
  // forward to the resolved-content start — both sane, no 0,0 drift.
  view.dispatch({ selection: { anchor: v1.from } });
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

// ── keyboard hotkeys (§1.9) ──────────────────────────────────────────────────
// The group whose span [ver1.from, ver2.to] contains the caret, else null.
export function currentGroupAt(ranges: VerRange[], caret: number): number | null {
  for (const g of groupsOf(ranges)) {
    if (caret >= g.from && caret <= g.to) return g.group;
  }
  return null;
}

// Resolve the group the caret is in (no-op if the caret isn't in a group).
export function resolveCurrentGroup(
  view: EditorView,
  choice: ResolveChoice,
  opts: ResolveOpts = {},
): boolean {
  const group = currentGroupAt(readStructure(view.state), view.state.selection.main.head);
  if (group === null) return false;
  return applyResolve(view, group, choice, opts);
}

// Default hotkeys for the current group (configurable; Prec.highest so they win
// over defaultKeymap). Mod = Ctrl/Cmd.
export function diffResolveKeymap(opts: ResolveOpts = {}): Extension {
  return Prec.highest(
    keymap.of([
      { key: "Mod-Enter", run: (v) => resolveCurrentGroup(v, "keep2", opts) }, // apply theirs
      { key: "Mod-Shift-Enter", run: (v) => resolveCurrentGroup(v, "keep1", opts) }, // keep ours
      { key: "Mod-Alt-Enter", run: (v) => resolveCurrentGroup(v, "both", opts) },
    ]),
  );
}

// ── bulk resolution (toolbar: Keep all / Apply all / Join all) ────────────────
// Resolve EVERY group toward one choice in a SINGLE transaction (one undo step).
export function resolveAll(
  doc: Text,
  ranges: VerRange[],
  choice: ResolveChoice,
  opts: ResolveOpts = {},
): TransactionSpec | null {
  const groups = groupsOf(ranges);
  if (groups.length === 0) return null;
  const changes = groups.map((g) => {
    const v1 = ranges.find((r) => r.group === g.group && r.ver === 1)!;
    const v2 = ranges.find((r) => r.group === g.group && r.ver === 2)!;
    const insert = resolvedInsert(
      choice,
      doc.sliceString(v1.from, v1.to - 1),
      doc.sliceString(v2.from, v2.to - 1),
      opts,
    );
    return { from: g.from, to: g.to, insert }; // non-overlapping; ChangeSet composes
  });
  return {
    changes,
    effects: setStructure.of(toRangeSet([])), // all groups resolved ⇒ no conflicts left
    selection: { anchor: groups[0].from }, // caret at the first resolved group
    scrollIntoView: true,
  };
}

export function applyResolveAll(
  view: EditorView,
  choice: ResolveChoice,
  opts: ResolveOpts = {},
): boolean {
  const ranges = readStructure(view.state);
  const spec = resolveAll(view.state.doc, ranges, choice, opts);
  if (!spec) return false;
  const groups = groupsOf(ranges);
  view.dispatch({ selection: { anchor: groups[0].from } }); // §2.2.9 before-selection anchor
  view.dispatch(spec);
  view.focus();
  return true;
}

// A bulk toolbar element (placed ABOVE the editor by the host view). Buttons map
// to applyResolveAll; disabled when there are no conflicts.
export function createBulkToolbar(view: EditorView, opts: ResolveOpts = {}): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "diff2-toolbar";
  const buttons: { label: string; choice: ResolveChoice }[] = [
    { label: "Keep all (local)", choice: "keep1" },
    { label: "Apply all (remote)", choice: "keep2" },
    { label: "Join all", choice: "join" },
  ];
  for (const b of buttons) {
    const btn = document.createElement("button");
    btn.className = `diff2-toolbar-btn diff2-toolbar-${b.choice}`;
    btn.textContent = b.label;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      applyResolveAll(view, b.choice, opts);
    });
    bar.appendChild(btn);
  }
  return bar;
}
