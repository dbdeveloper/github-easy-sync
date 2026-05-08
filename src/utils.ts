import { base64ToArrayBuffer } from "obsidian";
import { MANIFEST_FILE_NAME } from "./metadata-store";
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

// Threshold for "diff is sensible by a human". Files with a known text
// extension but exceeding either of these go through the atomic path —
// dumping a 2 MB minified JSON or a single-line 5 MB CSS bundle into a
// side-by-side diff is useless and crashes the editor anyway.
const MAX_DIFFABLE_BYTES = 2 * 1024 * 1024;
const MAX_DIFFABLE_LINE_LENGTH = 4096;
const SNIFF_SAMPLE_BYTES = 32 * 1024;

/**
 * Decodes a base64 encoded string, this properly
 * handles emojis and other non ASCII chars.
 *
 * @param s base64 encoded string
 * @returns Decoded string
 */
export function decodeBase64String(s: string): string {
  const buffer = base64ToArrayBuffer(s);
  // ignoreBOM: keep U+FEFF at index 0 if present so callers (sync2's
  // text-canonicalisation pipeline) can detect and strip it. The
  // platform default eats BOM during decode, hiding "remote has BOM"
  // from us — we'd then save canonical bytes locally but fail to
  // republish to GitHub, leaving the server stuck on the BOM-laden
  // version forever.
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
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
 * The hardcoded portion is intentionally tiny — only things that absolutely
 * must not be overridable through a user-edited gitignore. Everything else
 * (workspace state, junk basenames, plugin folder allowlist, log files,
 * conflict backups, …) is expressed as gitignore patterns either in the
 * canonical invariant block (immutable) or in seeded defaults (user-
 * editable). See gitignore-cache.ts.
 *
 * Decision order:
 *   1. Manifest path — always allowed (immune to all gitignore patterns).
 *   2. Our own plugin's data.json — never (security backstop for the
 *      GitHub token, in addition to the strict per-plugin .gitignore).
 *   3. Anything inside a `.git` directory at any depth — never (git
 *      internals: refs, packed objects, hook scripts, possibly
 *      credentials). Hardcoded so even a deleted root .gitignore can't
 *      accidentally let .git/ leak to the remote.
 *   4. Combined gitignore matcher (root + configDir + self plugin) —
 *      reject if the path matches an ignore pattern.
 *   5. configDir gating — paths inside <configDir>/ require syncConfigDir.
 *   6. Otherwise allowed.
 *
 * The matcher argument is optional so any code path that legitimately
 * predates cache initialization can still call isSyncable — those callers
 * just skip rule 4.
 */
export function isSyncable(
  filePath: string,
  configDir: string,
  syncConfigDir: boolean,
  gitignoreMatcher?: { isIgnored(path: string): boolean },
): boolean {
  const manifestPath = `${configDir}/${MANIFEST_FILE_NAME}`;

  // 1. Manifest always syncs.
  if (filePath === manifestPath) return true;

  // 2. Our own data.json carries the GitHub token. The strict per-plugin
  // .gitignore covers this through `* / !main.js / !manifest.json /
  // !styles.css`, but we keep a code-level backstop in case the strict
  // file is missing or its rules haven't been refreshed yet.
  if (filePath === `${configDir}/plugins/${SELF_PLUGIN_ID}/data.json`) {
    return false;
  }

  // 3. Never sync anything under a `.git` directory at any depth. This
  // protects vaults that double as git working copies (e.g. users still
  // running obsidian-git side-by-side, or who init'd git in vault root
  // for backup): we'd otherwise try to push refs, packed objects and
  // possibly credentials. Note: `.gitignore` and `.gitattributes` are
  // single files at vault/configDir root, not under a `.git` directory,
  // so they pass through this rule.
  if (filePath.split("/").includes(".git")) return false;

  // 4. Defer to user-managed gitignore rules.
  if (gitignoreMatcher && gitignoreMatcher.isIgnored(filePath)) {
    return false;
  }

  // 5. configDir gating.
  if (filePath.startsWith(`${configDir}/`)) {
    return syncConfigDir;
  }

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
 * Compute the same SHA-1 git would for a blob with this content. Used to
 * compare local files against remote tree SHAs without uploading anything.
 */
export async function calculateGitBlobSHA(content: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(content);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const store = new Uint8Array(header.length + bytes.length);
  store.set(header, 0);
  store.set(bytes, header.length);
  const hash = await crypto.subtle.digest("SHA-1", store);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Decide whether an HTTP status from a GitHub API call is worth retrying.
 *
 * What we retry:
 *   - 422 — non-fast-forward updateBranchHead and a handful of other
 *     "conflict" responses GitHub uses when the underlying state moved
 *     under us. Original retry-on-422 behavior.
 *   - 429 — rate limit. GitHub's secondary rate limits in particular
 *     ask for a backoff; retryUntil's exponential delay matches.
 *   - 5xx — server errors. Transient by nature; safe to retry.
 *
 * What we deliberately DON'T retry: 401 (bad token), 403 (permission
 * or abuse-detection), 404 (wrong repo / branch), and any other 4xx.
 * Those are configuration / authentication problems where retrying
 * just delays the inevitable error notice.
 */
export function isRetriableStatus(status: number): boolean {
  if (status === 422 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
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
