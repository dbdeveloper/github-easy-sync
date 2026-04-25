import { base64ToArrayBuffer } from "obsidian";
import { MANIFEST_FILE_NAME } from "./metadata-store";
import { LOG_FILE_NAME } from "./logger";
import manifest from "../manifest.json";

// Pull our own plugin id straight from manifest.json so any rename of the
// plugin (e.g. a fork) automatically picks up the right path. Used to
// hard-block our own data.json from sync (it carries the GitHub token).
const SELF_PLUGIN_ID = manifest.id;

const TEXT_EXTENSIONS = [
  ".css",
  ".md",
  ".json",
  ".txt",
  ".csv",
  ".js",
  ".log",
] as const;

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
