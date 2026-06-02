// File-type guard for the [Join all] button (R7.9a).
//
// The bulk-resolution logic (resolveAll) moved into DiffPane.resolveAll
// in Stage 1b.1 (it operates on the editor-model structure directly); the
// legacy chunks-list helpers were removed. This module retains the
// markdown path guard used by the detail toolbar.
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.9a ([Join all] md-only safety)

// Markdown-only guard for the [Join all] / [join] button visibility.
// Blockquote-callout semantics make no sense in JSON/YAML/CSS/CSV.
export function isMarkdownPath(vaultPath: string): boolean {
  const lower = vaultPath.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}
