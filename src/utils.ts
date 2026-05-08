import { base64ToArrayBuffer } from "obsidian";

// Sync2-only utility functions surviving the Etap 7 cutover. Legacy
// helpers (isSyncable, classifyForConflict, compareSemver, …) lived
// here pre-cutover; the new engine doesn't need them.

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

/**
 * Decode a base64 string into JS text. ignoreBOM keeps a leading
 * U+FEFF in the output so sync2's text-canonicalisation pipeline
 * can detect and strip it; the platform default eats it silently
 * which would mask "remote has BOM" from the republish trigger.
 */
export function decodeBase64String(s: string): string {
  const buffer = base64ToArrayBuffer(s);
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  return decoder.decode(buffer);
}

/**
 * Copies the provided text to the system clipboard. Modern Clipboard
 * API with a textarea+execCommand fallback for older mobile webviews.
 */
export async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
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
 * Best-guess "is this a text file?" check used by sync2 to decide
 * between inline-content tree entries and createBlob upload paths.
 */
export function hasTextExtension(filePath: string): boolean {
  for (const extension of TEXT_EXTENSIONS) {
    if (filePath.endsWith(extension)) return true;
  }
  return false;
}

/**
 * Compute the same SHA-1 git would for a blob with this content.
 * Used to compare local files against remote tree SHAs without
 * uploading anything.
 */
export async function calculateGitBlobSHA(
  content: ArrayBuffer,
): Promise<string> {
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
 *  Retry: 422 (state-conflict), 429 (rate limit), 5xx (transient server).
 *  Don't retry: 401 (bad token), 403 (permission / abuse), 404 (wrong
 *  repo / branch), other 4xx — configuration / auth problems where
 *  retrying just delays the inevitable error notice.
 */
export function isRetriableStatus(status: number): boolean {
  if (status === 422 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

/**
 * Retry an async function with exponential backoff until its result
 * passes a condition or maxRetries is reached.
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
    if (condition(result) || retries >= maxRetries) return result;
    retries++;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay *= backoffFactor;
  }
}
