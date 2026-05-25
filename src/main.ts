// Originally authored by Silvano Cerza (https://silvanocerza.com).
// Modified by Claude Code under the attentive guidance of Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import {
  EventRef,
  MarkdownView,
  Plugin,
  WorkspaceLeaf,
  Notice,
} from "obsidian";
import { GitHubSyncSettings, DEFAULT_SETTINGS } from "./settings/settings";
import GitHubSyncSettingsTab from "./settings/tab";
import Logger from "./logger";
import { describeError } from "./utils";
import GithubClient from "./github/client";
import GI from "./gi";
import SnapshotStore from "./sync2/snapshot-store";
import { AtomicWriteRecovery } from "./sync2/atomic-write";
import ChangeDetector from "./sync2/change-detector";
import PushQueue from "./sync2/push-queue";
import TreeBuilder from "./sync2/tree-builder";
import GitignoreInvariants from "./sync2/gitignore-invariants";
import { Sync2Manager } from "./sync2/sync2-manager";
import { IntervalScheduler } from "./sync2/interval-scheduler";
import ConflictStore from "./sync2/conflict-store";
import PendingDeletionsStore from "./sync2/pending-deletions-store";
import { ConflictCounter } from "./sync2/conflict-counter";
import { ConflictWatcher } from "./sync2/conflict-watcher";
import { ConflictStatusIndicator } from "./sync2/views/conflict-status-indicator";
import { PreSyncConflictModal } from "./sync2/views/pre-sync-conflict-modal";
import manifest from "../manifest.json";

// How long the brief local-phase notices stay visible. 700ms is the
// sweet spot — long enough to read "Commit 3 files" without rushing,
// short enough that consecutive Sync clicks don't stack notices.
const BRIEF_NOTICE_MS = 700;

// Plugin entry point. Orchestrates Sync2Manager + ConflictStore;
// commands, ribbons, settings tab, and IntervalScheduler wiring live
// here.
export default class GitHubSyncPlugin extends Plugin {
  settings: GitHubSyncSettings;
  // Sync2Manager + ConflictStore are constructed once during onload
  // and live for the plugin's lifetime. No more nullable engine
  // pointers — the runtime is single-engine.
  sync2Manager!: Sync2Manager;
  conflictStore!: ConflictStore;
  pendingDeletions!: PendingDeletionsStore;
  conflictWatcher!: ConflictWatcher;
  conflictCounter!: ConflictCounter;
  logger!: Logger;
  // Exposed for the settings tab's "Push plugins data.json" toggle,
  // which reads/writes the allow line directly via this owner.
  invariants!: GitignoreInvariants;
  // Cached value of the toggle for synchronous use in the settings
  // tab. Refreshed at onload from invariants.getPushPluginsDataJson()
  // and after every successful set from the tab's onChange. Settings
  // tab must NOT call toggle.setValue() from an async context — for
  // reasons we don't fully understand, doing so triggers an infinite
  // re-entry inside Obsidian's settings pipeline and freezes the
  // renderer. Synchronous read of this cache sidesteps the issue.
  pushPluginsDataJsonCached: boolean = false;

  // UI elements that come and go with toggle settings.
  statusBarItem: HTMLElement | null = null;
  syncRibbonIcon: HTMLElement | null = null;
  // Pseudo-merge stage 10 — 4-point visibility for pending conflicts.
  // Status-bar indicator and ribbon-icon badge are created when the
  // user's settings turn the corresponding bar/ribbon on.
  conflictStatusIndicator: ConflictStatusIndicator | null = null;
  // PSEUDO-MERGE-MODE §12.3: the ribbon sync-icon's badge now shows
  // push-queue depth (count of pending batches in .push-queue/),
  // not the unresolved-conflict count. Fed by Sync2Manager's
  // onQueueDepthChanged callback.
  ribbonPendingBatchesBadge: HTMLElement | null = null;

  // Vault listeners — sibling-file delete/rename closes the matching
  // conflict record. Refs kept so we can offref them on unload.
  vaultDeleteListener: EventRef | null = null;
  vaultRenameListener: EventRef | null = null;

  // Auto-sync timer id (Window.setInterval handle). Retained for the
  // registerInterval() bookkeeping Obsidian wants on unload; the
  // tick + startup logic itself lives in IntervalScheduler.
  private syncIntervalId: number | null = null;
  private intervalScheduler!: IntervalScheduler;

  async onUserEnable(): Promise<void> {
    if (!this.isConfigured()) {
      new Notice("Go to settings to configure syncing");
    }
  }

  async onload(): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.loadSettings();
      this.logger = new Logger(
        this.app.vault,
        manifest.id,
        this.settings.enableLogging,
      );
      await this.logger.init();
      this.logger.info("Plugin onload start", {
        version: manifest.version,
        deviceLabel: this.settings.deviceLabel,
        enableLogging: this.settings.enableLogging,
        syncStrategy: this.settings.syncStrategy,
        configured: this.isConfigured(),
      });

      this.addSettingTab(new GitHubSyncSettingsTab(this.app, this));
      this.logger.info("Plugin onload: settings tab registered");

      await this.initSync2();
      this.logger.info("Plugin onload: initSync2 done");

      // Always start the timer: when interval is enabled, it runs at the
      // user's configured cadence and ticks pull + drain; when disabled
      // it's a 5-min watchdog that only drains pending batches (so a
      // failed earlier drain gets retried automatically).
      this.startSyncInterval();
      this.logger.info("Plugin onload: interval scheduler started");

      this.app.workspace.onLayoutReady(() => {
        if (this.settings.showStatusBarItem) this.showStatusBarItem();
        if (this.settings.showSyncRibbonButton) this.showSyncRibbonIcon();
        if (this.settings.syncOnStartup && this.isConfigured()) {
          void this.runStartupSync();
        }
      });

      this.addCommand({
        id: "sync-files",
        name: "Sync with GitHub",
        icon: "refresh-cw",
        callback: this.sync.bind(this),
      });
      this.addCommand({
        id: "sync-current-file",
        name: "Sync current file with GitHub",
        icon: "file-up",
        callback: this.syncCurrentFile.bind(this),
      });

      this.logger.info(
        `Plugin onload complete (duration=${Date.now() - startedAt}ms)`,
      );
    } catch (err) {
      // Best-effort crash log. Writes to a fixed-name file at the
      // vault root so a Mac/Android user can grab it via adb / Files
      // even when the plugin failed before Logger was ready. Always
      // attempts logger.error first (works if we got past
      // logger.init); falls back to direct adapter.write otherwise.
      const stack = (err as Error)?.stack ?? "";
      const message = `Plugin onload FAILED: ${err}`;
      console.error(message, err);
      try {
        if (this.logger) {
          this.logger.error(message, { stack });
        }
      } catch {}
      try {
        await this.app.vault.adapter.append(
          `${manifest.id}-crash.log`,
          `[${new Date().toISOString()}] ${message}\n${stack}\n\n`,
        );
      } catch {}
      try {
        new Notice(`${manifest.id} failed to start: ${err}`, 30000);
      } catch {}
      throw err;
    }
  }

  async onunload(): Promise<void> {
    this.stopSyncInterval();
    if (this.vaultDeleteListener) {
      this.app.vault.offref(this.vaultDeleteListener);
      this.vaultDeleteListener = null;
    }
    if (this.vaultRenameListener) {
      this.app.vault.offref(this.vaultRenameListener);
      this.vaultRenameListener = null;
    }
    this.conflictWatcher?.stop();
  }

  // ── settings ────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // One-pass sanitize for GitHub identity fields: Android's
    // paste-with-suggestion-bar appends trailing whitespace silently,
    // and a single trailing space in any of these makes the entire
    // REST API answer 404 for the affected token (GitHub returns 404
    // rather than 401 for "valid token, repo outside scope" — which
    // covers the trailing-space case since `owner/repo` no longer
    // matches anything). Rewrite once on load so existing installs
    // self-heal without forcing the user to re-type each field.
    const before = JSON.stringify({
      t: this.settings.githubToken,
      o: this.settings.githubOwner,
      r: this.settings.githubRepo,
      b: this.settings.githubBranch,
    });
    this.settings.githubToken = (this.settings.githubToken ?? "").trim();
    this.settings.githubOwner = (this.settings.githubOwner ?? "").trim();
    this.settings.githubRepo = (this.settings.githubRepo ?? "").trim();
    this.settings.githubBranch = (this.settings.githubBranch ?? "").trim();
    const after = JSON.stringify({
      t: this.settings.githubToken,
      o: this.settings.githubOwner,
      r: this.settings.githubRepo,
      b: this.settings.githubBranch,
    });
    if (before !== after) await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  isConfigured(): boolean {
    return !!(
      this.settings.githubToken &&
      this.settings.githubOwner &&
      this.settings.githubRepo &&
      this.settings.githubBranch
    );
  }

  // "Reset" button in Settings. Panic button: wipes credentials,
  // snapshot, push-queue, conflict-store. Use cases:
  //   - token rotation after a suspected leak (kill any pending push
  //     before the new owner of the token can intercept it),
  //   - clean slate before reconfiguring against a different repo,
  //   - troubleshooting "something feels wrong" without uninstalling.
  //
  // Irreversible — the settings tab gates this behind a confirmation
  // modal. Settings are restored to DEFAULT_SETTINGS; the user has to
  // re-enter the GitHub token, owner, repo, branch before the next
  // sync will reach a remote.
  async resetPluginState(): Promise<void> {
    if (this.sync2Manager) {
      const store = (this.sync2Manager as unknown as { store: SnapshotStore })
        .store;
      const queue = (this.sync2Manager as unknown as { queue: PushQueue })
        .queue;
      store.clear();
      await store.save();
      await queue.clearAll();
    }
    if (this.conflictStore) {
      // Rename vault sibling files BEFORE dropping the record index,
      // so a future re-enable doesn't collide with the user's
      // leftover conflict-from artifacts.
      await this.conflictStore.renameVaultSiblingsToUnresolved();
      await this.conflictStore.clearAll();
    }
    if (this.pendingDeletions) {
      // PSEUDO-MERGE-MODE §12.2 Reset semantics — pending-deletions
      // queue is plugin-managed state and gets wiped along with the
      // snapshot, conflict store, and push queue. No user data is
      // lost (the queue records intents to delete remote paths; on
      // Reset the user explicitly opts out of those intents).
      await this.pendingDeletions.clear();
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    await this.saveSettings();
  }

  // One-pass migration from 2.0.1-beta2/beta3 phantom-snapshot entries
  // into the new pending-deletions queue (PSEUDO-MERGE-MODE §12.2).
  // A phantom entry is a SnapshotStore row with mtime === 0 AND
  // size === 0 — the signature pull-side sanitize wrote when
  // recording "delete this forbidden GitHub path on next push"
  // intents before this refactor. Each such entry is moved to the
  // queue and removed from the snapshot; subsequent loads find
  // nothing to migrate (idempotent).
  //
  // No `observedAtCommit` is available in the phantom signature
  // (we never recorded it). We use `store.getLastSyncCommitSha()`
  // as the best approximation — it's the most recent commit this
  // device synced against and is therefore the latest point at
  // which the phantom's `remoteSha` was plausibly correct.
  // Empty string when lastSync is null (fresh install); in
  // practice that combination doesn't happen because phantoms only
  // exist after a sync that observed the forbidden path.
  private async migratePhantomSnapshotsToPendingDeletions(
    store: SnapshotStore,
    pendingDeletions: PendingDeletionsStore,
  ): Promise<void> {
    const observedAtCommit = store.getLastSyncCommitSha() ?? "";
    const migrated: string[] = [];
    for (const path of store.paths()) {
      const snap = store.get(path);
      if (!snap) continue;
      if (snap.mtime === 0 && snap.size === 0) {
        await pendingDeletions.add(path, {
          source: "migration-from-snapshot",
          observedAtCommit,
          remoteSha: snap.remoteSha,
        });
        store.remove(path);
        migrated.push(path);
      }
    }
    if (migrated.length > 0) {
      await store.save();
      this.logger.info(
        `Sync2 migration: phantom-snapshot → pending-deletions queue`,
        { count: migrated.length, paths: migrated },
      );
    }
  }

  // ── engine init ─────────────────────────────────────────────────────

  private async initSync2(): Promise<void> {
    const vaultRoot =
      (this.app.vault.adapter as unknown as { basePath?: string }).basePath ??
      "";
    const client = new GithubClient(this.settings, this.logger);
    const store = new SnapshotStore(this.app.vault);
    await store.load();
    this.logger.info("initSync2: SnapshotStore loaded", {
      lastSyncCommitSha: store.getLastSyncCommitSha(),
      paths: store.paths().length,
    });
    // AtomicWriteRecovery sweep runs AFTER ConflictStore.load (see
    // block below) so the sweep can resolve `.sync-tmp` staging
    // files owned by conflict records via record.theirsBlobSha
    // SHA-verify, not just snapshot-based reasoning.
    const gi = new GI(vaultRoot);
    const queue = new PushQueue({
      vault: this.app.vault,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
      autoCanonicalize: () => this.settings.autoCanonicalizeTextFiles ?? false,
    });
    const detector = new ChangeDetector({
      vault: this.app.vault,
      store,
      gi,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
      vaultRoot,
      syncConfigDir: () => this.settings.syncConfigDir ?? true,
      queue,
    });
    const builder = new TreeBuilder({
      vault: this.app.vault,
      queue,
      client,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
    });
    this.invariants = new GitignoreInvariants({
      vault: this.app.vault,
      store,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
    });
    // Prime the toggle cache once, here, so the settings tab can
    // read it synchronously without re-entering Obsidian via an
    // async setValue (see field doc above).
    try {
      this.pushPluginsDataJsonCached =
        await this.invariants.getPushPluginsDataJson();
    } catch {
      this.pushPluginsDataJsonCached = false;
    }
    const deviceLabel = this.settings.deviceLabel ?? "Obsidian";
    const conflictStore = new ConflictStore({
      vault: this.app.vault,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
    });
    await conflictStore.load();
    this.conflictStore = conflictStore;

    // Pending-deletions queue (PSEUDO-MERGE-MODE §12.2). Replaces
    // the 2.0.1-beta2 phantom-snapshot trick: pull-side sanitize
    // records "delete this forbidden GitHub path on next push"
    // intent in this queue rather than as a phantom SnapshotStore
    // entry. On first plugin load after the 2.0.1-beta4 upgrade,
    // any leftover phantom entries in the snapshot get migrated
    // into the queue and removed from the snapshot.
    const pendingDeletions = new PendingDeletionsStore({
      vault: this.app.vault,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
    });
    await pendingDeletions.load();
    this.pendingDeletions = pendingDeletions;
    await this.migratePhantomSnapshotsToPendingDeletions(store, pendingDeletions);
    // Crash-recovery sweep for atomic-write artifacts AND for
    // ConflictStore vault-level `.sync-tmp` staging siblings. Runs BEFORE the
    // engine starts touching the vault so any leftover staging from a
    // previous crash is reconciled against the snapshot + conflict
    // stores before findChanges or drain sees them.
    try {
      const recovery = new AtomicWriteRecovery(
        this.app.vault,
        store,
        conflictStore,
      );
      const result = await recovery.sweep();
      this.logger.info("initSync2: AtomicWriteRecovery sweep", result);
    } catch (err) {
      this.logger.error("Atomic-write recovery sweep failed", `${err}`);
    }
    // ConflictCounter owns the count formula + debounced recompute;
    // ConflictWatcher just calls counter.markDirty() on relevant
    // vault events; the counter notifies UI surfaces via
    // subscribe(). See docs/PSEUDO-MERGE-MODE.md §5 for the layer
    // separation.
    const conflictCounter = new ConflictCounter({
      vault: this.app.vault,
      store: conflictStore,
    });
    conflictCounter.subscribe(() => this.refreshConflictUI());
    this.conflictCounter = conflictCounter;
    // Seed the counter with whatever conflicts persisted from the
    // last session. markDirty + flush so the UI badge reflects
    // current state on first paint.
    conflictCounter.markDirty();
    await conflictCounter.flush();
    const conflictWatcher = new ConflictWatcher({
      vault: this.app.vault,
      store: conflictStore,
      counter: conflictCounter,
    });
    conflictWatcher.start();
    this.conflictWatcher = conflictWatcher;

    this.sync2Manager = new Sync2Manager({
      vault: this.app.vault,
      store,
      detector,
      queue,
      builder,
      client,
      logger: this.logger,
      invariants: this.invariants,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
      // Label read live from settings so the user can change it in
      // the settings tab and the next sync picks up the new value —
      // no plugin reload needed. Commit messages themselves are
      // hardcoded in src/sync2/commit-message.ts.
      deviceLabel: () => this.settings.deviceLabel ?? "Obsidian",
      // Remote identity read live so the manager catches a mid-session
      // settings change (user edits the repo coords in the settings
      // tab between two Sync clicks).
      remoteIdentity: () => ({
        owner: this.settings.githubOwner,
        repo: this.settings.githubRepo,
        branch: this.settings.githubBranch,
      }),
      conflictStore,
      conflictWatcher,
      conflictCounter,
      pendingDeletions,
      accumulateOfflineSyncs: this.settings.accumulateOfflineSyncs ?? false,
      autoCanonicalize: () => this.settings.autoCanonicalizeTextFiles ?? false,
      // Hooked to Obsidian's link-aware rename so the pre-sync
      // filename-sanitizer rewrites containing wiki-links automatically.
      // `getAbstractFileByPath` returns null when the path vanished
      // between the scanner's read and this callback's call (e.g. a
      // concurrent external delete) — the manager logs and continues.
      renameFile: async (oldPath: string, newPath: string): Promise<void> => {
        const file = this.app.vault.getAbstractFileByPath(oldPath);
        if (!file) return;
        await this.app.fileManager.renameFile(file, newPath);
      },
      onProgress: (initial: string) => {
        // Long-lived notice during the network phase — stays visible
        // until processQueue calls handle.hide(). The text is the
        // "Syncing with GitHub…" / "Syncing commit N/M …" string the
        // manager passes in.
        const notice = new Notice(initial, 0);
        return {
          update: (msg: string) => notice.setMessage(msg),
          hide: () => notice.hide(),
        };
      },
      // Local-commit ack — fires once `enqueueOrMerge` materialises
      // the batch on disk. We deliberately do NOT pop a separate
      // Notice here, and the same logic applies to onNoLocalChanges
      // below. Both used to surface their own brief toast, but the
      // user reported seeing them stack ON TOP OF the long-lived
      // "Syncing with GitHub…" progress notice ("Syncing with
      // GitHub…" + "Commit 2 files" side-by-side). The progress
      // notice's NEXT phase update ("Uploading N/M files…") already
      // implies the local commit happened and the manager is
      // talking to the network. Single-notice UX: only the progress
      // notice during the sync, and a single brief summary at the
      // end via onSyncCompleted.
      //
      // Click-time local-commit ack: brief flash right after the
      // batch is materialised on disk, before drain starts. Independent
      // notice (separate handle from the drain-level Pull/Push notice,
      // so users see them stacked naturally when both fire).
      onLocalCommitted: (count: number) => {
        new Notice(
          count === 1 ? "Commit 1 file" : `Commit ${count} files`,
          BRIEF_NOTICE_MS,
        );
      },
      onNoLocalChanges: () => {
        new Notice("Nothing to commit", BRIEF_NOTICE_MS);
      },
      // Observability hook only. The three user-visible notices in
      // sync2's new UX contract are handled elsewhere:
      //   - "Commit N files" via onLocalCommitted (click-time ack)
      //   - "Nothing to commit" via onNoLocalChanges (click on idle vault)
      //   - "Sync done" via the drain's own progress handle (replaces
      //     the Pull/Push notice on heavy syncs; brief flash on light
      //     syncs that did real work).
      // Left as a no-op so tests + future wiring can still depend on
      // the callback existing in the deps surface.
      onSyncCompleted: () => {},
      // PSEUDO-MERGE-MODE §12.3: push-queue depth changes drive the ribbon
      // sync-icon's badge. Fired by Sync2Manager after every
      // persistent .push-queue/ mutation (enqueueOrMerge add,
      // processBatch delete, etc).
      onQueueDepthChanged: (depth: number) => {
        this.refreshRibbonPendingBatchesBadge(depth);
      },
    });

    // Conflict resolution events (sibling delete, edit, rename) are
    // observed by ConflictWatcher above — no separate vault.on
    // wiring needed here.

    // Deliberately NO drain on enable. Users running with "Sync
    // strategy: manual" + "Sync on startup: false" expect to be in
    // control: a click triggers sync, otherwise the plugin stays
    // silent. Auto-draining on enable — even for the pending-batches
    // case — surprised users with a "Sync done" toast right after
    // toggling the plugin off and on. Orphaned push-queue batches
    // from a previous failed session still get retried, just later:
    //   • Manual click → syncAll → drain picks them up.
    //   • Watchdog tick (5 min, fires only when queue is non-empty)
    //     → backgroundDrain → drain picks them up.
    // Neither path startles the user on enable.
    // (Pre-stage-5 deviceLabel was used here; preserved for symmetry
    // with the later stage-9 widget pass.)
    void deviceLabel;
  }

  // ── sync triggers ───────────────────────────────────────────────────

  async sync(): Promise<void> {
    if (!this.isConfigured()) {
      new Notice("Sync plugin not configured");
      return;
    }
    if (!(await this.confirmPendingConflictsBeforeSync())) return;
    try {
      await this.sync2Manager.syncAll();
    } catch (err) {
      // Log BEFORE the Notice so the user-visible toast and the
      // logged record always agree. Without this, the only artifact
      // a failed click left behind was the transient Notice; the
      // log showed nothing, making bug reports actionable only when
      // the user happened to screenshot the toast in time.
      this.logger.error("syncAll click failed", { err: describeError(err) });
      new Notice(`Error syncing. ${err}`);
    }
    // Drain may have mutated ConflictStore (Phase A SHA-match
    // cleanup, Phase B path-close drops) without firing the vault
    // listeners that normally drive the counter. Mark dirty so the
    // counter recomputes and the subscribe → refreshConflictUI()
    // path fires when the badge value actually changes.
    this.conflictCounter?.markDirty();
  }

  // Background drain — entry point for the interval timer when
  // autoCommitOnSync is off. Errors are swallowed + logged because
  // network blips during a background tick are common and shouldn't
  // surface a toast.
  async backgroundDrain(): Promise<void> {
    if (!this.isConfigured()) return;
    try {
      await this.sync2Manager.resumeQueue();
    } catch (err) {
      void this.logger.error("Interval drain failed", `${err}`);
    }
  }

  async syncCurrentFile(): Promise<void> {
    const path = this.activeFilePath();
    if (!path) {
      new Notice("No active file to sync");
      return;
    }
    if (!this.isConfigured()) {
      new Notice("Sync plugin not configured");
      return;
    }
    if (!(await this.confirmPendingConflictsBeforeSync())) return;
    try {
      await this.sync2Manager.syncFile(path);
    } catch (err) {
      // Log BEFORE the Notice — see sync() rationale above.
      this.logger.error("syncFile click failed", { path, err: describeError(err) });
      new Notice(`Error syncing. ${err}`);
    }
    // See markDirty rationale in sync() above.
    this.conflictCounter?.markDirty();
  }

  // ── stage 10 — pre-sync conflict gate + UI refresh ──────────────────

  // Show the pre-sync conflict modal when ConflictStore has any
  // active records. Returns true if sync should proceed (no conflicts
  // OR user picked "Sync anyway"). Returns false when sync should be
  // aborted (user picked "Cancel" or "Resolve"; the latter opens the
  // first sibling in the editor as a courtesy).
  private async confirmPendingConflictsBeforeSync(): Promise<boolean> {
    if (!this.conflictStore) return true;
    const records = this.conflictStore.getAll();
    if (records.length === 0) return true;
    const paths = Array.from(
      new Set(records.map((r) => r.vaultPath)),
    ).sort();
    const decision = await new PreSyncConflictModal(this.app, paths).prompt();
    if (decision === "sync-anyway") return true;
    if (decision === "resolve") {
      // Open the first sibling file in the editor so the user can act
      // on it immediately. workspace.openLinkText accepts a vault-
      // relative path; the second arg ("") is the source path the
      // resolver would use to resolve relative links, which doesn't
      // matter for absolute paths.
      const firstSibling = records[0].siblingPath;
      try {
        await this.app.workspace.openLinkText(firstSibling, "", false);
      } catch (err) {
        void this.logger.error(
          "Failed to open first sibling from pre-sync modal",
          `${err}`,
        );
      }
      return false;
    }
    return false;
  }

  // Refresh every visibility surface (status bar, ribbon badge)
  // from the current ConflictCounter value. The counter formula
  // (excludes records with !siblingExists and records where
  // siblingSha == baseSha) reflects what the user actually still
  // has to resolve, not the raw record count.
  refreshConflictUI(): void {
    const count = this.conflictCounter?.getValue() ?? 0;
    this.conflictStatusIndicator?.refresh(count);
    // PSEUDO-MERGE-MODE §12.3: the ribbon sync-icon's badge is NO LONGER
    // driven by conflict-count — it shows push-queue depth instead
    // (see refreshRibbonPendingBatchesBadge, fed by Sync2Manager's
    // onQueueDepthChanged callback). Conflict-count is still
    // surfaced via the status-bar 🔀 N indicator; a future diff2
    // ribbon icon will optionally double-up on that signal
    // (DIFF2_IMPLEMENTATION_PLAN.md R2.7.4).
  }

  // Subtle absolute-positioned numeric pill in the ribbon sync
  // icon's corner. The exact styling is left to user themes — we
  // attach a CSS class so theme authors can override.
  // Visibility rules (PSEUDO-MERGE-MODE §12.3):
  //   depth === 0 → no badge (idle state).
  //   depth >= 1  → `(N)` badge in orange pill.
  private refreshRibbonPendingBatchesBadge(depth: number): void {
    if (!this.syncRibbonIcon) return;
    if (depth <= 0) {
      this.ribbonPendingBatchesBadge?.remove();
      this.ribbonPendingBatchesBadge = null;
      return;
    }
    if (!this.ribbonPendingBatchesBadge) {
      this.ribbonPendingBatchesBadge = this.syncRibbonIcon.createSpan({
        cls: "github-easy-sync-ribbon-pending-batches-badge",
      });
      const el = this.ribbonPendingBatchesBadge;
      el.style.position = "absolute";
      el.style.top = "2px";
      el.style.right = "2px";
      el.style.minWidth = "14px";
      el.style.height = "14px";
      el.style.padding = "0 3px";
      el.style.borderRadius = "7px";
      el.style.background = "var(--color-green, #16a34a)";
      el.style.color = "white";
      el.style.fontSize = "10px";
      el.style.lineHeight = "14px";
      el.style.textAlign = "center";
      el.style.pointerEvents = "none";
      this.syncRibbonIcon.style.position = "relative";
    }
    this.ribbonPendingBatchesBadge.setText(String(depth));
    this.ribbonPendingBatchesBadge.setAttribute(
      "aria-label",
      `${depth} push batch${depth === 1 ? "" : "es"} pending`,
    );
  }

  // ── status bar ──────────────────────────────────────────────────────

  showStatusBarItem(): void {
    if (this.statusBarItem) return;
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBarItem();
    // Conflict-count indicator lives in its own addStatusBarItem
    // element so user themes can style it independently. Click
    // opens the first sibling in the editor (same shortcut the
    // pre-sync modal's "Resolve" button uses).
    if (!this.conflictStatusIndicator) {
      const indicatorParent = this.addStatusBarItem();
      this.conflictStatusIndicator = new ConflictStatusIndicator(
        indicatorParent,
        () => void this.openFirstSibling(),
      );
    }
    this.refreshConflictUI();
  }

  hideStatusBarItem(): void {
    this.statusBarItem?.remove();
    this.statusBarItem = null;
    this.conflictStatusIndicator?.destroy();
    this.conflictStatusIndicator = null;
  }

  // Open the first pending sibling in the editor — used by the
  // status-bar indicator's click handler. No-op when there are no
  // pending conflicts.
  private async openFirstSibling(): Promise<void> {
    const records = this.conflictStore?.getAll() ?? [];
    if (records.length === 0) return;
    try {
      await this.app.workspace.openLinkText(records[0].siblingPath, "", false);
    } catch (err) {
      void this.logger.error(
        "Failed to open first sibling from status bar",
        `${err}`,
      );
    }
  }

  updateStatusBarItem(): void {
    // Static label after cutover. Future: surface
    // sync2Manager pending-batch count via PushQueue.list().length so
    // the user sees `GitHub: N pending` when offline-accumulate fires.
    if (this.statusBarItem) this.statusBarItem.setText("GitHub");
  }

  // ── sync ribbon ─────────────────────────────────────────────────────

  showSyncRibbonIcon(): void {
    if (this.syncRibbonIcon) return;
    this.syncRibbonIcon = this.addRibbonIcon(
      "refresh-cw",
      "Sync with GitHub",
      this.sync.bind(this),
    );
    // Seed the badge with the current push-queue depth so the icon
    // reflects on-disk state on first paint — covers the case where
    // the plugin loads with pre-existing batches (offline session,
    // crash recovery, etc.).
    void this.refreshSyncRibbonInitial();
  }

  private async refreshSyncRibbonInitial(): Promise<void> {
    try {
      const queue = (this.sync2Manager as unknown as { queue: PushQueue })
        .queue;
      const ids = await queue.list();
      this.refreshRibbonPendingBatchesBadge(ids.length);
    } catch {
      // ignored — startup race, the next sync click refreshes anyway
    }
  }

  hideSyncRibbonIcon(): void {
    this.ribbonPendingBatchesBadge?.remove();
    this.ribbonPendingBatchesBadge = null;
    this.syncRibbonIcon?.remove();
    this.syncRibbonIcon = null;
  }

  // ── auto-sync interval ──────────────────────────────────────────────

  startSyncInterval(): void {
    if (this.syncIntervalId !== null) return;
    // The tick + startup decisions all live in IntervalScheduler so
    // the three branches (interval-tick, watchdog, startup) can be
    // unit-tested without spinning up a real Obsidian. main.ts only
    // wires the settings predicates, the Sync2Manager ops, and the
    // OS-level setInterval handle.
    this.intervalScheduler = new IntervalScheduler({
      isConfigured: () => this.isConfigured(),
      intervalEnabled: () => this.settings.syncStrategy === "interval",
      intervalMinutes: () => this.settings.syncInterval,
      autoCommitOnSync: () => this.settings.autoCommitOnSync ?? false,
      hasPendingBatches: () => this.sync2Manager.hasPendingBatches(),
      // Background drain skips the pre-sync confirmation modal —
      // interval timers and the startup pulse are not user-driven,
      // so a blocking dialog would surprise the user. Detection
      // still runs; conflicts still land as siblings in the vault.
      drain: () => this.backgroundDrain(),
      fullSync: () => this.sync(),
      logError: (label, err) => {
        void this.logger.error(label, err);
      },
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (id) => window.clearInterval(id),
    });
    this.intervalScheduler.start();
    const active = this.intervalScheduler.getTimerId();
    if (active !== null) {
      this.syncIntervalId = active;
      this.registerInterval(active);
    }
  }

  // Startup hook for `syncOnStartup: true`. Same autoCommit gate as
  // interval, but with one extra step in the off-case: drain pending
  // queue batches that survived the previous Obsidian session
  // (offline pushes that never went through). The user explicitly
  // opted into "sync on startup" — pushing whatever they had queued
  // last time is the obvious right thing.
  private async runStartupSync(): Promise<void> {
    await this.intervalScheduler.runStartup();
  }

  stopSyncInterval(): void {
    if (this.intervalScheduler) this.intervalScheduler.stop();
    this.syncIntervalId = null;
  }

  restartSyncInterval(): void {
    this.stopSyncInterval();
    this.startSyncInterval();
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private activeFilePath(): string | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file?.path ?? null;
  }
}
