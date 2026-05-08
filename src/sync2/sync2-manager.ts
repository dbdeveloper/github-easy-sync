import { Vault, base64ToArrayBuffer } from "obsidian";
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
import SnapshotStore from "./snapshot-store";
import TreeBuilder from "./tree-builder";
import { mergeText } from "./three-way-merge";
import { applyTemplate, appendDeviceSuffix } from "./commit-templates";
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
  commitMessageAll: string;
  commitMessageFile: string;
  // Per-device label appended to every commit message as a fixed
  // " (label)" suffix and recorded in conflict-store metadata. One
  // setting drives both surfaces — see commit-templates.ts /
  // conflict-store.ts for the consumers.
  deviceLabel: string;
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
  // Both are no-ops in unit tests that don't pass them.
  onLocalCommitted?(filesCount: number): void;
  onNoLocalChanges?(): void;
  // When true, a new sync click while pending batches exist (i.e.
  // earlier push attempt failed — typically offline) folds the new
  // changes into the latest pending batch instead of stacking. The
  // eventual replay produces one commit instead of N.
  accumulateOfflineSyncs?: boolean;
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
  private readonly commitMessageAll: string;
  private readonly commitMessageFile: string;
  private readonly deviceLabel: string;
  private readonly conflictStore: ConflictStore | undefined;
  private readonly onConflict: OnConflictCallback;
  private readonly accumulateOfflineSyncs: boolean;
  private readonly onProgress: ProgressFactory | undefined;
  private readonly onLocalCommitted:
    | ((filesCount: number) => void)
    | undefined;
  private readonly onNoLocalChanges: (() => void) | undefined;
  private readonly now: () => number;
  // Guard against re-entrant processQueue. The runner only loops one
  // batch at a time; if a second syncAll() lands while the first is
  // still pushing, we let it enqueue but skip the second processQueue
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
    this.commitMessageAll = deps.commitMessageAll;
    this.commitMessageFile = deps.commitMessageFile;
    this.deviceLabel = deps.deviceLabel;
    this.conflictStore = deps.conflictStore;
    this.onConflict = deps.onConflict;
    this.accumulateOfflineSyncs = deps.accumulateOfflineSyncs ?? false;
    this.onProgress = deps.onProgress;
    this.onLocalCommitted = deps.onLocalCommitted;
    this.onNoLocalChanges = deps.onNoLocalChanges;
    this.now = deps.now ?? (() => Date.now());
  }

  // Action 1 — full sync.
  //   1. Pull remote-driven adds/modifies/deletes since last sync.
  //   2. Detect what changed locally.
  //   3. Materialize a queue batch with that snapshot.
  //   4. Drain the queue (push + commit + ref + record).
  //
  // The pull pass runs first so subsequent findChanges() classifies
  // local files against the freshly-updated snapshot, not against
  // a stale baseline.
  async syncAll(): Promise<void> {
    await this.logger.info("Sync2 syncAll start");
    // Etap 6.6: track paths whose remote bytes were non-canonical and
    // got rewritten locally. After findChanges runs we'll synthesize
    // FileChange[modified] for any republish entry not already covered
    // by user-driven local changes — that lets the next push bring
    // the remote in line with the canonical local copy.
    const republishPaths = new Set<string>();
    const headAfterBootstrap = await this.bootstrapIfNeeded(republishPaths);
    const headAfterPull =
      headAfterBootstrap ?? (await this.pullIfNeeded(republishPaths));
    // syncAll always touches configDir-side state (manifest/log,
    // possibly user notes there). Make sure invariant gitignores are
    // canonical before findChanges classifies anything.
    if (this.invariants) await this.invariants.enforce();
    const changes = await this.detector.findChanges();
    const combined = await this.appendRepublishChanges(
      changes,
      republishPaths,
    );
    if (combined.length === 0) {
      await this.store.save();
      // "Nothing local AND nothing pending in the queue" is the truly
      // idle case — fire onNoLocalChanges so plugin code can flash a
      // brief "No changes" notice. If the queue still has pending
      // batches (offline-accumulate case), processQueue picks them up
      // and onProgress takes over the user feedback.
      const pendingBatches = await this.queue.list();
      if (pendingBatches.length === 0) this.onNoLocalChanges?.();
      await this.processQueue(headAfterPull);
      await this.logger.info("Sync2 syncAll: nothing to sync");
      return;
    }
    const enqueued = await this.enqueueOrMerge(combined, this.fullSyncMeta());
    if (enqueued > 0) this.onLocalCommitted?.(enqueued);
    await this.processQueue(headAfterPull);
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
    // Etap 6.6: pull-side normalization may rewrite OTHER paths besides
    // the syncFile target. We only push the target in this batch (the
    // user asked to sync one file, not the whole vault); the rest stay
    // canonical-locally with the gap-to-remote tracked implicitly
    // until the next syncAll.
    const republishPaths = new Set<string>();
    const headAfterBootstrap = await this.bootstrapIfNeeded(republishPaths);
    const headAfterPull =
      headAfterBootstrap ?? (await this.pullIfNeeded(republishPaths));
    // Only enforce invariants when the active path is under configDir;
    // single-file syncs of regular notes don't risk touching them.
    if (this.invariants && path.startsWith(`${this.configDir}/`)) {
      await this.invariants.enforce();
    }
    let change = await this.detector.findChangeForPath(path);
    // If the target file itself was canonicalized during pull, surface
    // it as a synthetic modify so the push converges this file's
    // remote copy in this very call.
    if (!change && republishPaths.has(path)) {
      change = await this.synthesizeRepublishChange(path);
    }
    if (!change) {
      await this.store.save();
      // Same idle-vs-draining distinction as syncAll: only fire the
      // "No changes" hook when there's truly nothing to do.
      const pendingBatches = await this.queue.list();
      if (pendingBatches.length === 0) this.onNoLocalChanges?.();
      await this.processQueue(headAfterPull);
      await this.logger.info(`Sync2 syncFile: nothing to sync`, { path });
      return;
    }

    const baseMessage =
      customMessage !== undefined
        ? customMessage
        : applyTemplate(this.commitMessageFile, {
            date: new Date(this.now()),
            filename: path.split("/").pop() ?? path,
            path,
          });
    // Apply the device suffix to BOTH the templated path and a
    // user-typed customMessage — uniform parseability on GitHub.
    const message = appendDeviceSuffix(baseMessage, this.deviceLabel);
    const enqueued = await this.enqueueOrMerge([change], {
      commitMessage: message,
      parentCommitSha: this.store.getLastSyncCommitSha(),
      parentTreeSha: this.store.getLastSyncTreeSha(),
    });
    if (enqueued > 0) this.onLocalCommitted?.(enqueued);
    await this.processQueue(headAfterPull);
  }

  // resumeQueue — full implementation in Etap 6d. For 6a, processQueue
  // is callable on its own and behaves correctly when called fresh.
  async resumeQueue(): Promise<void> {
    await this.processQueue();
  }

  // Pull-only entry point for interval-driven background syncs (when
  // autoCommitOnIntervalSync is off). Brings the local vault up to
  // date with the remote — bootstrap-from-remote on a fresh device,
  // applyRemoteAddOrModify/applyRemoteDeletion for diverging files —
  // but DELIBERATELY skips:
  //   - invariants.enforce (no mass rewrite of `.gitignore`s on a
  //     timer; reserved for explicit Sync clicks)
  //   - findChanges + enqueueOrMerge + processQueue (no commits)
  //   - republishPaths follow-up (Etap 6.6 best-effort canonicalisation
  //     stays best-effort; the next manual syncAll picks it up)
  //
  // Conflicts surfaced during pull behave as if the user had clicked
  // "Later": the sibling file is created, the 🔀 status-bar widget
  // ticks up, and the path is excluded from any future push until
  // the user resolves it. main.ts achieves this by setting its
  // suppressConflictModals flag before calling pullOnly().
  async pullOnly(): Promise<void> {
    await this.logger.info("Sync2 pullOnly start");
    const republishPaths = new Set<string>();
    const headAfterBootstrap = await this.bootstrapIfNeeded(republishPaths);
    if (headAfterBootstrap === null) {
      await this.pullIfNeeded(republishPaths);
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
    republishPaths: Set<string>,
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
      // (force-pushed history). Don't crash — the next push will
      // reconcile against currentHead.
      const status = (err as { status?: number }).status;
      if (status === 404) {
        await this.logger.warn("Sync2 pull: compare base unreachable", {
          expectedHead,
          currentHead,
        });
        return currentHead;
      }
      throw err;
    }

    for (const f of cmp.files) {
      if (!(await this.detector.checkSyncable(f.filename))) continue;

      if (f.status === "removed") {
        await this.applyRemoteDeletion(f.filename, expectedHead);
        continue;
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
        republishPaths,
      );
    }

    // Bring lastSync forward so subsequent push doesn't try to merge
    // against the already-applied head.
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
  // letting the user's first push silently overwrite history.
  //
  // Returns the head SHA observed (so callers can pass it as a hint
  // to processQueue), or null when the branch is bare or there's
  // nothing to bootstrap (lastSyncCommitSha already set).
  private async bootstrapIfNeeded(
    republishPaths: Set<string>,
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
    await this.bootstrapFromRemote(currentHead, republishPaths);
    return currentHead;
  }

  private async bootstrapFromRemote(
    currentHead: string,
    republishPaths: Set<string>,
  ): Promise<void> {
    await this.logger.info("Sync2 bootstrap-from-remote start", {
      head: currentHead,
    });
    const { files, sha: treeSha } = await this.client.getRepoContent({
      retry: true,
    });
    let downloaded = 0;
    for (const filePath of Object.keys(files)) {
      if (!(await this.detector.checkSyncable(filePath))) continue;
      const item = files[filePath];
      const blob = await this.client.getBlob({ sha: item.sha, retry: true });
      const bytes = base64ToArrayBuffer(blob.content);
      if (hasTextExtension(filePath)) {
        // Etap 6.6: canonicalize on disk; track republish if the
        // remote's bytes weren't already canonical. ignoreBOM
        // preserves a leading U+FEFF so normalizeText can strip it;
        // the platform default eats it silently, which would mask
        // "remote has BOM" from the republish trigger.
        const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
          bytes,
        );
        const { canonicalSha, changed } = await this.writeRemoteText(
          filePath,
          text,
        );
        await this.detector.recordSync(filePath, canonicalSha);
        if (changed) republishPaths.add(filePath);
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
      downloaded++;
    }
    const headCommit = await this.client.getCommit({
      sha: currentHead,
      retry: true,
    });
    this.store.setLastSync(currentHead, headCommit.tree.sha ?? treeSha);
    this.store.setLastCommitMtime(this.now());
    await this.store.save();
    await this.logger.info("Sync2 bootstrap-from-remote done", {
      downloaded,
      treeSha,
    });
  }

  // `republishPaths` collects paths whose on-disk canonical bytes
  // differ from what's actually on the remote (because we normalized
  // the remote's non-canonical input). Caller flushes this set into a
  // synthetic FileChange[modified] batch after findChanges so the next
  // push closes the gap. Etap 6.6: "preferred clean server".
  private async applyRemoteAddOrModify(
    path: string,
    headRef: string,
    baseRef: string,
    republishPaths: Set<string>,
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
        // Record-sync against the canonical SHA so the snapshot
        // matches what's actually on disk. If the remote bytes were
        // already canonical, canonicalSha === blob.sha and there's
        // nothing to republish. Otherwise mark for republish — the
        // next push will bring the remote in line.
        await this.detector.recordSync(path, canonicalSha);
        if (changed) republishPaths.add(path);
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
        // as ours — we deliberately do NOT writeRemoteText here, do
        // NOT recordSync, do NOT add to republishPaths. The path is
        // excluded from push (enqueueOrMerge filters it) until
        // ConflictStore.resolve fires, at which point the next sync
        // picks it up like any other modified file.
        if (!this.conflictStore) {
          throw new Error(
            "Sync2 conflict deferral requested but no ConflictStore is wired",
          );
        }
        await this.conflictStore.create({
          vaultPath: path,
          baseContent,
          theirsContent: remoteContent,
          baseCommitSha: baseRef,
          theirsBlobSha: blob.sha,
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

    // Write canonical, then record-sync the canonical SHA so the
    // snapshot tracks on-disk bytes. If those bytes don't match what's
    // on GitHub, queue a republish so the next push closes the gap.
    const { canonicalSha } = await this.writeRemoteText(path, resolved);
    await this.detector.recordSync(path, canonicalSha);
    if (canonicalSha !== blob.sha) {
      republishPaths.add(path);
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

  // Build a synthetic FileChange[modified] for a path that needs to be
  // republished to GitHub in canonical form. The on-disk bytes are
  // already canonical and the snapshot already matches them — without
  // this synthetic entry, findChanges() would silently report nothing
  // (stat-cache hit), and the canonical-vs-remote gap would persist.
  private async synthesizeRepublishChange(
    path: string,
  ): Promise<FileChange | null> {
    const stat = await this.vault.adapter.stat(path);
    if (!stat) return null;
    const snap = this.store.get(path);
    return {
      kind: "modified",
      path,
      size: stat.size,
      mtime: stat.mtime,
      previousRemoteSha: snap?.remoteSha ?? "",
    };
  }

  // Combine ChangeDetector's findings with the post-pull republish set.
  // When a path is both edited locally AND was canonicalised during
  // pull, the user-driven change wins (it already includes whatever
  // bytes are now on disk).
  private async appendRepublishChanges(
    changes: FileChange[],
    republishPaths: Set<string>,
  ): Promise<FileChange[]> {
    if (republishPaths.size === 0) return changes;
    const seen = new Set(changes.map((c) => c.path));
    const extra: FileChange[] = [];
    for (const path of republishPaths) {
      if (seen.has(path)) continue;
      const synth = await this.synthesizeRepublishChange(path);
      if (synth) extra.push(synth);
    }
    return extra.length === 0 ? changes : [...changes, ...extra];
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
    if (this.accumulateOfflineSyncs) {
      const target = await this.queue.mergeIntoLatestPending(filtered);
      if (target !== null) return filtered.length;
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
    const base = applyTemplate(this.commitMessageAll, {
      date: new Date(this.now()),
    });
    return {
      // Always-trailing " (deviceLabel)" lets a future viewer
      // (Etap 8 file-history) read the source-device off any sync2
      // commit on GitHub regardless of how the user customized the
      // template. See commit-templates.ts → appendDeviceSuffix.
      commitMessage: appendDeviceSuffix(base, this.deviceLabel),
      parentCommitSha: this.store.getLastSyncCommitSha(),
      parentTreeSha: this.store.getLastSyncTreeSha(),
    };
  }

  // Drain pending batches one at a time, oldest-first. Stops on the
  // first failure so the user sees the error notice and can retry;
  // remaining batches stay on disk for the next syncAll/resumeQueue.
  //
  // `headHint` is the head SHA pullIfNeeded just observed (or null if
  // we have nothing fresh). The first batch processed in this drain
  // can use it to skip its own getBranchHeadSha; subsequent batches
  // re-fetch since each prior batch may have moved HEAD itself.
  private async processQueue(
    headHint: string | null = null,
  ): Promise<void> {
    if (this.running) return;
    this.running = true;
    let progress: ProgressHandle | null = null;
    try {
      const ids = await this.queue.list();
      if (ids.length === 0) return;
      if (this.onProgress) {
        progress = this.onProgress(
          ids.length === 1
            ? "Syncing with GitHub…"
            : `Syncing commit 1/${ids.length} with GitHub…`,
        );
      }
      for (let i = 0; i < ids.length; i++) {
        if (progress && ids.length > 1) {
          progress.update(
            `Syncing commit ${i + 1}/${ids.length} with GitHub…`,
          );
        }
        await this.processBatch(
          ids[i],
          i === 0 ? headHint : null,
          progress,
          i + 1,
          ids.length,
        );
      }
    } finally {
      progress?.hide();
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
    try {
      // Three states for the head before push:
      //   1. expectedHead = null, branch is bare → root commit, parent
      //      stays null. (Fresh repo.)
      //   2. expectedHead = null, branch already has commits → first
      //      sync on this device against an existing line of history.
      //      No snapshot to 3-way against; re-target the batch onto
      //      currentHead and let local files land on top. Server-side
      //      contents we don't carry are preserved through base_tree.
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
      if (expectedHead === null && currentHead !== null) {
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
      }

      // Estimate aggregate transfer size for the progress UI hint.
      // Cheap approximation: sum file sizes from on-disk stats. We
      // don't read content for this — the figure is a UI signal, not
      // an assertion.
      const heavyThreshold = 5 * 1024 * 1024;
      const totalBytes = await this.estimateBatchBytes(id);
      const isHeavy = totalBytes > heavyThreshold;
      if (progress && isHeavy) {
        const mb = (totalBytes / (1024 * 1024)).toFixed(1);
        progress.update(
          commitTotal > 1
            ? `Syncing commit ${commitNum}/${commitTotal} with GitHub (~${mb} MB)…`
            : `Syncing with GitHub (~${mb} MB)…`,
        );
      }

      const { entries, baseTreeSha, batch } =
        await this.builder.buildTreeEntries(id);

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
      const commitSha = await this.client.createCommit({
        message: batch.commitMessage,
        treeSha: newTreeSha,
        parent: batch.parentCommitSha ?? undefined,
        retry: true,
      });
      await this.client.updateBranchHead({
        sha: commitSha,
        retry: true,
      });

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
    for (const path of batch.files) {
      if (!hasTextExtension(path)) {
        // Binary: skip auto-merge. The batch's version wins on push;
        // a separate atomic-resolution path lives in pull-side
        // resolveBinaryConflict.
        continue;
      }
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
        resolved = this.requireResolvedContent(
          decision,
          "in-flight batch reconcile",
        );
      }

      const buf = new TextEncoder().encode(resolved).buffer as ArrayBuffer;
      await this.queue.overwriteFile(batchId, path, buf);
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

