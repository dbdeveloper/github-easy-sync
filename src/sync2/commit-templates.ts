import { CommitMessagePlaceholders } from "./types";

// Sync2 commit-message templates support these placeholders. Each is
// substituted only if the matching field is supplied; unknown braces
// are left untouched so users can include literal `{` in their text.
//
//   {date}     ISO timestamp, e.g. "2026-05-03T09:38:23Z"
//   {filename} basename of a single-file action, e.g. "note.md"
//   {path}     full vault-relative path, e.g. "Folder/note.md"
//
// deviceLabel is NOT a template placeholder — it's appended in a fixed
// trailing position by appendDeviceSuffix(), so any commit message
// produced by sync2 ends with `" (deviceLabel)"`. That fixed position
// makes the device parseable from any commit on GitHub regardless of
// how the user customized their template, and prevents users from
// accidentally dropping the device tag while editing the template.

export const DEFAULT_COMMIT_MESSAGE_ALL = "Sync at {date}";
export const DEFAULT_COMMIT_MESSAGE_FILE = "Update {filename} at {date}";

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
    out = out.replace(/\{date\}/g, formatDate(placeholders.date));
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
// after applyTemplate() for templated messages, OR directly on a
// user-typed customMessage from syncFile's modal — so every sync2
// commit ends with the device tag, parseable as /\s\(([^)]+)\)$/.
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

function formatDate(d: Date): string {
  // Full ISO including milliseconds. Two devices syncing within the
  // same second was previously a real collision risk: same template
  // + same default deviceLabel ("Obsidian") + second-precision date
  // gave byte-identical commit messages, indistinguishable in
  // git log scrolling. Millisecond precision makes the message
  // effectively unique even when three or more devices commit at
  // the "same" wall-clock second — sub-millisecond clock alignment
  // across devices doesn't happen in practice.
  return d.toISOString();
}
