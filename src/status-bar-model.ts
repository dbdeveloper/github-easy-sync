// E2 — status-bar text + menu models (TODO.md §6–§7 / DIFF2 R2.7.3).
//
// PURE models, unit-tested in isolation. main.ts owns the (untestable) Obsidian
// wiring: it renders the suffix segments as styled spans and turns the menu
// model into a `new Menu()`. Keeping these pure means the §6 text assembly (the
// "(↑ N | M ⁇)" shape, the space-after-arrow, the glyph) and the §7 menu shape
// (3 states, count-aware labels) are pinned by tests, not by eyeballing.

// U+2047 DOUBLE QUESTION MARK — the single-char "unresolved" glyph for the
// conflict count (TODO §6 "({N} ??)"). One place to change → trivially "??".
export const CONFLICT_GLYPH = "⁇";

export type StatusSegClass = "up" | "conflict";

export interface StatusSeg {
  text: string;
  cls?: StatusSegClass; // "up" → green, "conflict" → red; undefined → neutral
}

// The SUFFIX after the "GitHub" word (which main.ts renders separately, greened
// while draining). Shapes (§6):
//   0 batches, 0 conflicts → []                 → "GitHub"
//   N batches, 0 conflicts → " (↑ N)"           → "GitHub (↑ 3)"
//   N batches, M conflicts → " (↑ N | M ⁇)"     → "GitHub (↑ 3 | 20 ⁇)"
//   0 batches, M conflicts → " (M ⁇)"           → "GitHub (20 ⁇)"
// Space after the arrow, mirroring the space before the glyph.
export function statusBarSuffix(
  queueDepth: number,
  conflictCount: number,
): StatusSeg[] {
  const up = queueDepth > 0;
  const cf = conflictCount > 0;
  if (!up && !cf) return [];
  const inner: StatusSeg[] = [];
  if (up) inner.push({ text: `↑ ${queueDepth}`, cls: "up" });
  if (up && cf) inner.push({ text: " | " });
  if (cf) inner.push({ text: `${conflictCount} ${CONFLICT_GLYPH}`, cls: "conflict" });
  return [{ text: " (" }, ...inner, { text: ")" }];
}

// ── §7 clickable menu ────────────────────────────────────────────────

export type StatusMenuState = "uninitialized" | "token-expired" | "normal";

// uninitialized > token-expired > normal. Uninitialized wins by construction:
// you can't have an expired token with no token configured.
export function statusMenuState(
  configured: boolean,
  expired: boolean,
): StatusMenuState {
  if (!configured) return "uninitialized";
  if (expired) return "token-expired";
  return "normal";
}

export type MenuActionKey =
  | "sync-all"
  | "commit-all"
  | "commit-current"
  | "pull-push"
  | "open-diff"
  | "settings";

export interface StatusMenuItem {
  // null = a disabled grey heading (the "<name>: Uninitialized/Token expired").
  key: MenuActionKey | null;
  label: string;
  // draw a separator BEFORE this item.
  separatorBefore?: boolean;
}

export interface StatusMenuInput {
  state: StatusMenuState;
  pluginName: string;
  queueDepth: number;
  conflictCount: number;
}

// "(1 open conflict)" / "(N open conflicts)" / "" — §7 open-diff suffix.
function openDiffSuffix(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? " (1 open conflict)" : ` (${count} open conflicts)`;
}

// "Pull from repo and push stored (N) commits" — the "(N)" only when N > 0 (§7).
function pullPushLabel(queueDepth: number): string {
  const n = queueDepth > 0 ? ` (${queueDepth})` : "";
  return `Pull from repo and push stored${n} commits`;
}

export function buildStatusMenu(input: StatusMenuInput): StatusMenuItem[] {
  const { state, pluginName, queueDepth, conflictCount } = input;
  const items: StatusMenuItem[] = [];

  // Heading (greyed, disabled) for the error states only.
  if (state === "uninitialized") {
    items.push({ key: null, label: `${pluginName}: Uninitialized` });
  } else if (state === "token-expired") {
    items.push({ key: null, label: `${pluginName}: Token expired` });
  }

  // Actions — present for token-expired + normal; an uninitialized plugin can
  // only reach Settings (nothing else would work).
  if (state !== "uninitialized") {
    const headed = state === "token-expired";
    items.push({ key: "sync-all", label: "Sync All", separatorBefore: headed });
    items.push({ key: "commit-all", label: "Commit all changed files" });
    items.push({ key: "commit-current", label: "Commit current file" });
    items.push({ key: "pull-push", label: pullPushLabel(queueDepth) });
    items.push({
      key: "open-diff",
      label: `Open diff-panel${openDiffSuffix(conflictCount)}`,
    });
  }

  items.push({ key: "settings", label: "Settings", separatorBefore: true });
  return items;
}
