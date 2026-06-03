// autosaveIdForEntry — the single conflict-entry → autosave-id derivation
// shared by mount (startSession) and reopen (classifyReopen). The recovery
// linchpin: mount and reopen MUST agree on the id, so this must be pure,
// deterministic, and branch correctly on tracked vs synthetic.

import { describe, it, expect } from "vitest";
import type { ConflictEntry } from "../../src/diff2/synthetic-detector";
import { autosaveIdForEntry } from "../../src/diff2/synthetic-detector";
import {
  deriveAutosaveId,
  trackedAutosaveId,
} from "../../src/diff2/autosave-store";
import type { ConflictRecord } from "../../src/sync2/conflict-store";

function entry(over: Partial<ConflictEntry>): ConflictEntry {
  return {
    basePath: "Notes/idea.md",
    siblingPath: "Notes/idea.conflict-from-Phone-2026-05-26T10-30-00Z.md",
    deviceLabel: "Phone",
    isoTimestamp: "2026-05-26T10-30-00Z",
    kind: "synthetic",
    ...over,
  };
}

describe("autosaveIdForEntry", () => {
  it("tracked entry keys off its ConflictStore record id", () => {
    const e = entry({
      kind: "tracked",
      record: { id: "rec-123" } as ConflictRecord,
    });
    expect(autosaveIdForEntry(e)).toBe(trackedAutosaveId("rec-123"));
    expect(autosaveIdForEntry(e)).toBe("tracked-rec-123");
  });

  it("synthetic entry keys off the (sorted) base+sibling path pair", () => {
    const e = entry({ kind: "synthetic" });
    expect(autosaveIdForEntry(e)).toBe(
      deriveAutosaveId("synthetic", e.basePath, e.siblingPath),
    );
  });

  it("tracked WITHOUT a record falls back to the synthetic derivation", () => {
    // Defensive: kind says tracked but record is absent → don't crash, use paths.
    const e = entry({ kind: "tracked", record: undefined });
    expect(autosaveIdForEntry(e)).toBe(
      deriveAutosaveId("synthetic", e.basePath, e.siblingPath),
    );
  });

  it("is deterministic — same entry yields the same id", () => {
    const e = entry({ kind: "synthetic" });
    expect(autosaveIdForEntry(e)).toBe(autosaveIdForEntry(e));
  });

  it("synthetic id is order-independent in the path pair", () => {
    const a = entry({ basePath: "a.md", siblingPath: "b.md", kind: "synthetic" });
    const b = entry({ basePath: "b.md", siblingPath: "a.md", kind: "synthetic" });
    expect(autosaveIdForEntry(a)).toBe(autosaveIdForEntry(b));
  });
});
