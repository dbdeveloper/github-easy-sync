import { Vault, arrayBufferToBase64, base64ToArrayBuffer } from "obsidian";
import {
  GetTreeResponseItem,
  NewTreeRequestItem,
} from "../github/client";
import {
  calculateGitBlobSHA,
  decodeBase64String,
  hasTextExtension,
} from "../utils";
import ChangeDetector from "./change-detector";
import GitignoreInvariants from "./gitignore-invariants";
import PushQueue, { EnqueueMeta } from "./push-queue";
import SnapshotStore, { RemoteIdentity } from "./snapshot-store";
import TreeBuilder from "./tree-builder";
import { mergeText } from "./three-way-merge";
import {
  compareSemver,
  isAtomicPluginFile,
  pluginRootOf,
  readPluginVersion,
} from "./plugin-js";
import {
  applyTemplate,
  appendDeviceSuffix,
  DEFAULT_INIT_COMMIT_MESSAGE,
  parseDeviceSuffix,
} from "./commit-templates";
import ConflictStore from "./conflict-store";
import { normalizeText } from "./text-normalize";
import { ConflictResolution, FileChange } from "./types";

// Minimal client surface Sync2Manager needs. Lets tests inject a stub
// without dragging the real GithubClient (settings, retries, logger…).
// In production this is satisfied by GithubClient directly.
export interface Sync2Client {
  createBlob(args: {
    content: string;
    encoding?: "utf-8" | "base64";
    retry?: boolean;
  }): Promise<{ sha: string }>;
  createTree(args: {
    tree: { tree: NewTreeRequestItem[]; base_tree?: string };
    retry?: boolean;
  }): Promise<string>;
  createCommit(args: {
    message: string;
    treeSha: string;
    parent?: string;
    retry?: boolean;
  }): Promise<string>;
  updateBranchHead(args: { sha: string; retry?: boolean }): Promise<void>;
  // Contents API write. The only endpoint that works against a bare
  // repo (no commits yet) — Git Data API returns 409 "Git Repository
  // is empty" until at least one ref exists. Sync2 uses this to seed
  // a bare repo with <vault>/.gitignore as the first commit, then
  // switches to the Git Data API for everything after. Returns the
  // SHAs from the response so callers can build on top without a
  // follow-up GET (avoiding the eventual-consistency window).
  // PUT /repos/{o}/{r}/contents/{path}.
  createFile(args: {
    path: string;
    content: string;
    message: string;
    retry?: boolean;
  }): Promise<{ blobSha: string; treeSha: string; commitSha: string }>;
  getBranchHeadSha(args?: { retry?: boolean }): Promise<string>;
  // Conflict reconciliation needs the tree SHA of an arbitrary commit
  // (rebase target) and the committer date (binary atomic resolver).
  // GET /repos/{o}/{r}/git/commits/{sha}.
  getCommit(args: {
    sha: string;
    retry?: boolean;
  }): Promise<{
    tree: { sha: string };
    committer: { date: string };
    // Full commit message — sync2 reads the trailing " (label)" off
    // it via parseDeviceSuffix to identify the foreign device that
    // authored a conflict's "theirs" side.
    message: string;
  }>;
  // Fetches the base64-encoded blob content for `path` at a specific
  // commit `ref`. Returns null on 404 (path not present at that
  // commit, or commit GC'd after force-push). Used for both base
  // (lastSyncCommitSha) and theirs (currentHead) sides of a 3-way
  // merge. GET /repos/{o}/{r}/contents/{path}?ref={sha}.
  getContentsAtRef(args: {
    path: string;
    ref: string;
    retry?: boolean;
  }): Promise<{ content: string; sha: string } | null>;
  // Recursive listing of the branch's HEAD tree — every blob with its
  // path and SHA. Used by bootstrap-from-remote to enumerate what to
  // download into a fresh vault. GET /repos/{o}/{r}/git/trees/{branch}?recursive=1.
  getRepoContent(args?: {
    retry?: boolean;
  }): Promise<{ files: { [key: string]: GetTreeResponseItem }; sha: string }>;
  // Reads a single blob by SHA. Bootstrap fetches blobs through this
  // (one call per file). GET /repos/{o}/{r}/git/blobs/{sha}.
  getBlob(args: {
    sha: string;
    retry?: boolean;
  }): Promise<{ content: string; sha: string }>;
  // Files changed between two refs. Used by the pull pass to discover
  // remote-driven adds/modifies/deletes. Returns a flat list with
  // status. GET /repos/{o}/{r}/compare/{base}...{head}.
  compare(args: {
    base: string;
    head: string;
    retry?: boolean;
  }): Promise<{
    status: "ahead" | "behind" | "identical" | "diverged";
    files: Array<{
      filename: string;
      status:
        | "added"
        | "modified"
        | "removed"
        | "renamed"
        | "copied"
        | "changed"
        | "unchanged";
      sha: string | null;
      previous_filename?: string;
    }>;
  }>;
}

// Progress UI hook. Sync2Manager keeps one handle per drain run and
// calls update() as it advances commits or files. Whether that maps
// to an Obsidian Notice, a status-bar item, or a noop is the caller's
// decision — sync2's logic doesn't depend on which.
export interface ProgressHandle {
  update(message: string): void;
  hide(): void;
}
export type ProgressFactory = (initialMessage: string) => ProgressHandle;

// Sync2Manager fires this when 3-way merge can't auto-resolve. The
// callback shows the per-file modal (or any UI) and returns a
// ConflictResolution describing what the user picked:
//
//   - { kind: "resolved", content }       — diff editor finished
//   - { kind: "deferred" }                — sibling file already
//                                           created via ConflictStore
//   - { kind: "merged-into-one", content }— markdown auto-merge
//
// Returning `kind: "resolved"` with conflict-marked content is also
// valid (legacy stub behaviour: write the markers and let the user
// reconcile in the editor) — but production callers go through the
// real diff editor path.
export type OnConflictCallback = (args: {
  path: string;
  ours: string;
  base: string;
  theirs: string;
  conflictMarkedContent: string;
}) => Promise<ConflictResolution>;

// Thin async logger surface — Sync2Manager records phase markers and
// errors so the same `github-easy-sync.log` line format used by legacy
// instrumentation continues to work.
export interface Sync2Logger {
  info(message: string, data?: unknown): Promise<void>;
  warn(message: string, data?: unknown): Promise<void>;
  error(message: string, data?: unknown): Promise<void>;
}

export interface Sync2ManagerDeps {
  vault: Vault;
  store: SnapshotStore;
  detector: ChangeDetector;
  queue: PushQueue;
  builder: TreeBuilder;
  client: Sync2Client;
  logger: Sync2Logger;
  // Optional: when omitted, sync2 doesn't manage the two invariant
  // gitignores. Plugin code passes a real GitignoreInvariants here;
  // unit tests that don't care can leave it out.
  invariants?: GitignoreInvariants;
  configDir: string;
  selfPluginId: string;
  // Templates with `{date}` / `{filename}` / `{path}` placeholders.
  // Accept string OR getter so callers that read live from settings
  // can pass a closure; the manager re-reads on every use, so a
  // settings-tab edit propagates without rebuilding the manager.
  commitMessageAll: string | (() => string);
  commitMessageFile: string | (() => string);
  // Per-device label appended to every commit message as a fixed
  // " (label)" suffix and recorded in conflict-store metadata. One
  // setting drives both surfaces — see commit-templates.ts /
  // conflict-store.ts for the consumers. Live-readable for the same
  // reason as the templates above.
  deviceLabel: string | (() => string);
  // Optional ConflictStore for Etap 6.5 deferred / sibling-file
  // workflow. Plugin code passes a real one; unit tests that stick
  // entirely to the "resolved" callback return shape can omit it.
  // When omitted, calling onConflict with `kind: "deferred"` throws —
  // there's nowhere to persist the deferral.
  conflictStore?: ConflictStore;
  // Fired when reconciliation hits a conflict that 3-way merge can't
  // resolve. UI surface plugs in here.
  onConflict: OnConflictCallback;
  // UI hook for queue-drain progress. main.ts wires this to a long-
  // lived Notice; tests omit it. Returns a handle whose update()
  // changes the displayed text and hide() dismisses the notice.
  onProgress?: ProgressFactory;
  // Brief feedback hooks for the local phase (before any network
  // I/O). Plugin code wires them to short-lived Notices so the user
  // gets immediate feedback that "your work is saved locally; if
  // we're offline, you can keep editing":
  //   - onLocalCommitted fires once per syncAll/syncFile call after
  //     enqueueOrMerge has materialised a batch on disk. The count
  //     is how many distinct file paths landed in the batch (already
  //     filtered for pending-conflict paths).
  //   - onNoLocalChanges fires when there's nothing to enqueue AND
  //     no pending batches in the queue — i.e. a truly idle sync.
  //   - onSyncCompleted fires AT THE END of every successful
  //     syncAll/syncFile (in a finally block, so it fires even after
  //     errors — the wrapper hook is responsible for deciding
  //     whether to flash a success or failure notice).
  //     `pushedFiles` reflects the count enqueued in this sync
  //     specifically; 0 means "nothing went up to remote".
  //     `pulledFiles` counts vault mutations from the pull phases
  //     (bootstrap-from-remote + pullIfNeeded — adds, modifies,
  //     deletes, renames), so "nothing went up but stuff came down"
  //     reads as pushedFiles=0, pulledFiles>0. Identical-SHA no-ops
  //     during adoption do NOT count — those are comparisons, not
  //     content changes.
  // All are no-ops in unit tests that don't pass them.
  onLocalCommitted?(filesCount: number): void;
  onNoLocalChanges?(): void;
  onSyncCompleted?(summary: {
    pushedFiles: number;
    pulledFiles: number;
  }): void;
  // When true, a new sync click while pending batches exist (i.e.
  // earlier push attempt failed — typically offline) folds the new
  // changes into the latest pending batch instead of stacking. The
  // eventual replay produces one commit instead of N.
  accumulateOfflineSyncs?: boolean;
  // (owner, repo, branch) currently configured in settings. Read live
  // at the start of every syncAll: if it differs from the triplet the
  // snapshot was last reconciled against, the manager treats the
  // current state as "wrong remote", wipes snapshot + push-queue +
  // conflict-store, and routes through adoption-from-remote (the
  // bootstrap path) so the new repo is cloned cleanly. Optional —
  // unit tests that don't care about remote-identity tracking can
  // omit it; mismatch detection is skipped when undefined.
  remoteIdentity?: () => RemoteIdentity;
  // Override the clock for deterministic tests.
  now?: () => number;
}

export class Sync2Manager {
  private readonly vault: Vault;
  private readonly store: SnapshotStore;
  private readonly detector: ChangeDetector;
  private readonly queue: PushQueue;
  private readonly builder: TreeBuilder;
  private readonly client: Sync2Client;
  private readonly logger: Sync2Logger;
  private readonly invariants: GitignoreInvariants | undefined;
  private readonly configDir: string;
  private readonly selfPluginId: string;
  private readonly commitMessageAll: () => string;
  private readonly commitMessageFile: () => string;
  private readonly deviceLabel: () => string;
  private readonly conflictStore: ConflictStore | undefined;
  private readonly onConflict: OnConflictCallback;
  private readonly accumulateOfflineSyncs: boolean;
  private readonly onProgress: ProgressFactory | undefined;
  private readonly onLocalCommitted:
    | ((filesCount: number) => void)
    | undefined;
  private readonly onNoLocalChanges: (() => void) | undefined;
  private readonly onSyncCompleted:
    | ((summary: { pushedFiles: number; pulledFiles: number }) => void)
    | undefined;
  // Accumulator for the pull-side phases (bootstrapFromRemote +
  // pullIfNeeded) so onSyncCompleted can report how many files
  // actually came down from the remote. Reset at the start of each
  // syncAll/syncFile/pullOnly; only counts real vault mutations
  // (no identical-SHA noops).
  private pulledFilesThisSync = 0;
  private readonly remoteIdentity: (() => RemoteIdentity) | undefined;
  private readonly now: () => number;
  // Guard against re-entrant drain. The runner only loops one
  // batch at a time; if a second syncAll() lands while the first is
  // still pushing, we let it enqueue but skip the second drain
  // invocation — the first one will pick the new batch up.
  private running = false;

  constructor(deps: Sync2ManagerDeps) {
    this.vault = deps.vault;
    this.store = deps.store;
    this.detector = deps.detector;
    this.queue = deps.queue;
    this.builder = deps.builder;
    this.client = deps.client;
    this.logger = deps.logger;
    this.invariants = deps.invariants;
    this.configDir = deps.configDir;
    this.selfPluginId = deps.selfPluginId;
    this.commitMessageAll =
      typeof deps.commitMessageAll === "function"
        ? deps.commitMessageAll
        : () => deps.commitMessageAll as string;
    this.commitMessageFile =
      typeof deps.commitMessageFile === "function"
        ? deps.commitMessageFile
        : () => deps.commitMessageFile as string;
    this.deviceLabel =
      typeof deps.deviceLabel === "function"
        ? deps.deviceLabel
        : () => deps.deviceLabel as string;
    this.conflictStore = deps.conflictStore;
    this.onConflict = deps.onConflict;
    this.accumulateOfflineSyncs = deps.accumulateOfflineSyncs ?? false;
    this.onProgress = deps.onProgress;
    this.onLocalCommitted = deps.onLocalCommitted;
    this.onNoLocalChanges = deps.onNoLocalChanges;
    this.onSyncCompleted = deps.onSyncCompleted;
    this.remoteIdentity = deps.remoteIdentity;
    this.now = deps.now ?? (() => Date.now());
  }

  // Action 1 — full sync.
  //
  // Click path is LOCAL ONLY: identity check → optional one-time
  // bootstrap (network, fires only when lastSyncCommitSha is null) →
  // invariants → findChanges → enqueue. Returns when the batch is on
  // disk. Network drain (pull + push) runs inside drain() which can
  // also be triggered by the interval timer or onload.
  async syncAll(customMessage?: string): Promise<void> {
    await this.logger.info("Sync2 syncAll start", {
      customMessage: customMessage !== undefined,
    });
    // Remote-identity drift check runs FIRST — before bootstrapIfNeeded.
    // If the user pointed the plugin at a different
    // (owner, repo, branch), we wipe local state here so the rest of
    // syncAll naturally routes through adoption-from-remote against
    // the new remote (lastSyncCommitSha is null after the wipe →
    // bootstrapIfNeeded sees the new branch and clones it).
    await this.reconcileRemoteIdentity();
    // Open the progress notice IMMEDIATELY so the user sees instant
    // feedback that their [Sync with GitHub] click registered. Without
    // this, the first ~400ms (GET branch head) shows no UI at all and
    // feels broken on slow links. Each phase below (.update()) replaces
    // the text; the finally block hides at the end.
    const progress = this.onProgress
      ? this.onProgress("Syncing with GitHub…")
      : null;
    let syncedFiles = 0;
    this.pulledFilesThisSync = 0;
    try {
      // Bootstrap is the one network step the click body still runs:
      // first-ever sync needs a remote tree probe so the upcoming
      // enqueue doesn't blindly mass-overwrite a non-bare remote. After
      // the first success, lastSyncCommitSha !== null and
      // bootstrapIfNeeded returns null in O(1) — every subsequent click
      // is pure-local.
      await this.bootstrapIfNeeded(progress);
      if (this.invariants) await this.invariants.enforce();
      const changes = await this.detector.findChanges();
      if (changes.length === 0) {
        await this.store.save();
        // "Nothing local AND nothing pending in the queue" is the
        // truly idle case — fire onNoLocalChanges so plugin code can
        // flash a brief "No changes" notice. If the queue still has
        // pending batches (offline-accumulate case), drain
        // picks them up and onProgress takes over the user feedback.
        const pendingBatches = await this.queue.list();
        if (pendingBatches.length === 0) this.onNoLocalChanges?.();
        await this.drain(progress);
        await this.logger.info("Sync2 syncAll: nothing to sync");
        return;
      }
      // Custom-message syncAll goes through enqueueOrMerge as an
      // isolated batch — user's typed message must survive intact
      // and must not absorb later std-syncs into its commit on
      // GitHub.
      const meta: EnqueueMeta =
        customMessage !== undefined
          ? {
              commitMessage: appendDeviceSuffix(
                customMessage,
                this.deviceLabel(),
              ),
              parentCommitSha: this.store.getLastSyncCommitSha(),
              parentTreeSha: this.store.getLastSyncTreeSha(),
              isolated: true,
            }
          : this.fullSyncMeta();
      const enqueued = await this.enqueueOrMerge(changes, meta);
      syncedFiles = enqueued;
      if (enqueued > 0) {
        this.onLocalCommitted?.(enqueued);
        progress?.update(
          enqueued === 1 ? "Commit 1 file" : `Commit ${enqueued} files`,
        );
      }
      await this.drain(progress);
    } finally {
      progress?.hide();
      this.onSyncCompleted?.({
        pushedFiles: syncedFiles,
        pulledFiles: this.pulledFilesThisSync,
      });
    }
  }

  // Action 2/3 — sync just the file at `path`.
  //
  // customMessage, when set, replaces the templated commit message.
  // It's still passed verbatim — no further template expansion — so a
  // user typing literal `{filename}` into the modal sees that string
  // committed.
  //
  // Behaviour when there's nothing to push (file matches snapshot,
  // missing on both sides, hardcoded-blocked, gitignored): logs a
  // notice and returns silently. No queue batch is created.
  async syncFile(path: string, customMessage?: string): Promise<void> {
    await this.logger.info(`Sync2 syncFile start`, { path });
    // Remote-identity drift check first — same reason as syncAll. If
    // settings now point at a different remote, the snapshot is
    // useless and we'd be pushing single-file content to the wrong
    // repo if we kept going.
    await this.reconcileRemoteIdentity();
    const progress = this.onProgress
      ? this.onProgress("Syncing with GitHub…")
      : null;
    let syncedFiles = 0;
    this.pulledFilesThisSync = 0;
    try {
      // Click body is local-only after bootstrap: the only network
      // step is the first-ever bootstrap probe. Pull + push live in
      // drain (the network worker).
      await this.bootstrapIfNeeded(progress);
      // Only enforce invariants when the active path is under
      // configDir; single-file syncs of regular notes don't risk
      // touching them.
      if (this.invariants && path.startsWith(`${this.configDir}/`)) {
        await this.invariants.enforce();
      }
      const change = await this.detector.findChangeForPath(path);
      if (!change) {
        await this.store.save();
        const pendingBatches = await this.queue.list();
        if (pendingBatches.length === 0) this.onNoLocalChanges?.();
        await this.drain(progress);
        await this.logger.info(`Sync2 syncFile: nothing to sync`, { path });
        return;
      }

      const baseMessage =
        customMessage !== undefined
          ? customMessage
          : applyTemplate(this.commitMessageFile(), {
              date: new Date(this.now()),
              filename: path.split("/").pop() ?? path,
              path,
            });
      const message = appendDeviceSuffix(baseMessage, this.deviceLabel());
      const enqueued = await this.enqueueOrMerge([change], {
        commitMessage: message,
        parentCommitSha: this.store.getLastSyncCommitSha(),
        parentTreeSha: this.store.getLastSyncTreeSha(),
        isolated: customMessage !== undefined,
      });
      syncedFiles = enqueued;
      if (enqueued > 0) {
        this.onLocalCommitted?.(enqueued);
        progress?.update("Commit 1 file");
      }
      await this.drain(progress);
    } finally {
      progress?.hide();
      this.onSyncCompleted?.({
        pushedFiles: syncedFiles,
        pulledFiles: this.pulledFilesThisSync,
      });
    }
  }

  // resumeQueue — full implementation in Etap 6d. For 6a, drain
  // is callable on its own and behaves correctly when called fresh.
  async resumeQueue(): Promise<void> {
    await this.drain();
  }

  // True iff the on-disk push-queue has at least one pending batch.
  // Used by main.ts's interval timer to gate watchdog-style drain
  // ticks: when interval is OFF and the queue is empty, the timer
  // is a no-op (we don't periodically poll remote for changes the
  // user didn't ask for).
  async hasPendingBatches(): Promise<boolean> {
    const ids = await this.queue.list();
    return ids.length > 0;
  }

  // Pull-only entry point for interval-driven background syncs (when
  // autoCommitOnIntervalSync is off). Brings the local vault up to
  // date with the remote — bootstrap-from-remote on a fresh device,
  // applyRemoteAddOrModify/applyRemoteDeletion for diverging files —
  // but DELIBERATELY skips:
  //   - invariants.enforce (no mass rewrite of `.gitignore`s on a
  //     timer; reserved for explicit Sync clicks)
  //   - findChanges + enqueueOrMerge + drain (no commits)
  //
  // Conflicts surfaced during pull behave as if the user had clicked
  // "Later": the sibling file is created, the 🔀 status-bar widget
  // ticks up, and the path is excluded from any future push until
  // the user resolves it. main.ts achieves this by setting its
  // suppressConflictModals flag before calling pullOnly().
  async pullOnly(): Promise<void> {
    await this.logger.info("Sync2 pullOnly start");
    await this.reconcileRemoteIdentity();
    const headAfterBootstrap = await this.bootstrapIfNeeded();
    if (headAfterBootstrap === null) {
      await this.pullIfNeeded();
    }
    await this.store.save();
    await this.logger.info("Sync2 pullOnly done");
  }

  // ── internal ────────────────────────────────────────────────────────

  // Pull remote-driven changes from GitHub since lastSyncCommitSha,
  // applying adds/modifies/deletes to the vault. Runs at the start of
  // every syncAll/syncFile so subsequent local change detection is
  // computed against the freshest snapshot baseline.
  //
  // No-op when:
  //   - lastSyncCommitSha is null (first-ever sync; the in-flight
  //     batch will pick up currentHead as parent in processBatch);
  //   - HEAD hasn't moved (compare-step skipped, ~150-byte ref ping);
  //   - compare returns 404 (force-pushed history, GC'd commit) —
  //     graceful degradation, the user keeps editing locally and the
  //     next push will reconcile.
  //
  // For each remote-changed file:
  //   - the path is checked against gitignore + hardcoded blocklist,
  //     so ignored files on the remote don't pollute the local vault;
  //   - if locally clean, the new content overwrites the file and the
  //     snapshot is recorded;
  //   - if locally dirty (the user edited the same file between
  //     syncs), a 3-way merge runs against base = lastSyncCommitSha
  //     content. Clean merges land silently; conflicts route through
  //     onConflict so the UI can prompt.
  // Removals propagate to disk only if local is also unchanged; a
  // delete-vs-modify race is treated like a conflict (resurrection
  // upload on the next push, since recordSync isn't called).
  private async pullIfNeeded(
    sharedProgress: ProgressHandle | null = null,
  ): Promise<string | null> {
    const expectedHead = this.store.getLastSyncCommitSha();
    if (expectedHead === null) return null;

    let currentHead: string | null;
    try {
      currentHead = await this.client.getBranchHeadSha({ retry: true });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 409) return null; // bare repo somehow
      throw err;
    }
    if (currentHead === expectedHead) return currentHead;

    let cmp;
    try {
      cmp = await this.client.compare({
        base: expectedHead,
        head: currentHead,
        retry: true,
      });
    } catch (err) {
      // compare returns 404 when the base commit is unreachable
      // (force-pushed history, GC'd commit, manifest corruption that
      // landed a bogus SHA). The unreachable base means we can't
      // diff and can't 3-way-merge against it later — so advance
      // lastSync to the live head right now. The upcoming
      // enqueueOrMerge picks up that fresh parent and processBatch
      // hits the Case 3 fast-path (head matches), skipping the
      // reconcile branch that would try to fetch blobs at the
      // bogus base SHA. Pinned by K3.
      const status = (err as { status?: number }).status;
      if (status === 404) {
        await this.logger.warn("Sync2 pull: compare base unreachable", {
          expectedHead,
          currentHead,
        });
        const headCommit = await this.client.getCommit({
          sha: currentHead,
          retry: true,
        });
        this.store.setLastSync(currentHead, headCommit.tree.sha);
        this.store.setLastCommitMtime(this.now());
        await this.store.save();
        return currentHead;
      }
      throw err;
    }

    // Identify which remote-changed paths overlap with files the user
    // has already queued for push. Those overlapping paths must NOT be
    // mutated in the live vault here — the batch's snapshot is the
    // user's source-of-truth and gets reconciled at push time via
    // `reconcileBatchAgainstHead`. Touching them now would clobber
    // batch intent (the batch's snapshot would stay stale and still
    // get pushed, undoing the merge we just wrote into the vault).
    const queuedPaths = await this.queue.collectAllPaths();
    let anyOverlapDeferred = false;

    // Pre-filter syncable changes so the progress notice's "N"
    // matches what the loop will actually touch — same pattern as
    // bootstrapFromRemote. Each pulled file (added/modified/removed/
    // renamed) takes one network round-trip (getBlob) so the user
    // wants live feedback on per-file granularity, not "blob calls".
    const syncableChanges = [] as typeof cmp.files;
    for (const f of cmp.files) {
      if (await this.detector.checkSyncable(f.filename)) {
        syncableChanges.push(f);
      }
    }
    // Reuse the click-time progress notice if syncAll opened one;
    // otherwise spin up our own and own its hide.
    const ownPullProgress = sharedProgress === null;
    let pullProgress: ProgressHandle | null = sharedProgress;
    if (syncableChanges.length > 0) {
      if (pullProgress === null && this.onProgress) {
        pullProgress = this.onProgress(
          `Pull 0/${syncableChanges.length}`,
        );
      } else if (pullProgress) {
        pullProgress.update(
          `Pull 0/${syncableChanges.length}`,
        );
      }
    }
    let processed = 0;
    const tickPull = (): void => {
      processed += 1;
      if (pullProgress) {
        pullProgress.update(
          `Pull ${processed}/${syncableChanges.length}`,
        );
      }
    };

    try {
      for (const f of syncableChanges) {
        if (queuedPaths.has(f.filename)) {
          // Defer: processBatch's Case 4 (expectedHead != currentHead)
          // will run reconcileBatchAgainstHead on this path. We
          // deliberately leave lastSync at the OLD expectedHead so
          // processBatch sees the drift and triggers reconcile.
          anyOverlapDeferred = true;
          tickPull();
          continue;
        }

        if (f.status === "removed") {
          await this.applyRemoteDeletion(f.filename, expectedHead);
          this.pulledFilesThisSync++;
          tickPull();
          continue;
        }

        // Resume: a prior pull pass may have already written this file
        // before crashing. Mirrors bootstrapFromRemote's SHA-match skip.
        if (
          f.status !== "renamed" &&
          f.sha &&
          (await this.vault.adapter.exists(f.filename))
        ) {
          const localBuf = await this.vault.adapter.readBinary(f.filename);
          const localSha = await calculateGitBlobSHA(localBuf);
          if (localSha === f.sha) {
            const stat = await this.vault.adapter.stat(f.filename);
            if (stat) {
              this.store.set(f.filename, {
                path: f.filename,
                remoteSha: f.sha,
                mtime: stat.mtime,
                size: stat.size,
              });
            }
            tickPull();
            continue;
          }
        }

        // added / modified / renamed / copied / changed → fetch and
        // apply remote content. previous_filename only matters for
        // renamed status; we treat it as a delete-of-old + add-of-new
        // since GitHub's tree view does the same on its side.
        if (
          f.status === "renamed" &&
          f.previous_filename &&
          (await this.detector.checkSyncable(f.previous_filename))
        ) {
          await this.applyRemoteDeletion(f.previous_filename, expectedHead);
        }
        await this.applyRemoteAddOrModify(
          f.filename,
          currentHead,
          expectedHead,
        );
        this.pulledFilesThisSync++;
        tickPull();
      }
    } finally {
      if (ownPullProgress) pullProgress?.hide();
    }

    if (anyOverlapDeferred) {
      // At least one remote path overlaps with our queue. Keep lastSync
      // at expectedHead so processBatch enters reconcile and resolves
      // the overlap against the batch's snapshot. Non-overlap files
      // were applied above and their per-file snapshots are current —
      // the commit-level lastSync just hasn't caught up yet.
      return currentHead;
    }

    // No overlap: every remote change has been applied to the vault.
    // Safe to advance lastSync so the upcoming push (if any) sees a
    // clean Case 3 fast-path head match.
    const headCommit = await this.client.getCommit({
      sha: currentHead,
      retry: true,
    });
    this.store.setLastSync(currentHead, headCommit.tree.sha);
    this.store.setLastCommitMtime(this.now());
    await this.store.save();
    return currentHead;
  }

  // Pull every blob the branch already carries into the freshly-empty
  // local snapshot store. Runs at most once per device — when sync2
  // sees lastSyncCommitSha=null but the branch has commits, this is
  // the only honest way to align local state with remote without
  // Check the (owner, repo, branch) the snapshot was last reconciled
  // against. If it matches current settings: record (no-op when
  // already recorded) and proceed. If it differs: the user pointed
  // the plugin at a different remote (or branch); wipe snapshot +
  // push-queue + conflict-store so the rest of syncAll routes through
  // bootstrapIfNeeded → bootstrapFromRemote (adoption) against the
  // new remote. The pending batches in the queue carry the previous
  // repo's parent SHAs and would push wrong content if we kept them.
  //
  // First-observation case (recordedRemote === null on a vault that
  // has been synced before — e.g. an upgrade from an older sync2
  // version): record current settings without resetting.
  //
  // No-op when the manager wasn't given a remoteIdentity getter
  // (unit tests that don't care about this surface).
  private async reconcileRemoteIdentity(): Promise<void> {
    if (!this.remoteIdentity) return;
    const current = this.remoteIdentity();
    const recorded = this.store.getRemoteIdentity();
    if (recorded === null) {
      // First-ever observation. Record and continue — don't treat
      // this as a mismatch (an upgrade from an older sync2 version
      // would land here once and shouldn't wipe state).
      this.store.setRemoteIdentity(current);
      await this.store.save();
      return;
    }
    if (
      recorded.owner === current.owner &&
      recorded.repo === current.repo &&
      recorded.branch === current.branch
    ) {
      return;
    }
    await this.logger.warn(
      "Sync2 remote identity changed; wiping local state",
      { from: recorded, to: current },
    );
    this.store.clear();
    this.store.setRemoteIdentity(current);
    await this.store.save();
    await this.queue.clearAll();
    if (this.conflictStore) {
      await this.conflictStore.clearAll();
    }
  }

  // letting the user's first push silently overwrite history.
  //
  // Returns the head SHA observed (so callers can pass it as a hint
  // to drain), or null when the branch is bare or there's
  // nothing to bootstrap (lastSyncCommitSha already set).
  private async bootstrapIfNeeded(
    sharedProgress: ProgressHandle | null = null,
  ): Promise<string | null> {
    if (this.store.getLastSyncCommitSha() !== null) return null;
    let currentHead: string | null;
    try {
      currentHead = await this.client.getBranchHeadSha({ retry: true });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 409) return null; // bare repo
      throw err;
    }
    if (currentHead === null) return null;
    await this.bootstrapFromRemote(currentHead, sharedProgress);
    return currentHead;
  }

  // First-sync adoption from a non-bare remote. sync2 has no prior
  // history at this point (lastSyncCommitSha === null), so it can't do
  // a real 3-way merge for diverging files. Instead, per-file
  // resolution by content + atomic mtime:
  //
  //   - local has no copy → pull (write vault, recordSync).
  //   - local has the exact bytes (SHA match) → recordSync, no transfer.
  //   - local has different bytes → atomic resolution by mtime:
  //       localMtime  >= remoteHeadCommitDate → local wins. Don't
  //         touch vault, don't recordSync. findChanges later emits
  //         the path as "added", push lifts it to remote.
  //       localMtime  <  remoteHeadCommitDate → remote wins. Pull,
  //         OVERWRITING the local copy. (README must instruct users
  //         to pre-sync via the previous plugin to keep this branch
  //         from firing on divergent files.)
  //
  // Local-only files (in vault, not in remote tree) are NOT touched
  // here — findChanges naturally emits them as "added" once adoption
  // sets lastSyncCommitSha.
  //
  // Tie on mtime: local wins ("user's last edit is more important
  // than a peer's push from the same minute").
  private async bootstrapFromRemote(
    currentHead: string,
    sharedProgress: ProgressHandle | null = null,
  ): Promise<void> {
    await this.logger.info("Sync2 adoption-from-remote start", {
      head: currentHead,
    });
    const { files, sha: treeSha } = await this.client.getRepoContent({
      retry: true,
    });
    // One getCommit for the uniform remote "last touched" reference
    // — beats N per-file lookups for adoption that already touches
    // every entry once.
    const headCommit = await this.client.getCommit({
      sha: currentHead,
      retry: true,
    });
    const remoteHeadDateMs = Date.parse(headCommit.committer.date);

    // Pre-filter syncable paths so the progress notice's "N" matches
    // what the loop will actually touch. Without this, a 500-file
    // repo with a 300-file `.obsidian/` (toggle off) would advertise
    // "0/500" while the real work is just 200 files.
    const syncablePaths: string[] = [];
    for (const filePath of Object.keys(files)) {
      if (await this.detector.checkSyncable(filePath)) {
        syncablePaths.push(filePath);
      }
    }
    // Spin up the long-running notice once we know there's real work.
    // Adoption is mostly a *comparison* pass — for a vault previously
    // synced via another tool (obsidian-git, etc.), most files'
    // local content already matches the remote SHA and the loop
    // just stat-caches them. Only the "missing locally" and
    // "remote-newer" branches actually fire getBlob. Calling the
    // notice "Downloading…" misled a real user: the counter ripped
    // through 245 files in seconds and looked broken because nothing
    // was actually downloading. "Reconciling…" sets the right
    // expectation: we're cross-checking local against remote,
    // downloading what's missing as we go.
    // Reuse the click-time progress notice if syncAll opened one;
    // otherwise spin up our own and own its hide.
    const ownPullProgress = sharedProgress === null;
    let pullProgress: ProgressHandle | null = sharedProgress;
    if (syncablePaths.length > 0) {
      if (pullProgress === null && this.onProgress) {
        pullProgress = this.onProgress(
          `Preparing GitHub syncing…`,
        );
      } else if (pullProgress) {
        pullProgress.update(
          `Preparing GitHub syncing…`,
        );
      }
    }
    let processed = 0;
    const tickPull = (): void => {
      processed += 1;
      if (pullProgress) {
        pullProgress.update(
          `Preparing GitHub syncing: ${processed}/${syncablePaths.length}`,
        );
      }
    };

    let pulled = 0;
    let identical = 0;
    let localKept = 0;
    let remoteOverwrote = 0;
    try {
      for (const filePath of syncablePaths) {
        const item = files[filePath];
        const localExists = await this.vault.adapter.exists(filePath);
        if (!localExists) {
          await this.adoptionPullAndRecord(filePath, item);
          pulled++;
          this.pulledFilesThisSync++;
          tickPull();
          continue;
        }

        const localBuf = await this.vault.adapter.readBinary(filePath);
        const localSha = await calculateGitBlobSHA(localBuf);

        if (localSha === item.sha) {
          // Identical content. Stat-cache the snapshot so subsequent
          // syncs short-circuit via the watermark+stat-equality check.
          const stat = await this.vault.adapter.stat(filePath);
          if (stat) {
            this.store.set(filePath, {
              path: filePath,
              remoteSha: item.sha,
              mtime: stat.mtime,
              size: stat.size,
            });
          }
          identical++;
          tickPull();
          continue;
        }

        const stat = await this.vault.adapter.stat(filePath);
        const localMtimeMs = stat?.mtime ?? 0;
        if (localMtimeMs >= remoteHeadDateMs) {
          // Local wins. Don't recordSync — findChanges will emit
          // the file as "added" (no snapshot entry) and the next push
          // will lift this local version onto the remote.
          localKept++;
          tickPull();
          continue;
        }
        // Remote wins. Pull, overwriting the local copy in place.
        await this.adoptionPullAndRecord(filePath, item);
        remoteOverwrote++;
        this.pulledFilesThisSync++;
        tickPull();
      }
    } finally {
      if (ownPullProgress) pullProgress?.hide();
    }

    this.store.setLastSync(currentHead, headCommit.tree.sha ?? treeSha);
    this.store.setLastCommitMtime(this.now());
    await this.store.save();
    await this.logger.info("Sync2 adoption-from-remote done", {
      pulled,
      identical,
      localKept,
      remoteOverwrote,
      treeSha,
    });
  }

  // Shared "download from remote and write to vault" path used by
  // adoption's three pull branches (missing-locally, remote-newer
  // overwrite, and the legacy bootstrap pull). Text bytes go through
  // canonicalization (CRLF→LF, BOM strip, trailing-NL); when bytes
  // change, snapshot stays stale so the next findChanges treats the
  // file as added/modified and the next push uploads canonical bytes.
  private async adoptionPullAndRecord(
    filePath: string,
    item: GetTreeResponseItem,
  ): Promise<void> {
    const blob = await this.client.getBlob({ sha: item.sha, retry: true });
    const bytes = base64ToArrayBuffer(blob.content);
    if (hasTextExtension(filePath)) {
      const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
      const { canonicalSha, changed } = await this.writeRemoteText(
        filePath,
        text,
      );
      // recordSync only when bytes are already canonical. When pull
      // rewrote them, leave snapshot stale so the next findChanges
      // picks the file up as added/modified and pushes canonical back.
      if (!changed) {
        await this.detector.recordSync(filePath, canonicalSha);
      }
    } else {
      await this.ensureParentDir(filePath);
      await this.vault.adapter.writeBinary(filePath, bytes);
      const stat = await this.vault.adapter.stat(filePath);
      if (stat) {
        this.store.set(filePath, {
          path: filePath,
          remoteSha: item.sha,
          mtime: stat.mtime,
          size: stat.size,
        });
      }
    }
  }

  // When pull rewrites the on-disk file (CRLF→LF, BOM strip,
  // trailing-NL), recordSync is intentionally skipped so the snapshot
  // stays at the old remote SHA. Next findChanges sees the local-vs-
  // remote divergence and emits the file as modified; the next push
  // uploads canonical bytes back to GitHub.
  private async applyRemoteAddOrModify(
    path: string,
    headRef: string,
    baseRef: string,
  ): Promise<void> {
    const blob = await this.safeFetchContents(path, headRef);
    if (!blob) return; // raced with a subsequent remote delete; skip

    // Is the local version dirty against snapshot?
    const localChange = await this.detector.findChangeForPath(path);
    const exists = await this.vault.adapter.exists(path);

    if (localChange === null) {
      // Local matches snapshot (or doesn't exist). Pull straight in.
      if (hasTextExtension(path)) {
        const remoteText = decodeBase64String(blob.content);
        const { canonicalSha, changed } = await this.writeRemoteText(
          path,
          remoteText,
        );
        // recordSync only when local bytes match remote bytes byte-
        // exactly. When canonicalization rewrote anything (CRLF→LF,
        // BOM strip, trailing-NL), snapshot stays stale on purpose so
        // findChanges emits the file on the next sync click and the
        // canonical version reaches GitHub.
        if (!changed) {
          await this.detector.recordSync(path, canonicalSha);
        }
      } else {
        await this.writeBinaryRemote(path, blob.content);
        await this.detector.recordSync(path, blob.sha);
      }
      return;
    }
    const remoteContent = hasTextExtension(path)
      ? decodeBase64String(blob.content)
      : "";

    if (localChange.kind === "deleted") {
      // Local says "I deleted this", remote says "I edited it". Delete
      // wins on local for now — but we DON'T record-sync, so the next
      // push surfaces the deletion. Conservative: leave the file
      // missing locally; user's intent stands.
      return;
    }

    if (!hasTextExtension(path)) {
      // Binary divergence: text-style 3-way merge would corrupt the
      // file. Resolve atomically by timestamp instead — whichever
      // side touched the file most recently wins. Tie goes to local
      // ("ours wins" is the safer default since the user is sitting
      // in front of the local copy).
      await this.resolveBinaryConflict(path, headRef, blob);
      return;
    }
    if (isAtomicPluginFile(path, this.configDir)) {
      // Plugin JS bundles are minified single-line megabytes; a
      // 3-way text merge produces incoherent garbage that crashes
      // Obsidian on load. Resolve atomically via the plugin's
      // semver (read from manifest.json), falling back to mtime
      // on tie — same shape the legacy plugin used.
      await this.resolvePluginJsConflict(path, headRef, blob);
      return;
    }

    const baseFetched = await this.safeFetchContents(path, baseRef);
    const baseContent = baseFetched
      ? decodeBase64String(baseFetched.content)
      : "";
    const oursBytes = exists
      ? await this.vault.adapter.readBinary(path)
      : new ArrayBuffer(0);
    const oursContent = new TextDecoder().decode(oursBytes);

    const merge = mergeText(oursContent, baseContent, remoteContent);
    let resolved: string;
    if (merge.kind === "clean") {
      resolved = merge.content;
    } else {
      const decision = await this.onConflict({
        path,
        ours: oursContent,
        base: baseContent,
        theirs: remoteContent,
        conflictMarkedContent: merge.conflictMarkedContent,
      });
      if (decision.kind === "deferred") {
        // User picked "Later". Snapshot (base, theirs) and the sibling
        // file via ConflictStore so the conflict is visible in the
        // vault and survives a deferred resolution. Local file stays
        // as ours — we deliberately do NOT writeRemoteText here and
        // do NOT recordSync. The path is
        // excluded from push (enqueueOrMerge filters it) until
        // ConflictStore.resolve fires, at which point the next sync
        // picks it up like any other modified file.
        if (!this.conflictStore) {
          throw new Error(
            "Sync2 conflict deferral requested but no ConflictStore is wired",
          );
        }
        // Identify who authored the GitHub-side change so the
        // sibling filename (`<base>.conflict-from-<author>-<ts>.<ext>`)
        // points at the FOREIGN device, not the user's local one. We
        // pull the trailing " (label)" off the head commit's message;
        // hand-edited commits on the GitHub web UI parse to "unknown".
        // Falling back gracefully on a fetch failure — the sibling
        // still lands, just labelled "unknown".
        let theirsAuthor = "unknown";
        try {
          const headCommit = await this.client.getCommit({
            sha: headRef,
            retry: true,
          });
          theirsAuthor = parseDeviceSuffix(headCommit.message);
        } catch {
          // network / 404 — keep "unknown"
        }
        await this.conflictStore.create({
          vaultPath: path,
          baseContent,
          theirsContent: remoteContent,
          baseCommitSha: baseRef,
          theirsBlobSha: blob.sha,
          theirsAuthor,
        });
        await this.logger.info("Sync2 conflict deferred via sibling file", {
          path,
        });
        return;
      }
      // "resolved" or "merged-into-one": treat identically — write the
      // returned content, push it. The kind tag is for telemetry /
      // logging clarity, not control flow.
      resolved = decision.content;
    }

    // Write canonical. recordSync only when canonical equals what's on
    // GitHub; otherwise leave snapshot stale so findChanges picks the
    // gap up on the next sync click.
    const { canonicalSha } = await this.writeRemoteText(path, resolved);
    if (canonicalSha === blob.sha) {
      await this.detector.recordSync(path, canonicalSha);
    }
  }

  // Timestamp-based atomic resolution for a remote-modified binary
  // file the user has also edited locally. Compares local mtime to
  // the head commit's committer date; the newer side wins. Tie goes
  // to local. The blob argument is the already-fetched remote
  // {content, sha} from applyRemoteAddOrModify so we don't refetch.
  private async resolveBinaryConflict(
    path: string,
    headRef: string,
    blob: { content: string; sha: string },
  ): Promise<void> {
    const stat = await this.vault.adapter.stat(path);
    if (!stat) {
      // Local missing despite findChangeForPath flagging dirty — race
      // with a concurrent delete. Pull the remote version in.
      await this.writeBinaryRemote(path, blob.content);
      await this.detector.recordSync(path, blob.sha);
      return;
    }
    const headCommit = await this.client.getCommit({
      sha: headRef,
      retry: true,
    });
    const remoteMs = Date.parse(headCommit.committer.date);
    if (Number.isNaN(remoteMs) || stat.mtime >= remoteMs) {
      // Local is newer (or remote date unparseable) — keep ours. The
      // file is left as-is locally and will be pushed on the next
      // commit since the snapshot still points at the pre-change SHA.
      await this.logger.info("Sync2 binary conflict: local newer, keep ours", {
        path,
      });
      return;
    }
    // Remote wins — overwrite local with the fetched bytes.
    await this.writeBinaryRemote(path, blob.content);
    await this.detector.recordSync(path, blob.sha);
    await this.logger.info(
      "Sync2 binary conflict: remote newer, overwrote local",
      { path },
    );
  }

  // Plugin-js conflict: atomic resolution via the plugin's manifest
  // semver, falling back to mtime when versions tie or can't be
  // parsed. Called only for paths matching isAtomicPluginFile() — bare .js
  // files outside the plugin tree go through the standard text
  // 3-way merge.
  //
  // The plugin's version lives in `<pluginRoot>/manifest.json` on
  // each side. We read local from disk and remote via
  // safeFetchContents at headRef; either may be missing or
  // malformed (returns null from readPluginVersion), which routes
  // us into the mtime fallback the same way an equal-semver tie
  // would. This is deliberate: a missing/broken manifest doesn't
  // crash sync, it just degrades to the next-best heuristic.
  private async resolvePluginJsConflict(
    path: string,
    headRef: string,
    blob: { content: string; sha: string },
  ): Promise<void> {
    const root = pluginRootOf(path, this.configDir);
    if (root === null) {
      // Defensive: isAtomicPluginFile(path) ⇒ pluginRootOf(path) !== null.
      // Fall back to mtime if somehow violated.
      await this.resolveBinaryConflict(path, headRef, blob);
      return;
    }
    const manifestPath = `${root}/manifest.json`;

    let localSemver: string | null = null;
    if (await this.vault.adapter.exists(manifestPath)) {
      const text = await this.vault.adapter.read(manifestPath);
      localSemver = readPluginVersion(text);
    }
    const remoteManifestBlob = await this.safeFetchContents(
      manifestPath,
      headRef,
    );
    const remoteSemver = remoteManifestBlob
      ? readPluginVersion(decodeBase64String(remoteManifestBlob.content))
      : null;

    if (localSemver !== null && remoteSemver !== null) {
      const cmp = compareSemver(localSemver, remoteSemver);
      if (cmp > 0) {
        // Local plugin newer. Keep local; the next push will lift
        // it to remote.
        await this.logger.info(
          "Sync2 plugin-js conflict: local semver newer, keep ours",
          { path, localSemver, remoteSemver },
        );
        return;
      }
      if (cmp < 0) {
        // Remote plugin newer. Overwrite local in place.
        await this.writeBinaryRemote(path, blob.content);
        await this.detector.recordSync(path, blob.sha);
        await this.logger.info(
          "Sync2 plugin-js conflict: remote semver newer, overwrote local",
          { path, localSemver, remoteSemver },
        );
        return;
      }
      // Equal semver — fall through to mtime resolution below.
    }

    // Either semver missing on at least one side, or equal versions
    // — resolveBinaryConflict's mtime comparator handles both cases
    // identically.
    await this.logger.info(
      "Sync2 plugin-js conflict: semver tie or missing, falling back to mtime",
      { path, localSemver, remoteSemver },
    );
    await this.resolveBinaryConflict(path, headRef, blob);
  }

  private async writeBinaryRemote(
    path: string,
    base64Content: string,
  ): Promise<void> {
    const bytes = base64ToArrayBuffer(base64Content);
    await this.ensureParentDir(path);
    await this.vault.adapter.writeBinary(path, bytes);
  }

  private async applyRemoteDeletion(
    path: string,
    baseRef: string,
  ): Promise<void> {
    const exists = await this.vault.adapter.exists(path);
    if (!exists) {
      this.detector.recordDeletion(path);
      return;
    }

    const localChange = await this.detector.findChangeForPath(path);
    if (localChange === null) {
      // Local matches the version that just got deleted. Apply.
      await this.vault.adapter.remove(path);
      this.detector.recordDeletion(path);
      return;
    }

    // Local has its own changes. Modify-vs-delete: keep local, don't
    // record-sync — next push will resurrect it on the remote.
  }

  // Write text content to disk in canonical form (Etap 6.6: LF, no
  // BOM, trailing-NL iff non-empty). Returns the canonical SHA so the
  // caller can recordSync against the actual on-disk bytes, plus a
  // `changed` flag indicating whether normalization mutated the input
  // — used by callers to decide whether the path needs republishing
  // back to GitHub.
  private async writeRemoteText(
    path: string,
    content: string,
  ): Promise<{ canonicalSha: string; changed: boolean }> {
    if (!hasTextExtension(path)) {
      // Routing guard: binary paths must never funnel through here
      // (would re-encode bytes via UTF-8 round-trip and corrupt them).
      throw new Error(
        `Sync2 internal: writeRemoteText called with non-text path ${path}`,
      );
    }
    const { content: canonical, changed } = normalizeText(content);
    await this.ensureParentDir(path);
    await this.vault.adapter.write(path, canonical);
    const bytes = new TextEncoder().encode(canonical).buffer as ArrayBuffer;
    const canonicalSha = await calculateGitBlobSHA(bytes);
    return { canonicalSha, changed };
  }

  private async ensureParentDir(filePath: string): Promise<void> {
    const slash = filePath.lastIndexOf("/");
    if (slash <= 0) return;
    const parent = filePath.substring(0, slash);
    if (await this.vault.adapter.exists(parent)) return;
    const parts = parent.split("/");
    let acc = "";
    for (const part of parts) {
      acc = acc === "" ? part : `${acc}/${part}`;
      if (!(await this.vault.adapter.exists(acc))) {
        await this.vault.adapter.mkdir(acc);
      }
    }
  }

  // Either enqueue a fresh batch or fold into the latest pending one,
  // depending on the accumulate-offline-syncs setting and whether
  // there's already a non-in-progress batch waiting. mergeIntoLatest
  // returns null when no candidate exists; we then create a new one.
  //
  // Etap 6.5: paths with pending conflicts (sibling file present,
  // .conflicts/<id>/ persisted, awaiting user resolution) are dropped
  // here BEFORE enqueueing — pushing the local "ours" mid-resolution
  // would commit a half-merged version. The path comes back into the
  // push pipeline naturally on the next syncAll once ConflictStore
  // confirms the conflict is closed (sibling deleted by user OR diff
  // editor finalised the merge).
  // Returns the number of distinct file paths actually enqueued (after
  // pending-conflict filtering). Callers use this to drive the local-
  // phase user feedback Notice ("Commit N files").
  private async enqueueOrMerge(
    changes: import("./types").FileChange[],
    meta: EnqueueMeta,
  ): Promise<number> {
    const filtered = this.dropPendingConflictPaths(changes);
    if (filtered.length === 0) return 0;
    // Custom-message ("isolated") batches always stand alone — never
    // try to fold them into a prior batch. Standard syncs still
    // honour accumulateOfflineSyncs.
    if (this.accumulateOfflineSyncs && !meta.isolated) {
      const target = await this.queue.mergeIntoLatestPending(filtered);
      if (target !== null) {
        // Refresh the merged batch's commit message to the latest
        // template render. "Last std-sync in the group wins" — the
        // timestamp on GitHub then reflects when the batch actually
        // shipped, not when the first click happened.
        await this.queue.updateCommitMessage(target, meta.commitMessage);
        return filtered.length;
      }
    }
    await this.queue.enqueue(filtered, meta);
    return filtered.length;
  }

  // Filter out file changes whose path has an active conflict record
  // in ConflictStore. Logs each dropped path so the user can audit
  // why something they edited didn't show up on the remote.
  private dropPendingConflictPaths(changes: FileChange[]): FileChange[] {
    if (!this.conflictStore || changes.length === 0) return changes;
    const out: FileChange[] = [];
    for (const c of changes) {
      if (this.conflictStore.hasPending(c.path)) {
        // Fire-and-forget log; we don't want to block enqueue on a
        // logger that might be slow.
        void this.logger.info("Sync2 enqueue: skip pending-conflict path", {
          path: c.path,
        });
        continue;
      }
      out.push(c);
    }
    return out;
  }

  private fullSyncMeta(): EnqueueMeta {
    const base = applyTemplate(this.commitMessageAll(), {
      date: new Date(this.now()),
    });
    return {
      // Always-trailing " (deviceLabel)" lets a future viewer
      // (Etap 8 file-history) read the source-device off any sync2
      // commit on GitHub regardless of how the user customized the
      // template. See commit-templates.ts → appendDeviceSuffix.
      commitMessage: appendDeviceSuffix(base, this.deviceLabel()),
      parentCommitSha: this.store.getLastSyncCommitSha(),
      parentTreeSha: this.store.getLastSyncTreeSha(),
    };
  }

  // Drain runner — the network worker. Each iteration:
  //   1. pullIfNeeded — apply remote-driven changes to the vault for
  //      paths NOT already in the queue. For paths that ARE in the
  //      queue (overlap), pull defers — push-side reconcile resolves
  //      them against the batch's snapshot.
  //   2. queue.list. Empty → exit.
  //   3. processBatch(oldest) — push, with reconcile if remote moved.
  //   4. Loop. Picks up new batches that the user enqueued mid-drain.
  //
  // Pull runs BEFORE every push so each batch lands on the freshest
  // possible HEAD; even if the previous batch advanced HEAD itself,
  // the next iteration's pull re-syncs against that.
  //
  // Re-entry guard: in-memory `running` flag serializes concurrent
  // drain() calls. A click while drain is active becomes no-op here,
  // but the click's enqueueOrMerge upstream already added the new
  // batch to disk, which the active drain picks up on its next list().
  //
  // Stops on the first failure so the user sees the error notice and
  // can retry; remaining batches stay on disk for the next trigger
  // (next click, next interval tick, next onload).
  private async drain(
    sharedProgress: ProgressHandle | null = null,
  ): Promise<void> {
    if (this.running) return;
    this.running = true;
    const ownProgress = sharedProgress === null;
    let progress: ProgressHandle | null = sharedProgress;
    let commitNum = 0;
    try {
      while (true) {
        const headHint = await this.pullIfNeeded(progress);
        const ids = await this.queue.list();
        if (ids.length === 0) break;
        commitNum += 1;
        if (progress === null && this.onProgress) {
          progress = this.onProgress(
            ids.length === 1 && commitNum === 1
              ? "Syncing with GitHub…"
              : `Syncing commit ${commitNum} with GitHub…`,
          );
        } else if (progress) {
          progress.update(
            ids.length === 1 && commitNum === 1
              ? "Syncing with GitHub…"
              : `Syncing commit ${commitNum} with GitHub…`,
          );
        }
        await this.processBatch(
          ids[0],
          headHint,
          progress,
          commitNum,
          commitNum + ids.length - 1,
        );
      }
    } finally {
      if (ownProgress) progress?.hide();
      this.running = false;
    }
  }

  private async processBatch(
    id: string,
    headHint: string | null = null,
    progress: ProgressHandle | null = null,
    commitNum: number = 1,
    commitTotal: number = 1,
  ): Promise<void> {
    await this.logger.info(`Sync2 push batch ${id}`);
    await this.queue.markInProgress(id);
    // Freeze this batch against further merges. The marker survives a
    // failure (in-progress is cleared in the catch below, attempted is
    // not), so a follow-up sync click can't accumulate new changes
    // into a batch we already tried to push. See PushQueue.markAttempted.
    await this.queue.markAttempted(id);
    try {
      // Four states for the head before push:
      //   1. expectedHead = null, currentHead = null → bare repo.
      //      Seed via Contents API (<vault>/.gitignore — guaranteed
      //      by invariants.enforce()), then build the batch on top.
      //   2. expectedHead = null, currentHead set → first sync on
      //      this device against an existing line of history. No
      //      snapshot to 3-way against; re-target the batch onto
      //      currentHead and let local files land on top. Server-
      //      side contents we don't carry are preserved through
      //      base_tree.
      //   3. expectedHead set, currentHead matches → fast path.
      //   4. expectedHead set, currentHead drifted → reconcile + re-target.
      let currentHead: string | null;
      if (headHint !== null) {
        currentHead = headHint;
      } else {
        try {
          currentHead = await this.client.getBranchHeadSha({ retry: true });
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === 404 || status === 409) currentHead = null;
          else throw err;
        }
      }
      const expectedHead = this.store.getLastSyncCommitSha();
      if (expectedHead === null && currentHead === null) {
        // Case 1: bare repo. Seed turns the repo into a non-bare
        // one-commit state and rewrites the batch's parent SHAs so
        // the rest of processBatch builds on top of the seed.
        await this.seedBareRepo(id);
      } else if (expectedHead === null && currentHead !== null) {
        // Case 2.
        const headCommit = await this.client.getCommit({
          sha: currentHead,
          retry: true,
        });
        await this.queue.updateMeta(id, {
          parentCommitSha: currentHead,
          parentTreeSha: headCommit.tree.sha,
        });
      } else if (
        expectedHead !== null &&
        currentHead !== null &&
        currentHead !== expectedHead
      ) {
        // Case 4.
        await this.reconcileBatchAgainstHead(id, expectedHead, currentHead);
      } else if (currentHead !== null) {
        // Case 3 (expectedHead set + currentHead matches), but the
        // batch's recorded parent may be stale: if an earlier batch
        // in this same drain already committed, this
        // batch's parentCommitSha now lags behind reality. Without
        // a re-target, createCommit would build on the stale parent
        // and updateBranchHead would reject the non-fast-forward
        // with 422. Re-fetching head's tree is cheap (one GET) and
        // keeps the rest of the flow building on the right base.
        const peek = await this.queue.read(id);
        if (peek.parentCommitSha !== currentHead) {
          const headCommit = await this.client.getCommit({
            sha: currentHead,
            retry: true,
          });
          await this.queue.updateMeta(id, {
            parentCommitSha: currentHead,
            parentTreeSha: headCommit.tree.sha,
          });
        }
      }

      // Estimate aggregate transfer size for the progress UI hint.
      // Cheap approximation: sum file sizes from on-disk stats. We
      // don't read content for this — the figure is a UI signal, not
      // an assertion.
      const heavyThreshold = 5 * 1024 * 1024;
      const totalBytes = await this.estimateBatchBytes(id);
      const sizeHint =
        totalBytes > heavyThreshold
          ? ` (~${(totalBytes / (1024 * 1024)).toFixed(1)} MB)`
          : "";
      // Prefix that names the active commit when there's more than
      // one batch to drain. For a single batch we omit the prefix —
      // saying "commit 1/1" is just noise.
      const commitPrefix =
        commitTotal > 1 ? `commit ${commitNum}/${commitTotal}, ` : "";

      // Pre-blob phase: show the size hint immediately so the user
      // knows something heavy is coming, even before buildTreeEntries
      // starts hitting createBlob in parallel.
      if (progress && sizeHint) {
        progress.update(`Syncing${sizeHint} with GitHub…`);
      }

      const { entries, baseTreeSha, batch } =
        await this.builder.buildTreeEntries(id, {
          // Switch the notice to a live N/M counter the moment file
          // processing begins. The counter advances on every file —
          // text (read+inline) and binary (createBlob) alike — so
          // the user sees the same "Uploading M/N files…" semantics
          // regardless of how the batch is composed. Without this,
          // a 200-file vault shows a frozen "Syncing…" notice for
          // tens of seconds.
          onUploadStart: (total) => {
            if (!progress) return;
            progress.update(
              `Push ${commitPrefix}0/${total}${sizeHint}`,
            );
          },
          onFileProcessed: (done, total) => {
            if (!progress) return;
            progress.update(
              `Push ${commitPrefix}${done}/${total}${sizeHint}`,
            );
          },
        });
      // Empty batch: reconcile may have deferred every path via
      // ConflictStore, leaving nothing to push. Skip createTree/Commit
      // entirely and delete the batch so the drain loop moves on.
      if (entries.length === 0 && batch.deletions.length === 0) {
        await this.logger.info(
          `Sync2 push batch ${id}: empty after reconcile, skipping`,
        );
        await this.queue.delete(id);
        return;
      }

      // After all blobs settled, the work shifts to createTree +
      // createCommit + updateBranchHead. That's typically a few
      // seconds at most but the message would otherwise keep saying
      // "Uploading N/N files…" through those steps. Switch to a
      // dedicated phase label so the user sees we've moved on.
      if (progress) {
        progress.update(`Push: committing${sizeHint}`);
      }

      // Build path → blob SHA map for snapshot updates after success.
      // Text entries have inline content but no SHA from buildTreeEntries
      // (createTree assigns the SHA server-side); we compute it locally
      // via git's blob-hash formula so we don't need a follow-up GET.
      const shaByPath = await this.computeShaByPath(entries);

      const newTreeSha = await this.client.createTree({
        tree: {
          tree: entries,
          base_tree: baseTreeSha ?? undefined,
        },
        retry: true,
      });
      // No-op tree change vs the parent: typically a bare-repo seed
      // already includes every path in the batch (e.g. empty vault →
      // only <vault>/.gitignore in the batch, which the seed itself
      // wrote). Skip the redundant empty commit — the parent IS the
      // synced state. Without this branch we'd land an empty commit
      // on top of the seed.
      let commitSha: string;
      if (
        baseTreeSha !== null &&
        newTreeSha === baseTreeSha &&
        batch.parentCommitSha !== null
      ) {
        commitSha = batch.parentCommitSha;
        await this.logger.info(
          `Sync2 push batch ${id}: tree unchanged vs parent — reusing parent commit`,
          { commitSha, treeSha: newTreeSha },
        );
      } else {
        commitSha = await this.client.createCommit({
          message: batch.commitMessage,
          treeSha: newTreeSha,
          parent: batch.parentCommitSha ?? undefined,
          retry: true,
        });
        await this.client.updateBranchHead({
          sha: commitSha,
          retry: true,
        });
      }

      // Update local state. recordSync re-stats the file so its mtime
      // is current; subsequent findChanges() short-circuits via the
      // stat-cache for these paths.
      for (const path of batch.files) {
        const sha = shaByPath.get(path);
        if (sha === undefined) {
          await this.logger.warn(
            `Sync2 push: missing computed SHA for ${path} — skipping recordSync`,
          );
          continue;
        }
        await this.detector.recordSync(path, sha);
        // If the file we just pushed is one of the managed gitignores,
        // refresh the invariant cache too — otherwise the next sync
        // would see mtime drift, re-read, find the hash matches, and
        // burn an extra read+hash for nothing.
        if (this.invariants) {
          await this.invariants.notePathSelfWritten(path);
        }
      }
      for (const path of batch.deletions) {
        this.detector.recordDeletion(path);
      }
      this.store.setLastSync(commitSha, newTreeSha);
      this.store.setLastCommitMtime(this.now());
      await this.store.save();

      await this.queue.delete(id);
      await this.logger.info(`Sync2 push batch ${id} succeeded`, {
        commitSha,
        treeSha: newTreeSha,
      });
    } catch (err) {
      // Roll back the in-progress marker so a later resume can retry.
      await this.queue.clearInProgress(id);
      await this.logger.error(`Sync2 push batch ${id} failed`, {
        error: String(err),
      });
      throw err;
    }
  }

  // Seed a bare repo with a single Contents API write of
  // <vault>/.gitignore — guaranteed to exist after
  // GitignoreInvariants.enforce() (run by syncAll before
  // drain). Git Data API endpoints return 409 "Git Repository
  // is empty" until the branch has at least one ref, so this is the
  // only way to bootstrap. After this call the branch has one commit
  // ("Init at {date} {time} (label)") and we rewrite the batch's
  // parent SHAs so the rest of processBatch builds on top of the
  // seed just like any Case 2/3 push.
  private async seedBareRepo(batchId: string): Promise<void> {
    const path = this.invariants?.rootPath ?? ".gitignore";
    const buf = await this.vault.adapter.readBinary(path);
    const content = arrayBufferToBase64(buf);
    const message = appendDeviceSuffix(
      applyTemplate(DEFAULT_INIT_COMMIT_MESSAGE, {
        date: new Date(this.now()),
      }),
      this.deviceLabel(),
    );
    await this.logger.info(`Sync2 seed bare repo`, { path, message });
    const seed = await this.client.createFile({
      path,
      content,
      message,
      retry: true,
    });
    await this.queue.updateMeta(batchId, {
      parentCommitSha: seed.commitSha,
      parentTreeSha: seed.treeSha,
    });
    await this.detector.recordSync(path, seed.blobSha);
    if (this.invariants) {
      await this.invariants.notePathSelfWritten(path);
    }
  }

  // Reconcile a batch's contents against a remote head that moved
  // past the batch's parent. For each text file in the batch, we run
  // a 3-way merge against (base = expectedHead, theirs = currentHead);
  // clean merges silently overwrite the batch snapshot, conflicts hand
  // off to onConflict. Binary files are pushed as-is for now (legacy's
  // atomic timestamp resolution would land in a follow-up).
  //
  // After reconcile, the batch's parent SHAs are rewritten so the next
  // step in processBatch builds the commit on top of currentHead. Any
  // later queued batches that touch the same paths are cascade-rebased
  // onto the resolved versions, so they don't push stale "ours".
  private async reconcileBatchAgainstHead(
    batchId: string,
    expectedHead: string,
    currentHead: string,
  ): Promise<void> {
    await this.logger.info(`Sync2 reconcile batch ${batchId}`, {
      expectedHead,
      currentHead,
    });
    const batch = await this.queue.read(batchId);
    // Collect per-path resolved versions so we can cascade-rebase
    // later batches in a single pass instead of N×M loops.
    const resolvedPerPath = new Map<
      string,
      { oldOurs: string; newOurs: string }
    >();
    // Cached head commit (date used by binary/plugin-js mtime fallback)
    // — fetched lazily because most reconcile invocations only see text
    // files.
    let cachedHeadCommit: { committer: { date: string } } | null = null;
    const getHeadCommit = async (): Promise<{ committer: { date: string } }> => {
      if (cachedHeadCommit) return cachedHeadCommit;
      cachedHeadCommit = await this.client.getCommit({
        sha: currentHead,
        retry: true,
      });
      return cachedHeadCommit;
    };
    for (const path of batch.files) {
      const baseFetched = await this.safeFetchContents(path, expectedHead);
      const theirsFetched = await this.safeFetchContents(path, currentHead);

      // No remote-side change for this file? Skip.
      if (
        baseFetched !== null &&
        theirsFetched !== null &&
        baseFetched.sha === theirsFetched.sha
      ) {
        continue;
      }

      if (!hasTextExtension(path)) {
        // Binary overlap: atomic mtime. Same shape as pull-side
        // resolveBinaryConflict, but the loser ALSO drops out of this
        // batch's push (we don't want to upload a stale binary).
        if (theirsFetched === null) {
          // Remote deleted the file. Batch wins: push will resurrect
          // it. Nothing to do here.
          continue;
        }
        const headCommit = await getHeadCommit();
        const remoteMs = Date.parse(headCommit.committer.date);
        const stat = await this.vault.adapter.stat(path);
        const localMs = stat?.mtime ?? 0;
        if (!Number.isNaN(remoteMs) && remoteMs > localMs) {
          // Remote newer → apply remote bytes to live vault, drop path
          // from batch.
          await this.writeBinaryRemote(path, theirsFetched.content);
          await this.detector.recordSync(path, theirsFetched.sha);
          await this.queue.removeFile(batchId, path);
          await this.logger.info(
            "Sync2 reconcile binary: remote newer, dropped from batch",
            { path },
          );
        }
        // else: local newer (or remote date unparseable) — batch wins,
        // push will overwrite remote.
        continue;
      }

      if (isAtomicPluginFile(path, this.configDir)) {
        // Plugin-js overlap: semver from manifest.json, fall through
        // to mtime on tie. theirsFetched is the bytes; we need remote
        // manifest to read its semver.
        if (theirsFetched === null) continue;
        const root = pluginRootOf(path, this.configDir);
        let localSemver: string | null = null;
        let remoteSemver: string | null = null;
        if (root !== null) {
          const manifestPath = `${root}/manifest.json`;
          if (await this.vault.adapter.exists(manifestPath)) {
            const text = await this.vault.adapter.read(manifestPath);
            localSemver = readPluginVersion(text);
          }
          const remoteManifestBlob = await this.safeFetchContents(
            manifestPath,
            currentHead,
          );
          if (remoteManifestBlob) {
            remoteSemver = readPluginVersion(
              decodeBase64String(remoteManifestBlob.content),
            );
          }
        }
        let remoteWins: boolean | null = null;
        if (localSemver !== null && remoteSemver !== null) {
          const cmp = compareSemver(localSemver, remoteSemver);
          if (cmp > 0) remoteWins = false;
          else if (cmp < 0) remoteWins = true;
          // cmp === 0 → fall through to mtime
        }
        if (remoteWins === null) {
          const headCommit = await getHeadCommit();
          const remoteMs = Date.parse(headCommit.committer.date);
          const stat = await this.vault.adapter.stat(path);
          const localMs = stat?.mtime ?? 0;
          remoteWins =
            !Number.isNaN(remoteMs) && remoteMs > localMs;
        }
        if (remoteWins) {
          await this.writeBinaryRemote(path, theirsFetched.content);
          await this.detector.recordSync(path, theirsFetched.sha);
          await this.queue.removeFile(batchId, path);
          await this.logger.info(
            "Sync2 reconcile plugin-js: remote newer, dropped from batch",
            { path, localSemver, remoteSemver },
          );
        }
        continue;
      }

      const oursBytes = await this.queue.readFile(batchId, path);
      const oursContent = new TextDecoder().decode(oursBytes);
      const baseContent = baseFetched
        ? decodeBase64String(baseFetched.content)
        : "";
      const theirsContent = theirsFetched
        ? decodeBase64String(theirsFetched.content)
        : "";

      const merge = mergeText(oursContent, baseContent, theirsContent);
      let resolved: string;
      if (merge.kind === "clean") {
        resolved = merge.content;
      } else {
        const decision = await this.onConflict({
          path,
          ours: oursContent,
          base: baseContent,
          theirs: theirsContent,
          conflictMarkedContent: merge.conflictMarkedContent,
        });
        if (decision.kind === "deferred") {
          // User picked "Later" on an overlap path: stash base+theirs
          // via ConflictStore (sibling file appears in vault), drop the
          // path from this batch AND every subsequent batch in the
          // queue. The path's local vault copy stays as-is; user
          // resolves by editing local + deleting the sibling. Any
          // queued batch that becomes empty after the removal is
          // deleted from disk so drain doesn't try to push nothing.
          if (!this.conflictStore) {
            throw new Error(
              "Sync2 conflict deferral requested but no ConflictStore is wired",
            );
          }
          let theirsAuthor = "unknown";
          try {
            const headCommit = await this.client.getCommit({
              sha: currentHead,
              retry: true,
            });
            theirsAuthor = parseDeviceSuffix(headCommit.message);
          } catch {
            // network / 404 — keep "unknown"
          }
          await this.conflictStore.create({
            vaultPath: path,
            baseContent,
            theirsContent,
            baseCommitSha: expectedHead,
            theirsBlobSha: theirsFetched?.sha ?? "",
            theirsAuthor,
          });
          await this.cascadeDeferRemoval(batchId, path);
          await this.logger.info(
            "Sync2 reconcile deferred via sibling file",
            { path },
          );
          continue;
        }
        resolved = decision.content;
      }

      // Write resolved to BOTH the batch snapshot (what gets pushed)
      // and the live vault (what the user sees). After push the
      // snapshot will recordSync against the resolved SHA, so live ==
      // snapshot == batch == future remote.
      const buf = new TextEncoder().encode(resolved).buffer as ArrayBuffer;
      await this.queue.overwriteFile(batchId, path, buf);
      await this.writeRemoteText(path, resolved);
      resolvedPerPath.set(path, { oldOurs: oursContent, newOurs: resolved });
    }

    if (resolvedPerPath.size > 0) {
      await this.cascadeRebase(batchId, resolvedPerPath);
    }

    // Re-target the batch onto the current head so the next step in
    // processBatch builds the commit there. We need its tree SHA for
    // base_tree.
    const headCommit = await this.client.getCommit({
      sha: currentHead,
      retry: true,
    });
    await this.queue.updateMeta(batchId, {
      parentCommitSha: currentHead,
      parentTreeSha: headCommit.tree.sha,
    });
  }

  // Defer cascade: a path the user just deferred via reconcile must
  // also drop out of every subsequent queued batch. From this batch
  // onwards: remove the path from each batch's snapshot, delete batches
  // that become empty. User resolves by editing local + deleting the
  // sibling; the next sync after that picks up the resolved version
  // through normal findChanges.
  private async cascadeDeferRemoval(
    fromBatchId: string,
    path: string,
  ): Promise<void> {
    const ids = await this.queue.list();
    const startIdx = ids.indexOf(fromBatchId);
    if (startIdx < 0) return;
    for (const id of ids.slice(startIdx)) {
      const batch = await this.queue.read(id);
      if (!batch.files.includes(path) && !batch.deletions.includes(path)) {
        continue;
      }
      // Don't drop files from an in-progress batch — its push is
      // already mid-flight or about to start; mutating mid-push risks
      // a mismatched parentTree. The in-progress batch's reconcile
      // already removed the path from its OWN snapshot before this
      // helper was called (we only cascade to AFTER it).
      if (id !== fromBatchId && batch.inProgress) continue;
      await this.queue.removeFile(id, path);
      // For the current batch we let processBatch's empty-batch-skip
      // handle the delete — reconcile still wants to run updateMeta
      // and other post-resolve steps against it. Later batches are
      // safe to delete here so drain doesn't process empty pushes.
      if (id === fromBatchId) continue;
      const refreshed = await this.queue.read(id);
      if (
        refreshed.files.length === 0 &&
        refreshed.deletions.length === 0
      ) {
        await this.queue.delete(id);
      }
    }
  }

  // Propagate every resolution from a just-reconciled batch into the
  // batches behind it in the queue. Single-pass: list() + read() per
  // later batch happens once each, regardless of how many paths the
  // primary reconcile resolved. For each later batch we then
  // intersect resolvedPerPath with the batch's file list and 3-way
  // merge each match.
  //
  // The cascade base is `oldOurs` (the pre-resolve snapshot of the
  // primary batch); `theirs` is the resolved version. A clean
  // cascade merge silently overwrites the later batch's snapshot;
  // overlapping conflicts route through the same onConflict callback
  // the primary reconcile used.
  private async cascadeRebase(
    fromBatchId: string,
    resolvedPerPath: Map<string, { oldOurs: string; newOurs: string }>,
  ): Promise<void> {
    if (resolvedPerPath.size === 0) return;
    const ids = await this.queue.list();
    const startIdx = ids.indexOf(fromBatchId);
    if (startIdx < 0) return;
    for (const id of ids.slice(startIdx + 1)) {
      const batch = await this.queue.read(id);
      const intersection = batch.files.filter((p) => resolvedPerPath.has(p));
      if (intersection.length === 0) continue;
      for (const path of intersection) {
        const { oldOurs, newOurs } = resolvedPerPath.get(path)!;
        const oursBytes = await this.queue.readFile(id, path);
        const ours = new TextDecoder().decode(oursBytes);
        const merge = mergeText(ours, oldOurs, newOurs);
        let resolved: string;
        if (merge.kind === "clean") {
          resolved = merge.content;
        } else {
          const decision = await this.onConflict({
            path,
            ours,
            base: oldOurs,
            theirs: newOurs,
            conflictMarkedContent: merge.conflictMarkedContent,
          });
          resolved = this.requireResolvedContent(decision, "cascade rebase");
        }
        const buf = new TextEncoder().encode(resolved).buffer as ArrayBuffer;
        await this.queue.overwriteFile(id, path, buf);
      }
    }
  }

  // Convert a ConflictResolution to the resolved content, throwing if
  // the user picked "Later". Defer is only meaningful at pull time
  // (we still have leeway to skip the path); during cascade rebase or
  // in-flight batch reconcile the push is already happening, so the
  // diff modal should not even surface a Defer button. This helper
  // turns a misuse into a loud failure rather than a silent push of
  // half-merged content.
  private requireResolvedContent(
    decision: ConflictResolution,
    context: string,
  ): string {
    if (decision.kind === "deferred") {
      throw new Error(
        `Sync2 ${context}: cannot defer a conflict mid-push. ` +
          `The diff modal should not offer "Later" in this context.`,
      );
    }
    return decision.content;
  }

  private async safeFetchContents(
    path: string,
    ref: string,
  ): Promise<{ content: string; sha: string } | null> {
    try {
      return await this.client.getContentsAtRef({
        path,
        ref,
        retry: true,
      });
    } catch {
      // Force-push or commit GC made the ref unreachable. Treat as
      // "no base available" → the merge will run against an empty
      // base, which is the documented graceful-degradation path.
      return null;
    }
  }

  private async estimateBatchBytes(batchId: string): Promise<number> {
    const batch = await this.queue.read(batchId);
    let total = 0;
    const vaultRoot = `${this.configDir}/plugins/${this.selfPluginId}/.push-queue/${batchId}/vault`;
    for (const f of batch.files) {
      const stat = await this.vault.adapter.stat(`${vaultRoot}/${f}`);
      if (stat) total += stat.size;
    }
    return total;
  }

  private async computeShaByPath(
    entries: NewTreeRequestItem[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const entry of entries) {
      if (entry.sha === null) continue; // deletion — nothing to record
      if (typeof entry.sha === "string") {
        // Binary path: TreeBuilder fed createBlob and recorded the SHA.
        out.set(entry.path, entry.sha);
        continue;
      }
      if (typeof entry.content === "string") {
        // Text path: we know the bytes we sent; compute git's blob SHA
        // locally so we don't need a round-trip to learn what GitHub
        // assigned (it's deterministic).
        const buf = new TextEncoder().encode(entry.content)
          .buffer as ArrayBuffer;
        out.set(entry.path, await calculateGitBlobSHA(buf));
      }
    }
    return out;
  }
}

