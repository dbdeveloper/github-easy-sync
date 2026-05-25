import { describe, it, expect } from "vitest";
import { encodePathForGithub } from "../../src/sync2/cross-platform";

// Field bug 2026-05-25: the GitHub Contents API URL was built with raw
// path interpolation, so `?` and other URL-syntax chars truncated the
// path. A file named `[1] File ^ opa?.md` pushed via GitHub Web UI
// returned 404 on our pull. `encodePathForGithub` percent-encodes each
// path segment so the server gets the intended path verbatim.

describe("encodePathForGithub", () => {
  it("passes ASCII-letters / digits / `-` / `_` / `.` unchanged", () => {
    // Per RFC 3986 these are unreserved — encodeURIComponent leaves them.
    expect(encodePathForGithub("Notes/idea-v2_03.md")).toBe(
      "Notes/idea-v2_03.md",
    );
  });

  it("preserves `/` as the path separator", () => {
    // `/` is structural — encoding it as `%2F` would collapse a
    // multi-folder path into a single segment and the server would
    // return 404 (no such file under root).
    expect(encodePathForGithub("a/b/c/d.md")).toBe("a/b/c/d.md");
  });

  it("percent-encodes the URL-syntax chars `?` `#` ` ` ` ` `&`", () => {
    // The reference field-bug name.
    expect(encodePathForGithub("[1] File ^ opa?.md")).toBe(
      "%5B1%5D%20File%20%5E%20opa%3F.md",
    );
    // Sanity per single char:
    expect(encodePathForGithub("a?b")).toBe("a%3Fb");
    expect(encodePathForGithub("a#b")).toBe("a%23b");
    expect(encodePathForGithub("a b")).toBe("a%20b");
    expect(encodePathForGithub("a&b")).toBe("a%26b");
  });

  it("percent-encodes the URL-syntax-meaningful chars in Family-1", () => {
    // `< > : " | ? \`. These would otherwise break URL parsing on
    // GitHub's side. The sanitizer rewrites them before push so they
    // rarely reach the URL, but the client must still encode them
    // correctly for pull-side legacy migration of pre-sanitizer
    // GitHub state.
    expect(encodePathForGithub("a<b")).toBe("a%3Cb");
    expect(encodePathForGithub("a>b")).toBe("a%3Eb");
    expect(encodePathForGithub("a:b")).toBe("a%3Ab");
    expect(encodePathForGithub('a"b')).toBe("a%22b");
    expect(encodePathForGithub("a|b")).toBe("a%7Cb");
    expect(encodePathForGithub("a?b")).toBe("a%3Fb");
    expect(encodePathForGithub("a\\b")).toBe("a%5Cb");
  });

  it("leaves `*` unencoded (RFC 3986 unreserved — GitHub accepts it raw)", () => {
    // encodeURIComponent intentionally leaves `*` (and `'`, `(`, `)`,
    // `!`, `~`) untouched because they're "unreserved" per RFC 3986
    // and have no URL-syntax meaning. GitHub's Contents API accepts
    // them in the URL path verbatim. The sanitizer still rewrites `*`
    // in vault filenames for cross-platform compatibility (Windows
    // forbids it on disk), but the URL layer doesn't need to.
    expect(encodePathForGithub("a*b")).toBe("a*b");
    expect(encodePathForGithub("a'b")).toBe("a'b");
  });

  it("percent-encodes the full Family-2 forbidden ASCII set", () => {
    // `# ^ [ ]`. Same reason as Family-1 — pull-side migration of
    // pre-sanitizer GitHub state.
    expect(encodePathForGithub("a#b")).toBe("a%23b");
    expect(encodePathForGithub("a^b")).toBe("a%5Eb");
    expect(encodePathForGithub("a[b")).toBe("a%5Bb");
    expect(encodePathForGithub("a]b")).toBe("a%5Db");
  });

  it("UTF-8-encodes non-ASCII codepoints (Cyrillic)", () => {
    // The Cyrillic case from the field bug. The exact percent-encoding
    // is what GitHub itself uses in its web URLs.
    expect(encodePathForGithub("Замітки/нотатка.md")).toBe(
      "%D0%97%D0%B0%D0%BC%D1%96%D1%82%D0%BA%D0%B8/%D0%BD%D0%BE%D1%82%D0%B0%D1%82%D0%BA%D0%B0.md",
    );
  });

  it("UTF-8-encodes non-ASCII codepoints (CJK + emoji)", () => {
    // Surrogate-pair codepoints (emoji) must encode to a 4-byte
    // sequence; if encodeURIComponent only handled the high surrogate,
    // the URL would be malformed.
    expect(encodePathForGithub("note_📝_中文.md")).toBe(
      "note_%F0%9F%93%9D_%E4%B8%AD%E6%96%87.md",
    );
  });

  it("encodes the canonical Unicode replacements from filename-sanitizer", () => {
    // Sanity: once the push-side sanitizer has rewritten forbidden
    // chars to their canonical Unicode forms, the resulting path must
    // also encode cleanly for the Contents API. (The canonical chars
    // are NOT in any forbidden set, but they're non-ASCII so they
    // still need percent-encoding in the URL.)
    expect(encodePathForGithub(`Notes/“святої“.md`)).toBe(
      "Notes/%E2%80%9C%D1%81%D0%B2%D1%8F%D1%82%D0%BE%D1%97%E2%80%9C.md",
    );
  });

  it("preserves empty path", () => {
    expect(encodePathForGithub("")).toBe("");
  });

  it("handles a single-segment path (no slash)", () => {
    expect(encodePathForGithub("README.md")).toBe("README.md");
  });

  it("handles a path with consecutive slashes (degenerate but safe)", () => {
    // `a//b` is a malformed vault path, but if it leaks into the URL
    // the encoder must not invent extra segments or drop the empty one.
    expect(encodePathForGithub("a//b")).toBe("a//b");
  });
});
