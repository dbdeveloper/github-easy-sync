// Pure helpers for ConflictView. Extracted from conflict-view.ts so
// tests can import them without dragging in Obsidian's ItemView
// (which crashes outside the live Obsidian environment).

import { ConflictRecord } from "../conflict-store";

// Group conflict records by their target vault path. Inner arrays
// sorted by ts ascending; outer key order is "earliest first ts per
// path comes first" so the conflict view's left list shows the
// oldest-touched file at the top.
export function groupByVaultPath(
  records: ConflictRecord[],
): Map<string, ConflictRecord[]> {
  const sorted = [...records].sort((a, b) => a.ts - b.ts);
  const out = new Map<string, ConflictRecord[]>();
  for (const r of sorted) {
    const list = out.get(r.vaultPath) ?? [];
    list.push(r);
    out.set(r.vaultPath, list);
  }
  return out;
}

// Compact human-readable timestamp for the list. ISO seconds-only,
// no `T`/`Z` clutter. The full ms-precision lives in meta.json.
export function formatTs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
