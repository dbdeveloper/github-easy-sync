import { describe, it, expect } from "vitest";
// Import from the helper module (not conflict-view.ts) so the test
// doesn't drag in Obsidian's ItemView, which only exists in the
// live runtime — outside of it, `class extends ItemView` blows up.
import {
  groupByVaultPath,
  formatTs,
} from "../../src/sync2/views/conflict-view-helpers";
import { ConflictRecord } from "../../src/sync2/conflict-store-old";

function rec(o: Partial<ConflictRecord> & Pick<ConflictRecord, "id" | "vaultPath" | "ts">): ConflictRecord {
  return {
    siblingPath: `${o.vaultPath}.conflict-from-test-${o.id}.md`,
    deviceLabel: "test",
    baseCommitSha: null,
    theirsBlobSha: "sha",
    ...o,
  } as ConflictRecord;
}

describe("groupByVaultPath", () => {
  it("groups records by vault path; multi-copy entries have all their records", () => {
    const records: ConflictRecord[] = [
      rec({ id: "1", vaultPath: "a.md", ts: 100 }),
      rec({ id: "2", vaultPath: "b.md", ts: 200 }),
      rec({ id: "3", vaultPath: "a.md", ts: 300 }),
    ];
    const grouped = groupByVaultPath(records);
    expect([...grouped.keys()].sort()).toEqual(["a.md", "b.md"]);
    expect(grouped.get("a.md")!.map((r) => r.id)).toEqual(["1", "3"]);
    expect(grouped.get("b.md")!.map((r) => r.id)).toEqual(["2"]);
  });

  it("sorts records within a group by ts ascending", () => {
    const records: ConflictRecord[] = [
      rec({ id: "newer", vaultPath: "a.md", ts: 500 }),
      rec({ id: "older", vaultPath: "a.md", ts: 100 }),
    ];
    const grouped = groupByVaultPath(records);
    expect(grouped.get("a.md")!.map((r) => r.id)).toEqual(["older", "newer"]);
  });

  it("empty input returns empty map", () => {
    expect(groupByVaultPath([]).size).toBe(0);
  });

  it("preserves chronological order across files (oldest-touched-file appears first)", () => {
    const records: ConflictRecord[] = [
      rec({ id: "1", vaultPath: "newer.md", ts: 1000 }),
      rec({ id: "2", vaultPath: "older.md", ts: 100 }),
    ];
    const grouped = groupByVaultPath(records);
    expect([...grouped.keys()]).toEqual(["older.md", "newer.md"]);
  });
});

describe("formatTs", () => {
  it("emits compact YYYY-MM-DD HH:MM, local time", () => {
    // Use a UTC ms epoch that's deterministic across timezones via
    // Date.UTC, but format yields LOCAL time — we just check shape.
    const out = formatTs(Date.UTC(2026, 4, 8, 15, 30, 0));
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("zero-pads single-digit components", () => {
    // Pick a date guaranteed to have single-digit fields after
    // local conversion in any timezone we care about — 1pm UTC on
    // 2026-01-05 stays "first half of January" in every timezone
    // we'd reasonably encounter. Then assert the regex shape.
    const out = formatTs(Date.UTC(2026, 0, 5, 13, 7, 0));
    // Pad pattern: every component is exactly two digits.
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(out);
    expect(m).not.toBeNull();
  });
});
