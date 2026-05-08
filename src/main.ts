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
import { ConflictResolution as Sync2ConflictResolution } from "./sync2/types";
import { applyTemplate } from "./sync2/commit-templates";
import { CommitMessageModal } from "./sync2/views/commit-message-modal";
import {
  ConflictModal,
  ConflictPromptArgs,
} from "./sync2/views/conflict-modal";
import {
  ConflictView,
  VIEW_TYPE_SYNC2_CONFLICT,
} from "./sync2/views/conflict-view";
import { ConflictStatusBar } from "./sync2/views/conflict-status-bar";
import ConflictStore from "./sync2/conflict-store";
import { mergeIntoOne } from "./sync2/conflict-merge-all";
import manifest from "../manifest.json";

// Plugin entry point. After the Etap 7 cutover this only orchestrates
// sync2: legacy SyncManager, events-listener, and the chunk-pick
// conflict view are gone. The plugin id (`github-gitless-sync`) is
// kept verbatim — only the engine changed.
export default class GitHubSyncPlugin extends Plugin {
  settings: GitHubSyncSettings;
  // Sync2Manager + ConflictStore are constructed once during onload
  // and live for the plugin's lifetime. No more nullable engine
  // pointers — the runtime is single-engine.
  sync2Manager!: Sync2Manager;
  conflictStore!: ConflictStore;
  logger!: Logger;

  // UI elements that come and go with toggle settings.
  statusBarItem: HTMLElement | null = null;
  syncRibbonIcon: HTMLElement | null = null;
  conflictStatusBar: ConflictStatusBar | null = null;

  // Vault listeners — sibling-file delete/rename closes the matching
  // conflict record. Refs kept so we can offref them on unload.
  vaultDeleteListener: EventRef | null = null;
  vaultRenameListener: EventRef | null = null;

  // Per-sync conflict-modal state. Reset before every top-level
  // sync(); set by the modal flow.
  private suppressConflictModals = false;
  private openConflictViewAfterSync = false;

  // Auto-sync timer id (Window.setInterval handle).
  private syncIntervalId: number | null = null;

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

    if (this.settings.syncStrategy === "interval") {
      this.startSyncInterval();
    }

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.showStatusBarItem) this.showStatusBarItem();
      if (this.settings.showSyncRibbonButton) this.showSyncRibbonIcon();
      if (this.settings.syncOnStartup && this.isConfigured()) {
        void this.sync();
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
    this.addCommand({
      id: "sync-current-file-with-message",
      name: "Sync current file with GitHub (custom message)…",
      icon: "file-up",
      callback: this.syncCurrentFileWithMessage.bind(this),
    });
    this.addCommand({
      id: "open-conflict-view",
      name: "Open sync conflicts",
      icon: "merge",
      callback: () => void this.openConflictView(),
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
    this.conflictStatusBar?.destroy();
    this.conflictStatusBar = null;
  }

  // ── settings ────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

  // ── engine init ─────────────────────────────────────────────────────

  private async initSync2(): Promise<void> {
    const vaultRoot =
      (this.app.vault.adapter as unknown as { basePath?: string }).basePath ??
      "";
    const client = new GithubClient(this.settings, this.logger);
    const store = new SnapshotStore(this.app.vault);
    await store.load();
    const gi = new GI(vaultRoot);
    const detector = new ChangeDetector({
      vault: this.app.vault,
      store,
      gi,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
      vaultRoot,
    });
    const queue = new PushQueue({
      vault: this.app.vault,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
    });
    const builder = new TreeBuilder({
      vault: this.app.vault,
      queue,
      client,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
    });
    const invariants = new GitignoreInvariants({
      vault: this.app.vault,
      store,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
    });
    const deviceLabel = this.settings.deviceLabel ?? "Obsidian";
    const conflictStore = new ConflictStore({
      vault: this.app.vault,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
      deviceLabel,
    });
    await conflictStore.load();
    this.conflictStore = conflictStore;

    this.sync2Manager = new Sync2Manager({
      vault: this.app.vault,
      store,
      detector,
      queue,
      builder,
      client,
      logger: this.logger,
      invariants,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
      commitMessageAll: this.settings.commitMessageAll ?? "Sync at {date}",
      commitMessageFile:
        this.settings.commitMessageFile ?? "Update {filename} at {date}",
      deviceLabel,
      conflictStore,
      onConflict: (args) => this.handleSync2Conflict(args),
      accumulateOfflineSyncs: this.settings.accumulateOfflineSyncs ?? false,
      onProgress: (initial: string) => {
        const notice = new Notice(initial, 0);
        return {
          update: (msg: string) => notice.setMessage(msg),
          hide: () => notice.hide(),
        };
      },
    });

    // Conflict view leaf — registered once per plugin load. setDeps
    // wires in the live conflictStore so the view can render current
    // pending conflicts (and refresh on auto-finalize).
    this.registerView(VIEW_TYPE_SYNC2_CONFLICT, (leaf) => {
      const view = new ConflictView(leaf);
      view.setDeps({
        conflictStore,
        readOurs: (path) => this.app.vault.adapter.read(path),
        writeResolved: (path, content) =>
          this.app.vault.adapter.write(path, content),
        onConflictResolved: () => this.refreshConflictStatusBar(),
      });
      return view;
    });

    // Vault listeners: a sibling file deleted or renamed in the file
    // tree is treated as "user closed this conflict, ours wins on
    // next push". Same handler for both events — `oldPath` after a
    // rename is the path the conflict-store knows about.
    this.vaultDeleteListener = this.app.vault.on("delete", async (file) => {
      if (await this.conflictStore.notifySiblingDeleted(file.path)) {
        this.refreshConflictStatusBar();
      }
    });
    this.vaultRenameListener = this.app.vault.on(
      "rename",
      async (_file, oldPath) => {
        if (await this.conflictStore.notifySiblingDeleted(oldPath)) {
          this.refreshConflictStatusBar();
        }
      },
    );

    await this.sync2Manager.resumeQueue();
    this.refreshConflictStatusBar();
  }

  // ── sync triggers ───────────────────────────────────────────────────

  async sync(): Promise<void> {
    if (!this.isConfigured()) {
      new Notice("Sync plugin not configured");
      return;
    }
    this.resetSyncState();
    try {
      await this.sync2Manager.syncAll();
    } catch (err) {
      new Notice(`Error syncing. ${err}`);
    }
    this.afterSync();
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
    this.resetSyncState();
    try {
      await this.sync2Manager.syncFile(path);
    } catch (err) {
      new Notice(`Error syncing. ${err}`);
    }
    this.afterSync();
  }

  async syncCurrentFileWithMessage(): Promise<void> {
    const path = this.activeFilePath();
    if (!path) {
      new Notice("No active file to sync");
      return;
    }
    if (!this.isConfigured()) {
      new Notice("Sync plugin not configured");
      return;
    }
    const tpl =
      this.settings.commitMessageFile ?? "Update {filename} at {date}";
    const filename = path.split("/").pop() ?? path;
    const defaultMsg = applyTemplate(tpl, {
      date: new Date(),
      filename,
      path,
    });
    const msg = await new CommitMessageModal(
      this.app,
      defaultMsg,
      path,
    ).prompt();
    if (msg === null) return;
    this.resetSyncState();
    try {
      await this.sync2Manager.syncFile(path, msg);
    } catch (err) {
      new Notice(`Error syncing. ${err}`);
    }
    this.afterSync();
  }

  private resetSyncState(): void {
    // Per-sync state — each sync is its own conversation; the user's
    // previous "Defer all" choice doesn't carry over.
    this.suppressConflictModals = false;
    this.openConflictViewAfterSync = false;
  }

  private afterSync(): void {
    this.refreshConflictStatusBar();
    if (this.openConflictViewAfterSync) {
      this.openConflictViewAfterSync = false;
      void this.openConflictView();
    }
  }

  // ── conflict modal hook ─────────────────────────────────────────────

  private async handleSync2Conflict(args: {
    path: string;
    ours: string;
    base: string;
    theirs: string;
    conflictMarkedContent: string;
  }): Promise<Sync2ConflictResolution> {
    if (this.suppressConflictModals) {
      return { kind: "deferred" };
    }
    const promptArgs: ConflictPromptArgs = {
      path: args.path,
      // Sync2Manager doesn't surface batch index/total to the
      // callback; we offer Defer-all unconditionally so the user can
      // bail mid-batch. The header just shows the file path.
      index: 1,
      total: 2,
      isMarkdown: args.path.endsWith(".md"),
    };
    const choice = await new ConflictModal(this.app, promptArgs).prompt();
    if (choice === "defer-all") {
      this.suppressConflictModals = true;
      return { kind: "deferred" };
    }
    if (choice === "later") {
      return { kind: "deferred" };
    }
    if (choice === "resolve-now") {
      // Defer + open the conflict view tab so the user lands on the
      // diff editor as soon as sync finishes its housekeeping.
      this.openConflictViewAfterSync = true;
      return { kind: "deferred" };
    }
    // merge-into-one — markdown only. The modal hides the button
    // otherwise; defend against bad input regardless.
    if (!args.path.endsWith(".md")) {
      return { kind: "deferred" };
    }
    const merged = mergeIntoOne(args.ours, [
      {
        content: args.theirs,
        deviceLabel: "GitHub",
        ts: Date.now(),
      },
    ]);
    return { kind: "merged-into-one", content: merged };
  }

  // ── conflict view ───────────────────────────────────────────────────

  async openConflictView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_SYNC2_CONFLICT,
    );
    let leaf: WorkspaceLeaf;
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = this.app.workspace.getLeaf(true);
      await leaf.setViewState({
        type: VIEW_TYPE_SYNC2_CONFLICT,
        active: true,
      });
    }
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof ConflictView) view.refreshList();
  }

  // ── status bar ──────────────────────────────────────────────────────

  showStatusBarItem(): void {
    if (this.statusBarItem) return;
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBarItem();
    if (!this.conflictStatusBar) {
      const conflictEl = this.addStatusBarItem();
      this.conflictStatusBar = new ConflictStatusBar(conflictEl, () => {
        void this.openConflictView();
      });
      this.refreshConflictStatusBar();
    }
  }

  hideStatusBarItem(): void {
    this.statusBarItem?.remove();
    this.statusBarItem = null;
    this.conflictStatusBar?.destroy();
    this.conflictStatusBar = null;
  }

  updateStatusBarItem(): void {
    // Static label after cutover. Future: surface
    // sync2Manager pending-batch count via PushQueue.list().length so
    // the user sees `GitHub: N pending` when offline-accumulate fires.
    if (this.statusBarItem) this.statusBarItem.setText("GitHub");
  }

  refreshConflictStatusBar(): void {
    if (!this.conflictStatusBar) return;
    this.conflictStatusBar.refresh(this.conflictStore.list().length);
  }

  // ── sync ribbon ─────────────────────────────────────────────────────

  showSyncRibbonIcon(): void {
    if (this.syncRibbonIcon) return;
    this.syncRibbonIcon = this.addRibbonIcon(
      "refresh-cw",
      "Sync with GitHub",
      this.sync.bind(this),
    );
  }

  hideSyncRibbonIcon(): void {
    this.syncRibbonIcon?.remove();
    this.syncRibbonIcon = null;
  }

  // ── auto-sync interval ──────────────────────────────────────────────

  startSyncInterval(): void {
    if (this.syncIntervalId !== null) return;
    const ms = Math.max(1, this.settings.syncInterval) * 60 * 1000;
    this.syncIntervalId = window.setInterval(() => {
      void this.sync();
    }, ms);
    this.registerInterval(this.syncIntervalId);
  }

  stopSyncInterval(): void {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
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
