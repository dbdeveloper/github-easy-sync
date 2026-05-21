// Originally authored by Silvano Cerza (https://silvanocerza.com).
// Modified by Claude Code under the attentive guidance of Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { Vault, normalizePath } from "obsidian";

// Log file lives at the VAULT ROOT, named `<plugin-id>.log` — the
// plugin id from manifest.json is the canonical machine-readable
// name, so the log filename rides with it (rename the plugin →
// rename the log automatically). Locating the file at the vault
// root lets the user see it in Obsidian's file explorer, open it
// directly, and read it without a clipboard round-trip. *.log is
// in the root .gitignore by default so it doesn't accidentally
// sync to GitHub — power users can drop the rule if they want logs
// to travel between devices (with the obvious caveat that multi-
// device writes will collide on the same filename).
export function logFileNameFor(pluginId: string): string {
  return `${pluginId}.log`;
}

// Max serialized size of `data` we'll write per log entry. Anything larger
// is replaced with a small summary (size + preview) so a single chatty
// callsite can't blow the log up to hundreds of MB.
const MAX_DATA_BYTES = 64 * 1024;

export default class Logger {
  private logFile: string;

  constructor(
    private vault: Vault,
    pluginId: string,
    private enabled: boolean,
  ) {
    this.logFile = normalizePath(logFileNameFor(pluginId));
  }

  // Sync on-disk presence to the `enabled` flag: when enabled, the
  // log file must exist (touch into existence if it doesn't); when
  // disabled, it must NOT exist (delete if a previous session left
  // one behind). Called once at plugin load before any log writes,
  // and again by enable()/disable() when the user flips the toggle.
  async init(): Promise<void> {
    if (this.enabled) {
      await this.ensureFile();
    } else {
      await this.removeFile();
    }
  }

  private async write(
    level: string,
    message: string,
    data?: any,
  ): Promise<void> {
    if (!this.enabled) return;

    let payload = data;
    if (data !== undefined) {
      // Backstop: if a callsite hands us a giant array/object (e.g. the full
      // sync action list or a remote tree), don't faithfully serialize it.
      // The truncated form keeps just enough to debug without ballooning the
      // log file. Targeted summaries at known-large callsites avoid hitting
      // this in normal operation.
      const json = safeStringify(data);
      if (json.length > MAX_DATA_BYTES) {
        payload = {
          __truncated: true,
          serializedSize: json.length,
          preview: json.substring(0, 1024),
        };
      }
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      additional_data: payload,
    };

    // Mirror to console with a tag prefix so `adb logcat | grep gh-sync`
    // (Android) and Safari Web Inspector (iOS) give a real-time view of
    // the same lines that land in the log file. The tag lets users
    // filter the noisy logcat stream down to plugin events.
    const mirror = `[gh-sync] [${level}] ${message}${payload !== undefined ? " " + safeStringify(payload) : ""}`;
    if (level === "ERROR") console.error(mirror);
    else if (level === "WARN") console.warn(mirror);
    else console.log(mirror);

    await this.vault.adapter.append(
      this.logFile,
      JSON.stringify(logEntry) + "\n",
    );
  }

  async read(): Promise<string> {
    return await this.vault.adapter.read(this.logFile);
  }

  // Truncate the log to 0 bytes. Only meaningful while logging is
  // enabled; the settings tab gates the Clean button behind the
  // toggle so this isn't reachable on a disabled logger.
  async clean(): Promise<void> {
    return await this.vault.adapter.write(this.logFile, "");
  }

  async enable(): Promise<void> {
    this.enabled = true;
    await this.ensureFile();
  }

  async disable(): Promise<void> {
    this.enabled = false;
    await this.removeFile();
  }

  // Touch the log file into existence at 0 bytes if it's not
  // already on disk. No-op when the file exists (preserving any
  // accumulated lines).
  private async ensureFile(): Promise<void> {
    if (await this.vault.adapter.exists(this.logFile)) return;
    await this.vault.adapter.write(this.logFile, "");
  }

  // Remove the log file from disk. No-op when the file is already
  // missing (user deleted it manually, previous disable already ran).
  private async removeFile(): Promise<void> {
    if (!(await this.vault.adapter.exists(this.logFile))) return;
    await this.vault.adapter.remove(this.logFile);
  }

  async info(message: string, data?: any): Promise<void> {
    await this.write("INFO", message, data);
  }

  async warn(message: string, data?: any): Promise<void> {
    await this.write("WARN", message, data);
  }

  async error(message: string, data?: any): Promise<void> {
    await this.write("ERROR", message, data);
  }
}

// JSON.stringify throws on circular refs and silently drops Error fields;
// neither is helpful in a logger. This wraps both cases.
function safeStringify(value: unknown): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, v) => {
      if (v instanceof Error) {
        return { name: v.name, message: v.message, stack: v.stack };
      }
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    });
  } catch {
    return String(value);
  }
}
