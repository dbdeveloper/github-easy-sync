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
  onConflict?: (a: {
    path: string;
    ours: string;
    base: string;
    theirs: string;
    conflictMarkedContent: string;
  }) => Promise<
    | { kind: "resolved"; content: string }
    | { kind: "deferred" }
    | { kind: "merged-into-one"; content: string }
  >;
  accumulateOfflineSyncs?: boolean;
  enableLogging?: boolean;
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
  // to wire it up themselves. Etap 6.5 conflict-resolver tests use
  // it directly to assert on pending records / sibling files.
  conflictStore: ConflictStore;
  branch: string;
  settings: GitHubSyncSettings;
  cleanup(): void;
}

export async function createSync2Client(
  opts: Sync2ClientOpts,
): Promise<Sync2TestClient> {
  const { token, owner, repo } = opts.env ?? requireEnv();
  const ownsVaultPath = opts.vaultPath === undefined;
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
    syncConfigDir: false,
    enableLogging: opts.enableLogging ?? false,
    syncStrategy: "manual",
    showStatusBarItem: false,
    showSyncRibbonButton: false,
    showConflictsRibbonButton: false,
    experimentalSync2: true,
    accumulateOfflineSyncs: opts.accumulateOfflineSyncs ?? false,
  };

  const logger = new Logger(vault, opts.enableLogging ?? false);
  const client = new GithubClient(settings, logger);

  const store = new SnapshotStore(vault);
  await store.load();
  const gi = new GI(vaultPath);
  const detector = new ChangeDetector({
    vault,
    store,
    gi,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    vaultRoot: vaultPath,
  });
  const queue = new PushQueue({
    vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
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
    deviceLabel: "sync2-int-test",
  });
  await conflictStore.load();

  const onConflict =
    opts.onConflict ??
    (async (a): Promise<never> => {
      throw new Error(
        `Test 3-way merge conflict on ${a.path} but no resolver provided`,
      );
    });

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
    commitMessageAll: "Sync2 test {date}",
    commitMessageFile: "Update {filename}",
    deviceLabel: "sync2-int-test",
    conflictStore,
    onConflict,
    accumulateOfflineSyncs: opts.accumulateOfflineSyncs ?? false,
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
    branch: opts.branch,
    settings,
    cleanup() {
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
  customMessage?: string,
): Promise<void> {
  clearRecordedNotices();
  await c.manager.syncFile(vaultPath, customMessage);
  const errors = recordedNotices
    .map((n) => n.message)
    .filter((m) => m.toLowerCase().includes("error"));
  if (errors.length > 0) {
    throw new Error(`syncFile errors: ${errors.join("; ")}`);
  }
}
