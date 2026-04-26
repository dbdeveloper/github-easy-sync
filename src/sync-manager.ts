import {
  Vault,
  Notice,
  normalizePath,
  base64ToArrayBuffer,
  arrayBufferToBase64,
} from "obsidian";
import GithubClient, {
  GetTreeResponseItem,
  NewTreeRequestItem,
  RepoContent,
} from "./github/client";
import MetadataStore, {
  FileMetadata,
  Metadata,
  MANIFEST_FILE_NAME,
} from "./metadata-store";
import EventsListener from "./events-listener";
import { GitHubSyncSettings } from "./settings/settings";
import Logger, { LOG_FILE_NAME } from "./logger";
import { GitignoreCache } from "./gitignore-cache";
import {
  ConflictCategory,
  calculateGitBlobSHA,
  classifyForConflict,
  compareSemver,
  conflictBackupPath,
  decodeBase64String,
  hasTextExtension,
  isSyncable,
  pluginIdFromPath,
} from "./utils";
import {
  AdoptionAnalysis,
  InitAction,
  LocalState,
  RemoteState,
  ResumeKind,
  analyzeLocalState,
  analyzeRemoteState,
  compareForAdoption,
  decideInitAction,
  shouldAutoAdopt,
} from "./sync-state";
import GitHubSyncPlugin from "./main";

interface SyncAction {
  type: "upload" | "download" | "delete_local" | "delete_remote";
  filePath: string;
}

export interface ConflictFile {
  filePath: string;
  remoteContent: string;
  localContent: string;
}

export interface ConflictResolution {
  filePath: string;
  content: string;
}

type OnConflictsCallback = (
  conflicts: ConflictFile[],
) => Promise<ConflictResolution[]>;

export type AmbiguousStateInfo = {
  local: LocalState;
  remote: RemoteState;
  analysis: AdoptionAnalysis;
};

export type OnAmbiguousStateCallback = (
  info: AmbiguousStateInfo,
) => Promise<"overwrite-remote" | "overwrite-local" | "cancel">;

export default class SyncManager {
  private metadataStore: MetadataStore;
  private client: GithubClient;
  private eventsListener: EventsListener;
  private gitignoreCache: GitignoreCache;
  private syncIntervalId: number | null = null;

  // Use to track if syncing is in progress, this ideally
  // prevents multiple syncs at the same time and creation
  // of messy conflicts.
  private syncing: boolean = false;

  // Persistent toast updated as sync progresses through phases. Owned by
  // firstSync()/sync(): created at the start, updated via updateProgress(),
  // hidden in finally. Null when no sync is running.
  private progressNotice: Notice | null = null;

  private updateProgress(message: string) {
    this.progressNotice?.setMessage(message);
  }

  constructor(
    private vault: Vault,
    private settings: GitHubSyncSettings,
    private onConflicts: OnConflictsCallback,
    private logger: Logger,
    private onAmbiguousState?: OnAmbiguousStateCallback,
  ) {
    this.metadataStore = new MetadataStore(this.vault);
    this.client = new GithubClient(this.settings, this.logger);
    this.gitignoreCache = new GitignoreCache(this.vault);
    this.eventsListener = new EventsListener(
      this.vault,
      this.metadataStore,
      this.settings,
      this.logger,
      this.gitignoreCache,
    );
  }

  /**
   * Returns true if the local vault root is empty.
   */
  private async vaultIsEmpty(): Promise<boolean> {
    const { files, folders } = await this.vault.adapter.list(
      this.vault.getRoot().path,
    );
    // There are files or folders in the vault dir
    return (
      files.length === 0 ||
      // We filter out the config dir since is always present so it's fine if we find it.
      folders.filter((f) => f !== this.vault.configDir).length === 0
    );
  }

  private async dispatchSync() {
    await this.logger.info("Starting sync");
    this.updateProgress("Analyzing repository state...");

    // Two independent resume markers — each set by the corresponding
    // first-sync path before its first risky operation. "from-local"
    // takes precedence: in the rare case both are set, finishing the
    // upload is what the user was last trying to do.
    const resume: ResumeKind = this.metadataStore.data
      .firstSyncFromLocalInProgress
      ? "from-local"
      : this.metadataStore.data.firstSyncFromRemoteInProgress
        ? "from-remote"
        : null;
    const [localState, remoteState] = await Promise.all([
      analyzeLocalState(this.vault, this.settings.syncConfigDir),
      analyzeRemoteState(this.client, this.vault.configDir),
    ]);
    await this.logger.info("State analysis", {
      local: localState.kind,
      remote: remoteState.kind,
      resume,
    });

    let action = decideInitAction(localState, remoteState, resume);

    // Resolve adoption-analysis cases by hashing local files and comparing
    // against remote SHAs. Silent if no real conflicts; modal otherwise.
    if (action.kind === "needs-adoption-analysis") {
      this.updateProgress("Comparing local and remote files...");
      const analysis = await compareForAdoption(
        this.vault,
        this.vault.configDir,
        this.settings.syncConfigDir,
        action.remote.kind === "bare" ? {} : action.remote.files,
      );
      await this.logger.info("Adoption analysis", {
        identical: analysis.identical.length,
        localOnly: analysis.localOnly.length,
        remoteOnly: analysis.remoteOnly.length,
        conflicting: analysis.conflicting.length,
      });
      action = shouldAutoAdopt(analysis)
        ? { kind: "adopt", remote: action.remote, analysis }
        : { kind: "ambiguous", local: localState, remote: action.remote, analysis };
    }

    if (action.kind === "ambiguous") {
      if (!this.onAmbiguousState) {
        throw new Error(
          "Initial sync needs a decision but no UI handler is registered",
        );
      }
      const choice = await this.onAmbiguousState({
        local: localState,
        remote: action.remote,
        analysis: action.analysis,
      });
      await this.logger.info("Ambiguous state resolved by user", { choice });
      if (choice === "cancel") {
        throw new Error("Sync cancelled by user");
      }
      action =
        choice === "overwrite-remote"
          ? { kind: "first-sync-from-local", remote: action.remote }
          : { kind: "first-sync-from-remote", remote: action.remote };
    }

    await this.executeInitAction(action);
  }

  /**
   * Carry out the action chosen by decideInitAction (after any
   * adoption/modal resolution). Each branch maps to one of the existing
   * helper methods plus a small bootstrap path for bare-repo cases.
   */
  private async executeInitAction(action: InitAction): Promise<void> {
    switch (action.kind) {
      case "needs-adoption-analysis":
      case "ambiguous":
        // Should have been resolved by firstSyncImpl before reaching here.
        throw new Error(
          `Internal: unresolved init action "${action.kind}" reached executor`,
        );

      case "regular-sync":
        // Both sides have a manifest — run the incremental sync. This is
        // what used to be the body of the old separate sync() method:
        // dispatch reaches it whenever no first-sync work is needed.
        await this.logger.info(
          "Dispatch: regular incremental sync",
        );
        await this.syncImpl();
        return;

      case "bootstrap-empty": {
        await this.logger.info("Init: bootstrap empty repo");
        await this.bootstrapEmptyRepo();
        return;
      }

      case "first-sync-from-local": {
        // bootstrapEmptyRepo returns the freshly-built RemoteState so
        // we skip the follow-up analyzeRemoteState that used to race
        // against GitHub's eventual consistency.
        const remote =
          action.remote.kind === "bare"
            ? await this.bootstrapEmptyRepo()
            : action.remote;
        await this.firstSyncFromLocal(remote.files, remote.treeSha);
        return;
      }

      case "first-sync-from-remote": {
        if (action.remote.kind === "bare") {
          // Resume + bare. Best we can do is bootstrap and exit.
          await this.bootstrapEmptyRepo();
          return;
        }
        await this.firstSyncFromRemote(
          action.remote.files,
          action.remote.treeSha,
        );
        return;
      }

      case "adopt": {
        if (action.remote.kind === "bare") {
          // Adoption only happens when both sides have content; bare remote
          // wouldn't have triggered analysis. Defensive fallback.
          await this.bootstrapEmptyRepo();
          return;
        }
        await this.adoptCurrentState(action.remote, action.analysis);
        // After adoption: locals-only need uploading and remotes-only need
        // downloading. Delegate to the regular sync — manifests are now in
        // place on both sides, so it'll behave as a normal incremental sync.
        if (
          action.analysis.localOnly.length > 0 ||
          action.analysis.remoteOnly.length > 0
        ) {
          this.updateProgress("Reconciling differences after adoption...");
          await this.syncImpl();
        }
        return;
      }
    }
  }

  /**
   * Bootstrap a bare GitHub repo by writing just the manifest as the
   * first commit. Uses the Git Data API directly so the operation is
   * atomic from our point of view: we know the new tree SHA without a
   * follow-up getRepoContent that could race against eventual
   * consistency. The earlier createFile-based bootstrap had us
   * round-tripping for that SHA and occasionally seeing stale tree
   * data, which broke the next commit.
   *
   * Returns the freshly-built RemoteState (always kind="has-manifest")
   * so callers don't have to re-analyze remote.
   */
  private async bootstrapEmptyRepo(): Promise<
    Extract<RemoteState, { kind: "has-manifest" }>
  > {
    const manifestPath = `${this.vault.configDir}/${MANIFEST_FILE_NAME}`;
    const manifestContent = JSON.stringify(this.metadataStore.data);

    const blob = await this.client.createBlob({
      content: arrayBufferToBase64(
        new TextEncoder().encode(manifestContent).buffer as ArrayBuffer,
      ),
      retry: true,
    });

    const treeSha = await this.client.createTree({
      tree: {
        // No base_tree — we're building the very first tree of this repo.
        tree: [
          {
            path: manifestPath,
            mode: "100644",
            type: "blob",
            sha: blob.sha,
          },
        ],
      },
      retry: true,
    });

    const commitSha = await this.client.createCommit({
      message: "First sync",
      treeSha,
      // No parent — root commit.
      retry: true,
    });

    await this.client.createReference({
      ref: `refs/heads/${this.settings.githubBranch}`,
      sha: commitSha,
      retry: true,
    });

    // Update local metadata so the manifest entry knows the SHA we just
    // pushed; otherwise the next sync would re-detect divergence.
    this.metadataStore.data.files[manifestPath] = {
      ...this.metadataStore.data.files[manifestPath],
      sha: blob.sha,
      lastModified: Date.now(),
    };
    await this.metadataStore.save();

    // Construct the RemoteState the caller would have re-fetched.
    return {
      kind: "has-manifest",
      treeSha,
      files: {
        [manifestPath]: {
          path: manifestPath,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
          size: manifestContent.length,
          url: "",
        },
      },
      manifest: this.metadataStore.data,
    };
  }

  /**
   * Adopt the current state of both sides as the sync baseline: build local
   * metadata to mirror remote SHAs (for identical paths) plus local-only
   * paths flagged for upload, push the manifest to remote so future syncs
   * have a reference point. Reconciliation of one-sided extras is done by
   * the caller via a follow-up regular sync.
   */
  private async adoptCurrentState(
    remote: RemoteState,
    analysis: AdoptionAnalysis,
  ): Promise<void> {
    if (remote.kind === "bare") return; // type-narrow only
    this.updateProgress("Adopting current state as sync baseline...");
    const manifestPath = `${this.vault.configDir}/${MANIFEST_FILE_NAME}`;
    const now = Date.now();
    const newFiles: { [path: string]: FileMetadata } = {};

    // Identical paths: use the local SHA we just computed (matches remote).
    for (const path of analysis.identical) {
      newFiles[path] = {
        path,
        sha: analysis.localFileSHAs[path],
        dirty: false,
        justDownloaded: false,
        lastModified: now,
      };
    }
    // Local-only: track but mark as needing upload (sha=null signals new).
    for (const path of analysis.localOnly) {
      newFiles[path] = {
        path,
        sha: null,
        dirty: true,
        justDownloaded: false,
        lastModified: now,
      };
    }
    // Remote-only: record remote SHA so determineSyncActions emits download.
    for (const path of analysis.remoteOnly) {
      newFiles[path] = {
        path,
        sha: remote.files[path].sha,
        dirty: false,
        justDownloaded: false,
        lastModified: now,
      };
    }
    // Manifest itself: tracked, no SHA yet (we'll write it next).
    newFiles[manifestPath] = {
      path: manifestPath,
      sha: null,
      dirty: false,
      justDownloaded: false,
      lastModified: now,
    };

    this.metadataStore.data.files = newFiles;
    await this.metadataStore.save();

    // Push the manifest to remote via Contents API — single commit that
    // adds our manifest to whatever's already there. After this, both
    // sides have a manifest and regular sync logic applies.
    const buffer = await this.vault.adapter.readBinary(
      normalizePath(manifestPath),
    );
    await this.client.createFile({
      path: manifestPath,
      content: arrayBufferToBase64(buffer),
      message: "Adopt existing vault state",
      retry: true,
    });
    await this.logger.info("Adoption committed", {
      identical: analysis.identical.length,
      localOnly: analysis.localOnly.length,
      remoteOnly: analysis.remoteOnly.length,
    });
  }

  /**
   * Handles first sync with the remote repository.
   * This must be called in case there are no files in the local content dir while
   * remote has files in the repo content dir but no manifest file.
   *
   * @param files All files in the remote repository, including those not in its content dir.
   * @param treeSha The SHA of the tree in the remote repository.
   */
  private async firstSyncFromRemote(
    files: { [key: string]: GetTreeResponseItem },
    treeSha: string,
  ) {
    const resuming = !!this.metadataStore.data.firstSyncFromRemoteInProgress;
    await this.logger.info("Starting first sync from remote files", {
      resume: resuming,
    });

    // Mark the operation as in progress so a crash mid-download lets us
    // resume on the next attempt instead of bailing on "vault not empty".
    this.metadataStore.data.firstSyncFromRemoteInProgress = true;
    await this.metadataStore.save();

    await this.downloadAllFilesViaAPI(files, resuming);
    await this.commitFirstSyncFromRemote(files, treeSha);
  }

  /**
   * Downloads files one by one via the GitHub blob API. Holds at most a
   * single blob in memory at a time, so memory stays low on every platform —
   * including Android WebView, where buffering a multi-MB archive OOMs.
   * Resumable: files already on disk with the matching SHA are skipped.
   */
  private async downloadAllFilesViaAPI(
    files: { [key: string]: GetTreeResponseItem },
    resuming: boolean,
  ) {
    const filePaths = Object.keys(files).filter((filePath: string) =>
      isSyncable(
        filePath,
        this.vault.configDir,
        this.settings.syncConfigDir,
        this.gitignoreCache,
      ),
    );

    await this.logger.info("Downloading files via API", {
      count: filePaths.length,
      resume: resuming,
    });

    const phaseLabel = resuming
      ? "Resuming vault initialization from GitHub"
      : "Initializing vault from GitHub";
    this.updateProgress(`${phaseLabel}: 0/${filePaths.length}`);

    const BATCH_SIZE = 5;
    let downloaded = 0;
    let skipped = 0;

    for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
      const batch = filePaths.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (filePath: string) => {
          const fileItem = files[filePath];
          const normalizedPath = normalizePath(filePath);

          // Resume support: if a previous attempt already wrote this file
          // with the same SHA, skip the network round-trip.
          const existing = this.metadataStore.data.files[normalizedPath];
          if (
            existing?.sha === fileItem.sha &&
            (await this.vault.adapter.exists(normalizedPath))
          ) {
            skipped++;
            return;
          }

          const blob = await this.client.getBlob({
            sha: fileItem.sha,
            retry: true,
          });
          const dir = normalizedPath.split("/").slice(0, -1).join("/");
          if (dir !== "" && !(await this.vault.adapter.exists(dir))) {
            await this.vault.adapter.mkdir(dir);
          }
          await this.vault.adapter.writeBinary(
            normalizedPath,
            base64ToArrayBuffer(blob.content),
          );
          this.metadataStore.data.files[normalizedPath] = {
            path: normalizedPath,
            sha: fileItem.sha,
            dirty: false,
            justDownloaded: true,
            lastModified: Date.now(),
          };
          downloaded++;
        }),
      );
      // Persist after each batch so a crash mid-sync preserves progress.
      await this.metadataStore.save();

      const processed = Math.min(i + BATCH_SIZE, filePaths.length);
      const skipSuffix = skipped > 0 ? ` (skipped ${skipped})` : "";
      this.updateProgress(
        `${phaseLabel}: ${processed}/${filePaths.length}${skipSuffix}`,
      );
      if ((i / BATCH_SIZE) % 5 === 0 || processed >= filePaths.length) {
        await this.logger.info("Download progress", {
          processed,
          total: filePaths.length,
          downloaded,
          skipped,
        });
      }
    }

    await this.logger.info("Downloaded all files via API", {
      downloaded,
      skipped,
      total: filePaths.length,
    });
  }

  /**
   * After all remote files have been written locally, build the new tree,
   * include any locally-only files, clear the in-progress flag, and push the
   * commit that establishes the manifest on the remote.
   */
  private async commitFirstSyncFromRemote(
    files: { [key: string]: GetTreeResponseItem },
    treeSha: string,
  ) {
    this.updateProgress("Committing initial sync to GitHub...");
    const newTreeFiles = Object.keys(files)
      .map((filePath: string) => ({
        path: files[filePath].path,
        mode: files[filePath].mode,
        type: files[filePath].type,
        sha: files[filePath].sha,
      }))
      .reduce(
        (
          acc: { [key: string]: NewTreeRequestItem },
          item: NewTreeRequestItem,
        ) => ({ ...acc, [item.path]: item }),
        {},
      );
    // Add files that are in the manifest but not in the tree.
    await Promise.all(
      Object.keys(this.metadataStore.data.files)
        .filter((filePath: string) => {
          return !Object.keys(files).contains(filePath);
        })
        .map(async (filePath: string) => {
          const normalizedPath = normalizePath(filePath);
          // We need to check whether the file is a text file or not before
          // reading it here because trying to read a binary file as text fails
          // on iOS, and probably on other mobile devices too, so we read the file
          // content only if we're sure it contains text only.
          //
          // It's fine not reading the binary file in here and just setting some bogus
          // content because when committing the sync we're going to read the binary
          // file and upload its blob if it needs to be synced. The important thing is
          // that some content is set so we know the file changed locally and needs to be
          // uploaded.
          let content = "binaryfile";
          if (hasTextExtension(normalizedPath)) {
            content = await this.vault.adapter.read(normalizedPath);
          }
          newTreeFiles[filePath] = {
            path: filePath,
            mode: "100644",
            type: "blob",
            content,
          };
        }),
    );

    // Clear the resume flag before commit; commitSync writes the in-memory
    // metadata into the new tree manifest, so the remote will reflect the
    // completed state.
    this.metadataStore.data.firstSyncFromRemoteInProgress = false;
    await this.commitSync(newTreeFiles, treeSha);
  }

  /**
   * Handles first sync with the remote repository.
   * This must be called in case there are no files in the remote repo and no manifest while
   * local vault has files and a manifest.
   *
   * @param files All files in the remote repository
   * @param treeSha The SHA of the tree in the remote repository.
   */
  private async firstSyncFromLocal(
    files: { [key: string]: GetTreeResponseItem },
    treeSha: string,
  ) {
    const resuming = !!this.metadataStore.data.firstSyncFromLocalInProgress;
    await this.logger.info("Starting first sync from local files", {
      resume: resuming,
    });
    // Mark in-progress and persist before the first risky operation. A
    // crash mid-upload leaves this true on disk; the next plugin load
    // sees it via the resume marker and re-enters this path.
    this.metadataStore.data.firstSyncFromLocalInProgress = true;
    await this.metadataStore.save();

    this.updateProgress(
      resuming
        ? "Resuming GitHub init from vault: preparing files..."
        : "Initializing GitHub from vault: preparing files...",
    );
    const newTreeFiles = Object.keys(files)
      .map((filePath: string) => ({
        path: files[filePath].path,
        mode: files[filePath].mode,
        type: files[filePath].type,
        sha: files[filePath].sha,
      }))
      .reduce(
        (
          acc: { [key: string]: NewTreeRequestItem },
          item: NewTreeRequestItem,
        ) => ({ ...acc, [item.path]: item }),
        {},
      );
    await Promise.all(
      Object.keys(this.metadataStore.data.files)
        .filter((filePath: string) => {
          // We should not try to sync deleted files, this can happen when
          // the user renames or deletes files after enabling the plugin but
          // before syncing for the first time
          if (this.metadataStore.data.files[filePath].deleted) return false;
          // Apply the unified sync rules so files left over in metadata from
          // before the rules tightened (e.g. plugin source, .DS_Store, log
          // file) don't get pushed up.
          return isSyncable(
            filePath,
            this.vault.configDir,
            this.settings.syncConfigDir,
            this.gitignoreCache,
          );
        })
        .map(async (filePath: string) => {
          const normalizedPath = normalizePath(filePath);
          // We need to check whether the file is a text file or not before
          // reading it here because trying to read a binary file as text fails
          // on iOS, and probably on other mobile devices too, so we read the file
          // content only if we're sure it contains text only.
          //
          // It's fine not reading the binary file in here and just setting some bogus
          // content because when committing the sync we're going to read the binary
          // file and upload its blob if it needs to be synced. The important thing is
          // that some content is set so we know the file changed locally and needs to be
          // uploaded.
          let content = "binaryfile";
          if (hasTextExtension(normalizedPath)) {
            content = await this.vault.adapter.read(normalizedPath);
          }
          newTreeFiles[filePath] = {
            path: filePath,
            mode: "100644",
            type: "blob",
            content,
          };
        }),
    );
    this.updateProgress(
      resuming
        ? "Resuming GitHub init from vault: uploading..."
        : "Initializing GitHub from vault: uploading...",
    );
    // Clear the resume marker before commit. commitSync writes the
    // in-memory metadata to disk at the end, so a successful commit
    // persists flag=false. A crash before then leaves the on-disk
    // value untouched (still true), so resume detection still kicks in.
    this.metadataStore.data.firstSyncFromLocalInProgress = false;
    await this.commitSync(newTreeFiles, treeSha, [], { showProgress: true });
  }

  /**
   * Sync local and remote. Single public entry point: this method analyses
   * the current state of both sides and routes to the right flow itself
   * (bootstrap, first-sync-from-local, first-sync-from-remote, adoption,
   * or incremental sync) — callers no longer need to track whether this
   * is "first" sync or a regular one.
   */
  async sync() {
    if (this.syncing) {
      this.logger.info("Sync already in progress");
      return;
    }

    this.syncing = true;
    // Pass 0 so the notice stays until we hide it explicitly. Without this
    // a long sync (lots of files / slow link) silently lost the toast after
    // ~5 s and the user saw nothing happening until "Sync successful" at
    // the end.
    this.progressNotice = new Notice("Preparing sync...", 0);
    try {
      await this.gitignoreCache.refreshIfChanged();
      await this.dispatchSync();
      new Notice("Sync successful", 5000);
    } catch (err) {
      new Notice(`Error syncing. ${err}`);
    } finally {
      this.syncing = false;
      this.progressNotice?.hide();
      this.progressNotice = null;
    }
  }

  private async syncImpl() {
    await this.logger.info("Starting incremental sync");
    // dispatchSync set "Analyzing repository state..." already; syncImpl
    // doesn't need to repeat it.
    const { files, sha: treeSha } = await this.client.getRepoContent({
      retry: true,
    });
    const manifest = files[`${this.vault.configDir}/${MANIFEST_FILE_NAME}`];

    if (manifest === undefined) {
      // Log only counts and a few sample paths — the full files map can be
      // megabytes on a large repo.
      await this.logger.error("Remote manifest is missing", {
        treeSha,
        fileCount: Object.keys(files).length,
        samplePaths: Object.keys(files).slice(0, 10),
      });
      throw new Error("Remote manifest is missing");
    }

    if (
      Object.keys(files).contains(`${this.vault.configDir}/${LOG_FILE_NAME}`)
    ) {
      // We don't want to download the log file if the user synced it in the past.
      // This is necessary because in the past we forgot to ignore the log file
      // from syncing if the user enabled configs sync.
      // To avoid downloading it we delete it if still around.
      delete files[`${this.vault.configDir}/${LOG_FILE_NAME}`];
    }

    const blob = await this.client.getBlob({ sha: manifest.sha });
    const remoteMetadata: Metadata = JSON.parse(
      decodeBase64String(blob.content),
    );

    // Reconcile manifest against the actual tree. The manifest only records
    // what the *previous* commit chose to track — files that were filtered
    // out at the time (e.g. because syncConfigDir was off, or rules differed)
    // remain in the tree but are absent from the manifest. Without this step
    // determineSyncActions never proposes downloading them, so toggling
    // syncConfigDir on or relaxing a rule wouldn't pull anything new from
    // the remote. Synthesize manifest entries for those files so they enter
    // the action pipeline; isSyncable still filters at the end.
    let reconciled = 0;
    for (const filePath of Object.keys(files)) {
      if (filePath in remoteMetadata.files) continue;
      remoteMetadata.files[filePath] = {
        path: filePath,
        sha: files[filePath].sha,
        dirty: false,
        justDownloaded: false,
        lastModified: Date.now(),
      };
      reconciled++;
    }
    if (reconciled > 0) {
      await this.logger.info("Reconciled tree files into manifest view", {
        added: reconciled,
        manifestSize: Object.keys(remoteMetadata.files).length,
      });
    }

    // Find diverged files, classified into atomic (binary, plugin .js, or
    // text-with-undiffable-content) vs text (small text files where a side-
    // by-side merge actually makes sense).
    const diverged = await this.findDivergedPaths(remoteMetadata.files);
    const atomicDiverged = diverged.filter((d) => d.category !== "text");
    const textDiverged = diverged.filter((d) => d.category === "text");

    if (diverged.length > 0) {
      await this.logger.warn("Found conflicts", {
        total: diverged.length,
        atomic: atomicDiverged.length,
        text: textDiverged.length,
        paths: diverged.map((d) => `${d.category}:${d.filePath}`),
      });
    }

    // Atomic conflicts auto-resolve here — no user UI, no prompt. Each
    // emits a sync action and (for binary / opt-in plugin .js) a local
    // backup of the loser side.
    let conflictActions: SyncAction[] = [];
    if (atomicDiverged.length > 0) {
      this.updateProgress(
        `Resolving conflicts: ${atomicDiverged.length} file(s)...`,
      );
      conflictActions = await this.resolveAtomicConflicts(
        atomicDiverged,
        files,
        remoteMetadata,
      );
    }

    // Text conflicts go through whichever resolution mode the user picked.
    // We keep ConflictResolution records for "ask" mode so commitSync can
    // upload exactly what the user merged, even though the local file isn't
    // updated until after the remote commit succeeds.
    let conflictResolutions: ConflictResolution[] = [];
    if (textDiverged.length > 0) {
      const textPaths = textDiverged.map((d) => d.filePath);
      if (this.settings.conflictHandling === "ask") {
        this.updateProgress(
          `Waiting for you to resolve ${textPaths.length} conflict(s)...`,
        );
        const textConflicts = await this.loadTextConflictContents(
          textPaths,
          remoteMetadata.files,
        );
        conflictResolutions = await this.onConflicts(textConflicts);
        conflictActions.push(
          ...conflictResolutions.map(
            (r: ConflictResolution): SyncAction => ({
              type: "upload",
              filePath: r.filePath,
            }),
          ),
        );
      } else if (this.settings.conflictHandling === "overwriteLocal") {
        conflictActions.push(
          ...textPaths.map(
            (p): SyncAction => ({ type: "download", filePath: p }),
          ),
        );
      } else if (this.settings.conflictHandling === "overwriteRemote") {
        conflictActions.push(
          ...textPaths.map(
            (p): SyncAction => ({ type: "upload", filePath: p }),
          ),
        );
      }
    }

    const actions: SyncAction[] = [
      ...(await this.determineSyncActions(
        remoteMetadata.files,
        this.metadataStore.data.files,
        conflictActions.map((action) => action.filePath),
      )),
      ...conflictActions,
    ];

    if (actions.length === 0) {
      // Nothing to sync
      await this.logger.info("Nothing to sync");
      return;
    }
    // Summarize: full action arrays can be tens of thousands of entries
    // (esp. with syncConfigDir on) and previously bloated logs to hundreds
    // of MB per sync. Counts + a small sample preserves diagnostic value.
    const actionsByType = actions.reduce(
      (acc: { [key: string]: number }, a) => {
        acc[a.type] = (acc[a.type] ?? 0) + 1;
        return acc;
      },
      {},
    );
    await this.logger.info("Actions to sync", {
      total: actions.length,
      byType: actionsByType,
      sample: actions.slice(0, 10),
    });
    const newTreeFiles: { [key: string]: NewTreeRequestItem } = Object.keys(
      files,
    )
      .map((filePath: string) => ({
        path: files[filePath].path,
        mode: files[filePath].mode,
        type: files[filePath].type,
        sha: files[filePath].sha,
      }))
      .reduce(
        (
          acc: { [key: string]: NewTreeRequestItem },
          item: NewTreeRequestItem,
        ) => ({ ...acc, [item.path]: item }),
        {},
      );

    await Promise.all(
      actions.map(async (action) => {
        switch (action.type) {
          case "upload": {
            const normalizedPath = normalizePath(action.filePath);
            const resolution = conflictResolutions.find(
              (c: ConflictResolution) => c.filePath === action.filePath,
            );
            // If the file was conflicting we need to read the content from the
            // conflict resolution instead of reading it from file since at this point
            // we still have not updated the local file.
            let content: string;
            if (resolution) {
              content = resolution.content;
            } else if (await this.vault.adapter.exists(normalizedPath)) {
              content = await this.vault.adapter.read(normalizedPath);
            } else {
              // Stale metadata: file is in our tracking but not on disk. Skip
              // rather than crash; the sync continues for the remaining actions.
              await this.logger.warn(
                "Skip upload: local file missing",
                { filePath: action.filePath },
              );
              return;
            }
            newTreeFiles[action.filePath] = {
              path: action.filePath,
              mode: "100644",
              type: "blob",
              content: content,
            };
            break;
          }
          case "delete_remote": {
            // Same defensive check: if the path isn't in the current tree
            // there's nothing to delete remotely. Either it was already gone
            // or our metadata is out of step with reality.
            if (!newTreeFiles[action.filePath]) {
              await this.logger.warn(
                "Skip delete_remote: file not in remote tree",
                { filePath: action.filePath },
              );
              break;
            }
            newTreeFiles[action.filePath].sha = null;
            break;
          }
          case "download":
            break;
          case "delete_local":
            break;
        }
      }),
    );

    // Download files and delete local files
    const downloadActions = actions.filter((a) => a.type === "download");
    const deleteLocalActions = actions.filter(
      (a) => a.type === "delete_local",
    );
    if (downloadActions.length > 0) {
      this.updateProgress(
        `Downloading from GitHub: 0/${downloadActions.length}`,
      );
    }
    let downloaded = 0;
    await Promise.all([
      ...downloadActions.map(async (action: SyncAction) => {
        const remoteFile = files[action.filePath];
        if (!remoteFile) {
          // Path is in metadata but absent from the current remote tree —
          // happens when rules tightened and a previously-tracked file is
          // no longer being uploaded. Skip the download silently.
          await this.logger.warn(
            "Skip download: file not in remote tree",
            { filePath: action.filePath },
          );
          return;
        }
        await this.downloadFile(
          remoteFile,
          remoteMetadata.files[action.filePath]?.lastModified ?? Date.now(),
        );
        downloaded++;
        if (
          downloaded % 5 === 0 ||
          downloaded === downloadActions.length
        ) {
          this.updateProgress(
            `Downloading from GitHub: ${downloaded}/${downloadActions.length}`,
          );
        }
      }),
      ...deleteLocalActions.map(async (action: SyncAction) => {
        await this.deleteLocalFile(action.filePath);
      }),
    ]);

    this.updateProgress("Committing sync to GitHub...");
    await this.commitSync(newTreeFiles, treeSha, conflictResolutions, {
      showProgress: true,
    });
  }

  /**
   * Finds files where local and remote diverged since the last sync,
   * and classifies each one. Local content is read once per file (for SHA
   * + classification), so the categorization is content-aware: a file with
   * a .json extension but a 5 MB single-line dump comes back as "binary"
   * and bypasses the manual diff UI.
   */
  async findDivergedPaths(filesMetadata: {
    [key: string]: FileMetadata;
  }): Promise<{ filePath: string; category: ConflictCategory }[]> {
    const commonFiles = Object.keys(filesMetadata)
      .filter((key) => key in this.metadataStore.data.files)
      // Skip non-syncable paths up front. Without this, files that USED to
      // be synced (and so are still in both manifests) but are now blocked
      // by isSyncable rules — e.g. community-plugins.json after we added it
      // to the blocklist — get treated as conflicts. The conflict pipeline
      // then tries to fetch their remote blob and crashes (often with a
      // null-SHA 422 from GitHub).
      .filter((filePath) =>
        isSyncable(
          filePath,
          this.vault.configDir,
          this.settings.syncConfigDir,
          this.gitignoreCache,
        ),
      );
    if (commonFiles.length === 0) {
      return [];
    }

    const results = await Promise.all(
      commonFiles.map(async (filePath: string) => {
        if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
          // The manifest file is only internal, the user must not
          // handle conflicts for this.
          return null;
        }
        const remoteFile = filesMetadata[filePath];
        const localFile = this.metadataStore.data.files[filePath];
        if (remoteFile.deleted && localFile.deleted) {
          return null;
        }

        const normalizedPath = normalizePath(filePath);
        const localExists = await this.vault.adapter.exists(normalizedPath);
        let localBuffer: ArrayBuffer | null = null;
        let actualLocalSHA: string | null = null;
        if (localExists) {
          localBuffer = await this.vault.adapter.readBinary(normalizedPath);
          const bytes = new Uint8Array(localBuffer);
          const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
          const store = new Uint8Array([...header, ...bytes]);
          const hash = await crypto.subtle.digest("SHA-1", store);
          actualLocalSHA = Array.from(new Uint8Array(hash))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
        }

        const remoteFileHasBeenModifiedSinceLastSync =
          remoteFile.sha !== localFile.sha;
        const localFileHasBeenModifiedSinceLastSync =
          actualLocalSHA !== localFile.sha;
        // Identical content with a stale local SHA isn't a real conflict.
        const actualFilesAreDifferent = remoteFile.sha !== actualLocalSHA;
        if (
          !(
            remoteFileHasBeenModifiedSinceLastSync &&
            localFileHasBeenModifiedSinceLastSync &&
            actualFilesAreDifferent
          )
        ) {
          return null;
        }

        const category = classifyForConflict(
          filePath,
          this.vault.configDir,
          localBuffer,
        );
        return { filePath, category };
      }),
    );
    return results.filter(
      (r): r is { filePath: string; category: ConflictCategory } => r !== null,
    );
  }

  /**
   * Loads side-by-side text contents for files that need a manual merge.
   * Only call for `category === "text"` paths — binary / huge files would
   * be garbled by the text decoder and the side-by-side editor.
   */
  async loadTextConflictContents(
    paths: string[],
    filesMetadata: { [key: string]: FileMetadata },
  ): Promise<ConflictFile[]> {
    const results = await Promise.all(
      paths.map(async (filePath: string): Promise<ConflictFile | null> => {
        const remoteSha = filesMetadata[filePath]?.sha;
        // A null/missing remote SHA means the manifest entry was never
        // populated (legacy state from before the file was upload-tracked
        // properly). We can't fetch the blob without a real SHA — skip
        // the conflict gracefully rather than letting GitHub 422 crash sync.
        if (!remoteSha) {
          await this.logger.warn(
            "Skip text conflict: remote SHA missing in manifest",
            { filePath },
          );
          return null;
        }
        const [remoteContent, localContent] = await Promise.all([
          (async () => {
            const res = await this.client.getBlob({
              sha: remoteSha,
              retry: true,
              maxRetries: 1,
            });
            return decodeBase64String(res.content);
          })(),
          this.vault.adapter.read(normalizePath(filePath)),
        ]);
        return { filePath, remoteContent, localContent };
      }),
    );
    return results.filter((r): r is ConflictFile => r !== null);
  }

  /**
   * Auto-resolve atomic conflicts (plugin .js bundles + binary files) without
   * showing the conflict UI. Returns sync actions that the main pipeline can
   * apply, and writes loser-side backups to disk where appropriate.
   */
  async resolveAtomicConflicts(
    paths: { filePath: string; category: ConflictCategory }[],
    treeFiles: { [key: string]: GetTreeResponseItem },
    remoteMetadata: Metadata,
  ): Promise<SyncAction[]> {
    const actions: SyncAction[] = [];
    for (const { filePath, category } of paths) {
      if (category === "text") continue;

      const decision = await this.decideAtomicWinner(
        filePath,
        category,
        treeFiles,
        remoteMetadata,
      );

      // Decide whether to keep a loser-side backup. Binary files always do —
      // losing a screenshot or a PDF silently is worse than a tidy folder.
      // Plugin .js opt-in via setting; keeps plugin folders clean by default.
      const keepBackup =
        category === "binary" ||
        (category === "plugin-js" && this.settings.keepPluginConflictCopy);

      if (keepBackup) {
        await this.writeAtomicConflictBackup(
          filePath,
          decision.winner === "local" ? "remote" : "local",
          treeFiles,
        );
      }

      actions.push({
        type: decision.winner === "local" ? "upload" : "download",
        filePath,
      });

      await this.logger.info("Atomic conflict resolved", {
        filePath,
        category,
        winner: decision.winner,
        reason: decision.reason,
        backupKept: keepBackup,
      });
    }
    return actions;
  }

  private async decideAtomicWinner(
    filePath: string,
    category: ConflictCategory,
    treeFiles: { [key: string]: GetTreeResponseItem },
    remoteMetadata: Metadata,
  ): Promise<{ winner: "local" | "remote"; reason: string }> {
    if (category === "plugin-js") {
      const versionDecision = await this.compareByPluginVersion(
        filePath,
        treeFiles,
      );
      if (versionDecision) return versionDecision;
    }
    // Tie or non-plugin-js → fall back to timestamps, then local-wins.
    const localFile = this.metadataStore.data.files[filePath];
    const remoteFile = remoteMetadata.files[filePath];
    const localTs = localFile?.lastModified ?? 0;
    const remoteTs = remoteFile?.lastModified ?? 0;
    if (localTs > remoteTs) {
      return {
        winner: "local",
        reason: `local newer by timestamp (${localTs} > ${remoteTs})`,
      };
    }
    if (remoteTs > localTs) {
      return {
        winner: "remote",
        reason: `remote newer by timestamp (${remoteTs} > ${localTs})`,
      };
    }
    return { winner: "local", reason: "tie, default to local" };
  }

  private async compareByPluginVersion(
    filePath: string,
    treeFiles: { [key: string]: GetTreeResponseItem },
  ): Promise<{ winner: "local" | "remote"; reason: string } | null> {
    const pluginId = pluginIdFromPath(filePath, this.vault.configDir);
    if (!pluginId) return null;
    const manifestPath = `${this.vault.configDir}/plugins/${pluginId}/manifest.json`;

    let localVersion: string | null = null;
    let remoteVersion: string | null = null;

    if (await this.vault.adapter.exists(normalizePath(manifestPath))) {
      try {
        const text = await this.vault.adapter.read(normalizePath(manifestPath));
        localVersion = JSON.parse(text)?.version ?? null;
      } catch {
        // ignore — fall through to timestamp comparison
      }
    }

    const remoteManifestItem = treeFiles[manifestPath];
    if (remoteManifestItem) {
      try {
        const blob = await this.client.getBlob({
          sha: remoteManifestItem.sha,
          retry: true,
          maxRetries: 1,
        });
        remoteVersion =
          JSON.parse(decodeBase64String(blob.content))?.version ?? null;
      } catch {
        // ignore — fall through to timestamp comparison
      }
    }

    if (!localVersion || !remoteVersion) return null;

    const cmp = compareSemver(localVersion, remoteVersion);
    if (cmp > 0) {
      return {
        winner: "local",
        reason: `local v${localVersion} > remote v${remoteVersion}`,
      };
    }
    if (cmp < 0) {
      return {
        winner: "remote",
        reason: `remote v${remoteVersion} > local v${localVersion}`,
      };
    }
    return null; // equal — caller falls back to timestamp
  }

  /**
   * Writes the loser side of an atomic conflict next to the winner, named
   * `<base>.conflict-(local|remote)-<isoTimestamp>.<ext>`. The backup pattern
   * is excluded by isSyncable, so these copies stay strictly local.
   */
  private async writeAtomicConflictBackup(
    filePath: string,
    loserSide: "local" | "remote",
    treeFiles: { [key: string]: GetTreeResponseItem },
  ): Promise<void> {
    const backupPath = normalizePath(conflictBackupPath(filePath, loserSide));

    let loserContent: ArrayBuffer;
    if (loserSide === "remote") {
      const remoteItem = treeFiles[filePath];
      if (!remoteItem) {
        await this.logger.warn(
          "Skip backup: file not in remote tree",
          { filePath, loserSide },
        );
        return;
      }
      const blob = await this.client.getBlob({
        sha: remoteItem.sha,
        retry: true,
      });
      loserContent = base64ToArrayBuffer(blob.content);
    } else {
      const normalizedPath = normalizePath(filePath);
      if (!(await this.vault.adapter.exists(normalizedPath))) {
        await this.logger.warn(
          "Skip backup: file missing locally",
          { filePath, loserSide },
        );
        return;
      }
      loserContent = await this.vault.adapter.readBinary(normalizedPath);
    }

    await this.vault.adapter.writeBinary(backupPath, loserContent);
    await this.logger.info("Wrote conflict backup", {
      backupPath,
      loserSide,
    });
  }

  /**
   * Determines which sync action to take for each file.
   *
   * @param remoteFiles All files in the remote repo
   * @param localFiles All files in the local vault
   * @param conflictFiles List of paths to files that have conflict with remote
   *
   * @returns List of SyncActions
   */
  async determineSyncActions(
    remoteFiles: { [key: string]: FileMetadata },
    localFiles: { [key: string]: FileMetadata },
    conflictFiles: string[],
  ) {
    let actions: SyncAction[] = [];

    const commonFiles = Object.keys(remoteFiles)
      .filter((filePath) => filePath in localFiles)
      // Remove conflicting files, we determine their actions in a different way
      .filter((filePath) => !conflictFiles.contains(filePath));

    // Get diff for common files
    await Promise.all(
      commonFiles.map(async (filePath: string) => {
        if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
          // The manifest file must never trigger any action
          return;
        }

        const remoteFile = remoteFiles[filePath];
        const localFile = localFiles[filePath];
        if (remoteFile.deleted && localFile.deleted) {
          // Nothing to do
          return;
        }

        const localSHA = await this.calculateSHA(filePath);
        if (remoteFile.sha === localSHA) {
          // If the remote file sha is identical to the actual sha of the local file
          // there are no actions to take.
          // We calculate the SHA at the moment instead of using the one stored in the
          // metadata file cause we update that only when the file is uploaded or downloaded.
          return;
        }

        if (remoteFile.deleted && !localFile.deleted) {
          if ((remoteFile.deletedAt as number) > localFile.lastModified) {
            actions.push({
              type: "delete_local",
              filePath: filePath,
            });
            return;
          } else if (
            localFile.lastModified > (remoteFile.deletedAt as number)
          ) {
            actions.push({ type: "upload", filePath: filePath });
            return;
          }
        }

        if (!remoteFile.deleted && localFile.deleted) {
          if (remoteFile.lastModified > (localFile.deletedAt as number)) {
            actions.push({ type: "download", filePath: filePath });
            return;
          } else if (
            (localFile.deletedAt as number) > remoteFile.lastModified
          ) {
            actions.push({
              type: "delete_remote",
              filePath: filePath,
            });
            return;
          }
        }

        // For non-deletion cases, if SHAs differ, we just need to check if local changed.
        // Conflicts are already filtered out so we can make this decision easily
        if (localSHA !== localFile.sha) {
          actions.push({ type: "upload", filePath: filePath });
          return;
        } else {
          actions.push({ type: "download", filePath: filePath });
          return;
        }
      }),
    );

    // Get diff for files in remote but not in local
    Object.keys(remoteFiles).forEach((filePath: string) => {
      const remoteFile = remoteFiles[filePath];
      const localFile = localFiles[filePath];
      if (localFile) {
        // Local file exists, we already handled it.
        // Skip it.
        return;
      }
      if (remoteFile.deleted) {
        // Remote is deleted but we don't have it locally.
        // Nothing to do.
        // TODO: Maybe we need to remove remote reference too?
      } else {
        actions.push({ type: "download", filePath: filePath });
      }
    });

    // Get diff for files in local but not in remote
    Object.keys(localFiles).forEach((filePath: string) => {
      const remoteFile = remoteFiles[filePath];
      const localFile = localFiles[filePath];
      if (remoteFile) {
        // Remote file exists, we already handled it.
        // Skip it.
        return;
      }
      if (localFile.deleted) {
        // Local is deleted and remote doesn't exist.
        // Just remove the local reference.
      } else {
        actions.push({ type: "upload", filePath: filePath });
      }
    });

    // Apply the unified sync rules: drops actions for the log file,
    // workspace.json, junk like .DS_Store, plugin-folder noise, and the
    // configDir-when-disabled case all in one place.
    return actions.filter((action: SyncAction) =>
      isSyncable(
        action.filePath,
        this.vault.configDir,
        this.settings.syncConfigDir,
        this.gitignoreCache,
      ),
    );
  }

  /**
   * Calculates the SHA1 of a file given its content.
   * This is the same identical algoritm used by git to calculate
   * a blob's SHA.
   * @param filePath normalized path to file
   * @returns String containing the file SHA1 or null in case the file doesn't exist
   */
  async calculateSHA(filePath: string): Promise<string | null> {
    if (!(await this.vault.adapter.exists(filePath))) {
      // The file doesn't exist, can't calculate any SHA
      return null;
    }
    const contentBuffer = await this.vault.adapter.readBinary(filePath);
    const contentBytes = new Uint8Array(contentBuffer);
    const header = new TextEncoder().encode(`blob ${contentBytes.length}\0`);
    const store = new Uint8Array([...header, ...contentBytes]);
    return await crypto.subtle.digest("SHA-1", store).then((hash) =>
      Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
  }

  /**
   * Creates a new sync commit in the remote repository.
   *
   * @param treeFiles Updated list of files in the remote tree
   * @param baseTreeSha sha of the tree to use as base for the new tree
   * @param conflictResolutions list of conflicts between remote and local files
   */
  async commitSync(
    treeFiles: { [key: string]: NewTreeRequestItem },
    baseTreeSha: string,
    conflictResolutions: ConflictResolution[] = [],
    options: { showProgress?: boolean } = {},
  ) {
    // Update local sync time
    const syncTime = Date.now();
    this.metadataStore.data.lastSync = syncTime;
    this.metadataStore.save();

    // We update the last modified timestamp for all files that had resolved conflicts
    // to the the same time as the sync time.
    // At this time we still have not written the conflict resolution content to file,
    // so the last modified timestamp doesn't reflect that.
    // To prevent further conflicts in future syncs and to reflect the content change
    // on the remote metadata we update the timestamp for the conflicting files here,
    // just before pushing to remote.
    // We're going to update the local content when the sync is successful.
    conflictResolutions.forEach((resolution) => {
      this.metadataStore.data.files[resolution.filePath].lastModified =
        syncTime;
    });

    // We want the remote metadata file to track the correct SHA for each file blob,
    // so just before we upload any file we update all their SHAs in the metadata file.
    // This also makes it easier to handle conflicts.
    // We don't save the metadata file after setting the SHAs cause we do that when
    // the sync is fully commited at the end.
    // TODO: Understand whether it's a problem we don't revert the SHA setting in case of sync failure
    //
    // In here we also upload blob is file is a binary. We do it here because when uploading a blob we
    // also get back its SHA, so we can set it together with other files.
    // We also do that right before creating the new tree because we need the SHAs of those blob to
    // correctly create it.
    const filesToUpload = Object.keys(treeFiles).filter(
      (filePath: string) => treeFiles[filePath].content,
    );
    const binariesToUpload = filesToUpload.filter(
      (p) => !hasTextExtension(p),
    );
    // Progress updates are opt-in via options.showProgress so the firstSync
    // pathways (which set their own dedicated phase messages) stay quiet
    // here and don't get the "Uploading binaries" counter overwriting them.
    if (options.showProgress && binariesToUpload.length > 0) {
      this.updateProgress(
        `Uploading binaries to GitHub: 0/${binariesToUpload.length}`,
      );
    }
    let binariesUploaded = 0;
    let binariesSkipped = 0;
    await Promise.all(
      filesToUpload.map(async (filePath: string) => {
        // I don't fully trust file extensions as they're not completely reliable
        // to determine the file type, though I feel it's ok to compromise and rely
        // on them if it makes the plugin handle upload better on certain devices.
        if (hasTextExtension(filePath)) {
          const sha = await this.calculateSHA(filePath);
          this.metadataStore.data.files[filePath].sha = sha;
          return;
        }

        // Resume optimization: a previous (possibly interrupted) sync
        // already pushed this binary to GitHub, and the local file
        // hasn't changed since. The Git blob SHA is content-addressed,
        // so a match means the upload is still valid — reuse the SHA
        // and skip the createBlob round-trip.
        const buffer = await this.vault.adapter.readBinary(filePath);
        const currentSha = await calculateGitBlobSHA(buffer);
        const previousSha = this.metadataStore.data.files[filePath]?.sha;
        if (previousSha && previousSha === currentSha) {
          treeFiles[filePath].sha = previousSha;
          delete treeFiles[filePath].content;
          binariesSkipped++;
          return;
        }

        // Upload via createBlob.
        const { sha } = await this.client.createBlob({
          content: arrayBufferToBase64(buffer),
          retry: true,
          maxRetries: 3,
        });
        await this.logger.info("Created blob", filePath);
        treeFiles[filePath].sha = sha;
        delete treeFiles[filePath].content;
        this.metadataStore.data.files[filePath].sha = sha;
        // Persist progress so the next attempt (after a crash here) can
        // skip what we already finished.
        await this.metadataStore.save();

        binariesUploaded++;
        if (
          options.showProgress &&
          (binariesUploaded % 5 === 0 ||
            binariesUploaded === binariesToUpload.length)
        ) {
          const skipNote = binariesSkipped > 0 ? ` (skipped ${binariesSkipped})` : "";
          this.updateProgress(
            `Uploading binaries to GitHub: ${binariesUploaded}/${binariesToUpload.length}${skipNote}`,
          );
        }
      }),
    );
    if (binariesSkipped > 0) {
      await this.logger.info("Resume: skipped binaries already uploaded", {
        skipped: binariesSkipped,
        uploaded: binariesUploaded,
        total: binariesToUpload.length,
      });
    }

    // Always set the manifest entry from the current in-memory metadata.
    // commitSync owns this: callers no longer have to remember to populate
    // it (and used to crash with TypeError when the entry was missing).
    // We strip the per-device resume markers — they're local progress
    // state, not shared between machines, so the remote manifest must
    // never carry them.
    const manifestPath = `${this.vault.configDir}/${MANIFEST_FILE_NAME}`;
    const manifestForRemote = { ...this.metadataStore.data };
    delete manifestForRemote.firstSyncFromRemoteInProgress;
    delete manifestForRemote.firstSyncFromLocalInProgress;
    treeFiles[manifestPath] = {
      path: manifestPath,
      mode: "100644",
      type: "blob",
      content: JSON.stringify(manifestForRemote),
    };

    // Create the new tree
    const newTree: { tree: NewTreeRequestItem[]; base_tree: string } = {
      tree: Object.keys(treeFiles).map(
        (filePath: string) => treeFiles[filePath],
      ),
      base_tree: baseTreeSha,
    };
    const newTreeSha = await this.client.createTree({
      tree: newTree,
      retry: true,
    });

    const branchHeadSha = await this.client.getBranchHeadSha({ retry: true });

    const commitSha = await this.client.createCommit({
      // TODO: Make this configurable or find a nicer commit message
      message: "Sync",
      treeSha: newTreeSha,
      parent: branchHeadSha,
    });

    await this.client.updateBranchHead({ sha: commitSha, retry: true });

    // Update the local content of all files that had conflicts we resolved
    await Promise.all(
      conflictResolutions.map(async (resolution) => {
        await this.vault.adapter.write(resolution.filePath, resolution.content);
        // Even though we set the last modified timestamp for all files with conflicts
        // just before pushing the changes to remote we do it here again because the
        // write right above would overwrite that.
        // Since we want to keep the sync timestamp for this file to avoid future conflicts
        // we update it again.
        this.metadataStore.data.files[resolution.filePath].lastModified =
          syncTime;
      }),
    );
    // Now that the sync is done and we updated the content for conflicting files
    // we can save the latest metadata to disk.
    this.metadataStore.save();
    await this.logger.info("Sync done");
  }

  async downloadFile(file: GetTreeResponseItem, lastModified: number) {
    const fileMetadata = this.metadataStore.data.files[file.path];
    if (fileMetadata && fileMetadata.sha === file.sha) {
      // File already exists and has the same SHA, no need to download it again.
      return;
    }
    const blob = await this.client.getBlob({ sha: file.sha, retry: true });
    const normalizedPath = normalizePath(file.path);
    const fileFolder = normalizePath(
      normalizedPath.split("/").slice(0, -1).join("/"),
    );
    if (!(await this.vault.adapter.exists(fileFolder))) {
      await this.vault.adapter.mkdir(fileFolder);
    }
    await this.vault.adapter.writeBinary(
      normalizedPath,
      base64ToArrayBuffer(blob.content),
    );
    this.metadataStore.data.files[file.path] = {
      path: file.path,
      sha: file.sha,
      dirty: false,
      justDownloaded: true,
      lastModified: lastModified,
    };
    await this.metadataStore.save();
  }

  async deleteLocalFile(filePath: string) {
    const normalizedPath = normalizePath(filePath);
    await this.vault.adapter.remove(normalizedPath);
    this.metadataStore.data.files[filePath].deleted = true;
    this.metadataStore.data.files[filePath].deletedAt = Date.now();
    this.metadataStore.save();
  }

  async loadMetadata() {
    await this.logger.info("Loading metadata");
    // The gitignore cache must be ready before any isSyncable check fires —
    // reconcile below filters via it, and so do all subsequent sync
    // operations. initialize() also writes the canonical/strict files if
    // missing, which is something we want to happen exactly once at startup.
    await this.gitignoreCache.initialize();
    await this.metadataStore.load();

    // Always reconcile metadata with what's actually on disk. This catches
    // changes that happened while the plugin wasn't loaded — files added
    // or deleted by the user via Finder, files restored from backup, the
    // disable→edit-vault→re-enable cycle, etc. Plus it handles the
    // "metadata is essentially empty (only the manifest entry)" first-
    // install case as a special case of "lots of files appeared on disk
    // since metadata last saw them".
    await this.reconcileWithVault();

    await this.logger.info("Loaded metadata");
  }

  /**
   * Compare the metadata's view of the vault to what's actually on disk
   * and update metadata where they disagree at the path level:
   *   - File tracked but not on disk → mark deleted (next sync removes
   *     it from remote).
   *   - File on disk but not tracked → add as a fresh entry (next sync
   *     uploads it).
   * Content-level divergence (file's contents changed but path is the
   * same) is left to findDivergedPaths, which already handles it via
   * SHA comparison during sync.
   */
  private async reconcileWithVault(): Promise<void> {
    const all: string[] = [];
    const folders: string[] = [this.vault.getRoot().path];
    while (folders.length > 0) {
      const folder = folders.pop();
      if (folder === undefined) continue;
      const res = await this.vault.adapter.list(folder);
      all.push(...res.files);
      folders.push(...res.folders);
    }
    const onDisk = new Set(all);

    const now = Date.now();
    let markedDeleted = 0;
    let addedFresh = 0;

    for (const filePath of Object.keys(this.metadataStore.data.files)) {
      const entry = this.metadataStore.data.files[filePath];
      if (entry.deleted) continue;
      if (onDisk.has(filePath)) continue;
      // Tracked, not deleted, but no longer on disk — user removed it
      // outside the events-listener's reach. Mark it so the next sync
      // propagates the delete.
      entry.deleted = true;
      entry.deletedAt = now;
      markedDeleted++;
    }

    for (const filePath of onDisk) {
      if (this.metadataStore.data.files[filePath]) continue;
      if (
        !isSyncable(
          filePath,
          this.vault.configDir,
          this.settings.syncConfigDir,
          this.gitignoreCache,
        )
      ) {
        continue;
      }
      // On disk but not tracked — first-install case, or a file dropped
      // into the vault while the plugin was disabled. Track it; next
      // sync uploads.
      this.metadataStore.data.files[filePath] = {
        path: filePath,
        sha: null,
        dirty: false,
        justDownloaded: false,
        lastModified: now,
      };
      addedFresh++;
    }

    if (markedDeleted > 0 || addedFresh > 0) {
      await this.metadataStore.save();
      await this.logger.info("Reconcile applied changes", {
        markedDeleted,
        addedFresh,
      });
    } else {
      await this.logger.info("Reconcile: no changes");
    }
  }

  /**
   * Add all the files in the config dir in the metadata store.
   * This is mainly useful when the user changes the sync config settings
   * as we need to add those files to the metadata store or they would never be synced.
   */
  async addConfigDirToMetadata() {
    await this.logger.info("Adding config dir to metadata");
    // Walk every file under configDir on disk.
    let files: string[] = [];
    let folders = [this.vault.configDir];
    while (folders.length > 0) {
      const folder = folders.pop();
      if (folder === undefined) {
        continue;
      }
      const res = await this.vault.adapter.list(folder);
      files.push(...res.files);
      folders.push(...res.folders);
    }

    const onDiskSyncable = new Set<string>();
    for (const filePath of files) {
      if (
        !isSyncable(
          filePath,
          this.vault.configDir,
          this.settings.syncConfigDir,
          this.gitignoreCache,
        )
      ) {
        continue;
      }
      onDiskSyncable.add(filePath);
      // Preserve existing metadata (sha, lastModified, deleted state) — the
      // previous implementation overwrote entries with sha=null, which made
      // the very next sync re-upload everything from scratch.
      if (!this.metadataStore.data.files[filePath]) {
        this.metadataStore.data.files[filePath] = {
          path: filePath,
          sha: null,
          dirty: false,
          justDownloaded: false,
          lastModified: Date.now(),
        };
      }
    }

    // Drop stale entries: anything inside configDir that's either missing
    // from disk or no longer passes isSyncable (rules tightened, plugin
    // source got cleaned out, etc.). The manifest is exempt.
    const manifestPath = `${this.vault.configDir}/${MANIFEST_FILE_NAME}`;
    let removed = 0;
    for (const filePath of Object.keys(this.metadataStore.data.files)) {
      if (filePath === manifestPath) continue;
      if (!filePath.startsWith(`${this.vault.configDir}/`)) continue;
      if (onDiskSyncable.has(filePath)) continue;
      delete this.metadataStore.data.files[filePath];
      removed++;
    }

    await this.logger.info("Config dir metadata updated", {
      added: onDiskSyncable.size,
      removedStale: removed,
    });
    this.metadataStore.save();
  }

  /**
   * Remove all the files in the config dir from the metadata store.
   * The metadata file is not removed as it must always be present.
   * This is mainly useful when the user changes the sync config settings
   * as we need to remove those files to the metadata store or they would
   * keep being synced.
   */
  async removeConfigDirFromMetadata() {
    await this.logger.info("Removing config dir from metadata");
    // Get all the files in the config dir
    let files = [];
    let folders = [this.vault.configDir];
    while (folders.length > 0) {
      const folder = folders.pop();
      if (folder === undefined) {
        continue;
      }
      const res = await this.vault.adapter.list(folder);
      files.push(...res.files);
      folders.push(...res.folders);
    }

    // Remove all them from the metadata store
    files.forEach((filePath: string) => {
      if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
        // We don't want to remove the metadata file even if it's in the config dir
        return;
      }
      delete this.metadataStore.data.files[filePath];
    });
    this.metadataStore.save();
  }

  getFileMetadata(filePath: string): FileMetadata {
    return this.metadataStore.data.files[filePath];
  }

  startEventsListener(plugin: GitHubSyncPlugin) {
    this.eventsListener.start(plugin);
  }

  /**
   * Starts a new sync interval.
   * Raises an error if the interval is already running.
   */
  startSyncInterval(minutes: number): number {
    if (this.syncIntervalId) {
      throw new Error("Sync interval is already running");
    }
    this.syncIntervalId = window.setInterval(
      async () => await this.sync(),
      // Sync interval is set in minutes but setInterval expects milliseconds
      minutes * 60 * 1000,
    );
    return this.syncIntervalId;
  }

  /**
   * Stops the currently running sync interval
   */
  stopSyncInterval() {
    if (this.syncIntervalId) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  /**
   * Util function that stops and restart the sync interval
   */
  restartSyncInterval(minutes: number) {
    this.stopSyncInterval();
    return this.startSyncInterval(minutes);
  }

  async resetMetadata() {
    this.metadataStore.reset();
    await this.metadataStore.save();
  }
}
