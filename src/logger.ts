import { Vault, normalizePath } from "obsidian";

export const LOG_FILE_NAME = "github-sync.log" as const;

// Max serialized size of `data` we'll write per log entry. Anything larger
// is replaced with a small summary (size + preview) so a single chatty
// callsite can't blow the log up to hundreds of MB.
const MAX_DATA_BYTES = 64 * 1024;

export default class Logger {
  private logFile: string;

  constructor(
    private vault: Vault,
    private enabled: boolean,
  ) {
    this.logFile = normalizePath(`${vault.configDir}/${LOG_FILE_NAME}`);
  }

  async init() {
    // Create the log file in case it doesn't exist
    if (await this.vault.adapter.exists(this.logFile)) {
      return;
    }
    this.vault.adapter.write(this.logFile, "");
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

    await this.vault.adapter.append(
      this.logFile,
      JSON.stringify(logEntry) + "\n",
    );
  }

  async read(): Promise<string> {
    return await this.vault.adapter.read(this.logFile);
  }

  async clean(): Promise<void> {
    return await this.vault.adapter.write(this.logFile, "");
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
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
