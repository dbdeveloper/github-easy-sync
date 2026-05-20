// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { hasTextExtension } from "../utils";
import {
  isAtomicPluginFile,
  compareSemver,
} from "./plugin-js";
import { mergeText } from "./three-way-merge";
import { ConflictKind } from "./conflict-store";

// Pseudo-merge conflict-detection helpers (PSEUDO-MERGE-MODE.md,
// stage 5b).
//
// Pure functions. No vault/network I/O. Stage 5b ships them with
// dedicated unit tests; stage 5c wires them into
// applyRemoteAddOrModify + reconcileBatchAgainstHead.

// ── classifyConflictKind ──────────────────────────────────────────────

// Per-side state at the conflict point. "modified" covers both
// add-and-edit; "deleted" means the side wants the file gone.
export type Side = "modified" | "deleted";

// Map (oursSide, theirsSide) → ConflictKind, or null when the pair
// is not a real conflict (delete-vs-delete: both sides agree).
export function classifyConflictKind(
  oursSide: Side,
  theirsSide: Side,
): ConflictKind | null {
  if (oursSide === "modified" && theirsSide === "modified") {
    return "modify-vs-modify";
  }
  if (oursSide === "deleted" && theirsSide === "modified") {
    return "delete-vs-modify";
  }
  if (oursSide === "modified" && theirsSide === "deleted") {
    return "modify-vs-delete";
  }
  return null;
}

// ── attemptAutoMerge ──────────────────────────────────────────────────

// Outcome of the auto-merge gate. Caller acts on each variant:
//   - "clean": push merged content to main as if nothing happened
//   - "atomic": push the winning side's existing content
//   - "register-conflict": call ConflictStore.create(kind:
//     "modify-vs-modify", ...) and write a sibling
export type AutoMergeResult =
  | { type: "clean"; content: ArrayBuffer }
  | { type: "atomic"; side: "ours" | "theirs" }
  | { type: "register-conflict" };

// Plugin-js context — caller pre-reads the matching manifest.json on
// each side and extracts (version, mtime) before invoking
// attemptAutoMerge. We don't read disk here. `null` version means the
// manifest was missing or malformed; the resolver falls back to mtime.
export interface PluginJsContext {
  oursVersion: string | null;
  theirsVersion: string | null;
  oursMtime: number;
  theirsMtime: number;
}

export interface AttemptAutoMergeArgs {
  path: string;
  ours: ArrayBuffer;
  theirs: ArrayBuffer;
  // Last-common-ancestor bytes for 3-way merge. `null` when no shared
  // ancestor exists (e.g., file added independently on both sides);
  // in that case text auto-merge bails to register-conflict.
  base: ArrayBuffer | null;
  configDir: string;
  // Required when isAtomicPluginFile(path, configDir) — otherwise the
  // plugin-js branch can only register-conflict.
  pluginJs?: PluginJsContext;
}

// Auto-merge gate. Modify-vs-modify only — caller (classifyConflict-
// Kind first) is responsible for short-circuiting delete-vs-modify
// and modify-vs-delete kinds before reaching here.
//
// Strategy dispatch by path:
//   - isAtomicPluginFile  → plugin-js semver, mtime tie-break
//   - hasTextExtension    → 3-way merge via mergeText
//   - else (binary)       → register-conflict unconditionally
//                           (2.0.0-beta's silent atomic-mtime is gone)
export function attemptAutoMerge(args: AttemptAutoMergeArgs): AutoMergeResult {
  if (isAtomicPluginFile(args.path, args.configDir)) {
    return resolvePluginJs(args.pluginJs);
  }
  if (hasTextExtension(args.path)) {
    return tryTextMerge(args.ours, args.theirs, args.base);
  }
  return { type: "register-conflict" };
}

// ── internals ────────────────────────────────────────────────────────

function resolvePluginJs(ctx?: PluginJsContext): AutoMergeResult {
  if (!ctx) return { type: "register-conflict" };
  const { oursVersion, theirsVersion, oursMtime, theirsMtime } = ctx;

  // Both manifests parsed — compare semver first.
  if (oursVersion !== null && theirsVersion !== null) {
    const cmp = compareSemver(oursVersion, theirsVersion);
    if (cmp > 0) return { type: "atomic", side: "ours" };
    if (cmp < 0) return { type: "atomic", side: "theirs" };
    // Semver tie — fall through to mtime.
  } else if (oursVersion !== null) {
    // One side has a parseable version, the other doesn't — trust the
    // parseable side (the unparseable one is either missing or
    // borked).
    return { type: "atomic", side: "ours" };
  } else if (theirsVersion !== null) {
    return { type: "atomic", side: "theirs" };
  }

  // Mtime tiebreak (also covers "both sides unparseable").
  if (oursMtime > theirsMtime) return { type: "atomic", side: "ours" };
  if (theirsMtime > oursMtime) return { type: "atomic", side: "theirs" };

  // Versions tied AND mtimes tied → real conflict the user must look
  // at (spec R5: "plugin-js identical version and identical mtime →
  // register as conflict").
  return { type: "register-conflict" };
}

function tryTextMerge(
  ours: ArrayBuffer,
  theirs: ArrayBuffer,
  base: ArrayBuffer | null,
): AutoMergeResult {
  // 3-way merge needs a shared base. "Added on both sides
  // independently" has no base — register as a conflict and let the
  // user see both versions side-by-side.
  if (base === null) return { type: "register-conflict" };
  const decoder = new TextDecoder();
  const oursText = decoder.decode(ours);
  const theirsText = decoder.decode(theirs);
  const baseText = decoder.decode(base);
  const result = mergeText(oursText, baseText, theirsText);
  if (result.kind === "clean") {
    const encoded = new TextEncoder().encode(result.content);
    return {
      type: "clean",
      content: encoded.buffer.slice(
        encoded.byteOffset,
        encoded.byteOffset + encoded.byteLength,
      ) as ArrayBuffer,
    };
  }
  return { type: "register-conflict" };
}
