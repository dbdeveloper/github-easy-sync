// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { CommitMessagePlaceholders } from "./types";

// Sync2 commit-message templates support these placeholders. Each is
// substituted only if the matching field is supplied; unknown braces
// are left untouched so users can include literal `{` in their text.
//
//   {date}     YYYY-MM-DD UTC, e.g. "2026-05-03"
//   {time}     HH:MM:SS.ccc UTC (ms-precision), e.g. "09:38:23.123"
//   {filename} basename of a single-file action, e.g. "note.md"
//   {path}     full vault-relative path, e.g. "Folder/note.md"
//
// {date} and {time} both come from the same Date in placeholders.date
// — they're two views of the same instant, not independent values.
// Templates may use either, both, or neither. Defaults use both so
// out-of-the-box messages keep ms-precision and stay unique across
// multi-device syncs without forcing the user to remember to add
// {time}.
//
// deviceLabel is NOT a template placeholder — it's appended in a fixed
// trailing position by appendDeviceSuffix(), so any commit message
// produced by sync2 ends with `" (deviceLabel)"`. That fixed position
// makes the device parseable from any commit on GitHub regardless of
// how the user customized their template, and prevents users from
// accidentally dropping the device tag while editing the template.

export const DEFAULT_COMMIT_MESSAGE_ALL = "Sync at {date} {time}";
export const DEFAULT_COMMIT_MESSAGE_FILE =
  "Update {filename} at {date} {time}";

// Used as the seed commit message when sync2 bootstraps a bare repo
// (no commits yet). The seed is created via the Contents API with a
// single file — <vault>/.gitignore, which always exists after
// GitignoreInvariants.enforce() — because the Git Data API returns
// 409 "Git Repository is empty" until the branch has at least one
// ref. The deviceLabel suffix is appended by appendDeviceSuffix() so
// the resulting commit reads e.g. "Init at 2026-05-14 09:38:23.123
// (Obsidian)".
export const DEFAULT_INIT_COMMIT_MESSAGE = "Init at {date} {time}";

// Sentinel used wherever sync2 needs a stand-in for an unknown device
// — both at READ time (parseDeviceSuffix on a commit with no trailing
// " (label)") and at WRITE time (appendDeviceSuffix / sibling-file
// naming / conflict-store metadata when settings.deviceLabel is empty
// or missing). One constant, one literal "unknown", everywhere.
export const UNKNOWN_DEVICE_LABEL = "unknown";

export function applyTemplate(
  template: string,
  placeholders: CommitMessagePlaceholders,
): string {
  let out = template;
  if (placeholders.date !== undefined) {
    // {date} and {time} both substitute from the same Date — they're
    // two views of the same instant. Templates may use either, both,
    // or neither.
    out = out.replace(/\{date\}/g, formatDateOnly(placeholders.date));
    out = out.replace(/\{time\}/g, formatTimeOnly(placeholders.date));
  }
  if (placeholders.filename !== undefined) {
    out = out.replace(/\{filename\}/g, placeholders.filename);
  }
  if (placeholders.path !== undefined) {
    out = out.replace(/\{path\}/g, placeholders.path);
  }
  return out;
}

// Append a fixed-position " (deviceLabel)" suffix to the message.
// Called by Sync2Manager at the very end of message construction —
// after applyTemplate() — so every sync2 commit ends with the device
// tag, parseable as /\s\(([^)]+)\)$/.
//
// The label is escaped: `(` → `[`, `)` → `]`. Round parens inside the
// label would break the trailing-paren regex (greedy match across
// nested groups becomes ambiguous); square brackets render naturally
// in commit messages and stay parseable. Spaces and Unicode survive
// untouched. An empty or missing label falls back to
// UNKNOWN_DEVICE_LABEL ("unknown") rather than skipping the suffix —
// the invariant "every sync2 commit ends with `(label)`" must hold
// unconditionally so future viewers always have something to parse.
//
// Example: deviceLabel "device (one of three)" → suffix
// " (device [one of three])".
export function appendDeviceSuffix(
  message: string,
  deviceLabel: string,
): string {
  const raw =
    !deviceLabel || deviceLabel.length === 0
      ? UNKNOWN_DEVICE_LABEL
      : deviceLabel;
  const safe = raw.replace(/\(/g, "[").replace(/\)/g, "]");
  return `${message} (${safe})`;
}

// Inverse of appendDeviceSuffix: pulls the device label off any
// trailing " (label)" group in a commit message. Falls back to
// UNKNOWN_DEVICE_LABEL ("unknown") when nothing matches — i.e. a
// hand-edited GitHub commit, a commit from a non-sync2 tool, or
// one made before the suffix convention was introduced.
export function parseDeviceSuffix(message: string): string {
  const m = /\s\(([^()]+)\)\s*$/.exec(message);
  return m ? m[1] : UNKNOWN_DEVICE_LABEL;
}

// `2026-05-08`. ISO date in UTC. Used by `{date}` placeholder.
function formatDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// `15:30:00.123`. ISO time without `T` prefix or `Z` suffix, ms-
// precision. Used by `{time}` placeholder. Together with `{date}`
// reproduces the full ISO timestamp byte-for-byte (just swap the
// space separator for `T` and append `Z`). Ms-precision keeps the
// message unique across multi-device same-second syncs even when
// the user's template is just "{date} {time}".
function formatTimeOnly(d: Date): string {
  return d.toISOString().slice(11, 23);
}
