// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

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
import { isAtomicPluginFile, pluginRootOf, readPluginVersion } from "./plugin-js";
import {
  applyTemplate,
  appendDeviceSuffix,
  DEFAULT_INIT_COMMIT_MESSAGE,
  parseDeviceSuffix,
} from "./commit-templates";
import ConflictStore, { ConflictKind } from "./conflict-store";
import {
  attemptAutoMerge,
  PluginJsContext,
} from "./conflict-detection";
import { evaluateConflictState } from "./conflict-classifier";
import { ConflictWatcher } from "./conflict-watcher";
import { buildConflictBranchName } from "./conflict-branch";
import { normalizeText } from "./text-normalize";
import { FileChange } from "./types";

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
    // Single parent (existing call sites). Use `parents` for merge
    // commits in pseudo-merge stage 7+ (multi-parent finalize).
    parent?: string;
    parents?: string[];
    retry?: boolean;
  }): Promise<string>;
  updateBranchHead(args: { sha: string; retry?: boolean }): Promise<void>;
  // Pseudo-merge stage 7+: arbitrary-ref operations for the per-
  // device conflict branch lifecycle.
  // `ref` is in the post-"refs/" form, e.g. "heads/easy-sync-
  // conflicts-Obsidian-20260520143022-847".
  createReference(args: {
    ref: string;
    sha: string;
    retry?: boolean;
  }): Promise<void>;
  updateReference(args: {
    ref: string;
    sha: string;
    force?: boolean;
    retry?: boolean;
  }): Promise<void>;
  deleteReference(args: { ref: string; retry?: boolean }): Promise<void>;
  // Lists refs whose name starts with `prefix` (post-"refs/" form).
  // Returns [] on 404. Used by the recovery sweep to enumerate our
  // conflict branches on this device's GitHub repo.
  getMatchingRefs(args: {
    prefix: string;
    retry?: boolean;
  }): Promise<Array<{ ref: string; sha: string }>>;
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

// Thresholds for the lazy-opened progress notice. A pull or push
// cycle stays silent (no long-lived notice) below these; above either
// bound, drain opens a "Pull/Push N/M…" notice the user can watch.
// PROGRESS_BYTES_THRESHOLD applies to both pull (sum of tree sizes
// for the syncable changes) and push (estimateBatchBytes). Default
// 500 KB — overridable via Sync2ManagerDeps.progressBytesThreshold
// so tests can flip it to 0 to assert notice behaviour without
// having to fabricate 500 KB+ of test data.
export const PROGRESS_BYTES_THRESHOLD = 500 * 1024;
const PROGRESS_COUNT_THRESHOLD = 5;

// Progress UI hook. Sync2Manager keeps one handle per drain run and
// calls update() as it advances commits or files. Whether that maps
// to an Obsidian Notice, a status-bar item, or a noop is the caller's
// decision — sync2's logic doesn't depend on which.
export interface ProgressHandle {
  update(message: string): void;
  hide(): void;
}
export type ProgressFactory = (initialMessage: string) => ProgressHandle;

// Thin async logger surface — Sync2Manager records phase markers and
// errors. Backed by src/logger.ts which appends JSON lines to
// <vault>/<plugin-id>.log.
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
  commitMessage: string | (() => string);
  // Per-device label appended to every commit message as a fixed
  // " (label)" suffix and recorded in conflict-store metadata. One
  // setting drives both surfaces — see commit-templates.ts /
  // conflict-store.ts for the consumers. Live-readable for the same
  // reason as the templates above.
  deviceLabel: string | (() => string);
  // Pseudo-merge ConflictStore. Receives a record whenever detection
  // can't auto-resolve a conflict. Required in production; unit tests
  // that don't exercise the conflict path can omit it (the manager
  // throws if a conflict tries to register and the store is missing).
  conflictStore?: ConflictStore;
  // Pseudo-merge ConflictWatcher (stage 9 wiring). The drain wraps
  // its batch loop in pause/resume so mid-drain vault writes from
  // sibling-create don't trigger nested evaluateConflictState
  // invocations. Optional: tests that don't care leave it out and
  // sweeps still run inline via evaluateConflictState directly.
  conflictWatcher?: ConflictWatcher;
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
  // Bytes threshold for lazy-opening the long-lived progress notice
  // during drain's pull and push cycles. Defaults to 500 KB; tests
  // pass 0 to make every cycle "heavy" so they can assert the
  // notice transitions.
  progressBytesThreshold?: number;
  // Live getter for the autoCanonicalizeTextFiles setting. When `false`,
  // writeRemoteText writes raw remote bytes without CRLF→LF/BOM/trailing
  // -NL rewrites — the engine treats text the same as binary at the
  // byte level. Optional; default is true (canonicalization on).
  autoCanonicalize?: () => boolean;
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
  private readonly commitMessage: () => string;
  private readonly deviceLabel: () => string;
  private readonly conflictStore: ConflictStore | undefined;
  private readonly conflictWatcher: ConflictWatcher | undefined;
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
  // syncAll/syncFile; only counts real vault mutations
  // (no identical-SHA noops).
  private pulledFilesThisSync = 0;
  private readonly remoteIdentity: (() => RemoteIdentity) | undefined;
  private readonly progressBytesThreshold: number;
  private readonly autoCanonicalize: () => boolean;
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
    this.commitMessage =
      typeof deps.commitMessage === "function"
        ? deps.commitMessage
        : () => deps.commitMessage as string;
    this.deviceLabel =
      typeof deps.deviceLabel === "function"
        ? deps.deviceLabel
        : () => deps.deviceLabel as string;
    this.conflictStore = deps.conflictStore;
    this.conflictWatcher = deps.conflictWatcher;
    this.accumulateOfflineSyncs = deps.accumulateOfflineSyncs ?? false;
    this.onProgress = deps.onProgress;
    this.onLocalCommitted = deps.onLocalCommitted;
    this.onNoLocalChanges = deps.onNoLocalChanges;
    this.onSyncCompleted = deps.onSyncCompleted;
    this.remoteIdentity = deps.remoteIdentity;
    this.progressBytesThreshold =
      deps.progressBytesThreshold ?? PROGRESS_BYTES_THRESHOLD;
    this.autoCanonicalize = deps.autoCanonicalize ?? (() => true);
    this.now = deps.now ?? (() => Date.now());
  }

  // Action 1 — full sync.
  //
  // Click path is LOCAL ONLY: identity check → optional one-time
  // bootstrap (network, fires only when lastSyncCommitSha is null) →
  // invariants → findChanges → enqueue. Returns when the batch is on
  // disk. Network drain (pull + push) runs inside drain() which can
  // also be triggered by the interval timer or onload.
  async syncAll(): Promise<void> {
    await this.logger.info("Sync2 syncAll start");
    // Remote-identity drift check runs FIRST — before bootstrapIfNeeded.
    // If the user pointed the plugin at a different
    // (owner, repo, branch), we wipe local state here so the rest of
    // syncAll naturally routes through adoption-from-remote against
    // the new remote (lastSyncCommitSha is null after the wipe →
    // bootstrapIfNeeded sees the new branch and clones it).
    await this.reconcileRemoteIdentity();
    // Click is local-only; the long-lived progress notice is opened
    // LAZILY inside drain only when a batch's pull or push exceeds
    // PROGRESS_BYTES_THRESHOLD. Light syncs run silent and finish
    // with a brief "Sync done" via onSyncCompleted.
    const progress: ProgressHandle | null = (null as ProgressHandle | null);
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
        // flash a brief "Nothing to commit" notice. If the queue still has
        // pending batches (offline-accumulate case), drain
        // picks them up and onProgress takes over the user feedback.
        const pendingBatches = await this.queue.list();
        if (pendingBatches.length === 0) this.onNoLocalChanges?.();
        await this.drain(progress);
        await this.logger.info("Sync2 syncAll: nothing to sync");
        return;
      }
      const enqueued = await this.enqueueOrMerge(changes, this.fullSyncMeta());
      syncedFiles = enqueued;
      if (enqueued > 0) {
        this.onLocalCommitted?.(enqueued);
        // TEMPORARY DEBUG LOG: list every file the click is about to
        // commit so a user reading `<plugin-id>.log` can cross-check
        // the "Commit N files" notice against the actual paths. Drop
        // once the change-detection pipeline has had enough field
        // testing on multi-device traffic.
        await this.logger.info("Sync2 syncAll committed", {
          count: enqueued,
          changes: changes.map((c) => `${c.kind} ${c.path}`),
        });
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

  // Action 2 — sync just the file at `path`.
  //
  // Behaviour when there's nothing to push (file matches snapshot,
  // missing on both sides, hardcoded-blocked, gitignored): logs a
  // notice and returns silently. No queue batch is created.
  async syncFile(path: string): Promise<void> {
    await this.logger.info(`Sync2 syncFile start`, { path });
    // Remote-identity drift check first — same reason as syncAll. If
    // settings now point at a different remote, the snapshot is
    // useless and we'd be pushing single-file content to the wrong
    // repo if we kept going.
    await this.reconcileRemoteIdentity();
    const progress: ProgressHandle | null = (null as ProgressHandle | null);
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

      // Same unified template as syncAll — pseudo-merge's split-push
      // + accumulate-offline-syncs make per-file commit identity
      // unreliable. {filename}/{path} placeholders are no longer
      // supported.
      const baseMessage = applyTemplate(this.commitMessage(), {
        date: new Date(this.now()),
      });
      const message = appendDeviceSuffix(baseMessage, this.deviceLabel());
      const enqueued = await this.enqueueOrMerge([change], {
        commitMessage: message,
        parentCommitSha: this.store.getLastSyncCommitSha(),
        parentTreeSha: this.store.getLastSyncTreeSha(),
      });
      syncedFiles = enqueued;
      if (enqueued > 0) {
        this.onLocalCommitted?.(enqueued);
        // TEMPORARY DEBUG LOG (matches syncAll). Single-file path so
        // the entry shape stays identical for grep-ability.
        await this.logger.info("Sync2 syncFile committed", {
          count: enqueued,
          changes: [`${change.kind} ${change.path}`],
        });
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

  // resumeQueue — drain any pending batches without re-running
  // findChanges. Background entry point: invoked from onload (after
  // a previous session crashed mid-push) and from the watchdog tick
  // when interval-strategy is "manually" but the queue has work.
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
  //     syncs), `attemptAutoMerge` runs against base = lastSyncCommitSha
  //     content. Clean merges land silently; plugin-js gets atomic
  //     semver resolution; everything that can't auto-resolve goes
  //     into the ConflictStore as a sibling on a per-device conflict
  //     branch (split-push, pseudo-merge).
  // Removals: delete-vs-modify races route through the same conflict
  // path (kind="delete-vs-modify"), so the user explicitly picks
  // keep-delete vs accept-remote-version via the sibling-file UI.
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
    // Bytes-based threshold: fetch the head tree once and sum the
    // sizes of the syncable changes. The notice opens iff the total
    // would actually take noticeable time to download. Skipped when
    // there's nothing to pull (no tree call cost).
    let isHeavyPull = false;
    if (syncableChanges.length > 0) {
      try {
        const { files: treeFiles } = await this.client.getRepoContent({
          retry: true,
        });
        let totalBytes = 0;
        for (const f of syncableChanges) {
          totalBytes += treeFiles[f.filename]?.size ?? 0;
        }
        isHeavyPull = totalBytes > this.progressBytesThreshold;
      } catch {
        // Tree call failed (rare); fall back to count-based heuristic.
        isHeavyPull = syncableChanges.length > PROGRESS_COUNT_THRESHOLD;
      }
    }
    if (syncableChanges.length > 0 && isHeavyPull) {
      const initial =
        syncableChanges.length === 1
          ? "Pull file from GitHub…"
          : `Pull 0/${syncableChanges.length} files from GitHub`;
      if (pullProgress === null && this.onProgress) {
        pullProgress = this.onProgress(initial);
      } else if (pullProgress) {
        pullProgress.update(initial);
      }
    }
    let processed = 0;
    const tickPull = (): void => {
      processed += 1;
      if (pullProgress) {
        pullProgress.update(
          syncableChanges.length === 1
            ? "Pull file from GitHub…"
            : `Pull ${processed}/${syncableChanges.length} files from GitHub`,
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
          await this.applyRemoteDeletion(f.filename, expectedHead, currentHead);
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
          await this.applyRemoteDeletion(f.previous_filename, expectedHead, currentHead);
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

        // Canonicalize-aware resume: when the local copy matches what
        // we WOULD write under autoCanonicalize, the file is our own
        // interrupted-adoption leftover from a previous run that was
        // killed (e.g., Android process suspended) before recordSync
        // landed for this entry. Without this branch, the mtime-newer
        // check below would mis-classify it as user-edited "local
        // wins" and push the canonicalized bytes back to GitHub
        // pretending they're user content — exactly the surprise
        // 96-file re-push reported on first Android setup.
        if (
          hasTextExtension(filePath) &&
          this.autoCanonicalize() &&
          (await this.canonicalMatchesLocal(filePath, item.sha, localSha))
        ) {
          const stat = await this.vault.adapter.stat(filePath);
          if (stat) {
            this.store.set(filePath, {
              path: filePath,
              remoteSha: localSha,
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

    const localChange = await this.detector.findChangeForPath(path);
    const exists = await this.vault.adapter.exists(path);

    // Case 1: local is clean against snapshot → pull straight in.
    if (localChange === null) {
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

    const theirsBytes = base64ToArrayBuffer(blob.content) as ArrayBuffer;

    // Case 2: ours deleted, theirs modified → delete-vs-modify.
    if (localChange.kind === "deleted") {
      await this.registerConflictAndDropPath({
        vaultPath: path,
        kind: "delete-vs-modify",
        theirsContent: theirsBytes,
        theirsBlobSha: blob.sha,
        oursBlobSha: null,
        remoteDevice: await this.fetchRemoteDevice(headRef),
        fromBatchId: null,
      });
      return;
    }

    // Case 3: both modified → try auto-merge, register if it fails.
    const oursBytes = exists
      ? await this.vault.adapter.readBinary(path)
      : new ArrayBuffer(0);
    const baseFetched = await this.safeFetchContents(path, baseRef);
    const baseBytes = baseFetched
      ? (base64ToArrayBuffer(baseFetched.content) as ArrayBuffer)
      : null;

    let pluginJs: PluginJsContext | undefined;
    if (isAtomicPluginFile(path, this.configDir)) {
      pluginJs = await this.readPluginJsContext(path, headRef);
    }

    const auto = attemptAutoMerge({
      path,
      ours: oursBytes,
      theirs: theirsBytes,
      base: baseBytes,
      configDir: this.configDir,
      pluginJs,
    });

    if (auto.type === "clean") {
      // Text 3-way merged cleanly. Write canonical; recordSync only
      // when canonical bytes match the remote SHA (otherwise the
      // canonicalization gap surfaces on the next findChanges).
      const text = new TextDecoder().decode(auto.content);
      const { canonicalSha } = await this.writeRemoteText(path, text);
      if (canonicalSha === blob.sha) {
        await this.detector.recordSync(path, canonicalSha);
      }
      return;
    }

    if (auto.type === "atomic") {
      if (auto.side === "ours") {
        // Keep local; snapshot stays at the old SHA so the next push
        // surfaces ours to remote.
        await this.logger.info(
          "Sync2 atomic auto-merge: kept ours",
          { path },
        );
      } else {
        // Remote wins — overwrite local in place.
        await this.writeBinaryRemote(path, blob.content);
        await this.detector.recordSync(path, blob.sha);
        await this.logger.info(
          "Sync2 atomic auto-merge: overwrote with theirs",
          { path },
        );
      }
      return;
    }

    // auto.type === "register-conflict"
    await this.registerConflictAndDropPath({
      vaultPath: path,
      kind: "modify-vs-modify",
      theirsContent: theirsBytes,
      theirsBlobSha: blob.sha,
      oursBlobSha: await calculateGitBlobSHA(oursBytes),
      remoteDevice: await this.fetchRemoteDevice(headRef),
      fromBatchId: null,
    });
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
    _baseRef: string,
    _currentHead: string,
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

    // Local has its own changes — modify-vs-delete. Auto-resolves in
    // favour of local: leave the file alone, no recordSync (so the
    // pending batch's "modified" entry stays in the queue and pushes
    // the local content back to remote on the next pass, resurrecting
    // the file). In practice this branch is unreachable because
    // pullIfNeeded skips applyRemoteDeletion for paths in queuedPaths
    // (those route through reconcileBatchAgainstHead instead, which
    // surfaces the same outcome as AutoMergeResult.type ===
    // "modify-wins"). Kept as a defensive no-op for symmetry.
    await this.logger.info(
      "Sync2 applyRemoteDeletion: modify-wins (local-modify resurrects file)",
      { path },
    );
  }

  // ── pseudo-merge detection helpers (stage 5c) ──────────────────────

  // Snapshot live base file stats + SHA at conflict-registration time.
  // ConflictRecord caches these so the classifier can detect "user
  // copied sibling onto base" (case 6) without re-reading the vault on
  // every sweep. Returns nulls for kind=delete-vs-modify (the base
  // file doesn't exist by definition).
  private async snapshotBaseCache(
    path: string,
    kind: ConflictKind,
  ): Promise<{
    baseMtime: number | null;
    baseSize: number | null;
    baseSha: string | null;
  }> {
    if (kind === "delete-vs-modify") {
      return { baseMtime: null, baseSize: null, baseSha: null };
    }
    const stat = await this.vault.adapter.stat(path);
    if (!stat || stat.type !== "file") {
      return { baseMtime: null, baseSize: null, baseSha: null };
    }
    const bytes = await this.vault.adapter.readBinary(path);
    return {
      baseMtime: stat.mtime,
      baseSize: stat.size,
      baseSha: await calculateGitBlobSHA(bytes),
    };
  }

  // Read the remote commit's device suffix off the trailing
  // " (label)" of its message. Failures (network, GC'd ref) degrade
  // gracefully to "unknown" — the sibling filename still lands, just
  // labelled as such.
  private async fetchRemoteDevice(ref: string): Promise<string> {
    try {
      const headCommit = await this.client.getCommit({
        sha: ref,
        retry: true,
      });
      return parseDeviceSuffix(headCommit.message);
    } catch {
      return "unknown";
    }
  }

  // Read both sides' manifest.json for a plugin-js path and return
  // the (version, mtime) pair attemptAutoMerge needs. Either side may
  // be null when the manifest is missing or unparseable — the
  // detection helper falls back to mtime.
  private async readPluginJsContext(
    path: string,
    headRef: string,
  ): Promise<PluginJsContext | undefined> {
    const root = pluginRootOf(path, this.configDir);
    if (root === null) return undefined;
    const manifestPath = `${root}/manifest.json`;

    let oursVersion: string | null = null;
    let oursMtime = 0;
    if (await this.vault.adapter.exists(manifestPath)) {
      const text = await this.vault.adapter.read(manifestPath);
      oursVersion = readPluginVersion(text);
    }
    const oursStat = await this.vault.adapter.stat(path);
    if (oursStat) oursMtime = oursStat.mtime;

    let theirsVersion: string | null = null;
    const remoteManifest = await this.safeFetchContents(manifestPath, headRef);
    if (remoteManifest) {
      theirsVersion = readPluginVersion(
        decodeBase64String(remoteManifest.content),
      );
    }
    let theirsMtime = 0;
    try {
      const headCommit = await this.client.getCommit({
        sha: headRef,
        retry: true,
      });
      const parsed = Date.parse(headCommit.committer.date);
      if (!Number.isNaN(parsed)) theirsMtime = parsed;
    } catch {
      // best-effort — leave at 0
    }
    return { oursVersion, theirsVersion, oursMtime, theirsMtime };
  }

  // Register a conflict in the ConflictStore and remove the path from
  // any queued batches. Pull-side callers pass fromBatchId=null (no
  // batch yet for this path); push-side reconcile callers pass the
  // batch id so the path drops out of the current batch + every
  // later batch (cascade-defer) before reaching the main-push tree
  // build. Also pushes a snapshot of the local "ours" version to the
  // per-device conflict branch so the pre-conflict state is preserved
  // on GitHub even though it's filtered out of main.
  private async registerConflictAndDropPath(args: {
    vaultPath: string;
    kind: ConflictKind;
    theirsContent: ArrayBuffer;
    theirsBlobSha: string;
    oursBlobSha: string | null;
    remoteDevice: string;
    fromBatchId: string | null;
  }): Promise<void> {
    if (!this.conflictStore) {
      throw new Error(
        "Sync2 conflict registration requested but no ConflictStore is wired",
      );
    }
    const baseCache = await this.snapshotBaseCache(args.vaultPath, args.kind);
    await this.conflictStore.create({
      vaultPath: args.vaultPath,
      kind: args.kind,
      theirsContent: args.theirsContent,
      theirsBlobSha: args.theirsBlobSha,
      oursBlobSha: args.oursBlobSha,
      baseMtime: baseCache.baseMtime,
      baseSize: baseCache.baseSize,
      baseSha: baseCache.baseSha,
      remoteDevice: args.remoteDevice,
    });
    this.pulledFilesThisSync++;
    await this.logger.info("Sync2 conflict registered", {
      path: args.vaultPath,
      kind: args.kind,
    });
    // Push ours' version to the per-device conflict branch so the
    // user's pre-conflict state is preserved as a server-side commit
    // (PSEUDO-MERGE-MODE.md §"Архітектура push: split-push у
    // processBatch" step 4). Eager: branch is created at current
    // main HEAD on the first conflict registration of the session,
    // each subsequent conflict appends one commit. For
    // delete-vs-modify, ours was "delete" → tree entry is sha:null.
    const branchContent = args.kind === "delete-vs-modify" ? null : await this.readLocalBytesForBranchPush(args.vaultPath);
    await this.pushConflictPathsToBranch(
      [{ path: args.vaultPath, content: branchContent }],
      `Conflict snapshot: ${args.vaultPath} (${args.kind})`,
    );

    if (args.fromBatchId === null) return;

    // Push-side cascade: drop the path from the current batch + every
    // later queued batch so main-push doesn't accidentally upload
    // pre-conflict bytes.
    const ids = await this.queue.list();
    const startIdx = ids.indexOf(args.fromBatchId);
    if (startIdx < 0) return;
    for (const id of ids.slice(startIdx)) {
      const batch = await this.queue.read(id);
      if (
        !batch.files.includes(args.vaultPath) &&
        !batch.deletions.includes(args.vaultPath)
      ) {
        continue;
      }
      if (id !== args.fromBatchId && batch.inProgress) continue;
      await this.queue.removeFile(id, args.vaultPath);
      if (id === args.fromBatchId) continue;
      const refreshed = await this.queue.read(id);
      if (
        refreshed.files.length === 0 &&
        refreshed.deletions.length === 0
      ) {
        await this.queue.delete(id);
      }
    }
  }

  // Read the local "ours" bytes for a path being registered as a
  // conflict, for the conflict-branch push. Pulls from the live
  // vault — applyRemoteAddOrModify / applyRemoteDeletion / reconcile
  // callers all observe a vault that matches the value we want to
  // preserve on the server side. Missing file → 0-byte buffer
  // (defensive; the caller should already have routed delete-vs-modify
  // to a sha:null tree entry by the time we get here).
  private async readLocalBytesForBranchPush(
    vaultPath: string,
  ): Promise<ArrayBuffer> {
    if (!(await this.vault.adapter.exists(vaultPath))) {
      return new ArrayBuffer(0);
    }
    return await this.vault.adapter.readBinary(vaultPath);
  }

  // Push N conflict-path entries to the per-device conflict branch
  // as a single commit. Eager-create the branch at current main HEAD
  // when this is the first conflict of the session; otherwise append
  // to the existing branch head. `base_tree` for the new commit is
  // ALWAYS current main.tree — that's the "rebase forward" rule from
  // PSEUDO-MERGE-MODE.md §"Архітектура push: split-push у processBatch".
  // It keeps the branch trivially merge-able back to main on finalize:
  // branch.tree == main.tree + (only the conflict paths overridden).
  //
  // Each `entries[i].content` is the bytes that go on the branch:
  //   - ArrayBuffer → uploaded as a blob; tree entry references the
  //     blob's SHA.
  //   - null        → deletion (tree entry `sha: null`).
  //
  // Updates SnapshotStore.conflictBranch with the new head and
  // persists. Caller is responsible for ordering vs other writes.
  private async pushConflictPathsToBranch(
    entries: Array<{ path: string; content: ArrayBuffer | null }>,
    message: string,
  ): Promise<void> {
    if (entries.length === 0) return;

    // 1. Fresh main HEAD + tree (rebase forward).
    const mainHead = await this.client.getBranchHeadSha({ retry: true });
    const mainCommit = await this.client.getCommit({
      sha: mainHead,
      retry: true,
    });
    const mainTreeSha = mainCommit.tree.sha;

    // 2. Resolve / create the conflict branch.
    let cb = this.store.getConflictBranch();
    if (cb === null) {
      // Eager creation: name = easy-sync-conflicts-{label}-{ts}-{mmm}.
      // On the rare 422 "Reference already exists" (cross-device
      // sub-second collision on the default label), re-generate
      // with a freshly-clocked now() — millisecond resolution makes
      // a second collision vanishingly small.
      let attempt = 0;
      while (true) {
        const name = buildConflictBranchName(this.deviceLabel(), this.now());
        try {
          await this.client.createReference({
            ref: `refs/heads/${name}`,
            sha: mainHead,
            retry: true,
          });
          cb = { name, head: mainHead };
          break;
        } catch (err) {
          attempt += 1;
          const status = (err as { status?: number }).status;
          if (status === 422 && attempt < 5) {
            // Yield a millisecond and retry.
            await new Promise((r) => setTimeout(r, 2));
            continue;
          }
          throw err;
        }
      }
      this.store.setConflictBranch(cb);
      await this.store.save();
      await this.logger.info("Sync2 conflict-branch created", {
        name: cb.name,
        baseSha: mainHead,
      });
    }

    // 3. Build tree entries. For each path with content: createBlob
    //    + tree entry referencing the blob SHA. For sha:null entries
    //    (delete-vs-modify), the tree entry directly records the
    //    delete against base_tree.
    const treeEntries: NewTreeRequestItem[] = [];
    for (const e of entries) {
      if (e.content === null) {
        treeEntries.push({
          path: e.path,
          mode: "100644",
          type: "blob",
          sha: null,
        });
      } else {
        const base64 = arrayBufferToBase64(e.content);
        const { sha } = await this.client.createBlob({
          content: base64,
          encoding: "base64",
          retry: true,
        });
        treeEntries.push({
          path: e.path,
          mode: "100644",
          type: "blob",
          sha,
        });
      }
    }

    // 4. createTree on top of main.tree (always rebase forward).
    const newTreeSha = await this.client.createTree({
      tree: { tree: treeEntries, base_tree: mainTreeSha },
      retry: true,
    });

    // 5. createCommit on branch.head. On a freshly-created branch
    //    cb.head === mainHead, so the first conflict commit's parent
    //    is main; subsequent conflicts chain on the previous one.
    const commitSha = await this.client.createCommit({
      message,
      treeSha: newTreeSha,
      parent: cb.head,
      retry: true,
    });

    // 6. updateReference (PATCH /git/refs/heads/<branch>) + persist.
    await this.client.updateReference({
      ref: `heads/${cb.name}`,
      sha: commitSha,
      retry: true,
    });
    this.store.setConflictBranch({ name: cb.name, head: commitSha });
    await this.store.save();
    await this.logger.info("Sync2 conflict-branch commit pushed", {
      branch: cb.name,
      newHead: commitSha,
      paths: entries.map((e) => e.path),
    });
  }

  // Finalize the active conflict branch back into main when every
  // record in the ConflictStore has been resolved. Manual
  // merge-commit on main with parents=[main.head, branch.head] +
  // tree=main.tree (the user's resolutions already landed in main
  // via the regular push path; the branch just carries history).
  // Then deleteReference + clear local conflictBranch state.
  //
  // No-op when there's no active branch OR when records remain.
  // Safe to call multiple times — idempotent on a "nothing to do"
  // input.
  private async finalizeConflictBranchIfReady(): Promise<void> {
    const cb = this.store.getConflictBranch();
    if (cb === null) return;
    if (!this.conflictStore) return;
    if (this.conflictStore.getAll().length > 0) return;

    const mainHead = await this.client.getBranchHeadSha({ retry: true });
    const mainCommit = await this.client.getCommit({
      sha: mainHead,
      retry: true,
    });
    const mainTreeSha = mainCommit.tree.sha;

    const message = appendDeviceSuffix(
      `Merge ${cb.name}`,
      this.deviceLabel(),
    );
    const mergeCommit = await this.client.createCommit({
      message,
      treeSha: mainTreeSha,
      parents: [mainHead, cb.head],
      retry: true,
    });
    await this.client.updateBranchHead({ sha: mergeCommit, retry: true });
    await this.client.deleteReference({
      ref: `heads/${cb.name}`,
      retry: true,
    });

    this.store.clearConflictBranch();
    this.store.setLastSync(mergeCommit, mainTreeSha);
    await this.store.save();
    await this.logger.info("Sync2 conflict-branch finalized", {
      branch: cb.name,
      mergeCommit,
    });
  }

  // Write text content to disk in canonical form (LF, no BOM,
  // trailing-NL iff non-empty) when autoCanonicalize is on. Returns
  // the on-disk SHA so the caller can recordSync against the actual
  // bytes, plus a `changed` flag indicating whether normalization
  // mutated the input — callers use that to decide whether the next
  // findChanges should treat the file as modified (republish).
  //
  // When autoCanonicalize is off, no normalization happens: the input
  // bytes are written verbatim, the returned `changed` is always false,
  // and the SHA is computed against the raw bytes.
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
    const canonicalize = this.autoCanonicalize();
    const { content: canonical, changed } = canonicalize
      ? normalizeText(content)
      : { content, changed: false };
    await this.ensureParentDir(path);
    await this.vault.adapter.write(path, canonical);
    const bytes = new TextEncoder().encode(canonical).buffer as ArrayBuffer;
    const canonicalSha = await calculateGitBlobSHA(bytes);
    return { canonicalSha, changed };
  }

  // Fetch the remote text blob, run it through the same canonicalize
  // logic writeRemoteText would apply, and compare its git-blob SHA to
  // the local file's SHA. Used by adoption resume to recognize files
  // that the previous (interrupted) bootstrap already wrote out in
  // canonical form but didn't get to recordSync. Adds one getBlob per
  // candidate path during adoption only — the post-adoption fast path
  // (pullIfNeeded) never reaches this code.
  private async canonicalMatchesLocal(
    filePath: string,
    remoteSha: string,
    localSha: string,
  ): Promise<boolean> {
    try {
      const blob = await this.client.getBlob({ sha: remoteSha, retry: true });
      const remoteText = decodeBase64String(blob.content);
      const { content: canonical } = normalizeText(remoteText);
      const canonicalBytes = new TextEncoder().encode(canonical)
        .buffer as ArrayBuffer;
      const canonicalSha = await calculateGitBlobSHA(canonicalBytes);
      return localSha === canonicalSha;
    } catch {
      // Fail closed: if we can't fetch / decode the blob, fall through
      // to the mtime branch — same behavior as before the resume hint.
      return false;
    }
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
  // Pseudo-merge note: paths currently in the ConflictStore are NOT
  // filtered here — processBatch's split-push partition (see below)
  // routes them to the conflict branch instead of main. The user's
  // edits to an in-conflict file thus accumulate as commits on the
  // branch, and never leak to main until the conflict resolves.
  // Returns the number of distinct file paths actually enqueued.
  // Callers use this to drive the local-phase user feedback Notice
  // ("Commit N files").
  private async enqueueOrMerge(
    changes: import("./types").FileChange[],
    meta: EnqueueMeta,
  ): Promise<number> {
    if (changes.length === 0) return 0;
    // Pseudo-merge stage 7c: in-conflict paths are NOT filtered here
    // anymore. Edits to a file that's currently in conflict flow
    // through to processBatch's split-push partition step, where
    // they're routed to the per-device conflict branch on GitHub
    // (not main). The conflict's local "ours" history accumulates
    // server-side, invisible to other devices until resolution.
    if (this.accumulateOfflineSyncs) {
      const target = await this.queue.mergeIntoLatestPending(changes);
      if (target !== null) {
        // Refresh the merged batch's commit message to the latest
        // template render. "Last std-sync in the group wins" — the
        // timestamp on GitHub then reflects when the batch actually
        // shipped, not when the first click happened.
        await this.queue.updateCommitMessage(target, meta.commitMessage);
        return changes.length;
      }
    }
    await this.queue.enqueue(changes, meta);
    return changes.length;
  }

  private fullSyncMeta(): EnqueueMeta {
    const base = applyTemplate(this.commitMessage(), {
      date: new Date(this.now()),
    });
    return {
      // Always-trailing " (deviceLabel)" lets a future viewer read
      // the source-device off any sync2 commit on GitHub regardless
      // of how the user customized the template.
      // See commit-templates.ts → appendDeviceSuffix.
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
      // First-ever sync against this remote needs the bootstrap probe
      // BEFORE pullIfNeeded — adoption resolves identical/local-only/
      // remote-only/diverging files, sets lastSyncCommitSha. Click
      // paths (syncAll/syncFile) already call this in their body, but
      // background entry points (onload's resumeQueue, interval-tick
      // backgroundDrain) reach drain directly without going through
      // the click body — they MUST bootstrap here or fresh devices
      // would silently no-op forever.
      // bootstrapIfNeeded short-circuits in O(1) when
      // lastSyncCommitSha !== null, so the click-path callers pay
      // nothing for this defensive call.
      // Pseudo-merge stage 9: pause ConflictWatcher events for the
      // whole drain window. Obsidian events are NOT buffered while
      // paused (PSEUDO-MERGE-MODE.md §"Архітектура push") — that's
      // fine because the drain-start + drain-end sweeps below
      // re-evaluate ConflictStore vs file-system state, which
      // catches drift regardless of whether vault events fired.
      this.conflictWatcher?.pause();

      // Drain-start sweep: catches drift that happened OUTSIDE drain
      // since the last sweep — external mods (iCloud/file-manager
      // edits), plugin toggle off→on windows, mobile suspension
      // where vault.on doesn't fire reliably. Per spec the sweep is
      // a safety net even when ConflictWatcher is wired.
      if (this.conflictStore) {
        await evaluateConflictState(
          this.conflictStore,
          this.vault,
          this.now,
        );
      }

      await this.bootstrapIfNeeded(progress);
      let pushedAnyBatch = false;
      let finalizeAttempted = false;
      while (true) {
        const headHint = await this.pullIfNeeded(progress);
        const ids = await this.queue.list();
        if (ids.length === 0) break;
        commitNum += 1;
        // Lazy-open a long-lived progress notice only when this
        // batch's push would actually be heavy. The notice goes
        // straight into "Push 0/N files to GitHub" — no separate
        // "starting" pre-message, no batch-number indicator. Each
        // batch's per-file ticks become the user's only visible
        // signal during heavy push; light batches stay silent here
        // and the drain-level "Sync done" finale below shows the
        // success signal once the whole queue drains.
        const batchBytes = await this.estimateBatchBytes(ids[0]);
        const isHeavyPush = batchBytes > this.progressBytesThreshold;
        if (isHeavyPush && progress === null && this.onProgress) {
          const peek = await this.queue.read(ids[0]);
          progress = this.onProgress(
            `Push 0/${peek.files.length} files to GitHub`,
          );
        }
        await this.processBatch(
          ids[0],
          headHint,
          progress,
          commitNum,
          commitNum + ids.length - 1,
        );
        pushedAnyBatch = true;
      }
      // Drain-end sweep (pseudo-merge stage 9). Catches state that
      // changed DURING drain:
      //   - our own sibling writes (registerConflictAndDropPath fired
      //     during reconcile or applyRemoteAddOrModify) — those
      //     vault.on events fire while ConflictWatcher is paused and
      //     get effectively dropped; the sweep re-discovers the
      //     state via fs scan.
      //   - user's mid-drain actions on conflict files (delete
      //     sibling, copy onto base, edit base) — these can resolve
      //     conflicts inline so finalize fires in the same drain.
      if (this.conflictStore) {
        await evaluateConflictState(
          this.conflictStore,
          this.vault,
          this.now,
        );
      }
      // Conflict-branch finalize hook (pseudo-merge stage 7b). Runs
      // once per drain when the queue is empty: if the active
      // conflict-branch state holds AND every record in the
      // ConflictStore has been resolved, merge the branch back into
      // main and deleteRef. Idempotent on "nothing to do" inputs;
      // the `finalizeAttempted` guard just keeps the log line tidy.
      if (!finalizeAttempted) {
        finalizeAttempted = true;
        await this.finalizeConflictBranchIfReady();
      }
      // Drain finished cleanly with an empty queue. Show "Sync done":
      //   - reuse the long-lived handle if we opened one (heavy phase)
      //   - otherwise, briefly flash a new one only if SOMETHING
      //     actually moved (a pull applied remote changes, OR we
      //     pushed at least one batch). True no-op drains (no remote
      //     changes, no pending queue) stay silent.
      // When the pull side touched local files (writes from remote,
      // canonicalisations, sibling files for deferred conflicts), the
      // message is padded with "(updated N files)" so the user knows
      // their vault changed. Push-only syncs use the plain "Sync done"
      // — the user already saw "Commit N files" at click time and
      // their vault didn't get modified by sync. Counter resets at the
      // start of every syncAll/syncFile (pulledFilesThisSync).
      const drainDidWork =
        pushedAnyBatch || this.pulledFilesThisSync > 0;
      const doneMessage =
        this.pulledFilesThisSync > 0
          ? this.pulledFilesThisSync === 1
            ? "Sync done (1 file updated from GitHub)"
            : `Sync done (${this.pulledFilesThisSync} files updated from GitHub)`
          : "Sync done";
      if (ownProgress && progress) {
        progress.update(doneMessage);
        const handle = progress;
        setTimeout(() => handle.hide(), 1000);
      } else if (ownProgress && drainDidWork && this.onProgress) {
        const handle = this.onProgress(doneMessage);
        setTimeout(() => handle.hide(), 1000);
      }
    } finally {
      this.running = false;
      // Resume ConflictWatcher unconditionally — even on a drain
      // error the watcher should pick up subsequent vault events
      // (the next sync will re-evaluate).
      this.conflictWatcher?.resume();
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

      // Split-push partition (PSEUDO-MERGE-MODE.md §"Архітектура
      // push: split-push у processBatch", stage 7c).
      //
      // After reconcile / case-3 re-target settles, walk the batch
      // looking for paths that are now in the ConflictStore — they
      // were filtered into a conflict during a prior drain (then the
      // user edited them locally, which findChanges re-detected and
      // enqueueOrMerge accepted without filtering now that
      // dropPendingConflictPaths is gone). These conflict paths get
      // pushed to the per-device conflict branch instead of main:
      // the user's edits land on GitHub but stay invisible to other
      // devices until the conflict is resolved.
      //
      // We push them as a single multi-path commit via the same
      // helper that conflict registration uses, then drop the paths
      // from the batch so the main-side tree build below sees only
      // plain paths.
      if (this.conflictStore) {
        const peek = await this.queue.read(id);
        const conflictPaths = peek.files.filter((p) =>
          this.conflictStore!.hasPending(p),
        );
        if (conflictPaths.length > 0) {
          const branchEntries: Array<{
            path: string;
            content: ArrayBuffer | null;
          }> = [];
          for (const p of conflictPaths) {
            const bytes = await this.queue.readFile(id, p);
            branchEntries.push({ path: p, content: bytes });
          }
          await this.pushConflictPathsToBranch(
            branchEntries,
            `Edit-while-in-conflict: ${conflictPaths.length} path(s)`,
          );
          for (const p of conflictPaths) {
            await this.queue.removeFile(id, p);
          }
          await this.logger.info(
            "Sync2 split-push: routed edit-while-in-conflict paths to branch",
            { paths: conflictPaths },
          );
        }
      }

      const { entries, baseTreeSha, batch } =
        await this.builder.buildTreeEntries(id, {
          // Live N/M counter. Each batch starts hidden when not heavy
          // (progress=null, hook returns immediately). When heavy, the
          // drain opened the notice with "Push 0/N files to GitHub"
          // already, so onUploadStart is redundant — only the per-file
          // tick needs to advance the counter.
          onFileProcessed: (done, total) => {
            if (!progress) return;
            progress.update(`Push ${done}/${total} files to GitHub`);
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
      // createCommit + updateBranchHead. ~1-2 seconds; the notice
      // keeps the last "Push N/N files to GitHub" text until the
      // drain-level "Sync done" finale replaces it. No
      // intermediate phase label — the user gets one consistent
      // message per drain.

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
  // past the batch's parent. For each path in the batch we run
  // `attemptAutoMerge` against (ours = batch snapshot, theirs =
  // currentHead, base = expectedHead). Clean merges silently
  // overwrite the batch snapshot; plugin-js gets atomic semver;
  // anything else routes through `registerConflictAndDropPath`
  // (sibling + ConflictStore + branch push).
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
    // later batches in a single pass instead of N×M loops. Records
    // ours-bytes (pre) and theirs-bytes (post) for each clean
    // auto-merge.
    const resolvedPerPath = new Map<
      string,
      { oldOurs: ArrayBuffer; newOurs: ArrayBuffer }
    >();

    // Snapshot the iteration list once so for-of stays immune to
    // in-loop mutations of `batch.files`. `batch.files` is then kept
    // canonical with disk state via splice on every drop site below,
    // so helper reads (readReconcilePluginJsContext, etc.) that
    // consult `batch.files` see the same view the disk has.
    const toProcess = [...batch.files];
    const dropFromBatchInMemory = (path: string): void => {
      const idx = batch.files.indexOf(path);
      if (idx >= 0) batch.files.splice(idx, 1);
    };

    for (const path of toProcess) {
      const baseFetched = await this.safeFetchContents(path, expectedHead);
      const theirsFetched = await this.safeFetchContents(path, currentHead);

      // No remote-side change → batch pushes through unchanged.
      if (
        baseFetched !== null &&
        theirsFetched !== null &&
        baseFetched.sha === theirsFetched.sha
      ) {
        continue;
      }

      const oursBytes = await this.queue.readFile(batchId, path);
      const theirsBytes =
        theirsFetched === null
          ? null
          : (base64ToArrayBuffer(theirsFetched.content) as ArrayBuffer);
      const baseBytes = baseFetched
        ? (base64ToArrayBuffer(baseFetched.content) as ArrayBuffer)
        : null;

      // Convergence short-circuit: if ours.bytes === theirs.bytes,
      // any resolution path would degenerate into "no real change"
      // (semver tied, mtime tied or not — doesn't matter, the disk
      // state is already identical). Skip the whole attemptAutoMerge
      // dance + the wasteful writeBinaryRemote-of-identical-bytes.
      //
      // Cheap-then-expensive: byte-length first (O(1)), then SHA
      // (O(n)). theirsFetched.sha already came back from the GitHub
      // round-trip; we just need to hash ours.
      //
      // Concrete trigger: same file landed on both devices via an
      // out-of-band copy (adb push, manual download, IDE
      // synchronizer) — mtime metadata differs but content matches.
      // Previously this routed through "atomic theirs wins", spent
      // an unnecessary writeBinaryRemote of identical bytes, and
      // logged a misleading "theirs wins" line.
      if (
        theirsBytes !== null &&
        theirsFetched !== null &&
        oursBytes.byteLength === theirsBytes.byteLength
      ) {
        const oursSha = await calculateGitBlobSHA(oursBytes);
        if (oursSha === theirsFetched.sha) {
          await this.detector.recordSync(path, theirsFetched.sha);
          await this.queue.removeFile(batchId, path);
          dropFromBatchInMemory(path);
          await this.logger.info(
            "Sync2 reconcile no-op: ours bytes already match theirs (mtime ignored)",
            { path },
          );
          continue;
        }
      }

      let pluginJs: PluginJsContext | undefined;
      if (
        theirsFetched !== null &&
        isAtomicPluginFile(path, this.configDir)
      ) {
        pluginJs = await this.readReconcilePluginJsContext(
          batchId,
          batch.files,
          path,
          expectedHead,
          currentHead,
          batch.fileMtimes?.[path] ?? 0,
        );
      }

      const auto = attemptAutoMerge({
        path,
        ours: oursBytes,
        theirs: theirsBytes,
        base: baseBytes,
        configDir: this.configDir,
        pluginJs,
      });

      if (auto.type === "modify-wins") {
        // Remote deleted the file but the batch still carries our
        // modification. Local-intent wins automatically — leave the
        // batch entry intact; push will resurrect the file on remote.
        await this.logger.info(
          "Sync2 reconcile modify-wins: remote deleted, local modify resurrects",
          { path },
        );
        continue;
      }

      if (auto.type === "clean") {
        // Write merged bytes to BOTH the batch snapshot (what gets
        // pushed) and the live vault (what the user sees).
        const text = new TextDecoder().decode(auto.content);
        await this.queue.overwriteFile(batchId, path, auto.content);
        await this.writeRemoteText(path, text);
        resolvedPerPath.set(path, {
          oldOurs: oursBytes,
          newOurs: auto.content,
        });
        continue;
      }

      if (auto.type === "atomic") {
        if (auto.side === "theirs") {
          // Remote wins → apply remote bytes to live vault, drop the
          // path from this batch so push doesn't upload stale "ours".
          // theirsFetched is non-null here: modify-wins already
          // handled the theirs===null case above.
          await this.writeBinaryRemote(path, theirsFetched!.content);
          await this.detector.recordSync(path, theirsFetched!.sha);
          await this.queue.removeFile(batchId, path);
          dropFromBatchInMemory(path);
          await this.logger.info(
            "Sync2 reconcile atomic: theirs wins, dropped from batch",
            { path },
          );
        }
        // side === "ours": local wins → leave batch entry intact;
        // push will overwrite remote.
        continue;
      }

      // auto.type === "register-conflict"
      await this.registerConflictAndDropPath({
        vaultPath: path,
        kind: "modify-vs-modify",
        theirsContent: theirsBytes!,
        theirsBlobSha: theirsFetched!.sha,
        oursBlobSha: await calculateGitBlobSHA(oursBytes),
        remoteDevice: await this.fetchRemoteDevice(currentHead),
        fromBatchId: batchId,
      });
      dropFromBatchInMemory(path);
    }

    if (resolvedPerPath.size > 0) {
      await this.cascadeRebase(batchId, resolvedPerPath, currentHead);
    }

    // Reconcile batch.deletions against the current remote head.
    //   - Remote already deleted: drop the redundant deletion (createTree
    //     would 422 on a deletion not in base_tree).
    //   - Remote unchanged: deletion stands.
    //   - Remote modified: delete-vs-modify conflict — register and
    //     drop from queue. User resolves via sibling file (delete the
    //     .deleted placeholder → keep delete; delete the base → accept
    //     remote modification).
    for (const path of batch.deletions) {
      const theirs = await this.safeFetchContents(path, currentHead);
      if (theirs === null) {
        await this.queue.removeDeletion(batchId, path);
        continue;
      }
      const base = await this.safeFetchContents(path, expectedHead);
      if (base !== null && base.sha === theirs.sha) {
        continue;
      }
      // Remote modified since base → register delete-vs-modify.
      // ours = "deleted", theirs = remote bytes.
      const theirsBytes = base64ToArrayBuffer(theirs.content) as ArrayBuffer;
      await this.queue.removeDeletion(batchId, path);
      await this.registerConflictAndDropPath({
        vaultPath: path,
        kind: "delete-vs-modify",
        theirsContent: theirsBytes,
        theirsBlobSha: theirs.sha,
        oursBlobSha: null,
        remoteDevice: await this.fetchRemoteDevice(currentHead),
        fromBatchId: batchId,
      });
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

  // Push-side plugin-js context. Reads the manifest as it WAS at
  // click time, not what's currently in the live vault — pull may
  // have just overwritten the live manifest with the remote version,
  // which would make oursVersion == theirsVersion and silently flip
  // resolution. Two cases:
  //   - User bumped the manifest themselves (it's in this batch): use
  //     the batch's snapshot.
  //   - Otherwise: fetch from expectedHead (lastSync) — the version
  //     the user was effectively on.
  // For mtime, oursMtime comes from batch.fileMtimes (captured at
  // enqueue BEFORE canonical-write-back), theirsMtime from current
  // head's committer date.
  private async readReconcilePluginJsContext(
    batchId: string,
    batchFiles: string[],
    path: string,
    expectedHead: string,
    currentHead: string,
    oursMtime: number,
  ): Promise<PluginJsContext | undefined> {
    const root = pluginRootOf(path, this.configDir);
    if (root === null) return undefined;
    const manifestPath = `${root}/manifest.json`;

    let oursVersion: string | null = null;
    if (batchFiles.includes(manifestPath)) {
      const buf = await this.queue.readFile(batchId, manifestPath);
      oursVersion = readPluginVersion(new TextDecoder().decode(buf));
    } else {
      const baseManifestBlob = await this.safeFetchContents(
        manifestPath,
        expectedHead,
      );
      if (baseManifestBlob) {
        oursVersion = readPluginVersion(
          decodeBase64String(baseManifestBlob.content),
        );
      }
    }

    let theirsVersion: string | null = null;
    const remoteManifestBlob = await this.safeFetchContents(
      manifestPath,
      currentHead,
    );
    if (remoteManifestBlob) {
      theirsVersion = readPluginVersion(
        decodeBase64String(remoteManifestBlob.content),
      );
    }

    let theirsMtime = 0;
    try {
      const headCommit = await this.client.getCommit({
        sha: currentHead,
        retry: true,
      });
      const parsed = Date.parse(headCommit.committer.date);
      if (!Number.isNaN(parsed)) theirsMtime = parsed;
    } catch {
      // best-effort
    }

    return { oursVersion, theirsVersion, oursMtime, theirsMtime };
  }

  // Propagate every resolution from a just-reconciled batch into the
  // batches behind it in the queue. Single-pass: list() + read() per
  // later batch happens once each, regardless of how many paths the
  // primary reconcile resolved. For each later batch we then
  // intersect resolvedPerPath with the batch's file list and run
  // attemptAutoMerge against (ours_of_later_batch, theirs=newOurs,
  // base=oldOurs).
  //
  // Clean → overwrite the later batch's snapshot silently.
  // Conflict (markers) → register modify-vs-modify + cascade-drop the
  // path from this and every later batch (per advisor's "option A"
  // for stage 5c: no more throw-on-defer).
  private async cascadeRebase(
    fromBatchId: string,
    resolvedPerPath: Map<
      string,
      { oldOurs: ArrayBuffer; newOurs: ArrayBuffer }
    >,
    currentHead: string,
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
        const auto = attemptAutoMerge({
          path,
          ours: oursBytes,
          theirs: newOurs,
          base: oldOurs,
          configDir: this.configDir,
        });
        if (auto.type === "clean") {
          await this.queue.overwriteFile(id, path, auto.content);
          continue;
        }
        // atomic or register-conflict during cascade → can't silently
        // pick a winner; register the conflict and drop the path from
        // this batch (and any later batches that also carry it).
        await this.registerConflictAndDropPath({
          vaultPath: path,
          kind: "modify-vs-modify",
          theirsContent: newOurs,
          theirsBlobSha: await calculateGitBlobSHA(newOurs),
          oursBlobSha: await calculateGitBlobSHA(oursBytes),
          remoteDevice: await this.fetchRemoteDevice(currentHead),
          fromBatchId: id,
        });
      }
    }
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

