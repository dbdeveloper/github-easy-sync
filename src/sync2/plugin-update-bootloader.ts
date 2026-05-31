// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// 2.0.2-beta2 self-update bootloader. The ONE thing
// `app.plugins.reloadPlugin('github-easy-sync')` can't do for us:
// pick up a `main.js` we updated WHILE WE WERE RUNNING. The bootloader
// runs at the very top of our onload() (before logger, before
// settings init) and handles a pending `main.sync-tmp.js` left by a
// previous sync that updated our plugin's own code.
//
// The 9-step decision tree (mirrors docs/tasks/SYNC2-TODO.md
// "BRAT-style auto-reload" → "Self-update of github-easy-sync"):
//
//   1. Check if `<plugin>/main.sync-tmp.js` exists. If NOT → return
//      false; the caller continues normal onload.
//   2. Read both files; compute git-blob SHA of each.
//   3. SHAs equal → the running code already IS the new version
//      (Obsidian re-enabled us via a fresh load and picked up the
//      new main.js naturally). Delete sync-tmp, return false; the
//      caller continues normal onload.
//   4. SHAs differ AND `main.sync-bak.js` is also present → the
//      user reinstalled mid-recovery via BRAT / Community Plugins
//      so whatever they just installed is the source of truth.
//      Delete BOTH temp files, return false.
//   5. SHAs differ AND no sync-bak → swap is pending. Two paths:
//      a. Atomic rename available (POSIX) — adapter.rename
//         (preceded by a defensive remove of the target so the
//         Capacitor adapter's "destination exists" failure doesn't
//         bite us).
//      b. Atomic rename unavailable → fallback: rename main.js to
//         sync-bak, rename sync-tmp to main.js, remove sync-bak.
//         A crash in the middle of this is the documented "user
//         reinstalls via BRAT / Community Plugins" case.
//   6. Call reloadPlugin via setTimeout(..., 500) — gives the
//      in-flight onload stack frame time to unwind cleanly before
//      Obsidian's plugin manager tears the old instance down.
//   7. Return true; the caller aborts the rest of onload (we'll be
//      re-entered with NEW code in ~500ms).

import type { DataAdapter } from "obsidian";

export interface BootloaderDeps {
  adapter: DataAdapter;
  pluginDir: string; // e.g. ".obsidian/plugins/github-easy-sync"
  computeSha: (bytes: ArrayBuffer) => Promise<string>;
  // Closure that invokes app.plugins.reloadPlugin(<self id>). Wrapped
  // so tests can capture the call without touching Obsidian's
  // internal API and so the bootloader stays platform-agnostic.
  reloadPlugin: () => void;
  // Optional. Surfaces "Plugin updated — reloading…" so the user sees
  // SOMETHING happen before the reload fires.
  notice?: (msg: string, durationMs?: number) => void;
  // Optional. Logger sink for diagnostic lines. Falls back to console
  // in production (logger isn't initialised yet at bootloader time).
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  // Defaults to setTimeout. Tests pass a synchronous shim that
  // captures the scheduled callback.
  scheduleReload?: (cb: () => void, delayMs: number) => void;
}

export type BootloaderResult =
  | { action: "no-pending" }
  | { action: "already-applied"; details: "deleted-sync-tmp" }
  | { action: "stale-recovery"; details: "deleted-sync-tmp-and-bak" }
  | { action: "applied"; via: "atomic-rename" | "fallback" }
  | { action: "failed"; reason: string };

export async function runSelfUpdateBootloader(
  deps: BootloaderDeps,
): Promise<BootloaderResult> {
  const {
    adapter,
    pluginDir,
    computeSha,
    reloadPlugin,
    notice,
    log,
    scheduleReload = (cb, delay) => setTimeout(cb, delay),
  } = deps;
  const mainPath = `${pluginDir}/main.js`;
  const tmpPath = `${pluginDir}/main.sync-tmp.js`;
  const bakPath = `${pluginDir}/main.sync-bak.js`;
  const logFn =
    log ??
    ((msg: string, ctx?: Record<string, unknown>) => {
      try {
        console.log(`[github-easy-sync bootloader] ${msg}`, ctx ?? {});
      } catch {
        // ignore
      }
    });

  // Step 1: no pending update → no-op
  if (!(await adapter.exists(tmpPath))) {
    return { action: "no-pending" };
  }

  // Step 2: compare SHAs
  let mainSha: string;
  let tmpSha: string;
  try {
    const mainBytes = await adapter.readBinary(mainPath);
    const tmpBytes = await adapter.readBinary(tmpPath);
    mainSha = await computeSha(mainBytes);
    tmpSha = await computeSha(tmpBytes);
  } catch (err) {
    logFn("Failed to read main.js / sync-tmp for SHA comparison", {
      err: `${err}`,
    });
    return { action: "failed", reason: "sha-read-failed" };
  }

  // Step 3: already up-to-date (Obsidian re-enabled us with new
  // bytes — sync-tmp is a stale leftover)
  if (mainSha === tmpSha) {
    try {
      await adapter.remove(tmpPath);
    } catch (err) {
      logFn("Failed to remove stale sync-tmp", { err: `${err}` });
    }
    logFn("Self-update bootloader: SHAs equal, removed sync-tmp", {
      sha: mainSha,
    });
    return { action: "already-applied", details: "deleted-sync-tmp" };
  }

  // Step 4: sync-bak ALSO present (user reinstalled mid-recovery
  // via BRAT / Community Plugins). Trust the running install,
  // sweep both temp files away.
  if (await adapter.exists(bakPath)) {
    try {
      await adapter.remove(tmpPath);
    } catch (err) {
      logFn("Failed to remove sync-tmp during stale-recovery sweep", {
        err: `${err}`,
      });
    }
    try {
      await adapter.remove(bakPath);
    } catch (err) {
      logFn("Failed to remove sync-bak during stale-recovery sweep", {
        err: `${err}`,
      });
    }
    logFn(
      "Self-update bootloader: stale sync-tmp + sync-bak from external reinstall, both removed",
    );
    return {
      action: "stale-recovery",
      details: "deleted-sync-tmp-and-bak",
    };
  }

  // Step 5: apply the swap. Try Capacitor-safe pattern first
  // (remove target, then rename) — works on every adapter the
  // plugin supports.
  let via: "atomic-rename" | "fallback";
  try {
    await adapter.remove(mainPath);
    await adapter.rename(tmpPath, mainPath);
    via = "atomic-rename";
  } catch (err) {
    logFn(
      "Atomic-style rename failed, attempting fallback (bak intermediate)",
      { err: `${err}` },
    );
    // Fallback: mv → bak, mv tmp → main, rm bak. If the second
    // rename crashes, the user must reinstall via BRAT / Community
    // Plugins.
    try {
      // If main.js was already removed by the failed first attempt,
      // the rename-to-bak will throw too — accept the crash window
      // and let the documented "reinstall via BRAT" path take over.
      if (await adapter.exists(mainPath)) {
        await adapter.rename(mainPath, bakPath);
      }
      await adapter.rename(tmpPath, mainPath);
      try {
        await adapter.remove(bakPath);
      } catch {
        // bak cleanup is best-effort; recovery sweep will catch it
        // on the next run.
      }
      via = "fallback";
    } catch (fallbackErr) {
      logFn("Self-update bootloader: fallback rename also failed", {
        err: `${fallbackErr}`,
      });
      return { action: "failed", reason: "rename-failed" };
    }
  }

  // Step 6: schedule reload. 500ms lets the onload stack frame
  // unwind before Obsidian's plugin lifecycle tears us down.
  scheduleReload(() => {
    try {
      reloadPlugin();
    } catch (err) {
      logFn("reloadPlugin call failed", { err: `${err}` });
    }
  }, 500);
  notice?.("Plugin updated — reloading…", 5000);
  logFn("Self-update bootloader: swap applied, reload scheduled", {
    via,
  });

  return { action: "applied", via };
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
