// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// 2.0.2-beta2 self-update bootloader. The first code that runs at the
// top of our plugin's onload(), before logger, settings, or anything
// else. Recovers a pending self-update for any of:
//
//   - main.js        (running code, atomic-swap target)
//   - manifest.json  (plugin metadata Obsidian reads on enable)
//   - styles.css     (CSS Obsidian re-applies on enable)
//
// data.json is intentionally OUT OF SCOPE: it's per-device state we
// never pull from remote, so it has no recovery to do.
//
// CORRECTNESS NOTE — why marker file, not SHA comparison
// ────────────────────────────────────────────────────────
// The bootloader runs BEFORE the snapshot store loads, so it has no
// "ground truth" SHA to verify a sync-tmp file's integrity against.
// SHA(sync-tmp) computed at startup is just the hash of whatever
// bytes happen to be on disk — if the write was interrupted, those
// bytes are partial and the SHA is meaningless. A previous draft of
// this bootloader compared SHA(file) to SHA(sync-tmp) and applied
// when they differed; that incorrectly applied corrupted bytes when
// sync-tmp was partial.
//
// The fix: a separate marker file `.<basename>.<ext>.sync-tmp.` is
// written by the drain ONLY AFTER the sync-tmp write fully
// completes. The bootloader uses MARKER PRESENCE as the integrity
// signal:
//
//   marker present + sync-tmp present  →  sync-tmp is verified complete,
//                                          apply forward (Case A)
//   marker present + sync-tmp absent   →  swap completed before crash,
//                                          remove orphan marker (Case B)
//   marker absent  + sync-tmp present  →  write was incomplete OR
//                                          marker write never landed;
//                                          drop sync-tmp (Case C).
//                                          Next sync re-pulls.
//   marker absent  + sync-tmp absent   →  nothing pending (Case D)
//
// The marker filename shape `.<basename>.<ext>.sync-tmp.` matches
// the modify-in-place marker convention from PSEUDO-MERGE-MODE
// §19.1. This is intentional: the existing AtomicWriteRecovery.sweep
// (which runs LATER in onload, at initSync2 time) already handles
// markers via its modify-in-place recovery branch. So the sweep
// provides a free defense-in-depth layer — if the bootloader is
// somehow bypassed (e.g., a code bug at the very top of main()
// causes onload to fall through), the sweep catches the same case.

import type { DataAdapter } from "obsidian";

// Files in our plugin's directory the bootloader recovers. Each gets
// the same 4-case marker logic. data.json is excluded — we don't
// sync it from remote, so there's no pending-update concept for it.
const SELF_UPDATE_FILES = ["main.js", "manifest.json", "styles.css"];

export interface BootloaderDeps {
  adapter: DataAdapter;
  pluginDir: string; // e.g. ".obsidian/plugins/github-easy-sync"
  // Closure that invokes app.plugins.reloadPlugin(<self id>). Wrapped
  // so tests can capture the call without touching Obsidian's
  // internal API and so the bootloader stays platform-agnostic.
  reloadPlugin: () => void;
  // Optional. Surfaces "Plugin updated — reloading…" so the user
  // sees SOMETHING happen before the reload fires.
  notice?: (msg: string, durationMs?: number) => void;
  // Optional. Logger sink for diagnostic lines. Falls back to
  // console in production (logger isn't initialised yet at
  // bootloader time).
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  // Defaults to setTimeout. Tests pass a synchronous shim that
  // captures the scheduled callback.
  scheduleReload?: (cb: () => void, delayMs: number) => void;
}

// Per-file recovery outcome. Aggregated into BootloaderResult below.
type FileResult =
  | { kind: "no-pending" }
  | { kind: "cleanup-marker-orphan" }
  | { kind: "drop-orphan-sync-tmp" }
  | { kind: "applied" }
  | { kind: "failed"; reason: string };

export type BootloaderResult =
  | { action: "no-pending" }
  | { action: "applied"; appliedFiles: string[] }
  | { action: "failed"; reason: string; failedFile: string };

// Derives the staging filename for an original. main.js →
// main.sync-tmp.js. manifest.json → manifest.sync-tmp.json.
function stagingNameFor(
  fileName: string,
  suffix: "sync-tmp" | "sync-bak",
): string {
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx <= 0) return `${fileName}.${suffix}`;
  const base = fileName.slice(0, dotIdx);
  const ext = fileName.slice(dotIdx);
  return `${base}.${suffix}${ext}`;
}

// Derives the marker filename: .<basename>.<ext>.sync-tmp.
function markerNameFor(fileName: string): string {
  return `.${fileName}.sync-tmp.`;
}

async function recoverOneFile(
  deps: BootloaderDeps,
  fileName: string,
): Promise<FileResult> {
  const { adapter, pluginDir, log } = deps;
  const finalPath = `${pluginDir}/${fileName}`;
  const tmpPath = `${pluginDir}/${stagingNameFor(fileName, "sync-tmp")}`;
  const markerPath = `${pluginDir}/${markerNameFor(fileName)}`;
  const bakPath = `${pluginDir}/${stagingNameFor(fileName, "sync-bak")}`;

  const markerExists = await adapter.exists(markerPath);
  const tmpExists = await adapter.exists(tmpPath);

  // Case A: marker + sync-tmp → apply forward
  if (markerExists && tmpExists) {
    try {
      if (await adapter.exists(finalPath)) {
        if (await adapter.exists(bakPath)) {
          await adapter.remove(bakPath);
        }
        await adapter.rename(finalPath, bakPath);
      }
      await adapter.rename(tmpPath, finalPath);
      try {
        await adapter.remove(markerPath);
      } catch {
        // best-effort
      }
      try {
        await adapter.remove(bakPath);
      } catch {
        // best-effort
      }
    } catch (err) {
      log?.(`Self-update bootloader: ${fileName} apply failed`, {
        err: `${err}`,
      });
      return { kind: "failed", reason: "apply-failed" };
    }
    log?.(
      `Self-update bootloader: ${fileName} marker + sync-tmp → applied forward`,
    );
    return { kind: "applied" };
  }

  // Case B: marker without sync-tmp → cleanup orphan marker
  if (markerExists && !tmpExists) {
    try {
      await adapter.remove(markerPath);
    } catch (err) {
      log?.(`Failed to remove ${fileName} orphan marker`, {
        err: `${err}`,
      });
    }
    log?.(`Self-update bootloader: ${fileName} marker orphan cleaned`);
    return { kind: "cleanup-marker-orphan" };
  }

  // Case C: sync-tmp without marker → drop
  if (!markerExists && tmpExists) {
    try {
      await adapter.remove(tmpPath);
    } catch (err) {
      log?.(`Failed to drop ${fileName} incomplete sync-tmp`, {
        err: `${err}`,
      });
    }
    log?.(
      `Self-update bootloader: ${fileName} incomplete sync-tmp dropped (no marker)`,
    );
    return { kind: "drop-orphan-sync-tmp" };
  }

  // Case D: nothing pending
  return { kind: "no-pending" };
}

export async function runSelfUpdateBootloader(
  deps: BootloaderDeps,
): Promise<BootloaderResult> {
  const {
    reloadPlugin,
    notice,
    log,
    scheduleReload = (cb, delay) => setTimeout(cb, delay),
  } = deps;
  const logFn =
    log ??
    ((msg: string, ctx?: Record<string, unknown>) => {
      try {
        console.log(`[github-easy-sync bootloader] ${msg}`, ctx ?? {});
      } catch {
        // ignore
      }
    });

  const appliedFiles: string[] = [];
  for (const fileName of SELF_UPDATE_FILES) {
    const r = await recoverOneFile({ ...deps, log: logFn }, fileName);
    if (r.kind === "failed") {
      return {
        action: "failed",
        reason: r.reason,
        failedFile: fileName,
      };
    }
    if (r.kind === "applied") {
      appliedFiles.push(fileName);
    }
    // Cases B/C/D for this file: continue with next file. The
    // changes happened (marker cleared, sync-tmp dropped) but don't
    // require reload by themselves.
  }

  if (appliedFiles.length === 0) {
    return { action: "no-pending" };
  }

  // At least one of (main.js, manifest.json, styles.css) was applied —
  // schedule reloadPlugin. Obsidian re-reads all three on plugin
  // enable, so a single reload picks up any combination of changes.
  scheduleReload(() => {
    try {
      reloadPlugin();
    } catch (err) {
      logFn("reloadPlugin call failed", { err: `${err}` });
    }
  }, 500);
  const msg =
    appliedFiles.length === 1
      ? `Plugin updated (${appliedFiles[0]})`
      : `Plugin updated (${appliedFiles.length} files)`;
  notice?.(msg, 3000);
  logFn("Self-update bootloader: apply complete, reload scheduled", {
    appliedFiles,
  });
  return { action: "applied", appliedFiles };
}

// Helper: parses a path under the vault root and returns the plugin
// ID if and only if the path matches the
// "<configDir>/plugins/<id>/<file>" shape AND <file> is one of the
// files Obsidian re-loads on reloadPlugin (main.js, manifest.json,
// styles.css, data.json). Returns null otherwise. Used by
// Sync2Manager to track which plugin IDs need reloadPlugin after a
// drain.
export function extractAffectedPluginId(
  path: string,
  configDir: string,
): string | null {
  const prefix = `${configDir}/plugins/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const id = rest.slice(0, slash);
  const file = rest.slice(slash + 1);
  // Only top-level plugin files trigger reload; subdirectory files
  // (e.g. a plugin's `data/` folder) do not.
  if (file.includes("/")) return null;
  if (
    file === "main.js" ||
    file === "manifest.json" ||
    file === "styles.css" ||
    file === "data.json"
  ) {
    return id;
  }
  return null;
}

// True iff the given path is one of OUR plugin's files that uses the
// bootloader marker protocol on write. Excludes data.json (per-device
// state, never synced from remote). Used by Sync2Manager to route
// remote-driven writes to `applySelfUpdate*` instead of plain
// atomicWriteFile.
export function isOwnPluginRecoverableFile(
  path: string,
  configDir: string,
  selfPluginId: string,
): boolean {
  const prefix = `${configDir}/plugins/${selfPluginId}/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  if (rest.includes("/")) return false;
  return SELF_UPDATE_FILES.includes(rest);
}
