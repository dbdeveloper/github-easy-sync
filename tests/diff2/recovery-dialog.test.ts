// W4b — recovery-dialog pure helpers. The modal classes themselves are UI
// (manual/Playwright-tested, like PreSyncConflictModal — the mock Modal is a
// stub without createEl/titleEl), so only the deterministic formatters are
// unit-tested here.

import { describe, it, expect } from "vitest";
import {
  relativeTimeFromIso,
  clockFromIso,
} from "../../src/diff2/recovery-dialog";

const BASE = Date.parse("2026-06-04T12:00:00.000Z");
const at = (msOffset: number) => BASE + msOffset;

describe("relativeTimeFromIso", () => {
  const iso = "2026-06-04T12:00:00.000Z";

  it("under a minute → 'just now'", () => {
    expect(relativeTimeFromIso(iso, at(30_000))).toBe("just now");
    expect(relativeTimeFromIso(iso, at(0))).toBe("just now");
  });

  it("minutes (singular/plural)", () => {
    expect(relativeTimeFromIso(iso, at(60_000))).toBe("1 minute ago");
    expect(relativeTimeFromIso(iso, at(5 * 60_000))).toBe("5 minutes ago");
    expect(relativeTimeFromIso(iso, at(59 * 60_000))).toBe("59 minutes ago");
  });

  it("hours (singular/plural)", () => {
    expect(relativeTimeFromIso(iso, at(90 * 60_000))).toBe("1 hour ago");
    expect(relativeTimeFromIso(iso, at(2 * 3600_000))).toBe("2 hours ago");
    expect(relativeTimeFromIso(iso, at(23 * 3600_000))).toBe("23 hours ago");
  });

  it("days (singular/plural)", () => {
    expect(relativeTimeFromIso(iso, at(25 * 3600_000))).toBe("1 day ago");
    expect(relativeTimeFromIso(iso, at(49 * 3600_000))).toBe("2 days ago");
  });

  it("future / negative elapsed clamps to 'just now'", () => {
    expect(relativeTimeFromIso(iso, at(-99999))).toBe("just now");
  });

  it("unparseable → 'some time ago'", () => {
    expect(relativeTimeFromIso("not-a-date", BASE)).toBe("some time ago");
  });
});

describe("clockFromIso", () => {
  it("valid iso → HH:MM:SS (zero-padded)", () => {
    expect(clockFromIso("2026-06-04T12:00:00.000Z")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    // padding: a single-digit second renders two digits
    expect(clockFromIso("2026-06-04T01:02:03.000Z")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("unparseable → ''", () => {
    expect(clockFromIso("nope")).toBe("");
  });
});
