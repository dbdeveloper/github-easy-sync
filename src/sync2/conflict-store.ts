import { Vault } from "obsidian";
import { hasTextExtension } from "../utils";
import { UNKNOWN_DEVICE_LABEL } from "./commit-templates";

// Persistent state for sync2's text conflict resolver (Etap 6.5).
//
// On a real text conflict (3-way merge with overlapping edits), sync2
// captures (base, theirs) bytes here so the user can defer resolution
// indefinitely without losing the merge ancestor — `lastSyncCommitSha`
// will move forward and GitHub history may even be GC'd by the time the
// user comes back to resolve. A sibling file is also written into the
// vault so the conflict is visible in the file tree.
//
// Layout under the plugin's own directory (already covered by the
// strict-allowlist .gitignore from Etap 1; nothing here ever leaks to
// GitHub):
//
//   <configDir>/plugins/<self>/.conflicts/
//     <id>/
//       meta.json        ← ConflictRecord
//       base.<ext>       ← captured ancestor bytes
//       theirs.<ext>     ← captured remote-side bytes
//
// The sibling file lives in the vault itself, not under .conflicts/, so
// users see and edit it in Obsidian normally:
//
//   <basename>.conflict-from-<deviceLabel>-<isoTs>.<ext>
//
// (Same directory as the original. `Notes/note.md` →
// `Notes/note.conflict-from-Phone-2026-05-08T15-30-00Z.md`.)

const CONFLICTS_DIRNAME = ".conflicts";
const META_FILE = "meta.json";

export interface ConflictRecord {
  // YYYYMMDDhhmmssfff in UTC (matches push-queue's id format so the two
  // dirs sort uniformly when listed alongside each other).
  id: string;
  vaultPath: string;
  siblingPath: string;
  deviceLabel: string;
  // ms epoch UTC; when the conflict was first captured.
  ts: number;
  // commit SHA at lastSyncCommitSha when the conflict was detected. Null
  // when the base wasn't fetchable (force-pushed history). The local
  // base.<ext> snapshot still holds the bytes we used.
  baseCommitSha: string | null;
  // git blob SHA of "theirs" as observed at conflict time.
  theirsBlobSha: string;
}

export interface ConflictStoreDeps {
  vault: Vault;
  configDir: string;
  selfPluginId: string;
  // Per-device label baked into the sibling file name and stored in
  // metadata so a multi-device user can tell at a glance which device
  // contributed which copy. Sourced from settings.deviceLabel.
  deviceLabel: string;
  // Override the clock for deterministic IDs in tests.
  now?: () => Date;
}

export default class ConflictStore {
  private readonly vault: Vault;
  private readonly conflictsRoot: string;
  private readonly deviceLabel: string;
  private readonly now: () => Date;

  // In-memory caches populated by load() and kept in sync with disk by
  // create() / resolve() / notifySiblingDeleted(). Public lookups go
  // through these — no per-call disk walk.
  private byId = new Map<string, ConflictRecord>();
  private bySiblingPath = new Map<string, string>(); // siblingPath → id
  private byVaultPath = new Map<string, Set<string>>(); // vaultPath → ids

  constructor(deps: ConflictStoreDeps) {
    this.vault = deps.vault;
    this.conflictsRoot = `${deps.configDir}/plugins/${deps.selfPluginId}/${CONFLICTS_DIRNAME}`;
    // Empty / missing label falls back to the shared "unknown"
    // sentinel — same behaviour as the commit-message suffix, so
    // multi-device users see one consistent placeholder both on
    // GitHub and in vault sibling-file names if they forgot to set
    // deviceLabel on a particular machine.
    this.deviceLabel =
      deps.deviceLabel && deps.deviceLabel.length > 0
        ? deps.deviceLabel
        : UNKNOWN_DEVICE_LABEL;
    this.now = deps.now ?? (() => new Date());
  }

  // Walk .conflicts/*/meta.json into memory. Idempotent — re-load() is
  // safe and discards stale in-memory state. Call once at plugin start;
  // sync2-manager and the conflict view both rely on hasPending() being
  // accurate immediately after load.
  async load(): Promise<void> {
    this.byId.clear();
    this.bySiblingPath.clear();
    this.byVaultPath.clear();

    if (!(await this.vault.adapter.exists(this.conflictsRoot))) return;
    const { folders } = await this.vault.adapter.list(this.conflictsRoot);
    for (const folder of folders) {
      const id = folder.split("/").pop() ?? "";
      if (!/^\d{17}$/.test(id)) continue; // stray non-conflict folder
      const metaPath = `${folder}/${META_FILE}`;
      if (!(await this.vault.adapter.exists(metaPath))) continue;
      try {
        const text = await this.vault.adapter.read(metaPath);
        const record = JSON.parse(text) as ConflictRecord;
        if (this.isValidRecord(record)) {
          this.indexRecord(record);
        }
      } catch {
        // Malformed meta.json — skip silently. The conflict survives on
        // disk; an admin can clean it up manually. We don't surface
        // this as an error because sync2 should never block the user
        // over a corrupted conflict marker.
      }
    }
  }

  // Create a fresh conflict: snapshots base + theirs to .conflicts/<id>/,
  // writes the sibling file into the vault with `theirs` content, and
  // indexes the record in memory. Returns the new record so the caller
  // can hand it off to the modal/view.
  //
  // The `oursContent` argument is unused at storage time (ours always
  // lives at vaultPath in the live vault), but accepting it keeps the
  // call-site signature parallel to the legacy onConflict callback.
  async create(args: {
    vaultPath: string;
    baseContent: string;
    theirsContent: string;
    baseCommitSha: string | null;
    theirsBlobSha: string;
  }): Promise<ConflictRecord> {
    const ts = this.now().getTime();
    const id = await this.allocateUniqueId(ts);
    const siblingPath = buildSiblingPath(
      args.vaultPath,
      this.deviceLabel,
      ts,
    );

    const record: ConflictRecord = {
      id,
      vaultPath: args.vaultPath,
      siblingPath,
      deviceLabel: this.deviceLabel,
      ts,
      baseCommitSha: args.baseCommitSha,
      theirsBlobSha: args.theirsBlobSha,
    };

    const dir = `${this.conflictsRoot}/${id}`;
    await this.ensureDir(this.conflictsRoot);
    await this.ensureDir(dir);

    // Snapshot base + theirs into the conflict dir. Use the original
    // file's extension so Obsidian preview / syntax highlight still
    // works if the user opens base.<ext> directly.
    const ext = extensionOf(args.vaultPath);
    const baseFile = `${dir}/base${ext}`;
    const theirsFile = `${dir}/theirs${ext}`;
    await this.writeContent(baseFile, args.baseContent, args.vaultPath);
    await this.writeContent(theirsFile, args.theirsContent, args.vaultPath);

    // meta.json last — if we crash partway, the missing meta means the
    // record is invisible to load() and gets cleaned up next time the
    // user runs "Sync2: prune orphan conflicts" (future maintenance
    // command; for now, the orphan dir is harmless dead weight).
    await this.vault.adapter.write(
      `${dir}/${META_FILE}`,
      JSON.stringify(record, null, 2),
    );

    // Sibling in the vault — the user-visible artifact.
    await this.ensureParentDir(siblingPath);
    await this.writeContent(siblingPath, args.theirsContent, args.vaultPath);

    this.indexRecord(record);
    return record;
  }

  // True if any active conflict record references this vault path.
  // Sync2Manager calls this in enqueueOrMerge to skip pushing files
  // mid-resolution.
  hasPending(vaultPath: string): boolean {
    return (this.byVaultPath.get(vaultPath)?.size ?? 0) > 0;
  }

  forPath(vaultPath: string): ConflictRecord[] {
    const ids = this.byVaultPath.get(vaultPath);
    if (!ids) return [];
    const out: ConflictRecord[] = [];
    for (const id of ids) {
      const r = this.byId.get(id);
      if (r) out.push(r);
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  list(): ConflictRecord[] {
    return [...this.byId.values()].sort((a, b) => a.ts - b.ts);
  }

  get(id: string): ConflictRecord | null {
    return this.byId.get(id) ?? null;
  }

  // Distinct vault paths that currently have at least one pending
  // conflict. Useful for the status-bar widget and the conflict view's
  // left-side list grouping.
  pendingPaths(): string[] {
    return [...this.byVaultPath.keys()].filter(
      (p) => (this.byVaultPath.get(p)?.size ?? 0) > 0,
    );
  }

  async readBase(id: string): Promise<string> {
    const r = this.requireRecord(id);
    const ext = extensionOf(r.vaultPath);
    return await this.vault.adapter.read(`${this.conflictsRoot}/${id}/base${ext}`);
  }

  async readTheirs(id: string): Promise<string> {
    const r = this.requireRecord(id);
    const ext = extensionOf(r.vaultPath);
    return await this.vault.adapter.read(
      `${this.conflictsRoot}/${id}/theirs${ext}`,
    );
  }

  // Resolve the conflict by its id. Deletes both the .conflicts/<id>/
  // directory and the sibling file in the vault, then drops the record
  // from in-memory caches. Idempotent — calling resolve() on an unknown
  // id is a no-op.
  async resolve(id: string): Promise<void> {
    const r = this.byId.get(id);
    if (!r) return;
    if (await this.vault.adapter.exists(r.siblingPath)) {
      await this.vault.adapter.remove(r.siblingPath);
    }
    const dir = `${this.conflictsRoot}/${id}`;
    if (await this.vault.adapter.exists(dir)) {
      await this.vault.adapter.rmdir(dir, true);
    }
    this.unindexRecord(r);
  }

  // Vault listener entry point: when the user deletes a sibling file
  // through Obsidian's file tree, fire this with the deleted path so
  // the conflict closes itself. Returns true if a record matched and
  // was cleaned up.
  async notifySiblingDeleted(siblingVaultPath: string): Promise<boolean> {
    const id = this.bySiblingPath.get(siblingVaultPath);
    if (!id) return false;
    // Sibling is already gone; only the .conflicts/ dir + indexes.
    const dir = `${this.conflictsRoot}/${id}`;
    if (await this.vault.adapter.exists(dir)) {
      await this.vault.adapter.rmdir(dir, true);
    }
    const r = this.byId.get(id);
    if (r) this.unindexRecord(r);
    return true;
  }

  // ── internal ────────────────────────────────────────────────────────

  private isValidRecord(r: unknown): r is ConflictRecord {
    if (typeof r !== "object" || r === null) return false;
    const x = r as Record<string, unknown>;
    return (
      typeof x.id === "string" &&
      typeof x.vaultPath === "string" &&
      typeof x.siblingPath === "string" &&
      typeof x.deviceLabel === "string" &&
      typeof x.ts === "number" &&
      (x.baseCommitSha === null || typeof x.baseCommitSha === "string") &&
      typeof x.theirsBlobSha === "string"
    );
  }

  private requireRecord(id: string): ConflictRecord {
    const r = this.byId.get(id);
    if (!r) {
      throw new Error(`ConflictStore: unknown id ${id}`);
    }
    return r;
  }

  private indexRecord(r: ConflictRecord): void {
    this.byId.set(r.id, r);
    this.bySiblingPath.set(r.siblingPath, r.id);
    let set = this.byVaultPath.get(r.vaultPath);
    if (!set) {
      set = new Set();
      this.byVaultPath.set(r.vaultPath, set);
    }
    set.add(r.id);
  }

  private unindexRecord(r: ConflictRecord): void {
    this.byId.delete(r.id);
    this.bySiblingPath.delete(r.siblingPath);
    const set = this.byVaultPath.get(r.vaultPath);
    if (set) {
      set.delete(r.id);
      if (set.size === 0) this.byVaultPath.delete(r.vaultPath);
    }
  }

  private async allocateUniqueId(tsMs: number): Promise<string> {
    // Collisions happen when two conflicts land in the same millisecond
    // (synthetic in tests, plausible in cascade scenarios). Tick forward
    // a millisecond at a time until the directory name is free.
    let ms = tsMs;
    let id = buildId(ms);
    while (
      this.byId.has(id) ||
      (await this.vault.adapter.exists(`${this.conflictsRoot}/${id}`))
    ) {
      ms += 1;
      id = buildId(ms);
    }
    return id;
  }

  private async ensureDir(dirPath: string): Promise<void> {
    if (!(await this.vault.adapter.exists(dirPath))) {
      await this.vault.adapter.mkdir(dirPath);
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

  private async writeContent(
    targetPath: string,
    content: string,
    originalPath: string,
  ): Promise<void> {
    // Mirror push-queue's text/binary distinction so binary files that
    // happen to come through this path (rare — current Etap 6.5 only
    // routes text conflicts here, but be robust) round-trip byte-exact.
    if (hasTextExtension(originalPath)) {
      await this.vault.adapter.write(targetPath, content);
    } else {
      // For binaries, content is a base64-decoded string of bytes — the
      // current callers only pass text, so we treat it as text. If a
      // binary code path is added later, switch to writeBinary here.
      await this.vault.adapter.write(targetPath, content);
    }
  }
}

// Build the .conflicts/<id>/ directory name. Same shape as push-queue.
export function buildId(tsMs: number): string {
  const d = new Date(tsMs);
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return (
    `${d.getUTCFullYear()}` +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    pad(d.getUTCMilliseconds(), 3)
  );
}

// Sibling path next to the original. Preserves the directory and
// extension so Obsidian's syntax highlighting / preview kicks in.
//
//   `Notes/note.md`, label="Phone", ts=2026-05-08T15:30:00.000Z
//     → `Notes/note.conflict-from-Phone-2026-05-08T15-30-00Z.md`
//
// Why colons become dashes in the timestamp: Windows filesystems reject
// `:` in filenames, and we want users on every OS to see the same
// sibling file in their vault.
export function buildSiblingPath(
  vaultPath: string,
  deviceLabel: string,
  tsMs: number,
): string {
  const ext = extensionOf(vaultPath);
  const base = ext ? vaultPath.slice(0, vaultPath.length - ext.length) : vaultPath;
  // ISO with seconds resolution, no colons, no milliseconds.
  const iso = new Date(tsMs)
    .toISOString()
    .replace(/\.\d+/, "")
    .replace(/:/g, "-");
  // Strip filesystem-unsafe characters from the device label. The
  // human-readable form lives in meta.json.deviceLabel; the filename
  // sees the safe form only. If sanitization collapses the label to
  // an empty string (or input was already empty), use UNKNOWN_DEVICE_LABEL
  // so the filename never has a `.conflict-from--` double-dash.
  let safe = deviceLabel.replace(/[^a-zA-Z0-9_-]+/g, "_");
  if (safe.length === 0 || safe === "_") safe = UNKNOWN_DEVICE_LABEL;
  return `${base}.conflict-from-${safe}-${iso}${ext}`;
}

// Extension including the leading dot. Empty string for files without
// an extension. Splits on the LAST dot, so `archive.tar.gz` → `.gz`.
export function extensionOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  const dot = filePath.lastIndexOf(".");
  if (dot <= slash) return ""; // dot in directory name doesn't count
  return filePath.slice(dot);
}
