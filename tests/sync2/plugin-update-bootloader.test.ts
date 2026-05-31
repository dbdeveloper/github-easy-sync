// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";
import { Vault as MockVault } from "../../mock-obsidian";
import {
  runSelfUpdateBootloader,
  extractAffectedPluginId,
} from "../../src/sync2/plugin-update-bootloader";
import { calculateGitBlobSHA } from "../../src/utils";
import type { DataAdapter } from "obsidian";

// Spin up a fresh fs-backed adapter for each test so the file state
// of one case doesn't leak into the next. All bootloader tests
// operate inside `<tmp>/.obsidian/plugins/github-easy-sync/`.
function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "bootloader-test-"));
  const vault = new MockVault(root) as unknown as { adapter: DataAdapter };
  const pluginDir = ".obsidian/plugins/github-easy-sync";
  return {
    root,
    adapter: vault.adapter,
    pluginDir,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function setupPluginDir(
  adapter: DataAdapter,
  pluginDir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const full = `${pluginDir}/${name}`;
    // Ensure parent dir exists. Mock adapter creates as needed when
    // writing through write().
    await adapter.write(full, content);
  }
}

interface CapturedReload {
  count: number;
  delays: number[];
}

function captureReload(): {
  reloadPlugin: () => void;
  scheduleReload: (cb: () => void, delay: number) => void;
  fireDeferred: () => void;
  captured: CapturedReload;
} {
  let pending: (() => void) | null = null;
  const captured: CapturedReload = { count: 0, delays: [] };
  return {
    reloadPlugin: () => {
      captured.count += 1;
    },
    scheduleReload: (cb, delay) => {
      pending = cb;
      captured.delays.push(delay);
    },
    fireDeferred: () => {
      if (pending) {
        const cb = pending;
        pending = null;
        cb();
      }
    },
    captured,
  };
}

describe("runSelfUpdateBootloader — 9-step decision matrix", () => {
  it("Case 1: no main.sync-tmp.js → returns 'no-pending', no reload scheduled", async () => {
    const f = makeFixture();
    try {
      await setupPluginDir(f.adapter, f.pluginDir, {
        "main.js": "old-code",
      });
      const r = captureReload();

      const result = await runSelfUpdateBootloader({
        adapter: f.adapter,
        pluginDir: f.pluginDir,
        computeSha: calculateGitBlobSHA,
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
      });

      expect(result).toEqual({ action: "no-pending" });
      expect(r.captured.count).toBe(0);
      expect(r.captured.delays).toEqual([]);
      // main.js untouched
      expect(await f.adapter.read(`${f.pluginDir}/main.js`)).toBe("old-code");
    } finally {
      f.cleanup();
    }
  });

  it("Case 2: sync-tmp present, SHAs EQUAL, no bak → deletes sync-tmp, no reload", async () => {
    const f = makeFixture();
    try {
      await setupPluginDir(f.adapter, f.pluginDir, {
        "main.js": "new-code",
        "main.sync-tmp.js": "new-code", // SHA matches main.js
      });
      const r = captureReload();

      const result = await runSelfUpdateBootloader({
        adapter: f.adapter,
        pluginDir: f.pluginDir,
        computeSha: calculateGitBlobSHA,
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
      });

      expect(result).toEqual({
        action: "already-applied",
        details: "deleted-sync-tmp",
      });
      expect(r.captured.count).toBe(0);
      expect(
        await f.adapter.exists(`${f.pluginDir}/main.sync-tmp.js`),
      ).toBe(false);
      expect(await f.adapter.read(`${f.pluginDir}/main.js`)).toBe("new-code");
    } finally {
      f.cleanup();
    }
  });

  it("Case 3: SHAs EQUAL but bak ALSO present → still deletes sync-tmp (bak is stale leftover, no special handling needed beyond no-op)", async () => {
    // This case is rare: sync-bak surviving alongside sync-tmp with
    // matching SHA means a prior recovery sweep half-finished but
    // main.js was already up to date. We just delete sync-tmp; the
    // sync-bak is left for the next general recovery pass (or for
    // the user / community-plugin reinstall flow). The 9-step spec
    // doesn't special-case it because the "delete both" only fires
    // when SHAs DIFFER (per step 4). Verify the bootloader follows
    // the spec exactly.
    const f = makeFixture();
    try {
      await setupPluginDir(f.adapter, f.pluginDir, {
        "main.js": "code",
        "main.sync-tmp.js": "code",
        "main.sync-bak.js": "old-backup",
      });
      const r = captureReload();

      const result = await runSelfUpdateBootloader({
        adapter: f.adapter,
        pluginDir: f.pluginDir,
        computeSha: calculateGitBlobSHA,
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
      });

      expect(result).toEqual({
        action: "already-applied",
        details: "deleted-sync-tmp",
      });
      expect(r.captured.count).toBe(0);
      expect(
        await f.adapter.exists(`${f.pluginDir}/main.sync-tmp.js`),
      ).toBe(false);
      // sync-bak left alone in this code path — it's only swept when
      // SHAs differ (the edge-case-from-external-reinstall path).
      expect(
        await f.adapter.exists(`${f.pluginDir}/main.sync-bak.js`),
      ).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("Case 4: SHAs DIFFER, bak ALSO present (external reinstall edge case) → deletes BOTH temp files, no reload", async () => {
    const f = makeFixture();
    try {
      await setupPluginDir(f.adapter, f.pluginDir, {
        "main.js": "fresh-install-from-brat",
        "main.sync-tmp.js": "stale-pending-update",
        "main.sync-bak.js": "what-used-to-be-old",
      });
      const r = captureReload();

      const result = await runSelfUpdateBootloader({
        adapter: f.adapter,
        pluginDir: f.pluginDir,
        computeSha: calculateGitBlobSHA,
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
      });

      expect(result).toEqual({
        action: "stale-recovery",
        details: "deleted-sync-tmp-and-bak",
      });
      expect(r.captured.count).toBe(0);
      expect(
        await f.adapter.exists(`${f.pluginDir}/main.sync-tmp.js`),
      ).toBe(false);
      expect(
        await f.adapter.exists(`${f.pluginDir}/main.sync-bak.js`),
      ).toBe(false);
      // main.js was the fresh install — left untouched
      expect(await f.adapter.read(`${f.pluginDir}/main.js`)).toBe(
        "fresh-install-from-brat",
      );
    } finally {
      f.cleanup();
    }
  });

  it("Case 5: SHAs DIFFER, no bak → applies swap via atomic rename, schedules reload", async () => {
    const f = makeFixture();
    try {
      await setupPluginDir(f.adapter, f.pluginDir, {
        "main.js": "old-code-bytes",
        "main.sync-tmp.js": "new-code-bytes",
      });
      const r = captureReload();
      const notices: string[] = [];

      const result = await runSelfUpdateBootloader({
        adapter: f.adapter,
        pluginDir: f.pluginDir,
        computeSha: calculateGitBlobSHA,
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
        notice: (msg) => notices.push(msg),
      });

      expect(result).toEqual({ action: "applied", via: "atomic-rename" });
      expect(r.captured.delays).toEqual([500]);
      expect(r.captured.count).toBe(0); // not fired yet
      r.fireDeferred();
      expect(r.captured.count).toBe(1);

      expect(await f.adapter.read(`${f.pluginDir}/main.js`)).toBe(
        "new-code-bytes",
      );
      expect(
        await f.adapter.exists(`${f.pluginDir}/main.sync-tmp.js`),
      ).toBe(false);
      expect(
        await f.adapter.exists(`${f.pluginDir}/main.sync-bak.js`),
      ).toBe(false);
      expect(notices.length).toBe(1);
      expect(notices[0]).toContain("reloading");
    } finally {
      f.cleanup();
    }
  });

  it("Case 6: failure during SHA read → returns 'failed', no swap, no reload", async () => {
    const f = makeFixture();
    try {
      // sync-tmp exists per exists() but readBinary throws
      // (simulates a partial/corrupted write).
      await setupPluginDir(f.adapter, f.pluginDir, {
        "main.js": "old",
        "main.sync-tmp.js": "tmp",
      });
      const adapter: DataAdapter = {
        ...f.adapter,
        readBinary: async () => {
          throw new Error("simulated read failure");
        },
      } as DataAdapter;
      const r = captureReload();

      const result = await runSelfUpdateBootloader({
        adapter,
        pluginDir: f.pluginDir,
        computeSha: calculateGitBlobSHA,
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
      });

      expect(result).toEqual({ action: "failed", reason: "sha-read-failed" });
      expect(r.captured.count).toBe(0);
      // Files all untouched — caller continues normal onload.
      expect(
        await f.adapter.exists(`${f.pluginDir}/main.sync-tmp.js`),
      ).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("Case 7: atomic-rename throws → falls back to bak-intermediate path, swap applied", async () => {
    const f = makeFixture();
    try {
      await setupPluginDir(f.adapter, f.pluginDir, {
        "main.js": "old-code",
        "main.sync-tmp.js": "new-code",
      });
      // First rename throws (simulates Capacitor edge case);
      // the fallback path uses two renames + a remove.
      let renameCalls = 0;
      const adapter: DataAdapter = {
        ...f.adapter,
        remove: f.adapter.remove.bind(f.adapter),
        rename: async (src: string, dst: string): Promise<void> => {
          renameCalls += 1;
          if (renameCalls === 1) {
            throw new Error("simulated atomic rename failure");
          }
          // Subsequent renames go through normally
          return f.adapter.rename(src, dst);
        },
        exists: f.adapter.exists.bind(f.adapter),
      } as DataAdapter;
      const r = captureReload();

      const result = await runSelfUpdateBootloader({
        adapter,
        pluginDir: f.pluginDir,
        computeSha: calculateGitBlobSHA,
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
      });

      expect(result).toEqual({ action: "applied", via: "fallback" });
      expect(r.captured.delays).toEqual([500]);
      expect(await f.adapter.read(`${f.pluginDir}/main.js`)).toBe("new-code");
      expect(
        await f.adapter.exists(`${f.pluginDir}/main.sync-tmp.js`),
      ).toBe(false);
      // Fallback path leaves sync-bak removed when remove() succeeds
      expect(
        await f.adapter.exists(`${f.pluginDir}/main.sync-bak.js`),
      ).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("Case 8: BOTH renames fail (atomic AND fallback) → returns 'failed', user must reinstall", async () => {
    const f = makeFixture();
    try {
      await setupPluginDir(f.adapter, f.pluginDir, {
        "main.js": "old-code",
        "main.sync-tmp.js": "new-code",
      });
      const adapter: DataAdapter = {
        ...f.adapter,
        remove: f.adapter.remove.bind(f.adapter),
        rename: async (): Promise<void> => {
          throw new Error("simulated all renames fail");
        },
        exists: f.adapter.exists.bind(f.adapter),
      } as DataAdapter;
      const r = captureReload();

      const result = await runSelfUpdateBootloader({
        adapter,
        pluginDir: f.pluginDir,
        computeSha: calculateGitBlobSHA,
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
      });

      expect(result).toEqual({ action: "failed", reason: "rename-failed" });
      expect(r.captured.count).toBe(0);
      expect(r.captured.delays).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("Case 9: applied swap fires Notice text user can see", async () => {
    const f = makeFixture();
    try {
      await setupPluginDir(f.adapter, f.pluginDir, {
        "main.js": "old",
        "main.sync-tmp.js": "new",
      });
      const r = captureReload();
      const notices: { msg: string; duration?: number }[] = [];

      await runSelfUpdateBootloader({
        adapter: f.adapter,
        pluginDir: f.pluginDir,
        computeSha: calculateGitBlobSHA,
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
        notice: (msg, duration) => notices.push({ msg, duration }),
      });

      expect(notices.length).toBe(1);
      expect(notices[0].msg.toLowerCase()).toContain("plugin");
      expect(notices[0].msg.toLowerCase()).toContain("reload");
      expect(notices[0].duration).toBe(5000);
    } finally {
      f.cleanup();
    }
  });
});

describe("extractAffectedPluginId — plugin file path detection", () => {
  const cfg = ".obsidian";

  it("matches .obsidian/plugins/<id>/main.js → returns id", () => {
    expect(
      extractAffectedPluginId(".obsidian/plugins/some-plugin/main.js", cfg),
    ).toBe("some-plugin");
  });

  it("matches .obsidian/plugins/<id>/manifest.json → returns id", () => {
    expect(
      extractAffectedPluginId(
        ".obsidian/plugins/some-plugin/manifest.json",
        cfg,
      ),
    ).toBe("some-plugin");
  });

  it("matches .obsidian/plugins/<id>/styles.css → returns id", () => {
    expect(
      extractAffectedPluginId(
        ".obsidian/plugins/some-plugin/styles.css",
        cfg,
      ),
    ).toBe("some-plugin");
  });

  it("matches .obsidian/plugins/<id>/data.json → returns id", () => {
    expect(
      extractAffectedPluginId(".obsidian/plugins/some-plugin/data.json", cfg),
    ).toBe("some-plugin");
  });

  it("rejects subdirectory files under plugins/<id>/data/", () => {
    expect(
      extractAffectedPluginId(
        ".obsidian/plugins/some-plugin/data/file.json",
        cfg,
      ),
    ).toBeNull();
  });

  it("rejects unknown top-level files under plugins/<id>/", () => {
    expect(
      extractAffectedPluginId(
        ".obsidian/plugins/some-plugin/somethingelse.txt",
        cfg,
      ),
    ).toBeNull();
  });

  it("rejects paths outside .obsidian/plugins/", () => {
    expect(extractAffectedPluginId("notes/abc.md", cfg)).toBeNull();
    expect(extractAffectedPluginId(".obsidian/themes/x.css", cfg)).toBeNull();
  });

  it("rejects bare .obsidian/plugins/<id>/ with no file", () => {
    expect(
      extractAffectedPluginId(".obsidian/plugins/some-plugin/", cfg),
    ).toBeNull();
    expect(
      extractAffectedPluginId(".obsidian/plugins/some-plugin", cfg),
    ).toBeNull();
  });

  it("respects custom configDir", () => {
    expect(
      extractAffectedPluginId(
        "my-config/plugins/some-plugin/main.js",
        "my-config",
      ),
    ).toBe("some-plugin");
    expect(
      extractAffectedPluginId(
        ".obsidian/plugins/some-plugin/main.js",
        "my-config",
      ),
    ).toBeNull();
  });

  it("handles hyphenated and dotted plugin IDs", () => {
    expect(
      extractAffectedPluginId(
        ".obsidian/plugins/com.example.my-plugin/main.js",
        cfg,
      ),
    ).toBe("com.example.my-plugin");
  });
});
