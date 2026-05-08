import {
  EventRef,
  MarkdownView,
  Plugin,
  WorkspaceLeaf,
  normalizePath,
  Notice,
} from "obsidian";
import { GitHubSyncSettings, DEFAULT_SETTINGS } from "./settings/settings";
import GitHubSyncSettingsTab from "./settings/tab";
import SyncManager, {
  AmbiguousStateInfo,
  ConflictFile,
  ConflictResolution,
} from "./sync-manager";
import Logger from "./logger";
import {
  ConflictsResolutionView,
  CONFLICTS_RESOLUTION_VIEW_TYPE,
} from "./views/conflicts-resolution/view";
import { InitDecisionModal } from "./views/init-decision-modal";
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

export default class GitHubSyncPlugin extends Plugin {
  settings: GitHubSyncSettings;
  syncManager: SyncManager;
  // Active when settings.experimentalSync2 is true. Cohabits with the
  // legacy syncManager during the rollout; only one engine drives a
  // given sync click. Removed in the cutover commit.
  sync2Manager: Sync2Manager | null = null;
  // Etap 6.5 conflict-resolver state. Populated alongside
  // sync2Manager whenever experimentalSync2 is on.
  conflictStore: ConflictStore | null = null;
  conflictStatusBar: ConflictStatusBar | null = null;
  // Set by the ConflictModal flow when the user clicks "Defer ALL
  // remaining". Skips subsequent modal pops within the same sync
  // and is reset before each top-level Sync2Manager call.
  private suppressConflictModals = false;
  // After "Resolve now", we want the Conflict View leaf to open
  // automatically once sync finishes the deferral side-effects so
  // the user lands directly on the diff editor. Tracked here so the
  // close-of-sync wrapper can pop it open.
  private openConflictViewAfterSync = false;
  logger: Logger;

  statusBarItem: HTMLElement | null = null;
  syncRibbonIcon: HTMLElement | null = null;
  conflictsRibbonIcon: HTMLElement | null = null;

  activeLeafChangeListener: EventRef | null = null;
  vaultCreateListener: EventRef | null = null;
  vaultModifyListener: EventRef | null = null;
  vaultDeleteListener: EventRef | null = null;
  vaultRenameListener: EventRef | null = null;

  // Called in ConflictResolutionView when the user solves all the conflicts.
  // This is initialized every time we open the view to set new conflicts so
  // we can notify the SyncManager that everything has been resolved and the sync
  // process can continue on.
  conflictsResolver: ((resolutions: ConflictResolution[]) => void) | null =
    null;

  // We keep track of the sync conflicts in here too in case the
  // conflicts view must be rebuilt, or the user closes the view
  // and it gets destroyed.
  // By keeping them here we can recreate it easily.
  private conflicts: ConflictFile[] = [];

  async onUserEnable() {
    if (
      this.settings.githubToken === "" ||
      this.settings.githubOwner === "" ||
      this.settings.githubRepo === "" ||
      this.settings.githubBranch === ""
    ) {
      new Notice("Go to settings to configure syncing");
    }
  }

  getConflictsView(): ConflictsResolutionView | null {
    const leaves = this.app.workspace.getLeavesOfType(
      CONFLICTS_RESOLUTION_VIEW_TYPE,
    );
    if (leaves.length === 0) {
      return null;
    }
    return leaves[0].view as ConflictsResolutionView;
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(CONFLICTS_RESOLUTION_VIEW_TYPE);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getLeaf(false)!;
      await leaf.setViewState({
        type: CONFLICTS_RESOLUTION_VIEW_TYPE,
        active: true,
      });
    }
    workspace.revealLeaf(leaf);
  }

  async onload() {
    await this.loadSettings();

    this.logger = new Logger(this.app.vault, this.settings.enableLogging);
    this.logger.init();

    this.registerView(
      CONFLICTS_RESOLUTION_VIEW_TYPE,
      (leaf) => new ConflictsResolutionView(leaf, this, this.conflicts),
    );

    this.addSettingTab(new GitHubSyncSettingsTab(this.app, this));

    this.syncManager = new SyncManager(
      this.app.vault,
      this.settings,
      this.onConflicts.bind(this),
      this.logger,
      this.onAmbiguousState.bind(this),
    );
    await this.syncManager.loadMetadata();

    if (this.settings.experimentalSync2) {
      await this.initSync2();
    }

    if (this.settings.syncStrategy == "interval") {
      this.restartSyncInterval();
    }

    this.app.workspace.onLayoutReady(async () => {
      // Create the events handling only after tha layout is ready to avoid
      // getting spammed with create events.
      // See the official Obsidian docs:
      // https://docs.obsidian.md/Reference/TypeScript+API/Vault/on('create')
      //
      // CRITICAL: only start the legacy events-listener when running on
      // the legacy engine. Sync2 uses pull-based change detection
      // (ChangeDetector.findChanges via vault.getFiles + stat) and
      // does NOT need vault events. Running both paths simultaneously
      // is catastrophic: legacy MetadataStore.save() writes the same
      // `github-easy-sync-metadata.json` that sync2 SnapshotStore
      // owns, with a different schema. Each write trashes the
      // other's sync2-specific fields (lastSyncCommitSha,
      // invariantState, …) and inserts legacy-shape entries
      // (`{sha, dirty, justDownloaded, lastModified}`) for files
      // sync2 hasn't pushed yet — those entries' `sha:null` means
      // sync2's migrate() then drops them, so the next syncAll
      // re-detects the file as `added`, but findChanges may have
      // already raced past it.
      if (!this.settings.experimentalSync2) {
        this.syncManager.startEventsListener(this);
      }

      // Load the ribbons after layout is ready so they're shown after the core
      // buttons
      if (this.settings.showStatusBarItem) {
        this.showStatusBarItem();
      }

      if (this.settings.showConflictsRibbonButton) {
        this.showConflictsRibbonIcon();
      }

      if (this.settings.showSyncRibbonButton) {
        this.showSyncRibbonIcon();
      }
    });

    this.addCommand({
      id: "sync-files",
      name: "Sync with GitHub",
      repeatable: false,
      icon: "refresh-cw",
      callback: this.sync.bind(this),
    });

    this.addCommand({
      id: "sync-current-file",
      name: "Sync current file with GitHub",
      repeatable: false,
      icon: "file-up",
      callback: this.syncCurrentFile.bind(this),
    });

    this.addCommand({
      id: "sync-current-file-with-message",
      name: "Sync current file with GitHub (custom message)…",
      repeatable: false,
      icon: "file-up",
      callback: this.syncCurrentFileWithMessage.bind(this),
    });

    // Etap 6.5: open the conflict-resolution view. Visible whether
    // or not there are pending conflicts — empty state shows "no
    // pending conflicts" so users can confirm the panel works.
    this.addCommand({
      id: "open-conflict-view",
      name: "Open sync conflicts",
      icon: "merge",
      callback: () => {
        if (!this.settings.experimentalSync2) {
          new Notice(
            "Sync conflict view requires experimentalSync2 to be enabled.",
          );
          return;
        }
        void this.openConflictView();
      },
    });

    this.addCommand({
      id: "merge",
      name: "Open sync conflicts view",
      repeatable: false,
      icon: "refresh-cw",
      callback: this.openConflictsView.bind(this),
    });
  }

  // Build the Sync2 dependency tree on top of the existing GithubClient
  // so the experimental engine can run alongside the legacy SyncManager.
  // No-op if sync2Manager already exists.
  async initSync2(): Promise<void> {
    if (this.sync2Manager) return;
    const vaultRoot = (
      this.app.vault.adapter as unknown as { basePath?: string }
    ).basePath ?? "";
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
      commitMessageAll:
        this.settings.commitMessageAll ?? "Sync at {date}",
      commitMessageFile:
        this.settings.commitMessageFile ?? "Update {filename} at {date}",
      deviceLabel,
      conflictStore,
      onConflict: (args) => this.handleSync2Conflict(args),
      accumulateOfflineSyncs: this.settings.accumulateOfflineSyncs ?? false,
      onProgress: (initial: string) => {
        // Long-lived Notice that survives across batch boundaries.
        // Passing 0 keeps it open until we hide it explicitly.
        const notice = new Notice(initial, 0);
        return {
          update: (msg: string) => notice.setMessage(msg),
          hide: () => notice.hide(),
        };
      },
    });

    // Conflict view leaf type — registered once per plugin load.
    // setDeps wires in the live conflictStore so the view can render
    // current pending conflicts.
    this.registerView(
      VIEW_TYPE_SYNC2_CONFLICT,
      (leaf) => {
        const view = new ConflictView(leaf);
        view.setDeps({
          conflictStore,
          readOurs: (path) => this.app.vault.adapter.read(path),
          writeResolved: (path, content) =>
            this.app.vault.adapter.write(path, content),
          onConflictResolved: () => {
            this.refreshConflictStatusBar();
          },
        });
        return view;
      },
    );

    // Vault listeners: a sibling file deleted or renamed in the file
    // tree is treated as "user closed this conflict, ours wins on
    // next push". Same semantics for both events — `oldPath` after a
    // rename is the path the conflict-store knows about.
    this.vaultDeleteListener = this.app.vault.on("delete", async (file) => {
      if (!this.conflictStore) return;
      if (await this.conflictStore.notifySiblingDeleted(file.path)) {
        this.refreshConflictStatusBar();
      }
    });
    this.vaultRenameListener = this.app.vault.on(
      "rename",
      async (_file, oldPath) => {
        if (!this.conflictStore) return;
        if (await this.conflictStore.notifySiblingDeleted(oldPath)) {
          this.refreshConflictStatusBar();
        }
      },
    );

    await this.sync2Manager.resumeQueue();
    this.refreshConflictStatusBar();
  }

  // Per-conflict modal hook routed from Sync2Manager.onConflict.
  // Returns the user's choice as a ConflictResolution. "resolve-now"
  // and "later" both produce `kind: "deferred"` (the diff editor
  // closes the conflict separately via the conflict-view leaf);
  // "merge-into-one" composes the markdown callout right here so
  // sync2 writes + pushes the merged content immediately;
  // "defer-all" sets a flag so the rest of the current sync's
  // conflicts skip the modal.
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
      // callback; we'd need to thread it through to render the
      // "(N of M)" header. Kept simple for now — the modal still
      // prints the file path. Defer-all is offered unconditionally
      // because we can't tell whether more conflicts are queued.
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
      // diff editor as soon as sync finishes its housekeeping. The
      // sibling file gets created via Sync2Manager → ConflictStore;
      // the view picks it up on next refresh.
      this.openConflictViewAfterSync = true;
      return { kind: "deferred" };
    }
    // merge-into-one: compose the markdown callout and return the
    // merged content. Only offered for .md files (the modal hides
    // the button otherwise), but defend against bad input anyway.
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

  private refreshConflictStatusBar(): void {
    if (!this.conflictStatusBar || !this.conflictStore) return;
    this.conflictStatusBar.refresh(
      this.conflictStore.list().length,
    );
  }

  // Open / focus the Conflict View workspace leaf. Reuses an
  // existing leaf if one is already open; otherwise spawns a new
  // one in the right sidebar.
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
    // Refresh in case the store changed since the leaf was created.
    const view = leaf.view;
    if (view instanceof ConflictView) view.refreshList();
  }

  async syncCurrentFile(): Promise<void> {
    const path = this.activeFilePath();
    if (!path) {
      new Notice("No active file to sync");
      return;
    }
    if (!(await this.ensureSync2Configured())) return;
    this.suppressConflictModals = false;
    this.openConflictViewAfterSync = false;
    await this.sync2Manager!.syncFile(path);
    this.updateStatusBarItem();
    this.refreshConflictStatusBar();
    if (this.openConflictViewAfterSync) {
      this.openConflictViewAfterSync = false;
      void this.openConflictView();
    }
  }

  async syncCurrentFileWithMessage(): Promise<void> {
    const path = this.activeFilePath();
    if (!path) {
      new Notice("No active file to sync");
      return;
    }
    if (!(await this.ensureSync2Configured())) return;
    const tpl =
      this.settings.commitMessageFile ?? "Update {filename} ({date})";
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
    if (msg === null) return; // user cancelled
    this.suppressConflictModals = false;
    this.openConflictViewAfterSync = false;
    await this.sync2Manager!.syncFile(path, msg);
    this.updateStatusBarItem();
    this.refreshConflictStatusBar();
    if (this.openConflictViewAfterSync) {
      this.openConflictViewAfterSync = false;
      void this.openConflictView();
    }
  }

  private activeFilePath(): string | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file?.path ?? null;
  }

  private async ensureSync2Configured(): Promise<boolean> {
    if (
      this.settings.githubToken === "" ||
      this.settings.githubOwner === "" ||
      this.settings.githubRepo === "" ||
      this.settings.githubBranch === ""
    ) {
      new Notice("Sync plugin not configured");
      return false;
    }
    if (!this.settings.experimentalSync2) {
      new Notice(
        "This command requires experimentalSync2 to be enabled in settings.",
      );
      return false;
    }
    if (!this.sync2Manager) await this.initSync2();
    return true;
  }

  async sync() {
    if (
      this.settings.githubToken === "" ||
      this.settings.githubOwner === "" ||
      this.settings.githubRepo === "" ||
      this.settings.githubBranch === ""
    ) {
      new Notice("Sync plugin not configured");
      return;
    }
    if (this.settings.experimentalSync2) {
      if (!this.sync2Manager) await this.initSync2();
      // Etap 6.5: reset per-sync conflict-modal state before each
      // top-level sync. Each sync is its own conversation; the
      // user's previous "Defer all" choice doesn't carry over.
      this.suppressConflictModals = false;
      this.openConflictViewAfterSync = false;
      try {
        await this.sync2Manager!.syncAll();
      } catch (err) {
        new Notice(`Error syncing. ${err}`);
      }
      this.updateStatusBarItem();
      this.refreshConflictStatusBar();
      // If the user picked "Resolve now" on any conflict during the
      // sync, surface the diff editor now that sync side-effects
      // have settled. The view is also visible whenever there are
      // pending conflicts even without explicit resolve-now — but
      // we only auto-pop on explicit user intent.
      if (this.openConflictViewAfterSync) {
        this.openConflictViewAfterSync = false;
        void this.openConflictView();
      }
      return;
    }
    // Legacy path. settings.firstSync used to gate which entry point
    // we'd call. Now SyncManager.sync() runs state analysis on every
    // call and routes to the right flow itself — first-sync, adoption,
    // regular sync, resume — so we always call it. The flag is kept
    // in the settings interface for backward compatibility with
    // existing data.json files but is never read here.
    await this.syncManager.sync();
    if (this.settings.firstSync) {
      this.settings.firstSync = false;
      await this.saveSettings();
    }
    this.updateStatusBarItem();
  }

  async onunload() {
    this.stopSyncInterval();
    // Etap 6.5: detach vault listeners + tear down the conflict
    // status bar item. Plugin reload would otherwise stack
    // duplicates and double-fire.
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

  showStatusBarItem() {
    if (this.statusBarItem) {
      return;
    }
    this.statusBarItem = this.addStatusBarItem();
    // Etap 6.5: dedicated status-bar widget for pending conflicts.
    // Constructed alongside the legacy status item so both indicators
    // coexist during the sync2 rollout. After cutover the legacy item
    // goes; this one stays.
    if (this.settings.experimentalSync2 && !this.conflictStatusBar) {
      const conflictEl = this.addStatusBarItem();
      this.conflictStatusBar = new ConflictStatusBar(conflictEl, () => {
        void this.openConflictView();
      });
      this.refreshConflictStatusBar();
    }

    if (!this.activeLeafChangeListener) {
      this.activeLeafChangeListener = this.app.workspace.on(
        "active-leaf-change",
        () => this.updateStatusBarItem(),
      );
    }
    if (!this.vaultCreateListener) {
      this.vaultCreateListener = this.app.vault.on("create", () => {
        this.updateStatusBarItem();
      });
    }
    if (!this.vaultModifyListener) {
      this.vaultModifyListener = this.app.vault.on("modify", () => {
        this.updateStatusBarItem();
      });
    }
  }

  hideStatusBarItem() {
    this.statusBarItem?.remove();
    this.statusBarItem = null;
    this.conflictStatusBar?.destroy();
    this.conflictStatusBar = null;
  }

  updateStatusBarItem() {
    if (!this.statusBarItem) {
      return;
    }
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      return;
    }

    let state = "Unknown";
    const fileData = this.syncManager.getFileMetadata(activeFile.path);
    if (!fileData) {
      state = "Untracked";
    } else if (fileData.dirty) {
      state = "Outdated";
    } else if (!fileData.dirty) {
      state = "Up to date";
    }

    this.statusBarItem.setText(`GitHub: ${state}`);
  }

  showSyncRibbonIcon() {
    if (this.syncRibbonIcon) {
      return;
    }
    this.syncRibbonIcon = this.addRibbonIcon(
      "refresh-cw",
      "Sync with GitHub",
      this.sync.bind(this),
    );
  }

  hideSyncRibbonIcon() {
    this.syncRibbonIcon?.remove();
    this.syncRibbonIcon = null;
  }

  showConflictsRibbonIcon() {
    if (this.conflictsRibbonIcon) {
      return;
    }
    this.conflictsRibbonIcon = this.addRibbonIcon(
      "merge",
      "Open sync conflicts view",
      this.openConflictsView.bind(this),
    );
  }

  hideConflictsRibbonIcon() {
    this.conflictsRibbonIcon?.remove();
    this.conflictsRibbonIcon = null;
  }

  async openConflictsView() {
    await this.activateView();
    this.getConflictsView()?.setConflictFiles(this.conflicts);
  }

  async onConflicts(conflicts: ConflictFile[]): Promise<ConflictResolution[]> {
    this.conflicts = conflicts;
    return await new Promise(async (resolve) => {
      this.conflictsResolver = resolve;
      await this.activateView();
      this.getConflictsView()?.setConflictFiles(conflicts);
    });
  }

  async onAmbiguousState(
    info: AmbiguousStateInfo,
  ): Promise<"overwrite-remote" | "overwrite-local" | "cancel"> {
    const modal = new InitDecisionModal(
      this.app,
      info.local,
      info.remote,
      info.analysis,
    );
    return await modal.prompt();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Proxy methods from sync manager to ease handling the interval
  // when settings are changed
  startSyncInterval() {
    const intervalID = this.syncManager.startSyncInterval(
      this.settings.syncInterval,
    );
    this.registerInterval(intervalID);
  }

  stopSyncInterval() {
    this.syncManager.stopSyncInterval();
  }

  restartSyncInterval() {
    this.syncManager.stopSyncInterval();
    this.syncManager.startSyncInterval(this.settings.syncInterval);
  }

  async reset() {
    this.settings = DEFAULT_SETTINGS;
    this.saveSettings();
    await this.syncManager.resetMetadata();
  }
}
