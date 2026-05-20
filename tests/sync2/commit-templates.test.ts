import { describe, it, expect } from "vitest";
import {
  applyTemplate,
  appendDeviceSuffix,
  parseDeviceSuffix,
  UNKNOWN_DEVICE_LABEL,
  DEFAULT_COMMIT_MESSAGE_ALL,
  DEFAULT_COMMIT_MESSAGE_FILE,
} from "../../src/sync2/commit-templates";

describe("applyTemplate", () => {
  const fixedDate = new Date("2026-05-03T09:38:23.123Z");

  it("substitutes {date} as YYYY-MM-DD UTC", () => {
    expect(applyTemplate("at {date}", { date: fixedDate })).toBe(
      "at 2026-05-03",
    );
  });

  it("substitutes {time} as HH:MM:SS.ccc UTC (ms-precision)", () => {
    expect(applyTemplate("at {time}", { date: fixedDate })).toBe(
      "at 09:38:23.123",
    );
  });

  it("{date} and {time} together reproduce the full ISO instant", () => {
    // Same source Date drives both placeholders — joining them with
    // T...Z yields a valid ISO timestamp, byte-equal to .toISOString().
    const out = applyTemplate("{date}T{time}Z", { date: fixedDate });
    expect(out).toBe("2026-05-03T09:38:23.123Z");
    expect(out).toBe(fixedDate.toISOString());
  });

  it("{time} alone (no {date}) substitutes from placeholders.date", () => {
    // Both placeholders draw from the same Date — they're not
    // independent fields. Passing only {time} in the template still
    // works as long as date is supplied.
    expect(applyTemplate("at {time}", { date: fixedDate })).toBe(
      "at 09:38:23.123",
    );
  });

  it("multi-device collision: ms-precision in {time} keeps messages unique", () => {
    const a = new Date("2026-05-03T09:38:23.001Z");
    const b = new Date("2026-05-03T09:38:23.002Z");
    expect(applyTemplate("Sync {date} {time}", { date: a })).not.toBe(
      applyTemplate("Sync {date} {time}", { date: b }),
    );
  });

  it("substitutes {filename}", () => {
    expect(
      applyTemplate("Update {filename}", { filename: "note.md" }),
    ).toBe("Update note.md");
  });

  it("substitutes {path}", () => {
    expect(applyTemplate("at {path}", { path: "Folder/note.md" })).toBe(
      "at Folder/note.md",
    );
  });

  it("substitutes multiple occurrences of the same placeholder", () => {
    expect(
      applyTemplate("{filename}: {filename} changed", {
        filename: "x.md",
      }),
    ).toBe("x.md: x.md changed");
  });

  it("leaves unknown placeholders alone (incl. {device}, which is suffix-only)", () => {
    expect(applyTemplate("{unknown} {device} text", { date: fixedDate })).toBe(
      "{unknown} {device} text",
    );
  });

  it("supports the default 'sync all' template with date + time", () => {
    expect(
      applyTemplate(DEFAULT_COMMIT_MESSAGE_ALL, { date: fixedDate }),
    ).toBe("Sync at 2026-05-03 09:38:23.123");
  });

  it("supports the default file template with all placeholders", () => {
    expect(
      applyTemplate(DEFAULT_COMMIT_MESSAGE_FILE, {
        filename: "todo.md",
        date: fixedDate,
      }),
    ).toBe("Update todo.md at 2026-05-03 09:38:23.123");
  });

  it("returns template unchanged if no placeholders supplied", () => {
    expect(applyTemplate("static message", {})).toBe("static message");
  });

  it("does not collapse literal braces unrelated to placeholders", () => {
    expect(applyTemplate("a { b } c", { date: fixedDate })).toBe(
      "a { b } c",
    );
  });
});

describe("appendDeviceSuffix", () => {
  it("appends ' (label)' at the end of the message", () => {
    expect(appendDeviceSuffix("Sync at 2026-05-03T09:38:23.123Z", "Phone")).toBe(
      "Sync at 2026-05-03T09:38:23.123Z (Phone)",
    );
  });

  it("works with the default ALL template + Phone", () => {
    const base = applyTemplate(DEFAULT_COMMIT_MESSAGE_ALL, {
      date: new Date("2026-05-03T09:38:23.123Z"),
    });
    expect(appendDeviceSuffix(base, "Phone")).toBe(
      "Sync at 2026-05-03 09:38:23.123 (Phone)",
    );
  });

  it("works with the default FILE template + Desktop", () => {
    const base = applyTemplate(DEFAULT_COMMIT_MESSAGE_FILE, {
      filename: "todo.md",
      date: new Date("2026-05-03T09:38:23.123Z"),
    });
    expect(appendDeviceSuffix(base, "Desktop")).toBe(
      "Update todo.md at 2026-05-03 09:38:23.123 (Desktop)",
    );
  });

  it("works on an un-templated message", () => {
    expect(appendDeviceSuffix("manual cleanup pass", "Phone")).toBe(
      "manual cleanup pass (Phone)",
    );
  });

  it("preserves spaces and unicode in the label", () => {
    expect(appendDeviceSuffix("msg", "My Phone")).toBe("msg (My Phone)");
    expect(appendDeviceSuffix("msg", "старий-laptop")).toBe(
      "msg (старий-laptop)",
    );
  });

  it("escapes parens in the label to brackets so the trailing-paren regex stays unambiguous", () => {
    // Without escaping, "Phone (old)" → "msg (Phone (old))" would be
    // ambiguous to parse: which closing paren matches the opening?
    // Map `(` → `[` and `)` → `]` for readability.
    expect(appendDeviceSuffix("msg", "Phone (old)")).toBe(
      "msg (Phone [old])",
    );
  });

  it("escapes the user's documented example", () => {
    // From design discussion: deviceLabel "device (one of three)" →
    // suffix shows brackets in the commit message.
    expect(
      appendDeviceSuffix("commit body", "device (one of three)"),
    ).toBe("commit body (device [one of three])");
  });

  it("empty / missing label falls back to the shared 'unknown' sentinel", () => {
    // Invariant: every sync2 commit ends with " (label)" — even when
    // settings.deviceLabel is somehow empty (cleared by the user, or
    // not yet migrated). UNKNOWN_DEVICE_LABEL keeps the suffix
    // parseable downstream rather than silently skipping it.
    expect(appendDeviceSuffix("msg", "")).toBe(`msg (${UNKNOWN_DEVICE_LABEL})`);
    expect(appendDeviceSuffix("msg", undefined as unknown as string)).toBe(
      `msg (${UNKNOWN_DEVICE_LABEL})`,
    );
  });

  it("default deviceLabel='Obsidian' reads as 'synced from Obsidian (the app)' out of the box", () => {
    expect(appendDeviceSuffix("Sync at 2026-05-03", "Obsidian")).toBe(
      "Sync at 2026-05-03 (Obsidian)",
    );
  });
});

describe("parseDeviceSuffix", () => {
  it("extracts the label from the trailing ' (label)' group", () => {
    expect(
      parseDeviceSuffix("Sync at 2026-05-03T09:38:23.123Z (Phone)"),
    ).toBe("Phone");
  });

  it("returns UNKNOWN_DEVICE_LABEL for messages without a recognizable suffix", () => {
    // Both inputs lack a trailing " (label)" — a sync2 commit whose
    // suffix was stripped, or a non-sync2 commit (gh CLI, web edit,
    // legacy plugin). The PARSER returns the constant "unknown" — a
    // fixed sentinel, NOT the input string.
    expect(parseDeviceSuffix("Sync at 2026-05-03T09:38:23.123Z")).toBe(
      UNKNOWN_DEVICE_LABEL,
    );
    expect(parseDeviceSuffix("commit message without parens")).toBe(
      UNKNOWN_DEVICE_LABEL,
    );
  });

  it("UNKNOWN_DEVICE_LABEL is the literal string 'unknown'", () => {
    expect(UNKNOWN_DEVICE_LABEL).toBe("unknown");
  });

  it("returns UNKNOWN_DEVICE_LABEL when the only parens are mid-message", () => {
    expect(parseDeviceSuffix("Update (mid) note.md")).toBe(
      UNKNOWN_DEVICE_LABEL,
    );
  });

  it("trailing parens at end DO match (greedy by design — that IS the suffix)", () => {
    // A user-customised template that itself ends in `(...)` would be
    // indistinguishable from a sync2 device suffix. That's expected:
    // the convention IS "the trailing parens hold the device". Users
    // who want literal trailing parens in their commit message are
    // out of luck — they'd see those parens read back as the device
    // tag in viewers.
    expect(parseDeviceSuffix("Update note.md (changed)")).toBe("changed");
  });

  it("round-trips with appendDeviceSuffix", () => {
    const final = appendDeviceSuffix("Sync at 2026-05-03", "Phone");
    expect(parseDeviceSuffix(final)).toBe("Phone");
  });

  it("round-trips with escaped parens in the label", () => {
    const final = appendDeviceSuffix("msg", "Phone (old)");
    // Round-trip recovers the ESCAPED label, not the original. That's
    // a known artefact — users who put parens in deviceLabel will see
    // the bracket version on GitHub and in future parsers. Brackets
    // are more readable than the previous `_old_` underscoring.
    expect(parseDeviceSuffix(final)).toBe("Phone [old]");
  });

  it("ignores a single trailing whitespace after the closing paren", () => {
    expect(parseDeviceSuffix("Sync (Phone) ")).toBe("Phone");
    expect(parseDeviceSuffix("Sync (Phone)\n")).toBe("Phone");
  });

  it("empty message → UNKNOWN_DEVICE_LABEL", () => {
    expect(parseDeviceSuffix("")).toBe(UNKNOWN_DEVICE_LABEL);
  });
});
