import { base64ToArrayBuffer } from "obsidian";
import { MANIFEST_FILE_NAME } from "./metadata-store";
import { LOG_FILE_NAME } from "./logger";
import manifest from "../manifest.json";

// Pull our own plugin id straight from manifest.json so any rename of the
// plugin (e.g. a fork) automatically picks up the right path. Used to
// hard-block our own data.json from sync (it carries the GitHub token).
const SELF_PLUGIN_ID = manifest.id;

const TEXT_EXTENSIONS = [
  // Notes / docs
  ".md",
  ".txt",
  ".csv",
  ".log",
  // Data / config
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".env",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".npmrc",
  ".eslintrc",
  // Markup
  ".html",
  ".htm",
  ".svg",
  ".xml",
  // Source
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
] as const;

// Matches conflict-backup files we drop next to a winner during atomic
// conflict resolution: `<base>.conflict-(local|remote)-<isoTimestamp>.<ext>`.
// These are local-only diagnostics; they must never be uploaded or moved
// between machines, otherwise they'd multiply on every sync.
const CONFLICT_BACKUP_PATTERN = /\.conflict-(local|remote)-[\dT.\-Z:]+\.[^./]+$/;

// Threshold for "diff is sensible by a human". Files with a known text
// extension but exceeding either of these go through the atomic path —
// dumping a 2 MB minified JSON or a single-line 5 MB CSS bundle into a
// side-by-side diff is useless and crashes the editor anyway.
const MAX_DIFFABLE_BYTES = 2 * 1024 * 1024;
const MAX_DIFFABLE_LINE_LENGTH = 4096;
const SNIFF_SAMPLE_BYTES = 32 * 1024;

// Files that always show up in vaults (esp. on macOS / Windows) but never
// belong in version control. Matched by basename anywhere in the path.
const BLOCKED_BASENAMES = new Set<string>([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
]);

// Directories whose contents are never user-meaningful for an Obsidian vault.
// Matched as any path segment (so `node_modules/foo/bar.js` is blocked, and
// so is `nested/.git/HEAD`).
const BLOCKED_DIR_SEGMENTS = new Set<string>([
  ".git",
  ".idea",
  ".vscode",
  ".trash",
  "node_modules",
]);

// The four canonical files an Obsidian plugin folder should contain. We
// allowlist these explicitly inside <configDir>/plugins/<id>/ so that vaults
// where someone checked their plugin source into the plugin directory don't
// end up uploading node_modules, README, src/, etc.
const PLUGIN_DIR_ALLOWED_FILES = new Set<string>([
  "data.json",
  "main.js",
  "manifest.json",
  "styles.css",
]);

/**
 * Decodes a base64 encoded string, this properly
 * handles emojis and other non ASCII chars.
 *
 * @param s base64 encoded string
 * @returns Decoded string
 */
export function decodeBase64String(s: string): string {
  const buffer = base64ToArrayBuffer(s);
  const decoder = new TextDecoder();
  return decoder.decode(buffer);
}

/**
 * Copies the provided text to the system clipboard.
 * Uses the modern Clipboard API with a fallback to older APIs.
 *
 * @param text The string to be copied to clipboard
 * @returns A promise that resolves when the text has been copied
 */
export async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    // Fallback for devices like iOS that don't support Clipboard API
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);

    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
}

/**
 * Checks if a file path has one of the predefined text extensions.
 * This is a best guess at best.
 *
 * @param filePath The path of the file to check
 * @returns True if the file has a text extension, false otherwise
 */
export function hasTextExtension(filePath: string) {
  for (const extension of TEXT_EXTENSIONS) {
    if (filePath.endsWith(extension)) {
      return true;
    }
  }
  return false;
}

/**
 * Single source of truth for "should this file be part of the sync set?".
 * Used by every place that decides what to track in metadata, what to
 * upload, and what to download. Keeping the rules here (rather than
 * duplicated across the codebase) is what stops new bugs from creeping in
 * each time a new sync path is added.
 *
 * Decision order:
 *   1. The plugin's own manifest is always synced — it's the wire protocol.
 *   2. Our own plugin's data.json is never synced — it carries the GitHub
 *      token, which is per-device by design.
 *   3. The plugin's log file is never synced.
 *   4. Obsidian's per-device workspace state files (workspace.json,
 *      workspace-mobile.json) are never synced; Obsidian explicitly
 *      recommends against it.
 *   5. Junk basenames anywhere in the path (.DS_Store, Thumbs.db, ...)
 *      are never synced.
 *   6. Junk directory segments anywhere in the path (.git, .idea,
 *      node_modules, ...) are never synced.
 *   7. Inside <configDir>/plugins/<id>/: only the four canonical plugin
 *      output files are allowed; subdirectories and other files are
 *      rejected. Plugin folders are still gated on syncConfigDir.
 *   8. Other paths inside <configDir>/ require syncConfigDir to be on.
 *   9. Anything else (regular vault content) is allowed.
 */
export function isSyncable(
  filePath: string,
  configDir: string,
  syncConfigDir: boolean,
): boolean {
  const manifestPath = `${configDir}/${MANIFEST_FILE_NAME}`;
  const logFilePath = `${configDir}/${LOG_FILE_NAME}`;
  const workspacePath = `${configDir}/workspace.json`;
  const workspaceMobilePath = `${configDir}/workspace-mobile.json`;

  // 0. Conflict-backup files dropped during atomic resolution stay local.
  // They are diagnostic copies of the loser side; replicating them through
  // sync would multiply them on every machine.
  if (CONFLICT_BACKUP_PATTERN.test(filePath)) return false;

  // 1. Manifest always syncs, regardless of any other rule.
  if (filePath === manifestPath) return true;

  // 2. Our own plugin's data.json never syncs — it stores the GitHub token,
  // which is per-device by design (each machine should use its own
  // fine-grained token with minimal permissions). Replicating it across
  // vaults via this very sync mechanism would defeat the security model:
  // one compromised pull would leak every machine's credentials.
  if (
    filePath ===
    `${configDir}/plugins/${SELF_PLUGIN_ID}/data.json`
  ) {
    return false;
  }

  // 3-4. Other hard exclusions inside configDir.
  if (filePath === logFilePath) return false;
  if (filePath === workspacePath) return false;
  if (filePath === workspaceMobilePath) return false;

  const segments = filePath.split("/");
  const basename = segments[segments.length - 1];

  // 4. Junk basenames anywhere.
  if (BLOCKED_BASENAMES.has(basename)) return false;

  // 5. Junk directory segments. Only check non-leaf segments — the basename
  // (last segment) is handled above. configDir itself starts with "." but
  // is not in the blocked set, so it passes through.
  for (let i = 0; i < segments.length - 1; i++) {
    if (BLOCKED_DIR_SEGMENTS.has(segments[i])) return false;
  }

  // 6. Plugin folder allowlist.
  const pluginsPrefix = `${configDir}/plugins/`;
  if (filePath.startsWith(pluginsPrefix)) {
    if (!syncConfigDir) return false;
    const rel = filePath.substring(pluginsPrefix.length).split("/");
    // Must be exactly <plugin-id>/<file> — anything deeper is rejected.
    if (rel.length !== 2) return false;
    return PLUGIN_DIR_ALLOWED_FILES.has(rel[1]);
  }

  // 7. Other configDir paths follow the user toggle.
  if (filePath.startsWith(`${configDir}/`)) {
    return syncConfigDir;
  }

  // 8. Everything else (vault root files, regular content folders).
  return true;
}

export type ConflictCategory = "plugin-js" | "binary" | "text";

/**
 * Quick heuristic for "would a side-by-side diff be sensible to a human?".
 * Used as a tie-breaker for files that have a text extension but might still
 * be unreadable in a diff (minified single-line bundles, generated CSS, huge
 * JSON dumps). The check looks at file size and the longest line in a 32 KB
 * sample — both cheap, both reliable for practical Obsidian content.
 */
export function isMergeFriendlyText(content: ArrayBuffer): boolean {
  if (content.byteLength > MAX_DIFFABLE_BYTES) return false;
  const sliceLen = Math.min(content.byteLength, SNIFF_SAMPLE_BYTES);
  const view = new Uint8Array(content, 0, sliceLen);
  // Null bytes effectively mean "not text". Scan the sample first — early
  // exit is fast for misnamed binaries.
  for (let i = 0; i < view.length; i++) {
    if (view[i] === 0) return false;
  }
  const sample = new TextDecoder("utf-8", { fatal: false }).decode(view);
  let maxLine = 0;
  let current = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 10) {
      if (current > maxLine) maxLine = current;
      current = 0;
    } else {
      current++;
    }
  }
  if (current > maxLine) maxLine = current;
  return maxLine <= MAX_DIFFABLE_LINE_LENGTH;
}

/**
 * Categorize a file for conflict resolution.
 *   - "plugin-js": .js inside <configDir>/plugins/<id>/. Always atomic;
 *     resolved by manifest version → timestamp → local-wins.
 *   - "binary": no text extension OR text extension but content is not
 *     diff-friendly (too big, lines too long, has null bytes). Resolved
 *     by timestamp → local-wins.
 *   - "text": text extension and merge-friendly content. Goes through
 *     the usual conflict UI for manual merge.
 *
 * `localBuffer` is optional: pass it if you've already loaded the file
 * (e.g. when computing its SHA) to enable the merge-friendliness check.
 * Without it, classification falls back to extension only.
 */
export function classifyForConflict(
  filePath: string,
  configDir: string,
  localBuffer?: ArrayBuffer | null,
): ConflictCategory {
  const pluginsPrefix = `${configDir}/plugins/`;
  if (filePath.startsWith(pluginsPrefix) && filePath.endsWith(".js")) {
    return "plugin-js";
  }
  if (!hasTextExtension(filePath)) {
    return "binary";
  }
  if (localBuffer && !isMergeFriendlyText(localBuffer)) {
    return "binary";
  }
  return "text";
}

/**
 * Returns the plugin id (folder name) for a path inside a plugin directory,
 * or null if the path isn't shaped like <configDir>/plugins/<id>/<file...>.
 */
export function pluginIdFromPath(
  filePath: string,
  configDir: string,
): string | null {
  const prefix = `${configDir}/plugins/`;
  if (!filePath.startsWith(prefix)) return null;
  const rest = filePath.substring(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return rest.substring(0, slash);
}

/**
 * Compare two semver-ish strings. Returns -1 / 0 / +1 the same way
 * Array.prototype.sort comparators do. Handles the common X.Y.Z form;
 * pre-release suffixes (e.g. "-beta") are stripped before comparison so
 * "1.0.7-beta" and "1.0.7" compare as equal — a coarse but acceptable
 * approximation for plugin version compare in conflict resolution.
 */
export function compareSemver(a: string, b: string): number {
  const numericPart = (s: string) => s.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pa = numericPart(a);
  const pb = numericPart(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/**
 * Build a path next to `filePath` that holds the loser side of an atomic
 * conflict. Filename pattern matches CONFLICT_BACKUP_PATTERN so isSyncable
 * keeps the backup local-only. The timestamp uses ":" replaced by "-" so
 * the path is portable across filesystems.
 */
export function conflictBackupPath(
  filePath: string,
  loserSide: "local" | "remote",
  when: Date = new Date(),
): string {
  const dot = filePath.lastIndexOf(".");
  const slash = filePath.lastIndexOf("/");
  // "ext" only counts as an extension if the dot is in the basename.
  const hasExt = dot > slash;
  const base = hasExt ? filePath.substring(0, dot) : filePath;
  const ext = hasExt ? filePath.substring(dot) : "";
  const stamp = when.toISOString().replace(/:/g, "-");
  return `${base}.conflict-${loserSide}-${stamp}${ext}`;
}

/**
 * Retries an async function until its return value satisfies a condition or max retries is reached.
 * Uses exponential backoff between retry attempts.
 *
 * @param fn - The async function to execute and potentially retry
 * @param condition - Function that evaluates if the result is acceptable
 * @param maxRetries - Maximum number of retry attempts (default: 5)
 * @param initialDelay - Initial delay in ms before first retry (default: 1000)
 * @param backoffFactor - Multiplicative factor for delay between retries (default: 2)
 * @returns The result of the function execution
 */
export async function retryUntil<T>(
  fn: () => Promise<T>,
  condition: (result: T) => boolean,
  maxRetries: number = 5,
  initialDelay: number = 1000,
  backoffFactor: number = 2,
): Promise<T> {
  let retries = 0;
  let delay = initialDelay;

  while (true) {
    const result = await fn();

    if (condition(result) || retries >= maxRetries) {
      return result;
    }

    retries++;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay *= backoffFactor;
  }
}
