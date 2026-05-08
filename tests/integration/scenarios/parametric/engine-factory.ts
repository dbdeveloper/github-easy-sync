// Engine-agnostic harness for integration scenarios that should pass
// against both the legacy SyncManager and Sync2Manager. The factory
// builds a "do the equivalent thing" closure (push, drain queue,
// commit) so test code can talk in user-level concepts ("sync the
// vault") without naming an engine.
//
// Scope is deliberately narrow: only scenarios where both engines
// have an equivalent flow get parameterised. Legacy-specific cases
// (init-decision modal, ambiguous adoption, resume markers) live in
// their own dedicated test files unchanged.

import { mkdtempSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";
import type { Vault as ObsidianVault } from "obsidian";
import {
  Vault as MockVault,
  recordedNotices,
  clearRecordedNotices,
} from "../../../../mock-obsidian";
import GithubClient from "../../../../src/github/client";
import Logger from "../../../../src/logger";
import GI from "../../../../src/gi";
import SyncManager from "../../../../src/sync-manager";
import { Sync2Manager } from "../../../../src/sync2/sync2-manager";
import SnapshotStore from "../../../../src/sync2/snapshot-store";
import ChangeDetector from "../../../../src/sync2/change-detector";
import PushQueue from "../../../../src/sync2/push-queue";
import TreeBuilder from "../../../../src/sync2/tree-builder";
import GitignoreInvariants from "../../../../src/sync2/gitignore-invariants";
import {
  GitHubSyncSettings,
  DEFAULT_SETTINGS,
} from "../../../../src/settings/settings";
import { requireEnv } from "../../helpers";
import manifest from "../../../../manifest.json";

const SELF_PLUGIN_ID = manifest.id;
const CONFIG_DIR = ".obsidian";

export interface ParametricEngine {
  name: "legacy" | "sync2";
  vault: ObsidianVault;
  vaultPath: string;
  branch: string;
  // Run the engine's "sync everything" entry point. Signals errors
  // by throwing — callers should run inside try/catch only when they
  // want to assert on specific failure shapes.
  syncAll(): Promise<void>;
  cleanup(): void;
}

export interface MakeEngineOpts {
  branch: string;
  vaultPath?: string;
}

function commonSettings(branch: string, env = requireEnv()): GitHubSyncSettings {
  const { token, owner, repo } = env;
  return {
    ...DEFAULT_SETTINGS,
    githubToken: token,
    githubOwner: owner,
    githubRepo: repo,
    githubBranch: branch,
    syncStrategy: "manual",
    syncConfigDir: false,
    enableLogging: false,
    showStatusBarItem: false,
    showSyncRibbonButton: false,
    showConflictsRibbonButton: false,
  };
}

function provisionVault(
  vaultPath?: string,
): { vault: MockVault; vaultPath: string; ownsPath: boolean } {
  const ownsPath = vaultPath === undefined;
  const resolved =
    vaultPath ??
    mkdtempSync(path.join(os.tmpdir(), "github-easy-sync-param-"));
  const vault = new MockVault(resolved);
  return { vault, vaultPath: resolved, ownsPath };
}

export function makeLegacyEngine(opts: MakeEngineOpts): ParametricEngine {
  const { vault, vaultPath, ownsPath } = provisionVault(opts.vaultPath);
  const settings = commonSettings(opts.branch);
  const logger = new Logger(vault as unknown as ObsidianVault, false);
  const syncManager = new SyncManager(
    vault as unknown as ObsidianVault,
    settings,
    async () => {
      throw new Error("legacy onConflicts unexpected in parametric scenario");
    },
    logger,
    async () => {
      throw new Error("legacy onAmbiguous unexpected in parametric scenario");
    },
  );

  return {
    name: "legacy",
    vault: vault as unknown as ObsidianVault,
    vaultPath,
    branch: opts.branch,
    async syncAll() {
      clearRecordedNotices();
      await syncManager.loadMetadata();
      await syncManager.sync();
      const errors = recordedNotices
        .map((n) => n.message)
        .filter((m) => m.startsWith("Error syncing"));
      if (errors.length > 0) {
        throw new Error(`legacy sync error: ${errors.join("; ")}`);
      }
    },
    cleanup() {
      if (!ownsPath) return;
      try {
        rmSync(vaultPath, { recursive: true, force: true });
      } catch {}
    },
  };
}

export function makeSync2Engine(opts: MakeEngineOpts): ParametricEngine {
  const { vault, vaultPath, ownsPath } = provisionVault(opts.vaultPath);
  const settings = commonSettings(opts.branch);
  const logger = new Logger(vault as unknown as ObsidianVault, false);
  const client = new GithubClient(settings, logger);
  const store = new SnapshotStore(vault as unknown as ObsidianVault);
  const gi = new GI(vaultPath);
  const detector = new ChangeDetector({
    vault: vault as unknown as ObsidianVault,
    store,
    gi,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    vaultRoot: vaultPath,
  });
  const queue = new PushQueue({
    vault: vault as unknown as ObsidianVault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
  });
  const builder = new TreeBuilder({
    vault: vault as unknown as ObsidianVault,
    queue,
    client,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
  });
  const invariants = new GitignoreInvariants({
    vault: vault as unknown as ObsidianVault,
    store,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
  });
  const manager = new Sync2Manager({
    vault: vault as unknown as ObsidianVault,
    store,
    detector,
    queue,
    builder,
    client,
    logger,
    invariants,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    commitMessageAll: "Sync2 parametric {date}",
    commitMessageFile: "Update {filename}",
    deviceLabel: "parametric-test",
    onConflict: async (a): Promise<never> => {
      throw new Error(
        `sync2 unexpected conflict in parametric scenario: ${a.path}`,
      );
    },
  });

  let loaded = false;
  return {
    name: "sync2",
    vault: vault as unknown as ObsidianVault,
    vaultPath,
    branch: opts.branch,
    async syncAll() {
      if (!loaded) {
        await store.load();
        loaded = true;
      }
      await manager.syncAll();
    },
    cleanup() {
      if (!ownsPath) return;
      try {
        rmSync(vaultPath, { recursive: true, force: true });
      } catch {}
    },
  };
}

// describe.each() shape for the two engines. Use when a scenario can
// run identically against both.
export const ENGINES: Array<{
  name: "legacy" | "sync2";
  make: (opts: MakeEngineOpts) => ParametricEngine;
}> = [
  { name: "legacy", make: makeLegacyEngine },
  { name: "sync2", make: makeSync2Engine },
];
