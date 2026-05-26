// Reverse of conflict-store.ts::buildSiblingPath. Given a sibling vault
// path of the form
//
//   "<dir>/<stem>.conflict-from-<label>-<isoTs>.<ext>"
//
// return the corresponding base path "<dir>/<stem>.<ext>" — or
// "<dir>/<stem>" when the base has no extension or is a dotfile
// (e.g. ".gitignore"). Returns null when the input does not match the
// sibling-naming convention; the caller treats null as "this is not a
// sibling I should reverse".
//
// The regex pattern is identical to conflict-store.ts::unresolvedNameFor,
// anchored on the exact iso shape (YYYY-MM-DDTHH-MM-SSZ) that
// buildSiblingPath produces. The two helpers reverse the same naming
// scheme; they differ only in what they reconstruct: this one returns
// the base path, the other returns the "unresolved-<iso>" rename form
// used at plugin reset.
//
// Used by TrashStore.confirmResolved (layer 1b of R3.5,
// docs/DIFF2_IMPLEMENTATION_PLAN.md §R3.5) to identify sibling-trash
// entries whose base path matches a just-resolved conflict's base path.
export function stripConflictSuffix(siblingPath: string): string | null {
  const slash = siblingPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : siblingPath.slice(0, slash + 1);
  const basename = slash === -1 ? siblingPath : siblingPath.slice(slash + 1);

  const m = basename.match(
    /^(.+?)\.conflict-from-.+-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(\..+)?$/,
  );
  if (!m) return null;

  const [, stem, , ext = ""] = m;
  return `${dir}${stem}${ext}`;
}
