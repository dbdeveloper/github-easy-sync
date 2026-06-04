// W4c Step A — full unit table for the pure reopen-action dispatch.
// Exhaustive over all six classifyReopen statuses. This is the testable spine:
// the execute-layer glue (mountDiffPane) is manual, but the branch matrix is
// pinned here so a regression in the decision is caught by a unit test.

import { describe, it, expect } from "vitest";
import type { AutosaveMeta, ReopenStatus } from "../../src/diff2/autosave-store";
import { reopenAction, type ReopenAction } from "../../src/diff2/reopen-action";

// reopenAction ignores meta contents — only the discriminant matters.
const meta = {} as AutosaveMeta;

const CASES: Array<{ status: ReopenStatus; expected: ReopenAction }> = [
  { status: { kind: "fresh" }, expected: { kind: "fresh" } },
  {
    status: { kind: "corrupt", reason: "meta" },
    expected: { kind: "discard-fresh", reason: "corrupt" },
  },
  {
    status: { kind: "corrupt", reason: "snapshot-integrity" },
    expected: { kind: "discard-fresh", reason: "corrupt" },
  },
  {
    status: { kind: "corrupt", reason: "input-missing" },
    expected: { kind: "discard-fresh", reason: "corrupt" },
  },
  {
    status: { kind: "sentinel", meta },
    expected: { kind: "discard-fresh", reason: "sentinel" },
  },
  {
    status: { kind: "library-drift", meta },
    expected: { kind: "discard-fresh", reason: "library-drift" },
  },
  { status: { kind: "resume", meta }, expected: { kind: "resume" } },
  {
    status: {
      kind: "vault-changed",
      meta,
      currentBaseSha: "aaa",
      currentSiblingSha: "bbb",
    },
    expected: { kind: "restore" },
  },
];

describe("reopenAction — W4c Step A dispatch (all 6 statuses)", () => {
  for (const { status, expected } of CASES) {
    const label =
      status.kind === "corrupt" ? `corrupt:${status.reason}` : status.kind;
    it(`${label} → ${expected.kind}${"reason" in expected ? `(${expected.reason})` : ""}`, () => {
      expect(reopenAction(status)).toEqual(expected);
    });
  }

  it("every status maps to a known action kind", () => {
    const kinds = new Set(CASES.map(({ expected }) => expected.kind));
    expect(kinds).toEqual(
      new Set(["fresh", "discard-fresh", "resume", "restore"]),
    );
  });
});
