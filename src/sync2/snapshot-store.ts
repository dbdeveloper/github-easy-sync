import { Vault, normalizePath } from "obsidian";
import { FileSnapshot } from "./types";

// Sync2's local manifest. Owned by SnapshotStore, read by ChangeDetector,
// written by Sync2Manager after successful pushes/pulls. Never sent to
// the remote — sync2's design treats per-device sync state as private.
export const SYNC2_MANIFEST_FILE_NAME =
  "github-easy-sync-metadata.json" as const;

// Per-invariant-gitignore record. mtime+hash lets us short-circuit
// the rewrite check: if the on-disk mtime hasn't moved since we last
// saw it, we trust the cached hash and skip the read entirely.
export interface InvariantFileState {
  mtime: number;
  hash: string;
}

export interface Sync2InvariantState {
  configDirGitignore?: InvariantFileState;
  selfPluginGitignore?: InvariantFileState;
  // Root <vault>/.gitignore — managed since Etap 6.5 to forcibly
  // hide conflict-sibling files from sync. Same shape as the other
  // two: mtime+hash cache, splice-on-edit invariant block.
  rootGitignore?: InvariantFileState;
}

export interface Sync2Metadata {
  // Branch state at the moment of this device's last successful sync.
  lastSyncCommitSha: string | null;
  lastSyncTreeSha: string | null;

  // Local-clock timestamp of the last successful sync. ChangeDetector
  // uses this as the watermark: candidates for "potentially changed"
  // are TFile entries whose stat.mtime is greater. Files that haven't
  // been touched since the watermark are skipped without read or sha.
  // null after a fresh install — first sync walks the whole vault.
  lastCommitMtime: number | null;

  // Per-file snapshots: what we believe is on the remote.
  files: { [path: string]: FileSnapshot };

  // Cached freshness markers for the two invariant gitignore files.
  // Used by GitignoreInvariants.enforce() to skip rewrite when on-disk
  // state matches what we last left there.
  invariantState: Sync2InvariantState;
}

function freshMetadata(): Sync2Metadata {
  return {
    lastSyncCommitSha: null,
    lastSyncTreeSha: null,
    lastCommitMtime: null,
    files: {},
    invariantState: {},
  };
}

// Coerce whatever JSON is on disk into a Sync2Metadata. Tolerates legacy
// fields (drops them) and missing top-level keys (fills with defaults).
// Single source of truth for the on-disk schema; bumping it goes here.
function migrate(raw: unknown): Sync2Metadata {
  const out = freshMetadata();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;

  if (typeof r.lastSyncCommitSha === "string") {
    out.lastSyncCommitSha = r.lastSyncCommitSha;
  }
  if (typeof r.lastSyncTreeSha === "string") {
    out.lastSyncTreeSha = r.lastSyncTreeSha;
  }
  if (typeof r.lastCommitMtime === "number") {
    out.lastCommitMtime = r.lastCommitMtime;
  }
  if (r.invariantState && typeof r.invariantState === "object") {
    const inv = r.invariantState as Record<string, unknown>;
    const coerce = (v: unknown): InvariantFileState | undefined => {
      if (!v || typeof v !== "object") return undefined;
      const o = v as Record<string, unknown>;
      if (typeof o.mtime !== "number" || typeof o.hash !== "string") {
        return undefined;
      }
      return { mtime: o.mtime, hash: o.hash };
    };
    const cd = coerce(inv.configDirGitignore);
    const sp = coerce(inv.selfPluginGitignore);
    const rg = coerce(inv.rootGitignore);
    if (cd) out.invariantState.configDirGitignore = cd;
    if (sp) out.invariantState.selfPluginGitignore = sp;
    if (rg) out.invariantState.rootGitignore = rg;
  }
  if (r.files && typeof r.files === "object") {
    for (const [path, val] of Object.entries(
      r.files as Record<string, unknown>,
    )) {
      const v = val as Record<string, unknown>;
      // Accept either sync2's "remoteSha" or legacy's "sha".
      const sha =
        typeof v.remoteSha === "string"
          ? v.remoteSha
          : typeof v.sha === "string"
            ? v.sha
            : null;
      const mtime = typeof v.mtime === "number" ? v.mtime : 0;
      const size = typeof v.size === "number" ? v.size : 0;
      // Skip entries that have no SHA — they were never pushed and the
      // bare path won't help findChanges classify them.
      if (sha === null) continue;
      out.files[path] = { path, remoteSha: sha, mtime, size };
    }
  }
  return out;
}

export default class SnapshotStore {
  private data: Sync2Metadata = freshMetadata();
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private vault: Vault) {
    this.filePath = normalizePath(
      `${vault.configDir}/${SYNC2_MANIFEST_FILE_NAME}`,
    );
  }

  async load(): Promise<void> {
    const exists = await this.vault.adapter.exists(this.filePath);
    if (!exists) {
      this.data = freshMetadata();
      return;
    }
    const text = await this.vault.adapter.read(this.filePath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    this.data = migrate(parsed);
  }

  async save(): Promise<void> {
    // Serialize through writeQueue: two concurrent saves would otherwise
    // race on adapter.write and one would clobber the other.
    this.writeQueue = this.writeQueue.then(async () => {
      await this.vault.adapter.write(
        this.filePath,
        JSON.stringify(this.data),
      );
    });
    return this.writeQueue;
  }

  // Per-file accessors.
  get(path: string): FileSnapshot | undefined {
    return this.data.files[path];
  }

  set(path: string, snap: FileSnapshot): void {
    this.data.files[path] = snap;
  }

  remove(path: string): void {
    delete this.data.files[path];
  }

  paths(): string[] {
    return Object.keys(this.data.files);
  }

  // Sync state.
  getLastSyncCommitSha(): string | null {
    return this.data.lastSyncCommitSha;
  }

  getLastSyncTreeSha(): string | null {
    return this.data.lastSyncTreeSha;
  }

  setLastSync(commitSha: string, treeSha: string): void {
    this.data.lastSyncCommitSha = commitSha;
    this.data.lastSyncTreeSha = treeSha;
  }

  getLastCommitMtime(): number | null {
    return this.data.lastCommitMtime;
  }

  setLastCommitMtime(mtime: number): void {
    this.data.lastCommitMtime = mtime;
  }

  // Invariant gitignore freshness cache. Read by GitignoreInvariants
  // to short-circuit the rewrite check; written by it after each
  // confirmed-clean state observation.
  getInvariantState(): Sync2InvariantState {
    return {
      configDirGitignore: this.data.invariantState.configDirGitignore,
      selfPluginGitignore: this.data.invariantState.selfPluginGitignore,
    };
  }

  setInvariantState(slot: keyof Sync2InvariantState, value: InvariantFileState): void {
    this.data.invariantState[slot] = value;
  }
}
