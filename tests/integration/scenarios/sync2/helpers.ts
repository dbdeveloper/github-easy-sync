// Sync2 integration helpers. Mirrors the legacy `helpers.ts` shape but
// constructs a Sync2Manager + dependencies instead of legacy SyncManager.
//
// Sync2 has no built-in bootstrap-from-remote; tests typically work
// against a freshly created branch with one well-known initial commit
// (default-branch HEAD), then drive the manager through edits. The
// `bootstrapSync2OnBranch` helper aligns the local snapshot store with
// the branch's current tree before the first syncAll, so the manager
// starts from a sane baseline.

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
import { Sync2Manager } from "../../../../src/sync2/sync2-manager";
import SnapshotStore from "../../../../src/sync2/snapshot-store";
import ChangeDetector from "../../../../src/sync2/change-detector";
import GitignoreInvariants from "../../../../src/sync2/gitignore-invariants";
import PushQueue from "../../../../src/sync2/push-queue";
import TreeBuilder from "../../../../src/sync2/tree-builder";
import ConflictStore from "../../../../src/sync2/conflict-store";
import { ConflictWatcher } from "../../../../src/sync2/conflict-watcher";
import {
  GitHubSyncSettings,
  DEFAULT_SETTINGS,
} from "../../../../src/settings/settings";
import { requireEnv, RepoEnv } from "../../helpers";
import manifest from "../../../../manifest.json";

const SELF_PLUGIN_ID = manifest.id;
const CONFIG_DIR = ".obsidian";

export interface Sync2ClientOpts {
  branch: string;
  env?: RepoEnv;
  vaultPath?: string;
  // When set, overrides the default vault-ownership rule
  // (`true` when vaultPath was auto-created, `false` when caller
  // supplied one). Lets disable/re-enable tests transfer ownership
  // from one client instance to its successor without losing the
  // rm-rf on cleanup. Defaults to `vaultPath === undefined`.
  ownsVaultPath?: boolean;
  accumulateOfflineSyncs?: boolean;
  enableLogging?: boolean;
  // Per-device configDir gate. Defaults to true (matches the
  // production default in settings.ts) so existing tests keep
  // syncing configDir paths the way they did before the toggle
  // landed. I-series tests opt into false explicitly.
  syncConfigDir?: boolean;
  // Default `true` here for back-compat with existing C-series tests
  // that exercise normalization. Production default flipped to false
  // in DEFAULT_SETTINGS to avoid the "convergence push" surprise on
  // first adoption — tests that exercise that surprise (interrupted
  // adoption resume) should pass `autoCanonicalize: true` explicitly.
  autoCanonicalize?: boolean;
}

export interface Sync2TestClient {
  vault: ObsidianVault;
  vaultPath: string;
  manager: Sync2Manager;
  store: SnapshotStore;
  detector: ChangeDetector;
  queue: PushQueue;
  builder: TreeBuilder;
  client: GithubClient;
  logger: Logger;
  // Always present in the integration fixture so tests don't have
  // to wire it up themselves. Stage 6.5 conflict-resolver tests use
  // it directly to assert on pending records / sibling files.
  conflictStore: ConflictStore;
  conflictWatcher: ConflictWatcher;
  branch: string;
  // Live settings reference — same object the detector reads
  // through. I-series tests mutate fields here (e.g. syncConfigDir,
  // deviceLabel) between syncs and the next syncAll picks them up.
  settings: GitHubSyncSettings;
  cleanup(): void;
}

export async function createSync2Client(
  opts: Sync2ClientOpts,
): Promise<Sync2TestClient> {
  const { token, owner, repo } = opts.env ?? requireEnv();
  const ownsVaultPath =
    opts.ownsVaultPath ?? opts.vaultPath === undefined;
  const vaultPath =
    opts.vaultPath ??
    mkdtempSync(path.join(os.tmpdir(), "github-easy-sync-int-"));
  const vault = new MockVault(vaultPath) as unknown as ObsidianVault;

  const settings: GitHubSyncSettings = {
    ...DEFAULT_SETTINGS,
    githubToken: token,
    githubOwner: owner,
    githubRepo: repo,
    githubBranch: opts.branch,
    enableLogging: opts.enableLogging ?? false,
    syncStrategy: "manual",
    showStatusBarItem: false,
    showSyncRibbonButton: false,
    accumulateOfflineSyncs: opts.accumulateOfflineSyncs ?? false,
    syncConfigDir: opts.syncConfigDir ?? true,
  };

  const logger = new Logger(vault, opts.enableLogging ?? false);
  const client = new GithubClient(settings, logger);

  const store = new SnapshotStore(vault);
  await store.load();
  const gi = new GI(vaultPath);
  const queue = new PushQueue({
    vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
  });
  const detector = new ChangeDetector({
    vault,
    store,
    gi,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    vaultRoot: vaultPath,
    syncConfigDir: () => settings.syncConfigDir ?? true,
    queue,
  });
  const builder = new TreeBuilder({
    vault,
    queue,
    client,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
  });
  const invariants = new GitignoreInvariants({
    vault,
    store,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
  });

  const conflictStore = new ConflictStore({
    vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
  });
  await conflictStore.load();
  // Stage 9 ConflictWatcher — opt-in for tests that want to drive
  // real-time vault events. Started by default so drain's pause/
  // resume cycle runs through. Tests that want to disable the
  // real-time watcher can call .stop() before fixturing.
  const conflictWatcher = new ConflictWatcher({
    vault,
    store: conflictStore,
  });
  conflictWatcher.start();

  const manager = new Sync2Manager({
    vault,
    store,
    detector,
    queue,
    builder,
    client,
    logger,
    invariants,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    // Pass through live getters so I-series tests can mutate
    // `settings.deviceLabel` / `settings.commitMessage*` between
    // syncs and the next push picks up the new value.
    commitMessageAll: () => settings.commitMessageAll ?? "Sync2 test {date}",
    commitMessageFile: () => settings.commitMessageFile ?? "Update {filename}",
    deviceLabel: () => settings.deviceLabel ?? "sync2-int-test",
    remoteIdentity: () => ({
      owner: settings.githubOwner,
      repo: settings.githubRepo,
      branch: settings.githubBranch,
    }),
    conflictStore,
    conflictWatcher,
    accumulateOfflineSyncs: opts.accumulateOfflineSyncs ?? false,
    autoCanonicalize: () => opts.autoCanonicalize ?? true,
  });

  return {
    vault,
    vaultPath,
    manager,
    store,
    detector,
    queue,
    builder,
    client,
    logger,
    conflictStore,
    conflictWatcher,
    branch: opts.branch,
    settings,
    cleanup() {
      conflictWatcher.stop();
      if (!ownsVaultPath) return;
      try {
        rmSync(vaultPath, { recursive: true, force: true });
      } catch {}
    },
  };
}

export async function sync2AllAndAssertNoErrors(
  c: Sync2TestClient,
): Promise<void> {
  clearRecordedNotices();
  await c.manager.syncAll();
  const errors = recordedNotices
    .map((n) => n.message)
    .filter((m) => m.toLowerCase().includes("error"));
  if (errors.length > 0) {
    throw new Error(`syncAll errors: ${errors.join("; ")}`);
  }
}

export async function sync2FileAndAssertNoErrors(
  c: Sync2TestClient,
  vaultPath: string,
): Promise<void> {
  clearRecordedNotices();
  await c.manager.syncFile(vaultPath);
  const errors = recordedNotices
    .map((n) => n.message)
    .filter((m) => m.toLowerCase().includes("error"));
  if (errors.length > 0) {
    throw new Error(`syncFile errors: ${errors.join("; ")}`);
  }
}
