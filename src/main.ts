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
import GithubClient from "./github/client";
import GI from "./gi";
import SnapshotStore from "./sync2/snapshot-store";
import ChangeDetector from "./sync2/change-detector";
import PushQueue from "./sync2/push-queue";
import TreeBuilder from "./sync2/tree-builder";
import GitignoreInvariants from "./sync2/gitignore-invariants";
import { Sync2Manager } from "./sync2/sync2-manager";
import { IntervalScheduler } from "./sync2/interval-scheduler";
import ConflictStore from "./sync2/conflict-store";
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
  conflictWatcher!: ConflictWatcher;
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
  ribbonConflictBadge: HTMLElement | null = null;

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
    await this.loadSettings();
    this.logger = new Logger(this.app.vault, this.settings.enableLogging);
    this.logger.init();

    this.addSettingTab(new GitHubSyncSettingsTab(this.app, this));

    await this.initSync2();

    // Always start the timer: when interval is enabled, it runs at the
    // user's configured cadence and ticks pull + drain; when disabled
    // it's a 5-min watchdog that only drains pending batches (so a
    // failed earlier drain gets retried automatically).
    this.startSyncInterval();

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
      await this.conflictStore.clearAll();
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    await this.saveSettings();
  }

  // ── engine init ─────────────────────────────────────────────────────

  private async initSync2(): Promise<void> {
    const vaultRoot =
      (this.app.vault.adapter as unknown as { basePath?: string }).basePath ??
      "";
    const client = new GithubClient(this.settings, this.logger);
    const store = new SnapshotStore(this.app.vault);
    await store.load();
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
    // Pseudo-merge stage 9: real-time vault listener that fires the
    // classifier on delete/modify/rename events touching either a
    // conflict's base path or its sibling. Drain pauses it during
    // the batch loop; outside drain it picks up the user's actions
    // (delete sibling, copy onto base, etc.) immediately so the
    // status bar / UI surfaces stay live.
    const conflictWatcher = new ConflictWatcher({
      vault: this.app.vault,
      store: conflictStore,
      onError: (err) =>
        void this.logger.error("ConflictWatcher error", `${err}`),
      // Stage 10 — every watcher-triggered classifier sweep refreshes
      // the 4 visibility surfaces. Cheap on a clean device (zero
      // conflicts → 0-cost refresh that just hides the indicator).
      onResolution: () => this.refreshConflictUI(),
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
      // Templates + label read live from settings so the user can
      // change them in the settings tab and the next syncAll picks
      // up the new value — no plugin reload needed.
      commitMessageAll: () =>
        this.settings.commitMessageAll ?? "Sync at {date} {time}",
      commitMessageFile: () =>
        this.settings.commitMessageFile ?? "Update {filename} at {date} {time}",
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
      accumulateOfflineSyncs: this.settings.accumulateOfflineSyncs ?? false,
      autoCanonicalize: () => this.settings.autoCanonicalizeTextFiles ?? false,
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
    });

    // Stage 5c: vault listeners that closed conflicts on sibling
    // delete are gone — the new ConflictStore's classifier runs
    // through ConflictWatcher (stage 4, wired in a later stage).
    // The old in-line notifySiblingDeleted path doesn't exist on
    // the new store.

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
      new Notice(`Error syncing. ${err}`);
    }
    this.refreshConflictUI();
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
      new Notice(`Error syncing. ${err}`);
    }
    this.refreshConflictUI();
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

  // Refresh every visibility surface (status bar, ribbon badge,
  // settings tab) from the current ConflictStore count. Cheap —
  // counts records and updates DOM only when count crosses zero or
  // changes magnitude.
  refreshConflictUI(): void {
    const count = this.conflictStore?.getAll().length ?? 0;
    this.conflictStatusIndicator?.refresh(count);
    this.refreshRibbonConflictBadge(count);
  }

  private refreshRibbonConflictBadge(count: number): void {
    if (!this.syncRibbonIcon) return;
    if (count <= 0) {
      this.ribbonConflictBadge?.remove();
      this.ribbonConflictBadge = null;
      return;
    }
    if (!this.ribbonConflictBadge) {
      // Subtle absolute-positioned numeric pill in the ribbon icon's
      // corner. The exact styling is left to user themes — we attach
      // a CSS class so theme authors can override.
      this.ribbonConflictBadge = this.syncRibbonIcon.createSpan({
        cls: "github-easy-sync-ribbon-conflict-badge",
      });
      const el = this.ribbonConflictBadge;
      el.style.position = "absolute";
      el.style.top = "2px";
      el.style.right = "2px";
      el.style.minWidth = "14px";
      el.style.height = "14px";
      el.style.padding = "0 3px";
      el.style.borderRadius = "7px";
      el.style.background = "var(--color-orange, #d97706)";
      el.style.color = "white";
      el.style.fontSize = "10px";
      el.style.lineHeight = "14px";
      el.style.textAlign = "center";
      el.style.pointerEvents = "none";
      this.syncRibbonIcon.style.position = "relative";
    }
    this.ribbonConflictBadge.setText(String(count));
    this.ribbonConflictBadge.setAttribute(
      "aria-label",
      `${count} pending sync conflict${count === 1 ? "" : "s"}`,
    );
  }

  // ── status bar ──────────────────────────────────────────────────────

  showStatusBarItem(): void {
    if (this.statusBarItem) return;
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBarItem();
    // Stage 10 — conflict-count indicator lives in its own
    // addStatusBarItem element so user themes can style it
    // independently. Click opens the first sibling in the editor
    // (same shortcut the pre-sync modal's "Resolve" button uses).
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
    this.refreshConflictUI();
  }

  hideSyncRibbonIcon(): void {
    this.ribbonConflictBadge?.remove();
    this.ribbonConflictBadge = null;
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
      // Background drain wraps suppressConflictModals so a pull-side
      // conflict auto-defers instead of blocking on the modal. The
      // interval timer never wants a modal popping up under the user.
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
