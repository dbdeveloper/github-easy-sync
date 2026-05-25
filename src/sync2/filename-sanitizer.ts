// Filename sanitizer — cross-platform-compatible names invariant.
//
// Two distinct families of forbidden chars, both handled by the same
// mapping:
//
//   1. Windows FAT/NTFS-forbidden ASCII: `< > : " | ? * \`. Allowed by
//      Desktop Obsidian (POSIX/APFS/NTFS-on-modern-Windows) but rejected
//      by Obsidian Android's file create path — the asymmetric failure
//      that motivated this module. Push-side rename catches existing
//      offenders on Desktop; pull-side rewrites incoming GitHub paths
//      that previously slipped through.
//
//   2. Obsidian-app-level forbidden across all platforms: `# ^ [ ]`.
//      Obsidian Desktop AND Mobile both reject file creation with
//      these in the name because they conflict with Obsidian's own
//      wiki-link grammar (`[[note#heading]]`, `[[note^block-id]]`,
//      `[[link]]`). The plugin can never see them in a local vault,
//      but they can land on GitHub from outside (raw git, web UI,
//      another tool) — pull-side handling is the only defence.
//
// The plugin's response: never let these ASCII chars land on GitHub.
// Mapping is hard-coded (no setting) so the canonical representation
// is identical across every device that ever touches this vault.
//
// Mapping selected for visual fidelity in the affected character's
// typographic role (curly quote for `"`, modifier-letter colon for `:`,
// fullwidth glyphs for the rest). All replacements are single Unicode
// code points outside both forbidden sets and accepted by every vault
// adapter we ship to.
//
// Application points:
//   - Push side: vault walk before findChanges renames any file whose
//     path contains a forbidden char via `app.fileManager.renameFile`
//     (Obsidian-aware rename — auto-updates wiki-links). The renamed
//     path is what ChangeDetector then publishes as a normal local
//     change to GitHub.
//   - Pull side: `applyRemoteAddOrModify` rewrites the incoming
//     GitHub path to canonical before any local write, and records a
//     phantom snapshot entry under the forbidden path so the next
//     ChangeDetector emits a deletion that cleans GitHub.
//
// Invariant: after one full sync round-trip across all devices, no
// path on GitHub OR in any local vault contains an unmapped ASCII char
// from the forbidden set.

export const FORBIDDEN_TO_CANONICAL: Record<string, string> = {
  // Family 1 — Windows FAT/NTFS-forbidden (Android Obsidian also rejects).
  '"': "“",   // "  LEFT DOUBLE QUOTATION MARK
  "<": "＜",  // ＜  FULLWIDTH LESS-THAN SIGN
  ">": "＞",  // ＞  FULLWIDTH GREATER-THAN SIGN
  ":": "꞉",   // ꞉  MODIFIER LETTER COLON
  "|": "｜",  // ｜  FULLWIDTH VERTICAL LINE
  "?": "？",  // ？  FULLWIDTH QUESTION MARK
  "*": "＊",  // ＊  FULLWIDTH ASTERISK
  "\\": "＼", // ＼  FULLWIDTH REVERSE SOLIDUS
  // Family 2 — Obsidian-app-level forbidden across all platforms
  // (conflict with wiki-link grammar `[[file#heading^block]]`).
  "#": "＃",  // ＃  FULLWIDTH NUMBER SIGN
  "^": "＾",  // ＾  FULLWIDTH CIRCUMFLEX ACCENT
  "[": "［",  // ［  FULLWIDTH LEFT SQUARE BRACKET
  "]": "］",  // ］  FULLWIDTH RIGHT SQUARE BRACKET
};

// Regex anchored to the exact ASCII set so the cheap pre-check stays
// O(n) in path length without allocating a stripped copy when nothing
// matches. Built once; reused by sanitizeFilename and needsSanitization.
// Inside the character class: `\\` for backslash, `\]` and `\[` to
// avoid breaking the class itself.
const FORBIDDEN_REGEX = /["<>:|?*\\#^\[\]]/;

// Returns the canonical form of `path`. Pass-through (same string
// reference) when no forbidden char is present — most calls take this
// path on a healthy vault, so the fast path matters.
export function sanitizeFilename(path: string): string {
  if (!FORBIDDEN_REGEX.test(path)) return path;
  let out = "";
  for (const ch of path) {
    out += FORBIDDEN_TO_CANONICAL[ch] ?? ch;
  }
  return out;
}

// Cheap predicate — short-circuits as soon as one forbidden char is
// found. Use this to gate work that's only relevant when a rename is
// actually needed (logging, queueing, etc.).
export function needsSanitization(path: string): boolean {
  return FORBIDDEN_REGEX.test(path);
}
