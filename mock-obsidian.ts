import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
  appendFileSync,
  promises as fs,
} from "fs";
import * as path from "path";

// Obsidian patches Array.prototype with `.contains()` (an alias for
// `.includes()`). Production source code uses it, so polyfill here so
// the same code runs under Node during unit + integration tests.
// Done idempotently and non-enumerably to avoid surprising for-in
// loops in unrelated test code.
if (!(Array.prototype as unknown as { contains?: unknown }).contains) {
  Object.defineProperty(Array.prototype, "contains", {
    value: function <T>(this: T[], item: T): boolean {
      return this.indexOf(item) !== -1;
    },
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

// Mock Obsidian's Vault class.
//
// Backed by the real filesystem so SyncManager / GitignoreCache /
// MetadataStore / Logger can run end-to-end against a temp directory.
// Used by both unit tests (via vitest alias) and integration tests
// (which point it at an isolated tmpdir per test).
export class Vault {
  configDir: string;
  private rootPath: string;
  private listeners: { event: string; cb: (...args: unknown[]) => void }[] = [];

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.configDir = ".obsidian";

    if (!existsSync(this.rootPath)) {
      mkdirSync(this.rootPath, { recursive: true });
    }

    if (!existsSync(path.join(this.rootPath, this.configDir))) {
      mkdirSync(path.join(this.rootPath, this.configDir), { recursive: true });
    }
  }

  getRoot() {
    // Real Obsidian's TFolder for root has path "" — paths returned by
    // adapter.list are vault-root-relative. Returning the absolute
    // tempdir here would corrupt downstream walks (analyzeLocalState,
    // compareForAdoption, helpers.listVaultFiles) because they push
    // this back into adapter.list and end up with absolute paths that
    // isSyncable then rejects.
    return { path: "" };
  }

  // Stub for the events API the plugin's EventsListener subscribes to.
  // Integration tests don't fire vault events — they drive sync()
  // directly — so we just record the listener for shape compat.
  on(event: string, cb: (...args: unknown[]) => void): EventRef {
    const ref = { event, cb };
    this.listeners.push(ref);
    return ref;
  }

  off(_event: string, _cb: (...args: unknown[]) => void): void {
    // no-op
  }

  get adapter() {
    return {
      read: async (filePath: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        return readFileSync(fullPath, "utf8");
      },

      write: async (filePath: string, data: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        const dir = path.dirname(fullPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(fullPath, data);
      },

      readBinary: async (filePath: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        return readFileSync(fullPath);
      },

      writeBinary: async (filePath: string, data: ArrayBuffer) => {
        const fullPath = path.join(this.rootPath, filePath);
        const dir = path.dirname(fullPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(fullPath, Buffer.from(data));
      },

      append: async (filePath: string, data: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        const dir = path.dirname(fullPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        appendFileSync(fullPath, data);
      },

      exists: async (filePath: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        return existsSync(fullPath);
      },

      mkdir: async (dirPath: string) => {
        const fullPath = path.join(this.rootPath, dirPath);
        if (!existsSync(fullPath)) {
          mkdirSync(fullPath, { recursive: true });
        }
      },

      remove: async (filePath: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        if (existsSync(fullPath)) {
          await fs.unlink(fullPath);
        }
      },

      // Returns an object shaped like Obsidian's Stat. We populate the
      // fields GitignoreCache.fileChanged actually reads (mtime); the
      // others are mostly cosmetic.
      stat: async (filePath: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        if (!existsSync(fullPath)) {
          return null;
        }
        const s = statSync(fullPath);
        return {
          type: s.isDirectory() ? "folder" : "file",
          ctime: s.ctimeMs,
          mtime: s.mtimeMs,
          size: s.size,
        };
      },

      list: async (dirPath: string) => {
        const fullPath = path.join(this.rootPath, dirPath);
        if (!existsSync(fullPath)) {
          return { files: [], folders: [] };
        }

        const entries = await fs.readdir(fullPath, { withFileTypes: true });
        // Match Obsidian's behaviour: paths returned are relative to
        // vault root, with forward slashes regardless of OS.
        const join = (name: string) =>
          dirPath === "" || dirPath === "/"
            ? name
            : `${dirPath.replace(/\\/g, "/")}/${name}`.replace(/^\/+/, "");
        const files = entries
          .filter((entry) => entry.isFile())
          .map((entry) => join(entry.name));
        const folders = entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(entry.name));
        return { files, folders };
      },
    };
  }
}

// Mock Notice
//
// Tests can inspect `recordedNotices` to verify what messages the
// plugin showed. Useful because SyncManager.sync() catches errors and
// surfaces them only via Notice — without capturing, integration
// tests would silently treat failed syncs as successful.
export const recordedNotices: { message: string; timestamp: number }[] = [];

export function clearRecordedNotices(): void {
  recordedNotices.length = 0;
}

export class Notice {
  constructor(message: string, _timeout?: number) {
    recordedNotices.push({ message, timestamp: Date.now() });
    if (process.env.MOCK_OBSIDIAN_NOTICE_LOG === "1") {
      console.log(`NOTICE: ${message}`);
    }
  }

  setMessage(message: string): void {
    recordedNotices.push({ message, timestamp: Date.now() });
  }

  hide() {
    // no-op
  }
}

// Stub TAbstractFile / TFile / TFolder used by EventsListener's
// instanceof checks. Integration tests don't use real Obsidian events
// so these only need to be constructible classes.
export class TAbstractFile {
  path: string;
  constructor(p: string) {
    this.path = p;
  }
}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}

// Plugin stub. main.ts extends the real one; integration tests don't
// instantiate it, but the file is imported transitively, so the symbol
// must exist at least as a class.
export class Plugin {
  app: unknown;
  registerEvent(_ref: EventRef): void {
    // no-op
  }
  registerInterval(_id: number): void {
    // no-op
  }
  addStatusBarItem(): HTMLElement {
    // jsdom is not loaded; return a thin stub.
    return { setText: () => {}, remove: () => {} } as unknown as HTMLElement;
  }
  addRibbonIcon(_icon: string, _title: string, _cb: () => void): HTMLElement {
    return { remove: () => {} } as unknown as HTMLElement;
  }
  addCommand(_cfg: unknown): void {
    // no-op
  }
  addSettingTab(_tab: unknown): void {
    // no-op
  }
  registerView(_type: string, _factory: unknown): void {
    // no-op
  }
}

// PluginSettingTab stub: the settings/tab.ts class extends it.
export class PluginSettingTab {
  app: unknown;
  containerEl: { empty: () => void };
  constructor(app: unknown, _plugin: unknown) {
    this.app = app;
    this.containerEl = { empty: () => {} };
  }
}

export class Setting {
  constructor(_containerEl: unknown) {}
  setName(_n: string) { return this; }
  setDesc(_d: string) { return this; }
  setHeading() { return this; }
  setDisabled(_b: boolean) { return this; }
  addText(_cb: (t: unknown) => void) { return this; }
  addToggle(_cb: (t: unknown) => void) { return this; }
  addDropdown(_cb: (t: unknown) => void) { return this; }
  addButton(_cb: (t: unknown) => void) { return this; }
}

export class Modal {
  app: unknown;
  contentEl: { empty: () => void };
  constructor(app: unknown) {
    this.app = app;
    this.contentEl = { empty: () => {} };
  }
  setTitle(_t: string) {}
  setContent(_c: string) {}
  open() {}
  close() {}
}

interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  contentType?: string;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

// Fault injection for integration tests that need to simulate crashes
// mid-sync (the C-series resume tests). Tests install an injector
// that inspects every requestUrl call; returning an Error causes the
// requestUrl to throw before issuing the network round-trip, which
// surfaces to the SyncManager as a real failure. Because the
// injector intercepts BEFORE fetch, we don't waste API calls.
//
// The injector is global because mock-obsidian itself is loaded
// once per vitest worker, but tests must always reset it in
// afterEach (helpers.installFaultInjector(null)) — otherwise a
// stale injector leaks into subsequent tests.
export interface RequestFaultInjector {
  /**
   * Decide what to do with this request.
   * Return null to pass through to the real fetch; return an Error
   * to throw it instead. callIndex is monotonically increasing
   * across the lifetime of the injector (1-based).
   */
  intercept(
    url: string,
    method: string,
    callIndex: number,
  ): Error | null;
}

let activeInjector: RequestFaultInjector | null = null;
let interceptorCallIndex = 0;

export function installRequestFaultInjector(
  injector: RequestFaultInjector | null,
): void {
  activeInjector = injector;
  interceptorCallIndex = 0;
}

export async function requestUrl(options: RequestUrlParam) {
  // Fault injection hook — runs BEFORE the real fetch so tests can
  // simulate "Obsidian killed mid-sync" without burning API quota.
  // Throwing here propagates up through GithubClient → SyncManager
  // exactly like a network error would.
  if (activeInjector) {
    interceptorCallIndex += 1;
    const err = activeInjector.intercept(
      options.url,
      options.method || "GET",
      interceptorCallIndex,
    );
    if (err) throw err;
  }

  // Mirror Obsidian's requestUrl behaviour: when there's a body and
  // the caller didn't set Content-Type, default to application/json.
  // Without this default, GitHub PUT /contents/{path} returns 404 on
  // bare repos because it can't parse the body to find the `branch`
  // parameter that tells it which branch to create.
  const headers: Record<string, string> = { ...(options.headers || {}) };
  if (
    options.body !== undefined &&
    !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")
  ) {
    headers["Content-Type"] = options.contentType || "application/json";
  }

  const response = await fetch(options.url, {
    method: options.method || "GET",
    headers,
    body: options.body,
  });

  // Always read body into both buffer + text + json (best-effort) so
  // callers can pick whichever shape they need without re-issuing the
  // request. Mirrors Obsidian's requestUrl behaviour.
  const buffer = await response.arrayBuffer();
  const decoder = new TextDecoder("utf-8");
  const text = decoder.decode(buffer);
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON, leave undefined
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    responseHeaders[k] = v;
  });

  return {
    status: response.status,
    headers: responseHeaders,
    arrayBuffer: buffer,
    text,
    json,
  };
}

// Mock utility functions
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64");
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  return Buffer.from(base64, "base64");
}

// Event ref shape for vault.on() — kept intentionally loose so we can
// pass it back in unregister calls without type friction.
export type EventRef = { event: string; cb: (...args: unknown[]) => void };

// Workspace / WorkspaceLeaf stubs — main.ts imports them, but they
// aren't used in integration paths.
export class WorkspaceLeaf {
  view: unknown;
}

export class App {
  vault: Vault;
  workspace: unknown;
  constructor(vault: Vault) {
    this.vault = vault;
    this.workspace = {
      getLeavesOfType: () => [],
      getLeaf: () => new WorkspaceLeaf(),
      revealLeaf: () => {},
      onLayoutReady: (_cb: () => void) => {},
      on: () => ({} as EventRef),
    };
  }
}
