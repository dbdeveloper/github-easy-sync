// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Canonicalisation for text files synced by sync2.
//
// Locked policy:
//   - LF line endings universally (CRLF → LF, lone CR → LF).
//   - No leading UTF-8 BOM (decoded as the U+FEFF code point at index 0).
//   - Trailing newline iff the content is non-empty. Empty stays empty.
//
// Pure module: no I/O, no platform branching. Caller decides which paths
// pass through here (gated by `hasTextExtension(path)` in src/utils.ts).

export interface NormalizeResult {
  content: string;
  changed: boolean;
}

const BOM_CODEPOINT = 0xfeff;

export function normalizeText(input: string): NormalizeResult {
  let s = input;
  if (s.length > 0 && s.charCodeAt(0) === BOM_CODEPOINT) {
    s = s.slice(1);
  }
  s = s.replace(/\r\n?/g, "\n");
  if (s.length > 0 && !s.endsWith("\n")) {
    s += "\n";
  }
  return { content: s, changed: s !== input };
}
