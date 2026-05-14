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
import { DiffPane } from "./sync2/views/diff-pane";
import { ConflictStatusBar } from "./sync2/views/conflict-status-bar";
import ConflictStore from "./sync2/conflict-store";
import { mergeIntoOne } from "./sync2/conflict-merge-all";
import manifest from "../manifest.json";

// How long the brief local-phase notices stay visible. 700ms is the
// sweet spot — long enough to read "Commit 3 files" without rushing,
// short enough that consecutive Sync clicks don't stack notices.
const BRIEF_NOTICE_MS = 700;

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
  conflictStatusBar: ConflictStatusBar | null = null;

  // Vault listeners — sibling-file delete/rename closes the matching
  // conflict record. Refs kept so we can offref them on unload.
  vaultDeleteListener: EventRef | null = null;
  vaultRenameListener: EventRef | null = null;

  // Per-sync conflict-modal state. Reset before every top-level
  // sync(); set by the modal flow.
  private suppressConflictModals = false;
  private openConflictViewAfterSync = false;
  // Vault path of the file the user picked "Resolve now" on, so the
  // post-sync openConflictView call lands the user directly on that
  // file's diff instead of just the list.
  private resolveNowPath: string | null = null;

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
    this.addCommand({
      id: "sync-current-file-with-message",
      name: "Sync current file with GitHub (custom message)…",
      icon: "file-up",
      callback: this.syncCurrentFileWithMessage.bind(this),
    });
    this.addCommand({
      id: "sync-files-with-message",
      name: "Sync with GitHub (custom message)…",
      icon: "refresh-cw",
      callback: this.syncWithMessage.bind(this),
    });
    this.addCommand({
      id: "open-conflict-view",
      name: "Open sync conflicts",
      icon: "merge",
      callback: () => void this.openConflictView(),
    });

    // Conflict-view chunk commands. Same operations the in-editor
    // Alt-N / Alt-1/2/3 keymap performs — exposed here as Obsidian
    // commands so they can be reassigned from the hotkey panel and
    // mapped through vim-mode / Commander / other binding plugins.
    // checkCallback returns false when the active leaf isn't a
    // ConflictView, which removes the entry from the command palette
    // in the wrong context (no false promises).
    this.registerConflictChunkCommand(
      "conflict-next-chunk",
      "Conflict view: next chunk",
      (diff) => diff.nextChunk(),
    );
    this.registerConflictChunkCommand(
      "conflict-prev-chunk",
      "Conflict view: previous chunk",
      (diff) => diff.previousChunk(),
    );
    this.registerConflictChunkCommand(
      "conflict-take-theirs",
      "Conflict view: take chunk from GitHub (theirs)",
      (diff) => diff.applyAtCursor("theirs"),
    );
    this.registerConflictChunkCommand(
      "conflict-take-both",
      "Conflict view: take chunk as both (markdown blockquote)",
      (diff) => diff.applyAtCursor("both"),
    );
    this.registerConflictChunkCommand(
      "conflict-take-ours",
      "Conflict view: take chunk from this device (ours)",
      (diff) => diff.applyAtCursor("ours"),
    );
  }

  // Helper: register an Obsidian command that targets the active
  // ConflictView's currently-open DiffPane. Uses checkCallback so the
  // command is hidden from the palette unless the precondition holds
  // (active leaf IS a ConflictView with a DiffPane open).
  private registerConflictChunkCommand(
    id: string,
    name: string,
    run: (diff: DiffPane) => boolean,
  ): void {
    this.addCommand({
      id,
      name,
      checkCallback: (checking: boolean): boolean => {
        const view = this.app.workspace.getActiveViewOfType(ConflictView);
        const diff = view?.getCurrentDiff();
        if (!diff) return false;
        if (checking) return true;
        run(diff);
        return true;
      },
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
    this.refreshConflictStatusBar();
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
      onConflict: (args) => this.handleSync2Conflict(args),
      accumulateOfflineSyncs: this.settings.accumulateOfflineSyncs ?? false,
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
      // Callbacks themselves kept (no-op here) for tests + future
      // wiring.
      onLocalCommitted: () => {},
      onNoLocalChanges: () => {},
      // Fires at the very end of every successful syncAll/syncFile,
      // AFTER the progress notice has hidden. Only this hook pops a
      // brief Notice so we never have two notices visible at the
      // same time.
      //
      // Differentiated by direction:
      //   pushedFiles > 0  → "Synced to GitHub"
      //   pulledFiles > 0  → "Pulled changes from GitHub"
      //   neither          → "No changes"
      onSyncCompleted: ({ pushedFiles, pulledFiles }) => {
        if (pushedFiles > 0) {
          new Notice("Synced to GitHub", BRIEF_NOTICE_MS);
        } else if (pulledFiles > 0) {
          new Notice("Pulled changes from GitHub", BRIEF_NOTICE_MS);
        } else {
          new Notice("No changes", BRIEF_NOTICE_MS);
        }
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
        oursLabel: deviceLabel,
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

  // Silent pull — entry point for the interval timer when
  // autoCommitOnIntervalSync is off. Conflicts that fire during the
  // pull are auto-deferred (suppressConflictModals stays true for the
  // whole call) so the timer never blocks waiting for a modal.
  async pullOnly(): Promise<void> {
    if (!this.isConfigured()) return;
    this.suppressConflictModals = true;
    this.openConflictViewAfterSync = false;
    try {
      await this.sync2Manager.pullOnly();
    } catch (err) {
      // Network errors during interval pull are common (offline,
      // captive portal, GitHub down). Don't spam the user with
      // notices — log only.
      void this.logger.error("Interval pullOnly failed", `${err}`);
    } finally {
      // Reset the suppress flag so a subsequent manual click reaches
      // the modal again.
      this.suppressConflictModals = false;
    }
    this.refreshConflictStatusBar();
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

  // Whole-vault custom-message sync. Same shape as
  // syncCurrentFileWithMessage but routes through Sync2Manager.syncAll
  // with the user-typed message; the resulting batch is "isolated"
  // (won't fold with later std-syncs, message survives intact).
  async syncWithMessage(): Promise<void> {
    if (!this.isConfigured()) {
      new Notice("Sync plugin not configured");
      return;
    }
    const tpl = this.settings.commitMessageAll ?? "Sync at {date} {time}";
    const defaultMsg = applyTemplate(tpl, { date: new Date() });
    const msg = await new CommitMessageModal(
      this.app,
      defaultMsg,
      null,
    ).prompt();
    if (msg === null) return;
    this.resetSyncState();
    try {
      await this.sync2Manager.syncAll(msg);
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
      this.settings.commitMessageFile ?? "Update {filename} at {date} {time}";
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
    this.resolveNowPath = null;
  }

  private afterSync(): void {
    this.refreshConflictStatusBar();
    if (this.openConflictViewAfterSync) {
      this.openConflictViewAfterSync = false;
      const focus = this.resolveNowPath;
      this.resolveNowPath = null;
      void this.openConflictView(focus ?? undefined);
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
      // resolveNowPath tells the post-sync openConflictView to
      // auto-select THIS file's diff in the view (otherwise the
      // user lands on an empty list-view and has to click).
      this.openConflictViewAfterSync = true;
      this.resolveNowPath = args.path;
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

  // Open / focus the Conflict View leaf. `focusPath` (when given)
  // tells the view to auto-open the diff for that file rather than
  // landing the user on an empty right pane — used after the user
  // picks "Resolve now" on the conflict modal so they go straight
  // to merging.
  async openConflictView(focusPath?: string): Promise<void> {
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
    if (view instanceof ConflictView) view.refreshList(focusPath);
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
      // Interval semantics depend on autoCommitOnSync. Off
      // (default) → silent pull only — no notices, no commits. On →
      // full sync, including push and the user-facing notices. The
      // Sync ribbon button always invokes the full sync() regardless,
      // so a user who's left interval on pull-only can still commit
      // on demand. Interval intentionally does NOT drain pending
      // queue batches — that's a startup-only concession (see
      // runStartupSync); idle background ticks shouldn't suddenly
      // push a commit the user thought was deferred.
      if (this.settings.autoCommitOnSync ?? false) {
        void this.sync();
      } else {
        void this.pullOnly();
      }
    }, ms);
    this.registerInterval(this.syncIntervalId);
  }

  // Startup hook for `syncOnStartup: true`. Same autoCommit gate as
  // interval, but with one extra step in the off-case: drain pending
  // queue batches that survived the previous Obsidian session
  // (offline pushes that never went through). The user explicitly
  // opted into "sync on startup" — pushing whatever they had queued
  // last time is the obvious right thing.
  private async runStartupSync(): Promise<void> {
    if (this.settings.autoCommitOnSync ?? false) {
      // Behave exactly like a manual Sync click — full commit + pull
      // + push, with notices. accumulateOfflineSyncs (if on) folds
      // the new commit into any pending batch so the result is one
      // combined commit on GitHub.
      await this.sync();
      return;
    }
    // Pull-only path: bring remote changes down silently, then push
    // any commits the user had queued before this Obsidian session
    // started. The "Commit N files" notice never fires (we don't
    // enqueue current edits); "Syncing with GitHub…" only appears
    // if there's actually something queued to push.
    await this.pullOnly();
    try {
      await this.sync2Manager.resumeQueue();
    } catch (err) {
      void this.logger.error("Startup queue drain failed", `${err}`);
    }
    this.refreshConflictStatusBar();
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
