// "Merge into one" option for the Stage 6.5 conflict resolver — markdown
// only. Folds every conflict-copy under the original via Obsidian-style
// callout blocks, so the result stays valid markdown that renders nicely
// in preview mode and is searchable by "Changing N" / "from <device>".

export interface ConflictCopyForMerge {
  // Raw text of the conflict-copy (sibling) file. Already canonical per
  // Stage 6.6 (LF, no BOM, trailing-NL invariant) — we don't re-normalize
  // here because the caller controls the upstream pipeline.
  content: string;
  // Label of the device that authored this copy (from the metadata in
  // .conflicts/<id>/meta.json).
  deviceLabel: string;
  // Conflict-detection timestamp (ms epoch UTC).
  ts: number;
}

// Build the merged file content. The original goes first, verbatim,
// followed by one Obsidian callout per copy. Each callout looks like:
//
//   > [!info] Changing N — from <device>, <iso-ts-without-ms>
//   > <copy line 1>
//   > <copy line 2>
//   > ...
//
// Why callouts (`> [!info]`):
//   - Obsidian renders them as visually-distinct blocks (foldable).
//   - Inner content stays valid markdown (links/embeds/headers all work).
//   - The leading `>` on every line is a standard blockquote — no
//     `<<<<<<<` markers leak to GitHub if the file gets pushed before
//     the user finishes reconciling.
//   - Searchable by "Changing 1", "Changing 2", or "from <device>".
export function mergeIntoOne(
  originalContent: string,
  copies: ConflictCopyForMerge[],
): string {
  if (copies.length === 0) return originalContent;

  const blocks: string[] = [];
  for (let i = 0; i < copies.length; i++) {
    const copy = copies[i];
    blocks.push(buildCalloutBlock(i + 1, copy));
  }

  // Glue the parts together. Ensure the original ends with a newline
  // (canonicalization invariant says it should already, but be defensive
  // for hand-crafted callers / tests). Add a blank line between the
  // original and the first callout, and between successive callouts.
  let head = originalContent;
  if (head.length > 0 && !head.endsWith("\n")) head += "\n";
  const body = blocks.join("\n\n") + "\n";
  if (head.length === 0) return body;
  return head + "\n" + body;
}

function buildCalloutBlock(
  ordinal: number,
  copy: ConflictCopyForMerge,
): string {
  // ISO-8601 UTC, seconds resolution. Strip the milliseconds so the
  // header stays human-readable; the .conflicts/<id>/meta.json keeps
  // the millisecond-precision ts for any tooling that needs it.
  const iso = new Date(copy.ts).toISOString().replace(/\.\d+/, "");
  const header = `> [!info] Changing ${ordinal} — from ${copy.deviceLabel}, ${iso}`;

  // Prefix every line of the copy with "> ". Empty lines become "> "
  // (with a space) so the blockquote stays unbroken in markdown — a
  // bare ">" works too, but the trailing space keeps line widths
  // consistent in plain-text editors.
  const bodyLines = copy.content.split("\n").map((line) => `> ${line}`);

  // Drop the last empty quote line if the copy ended with a single
  // trailing newline (canonical form): split on "\n" of "abc\n" yields
  // ["abc", ""], which becomes ["> abc", "> "]. The trailing "> " just
  // produces a phantom empty quoted line in preview — collapse it.
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "> ") {
    bodyLines.pop();
  }

  return [header, ...bodyLines].join("\n");
}
