import { Vault } from "obsidian";
import { calculateGitBlobSHA } from "../utils";
import SnapshotStore, { InvariantFileState } from "./snapshot-store";

// Invariant block markers. Editing anything between BEGIN and END on
// disk triggers a rewrite back to canonical on the next sync.
export const INVARIANT_BEGIN =
  "# ===== github-easy-sync invariants — DO NOT EDIT =====";
export const INVARIANT_END =
  "# ===== end of invariants =====";

// Body of the invariant block in <configDir>/.gitignore. The plugin
// rewrites this block in place; the user keeps full ownership of any
// content above or below it.
const CONFIG_DIR_INVARIANT_BLOCK = `${INVARIANT_BEGIN}
# Editing this block triggers a rewrite to canonical on next load.

# Per-device state — never propagate between machines.
github-easy-sync-metadata.json
workspace.json
workspace-mobile.json
community-plugins.json
${INVARIANT_END}`;

// Recommended defaults seeded ONLY when sync2 first creates
// <configDir>/.gitignore. Pre-existing files keep the user's content
// untouched below the invariant block.
const CONFIG_DIR_RECOMMENDED_DEFAULTS = `# Recommended defaults — feel free to edit.

# Logs (covers the plugin's own github-easy-sync.log and any other *.log).
*.log

# Plugin folder allowlist — by default sync only the four canonical files.
plugins/*/*
!plugins/*/
!plugins/*/data.json
!plugins/*/main.js
!plugins/*/manifest.json
!plugins/*/styles.css`;

// Canonical content of <configDir>/plugins/<self>/.gitignore. Unlike
// the configDir gitignore, the plugin owns this file outright — full
// rewrite each time, no user content carried over.
const SELF_PLUGIN_GITIGNORE = `*
!main.js
!manifest.json
!styles.css
!.gitignore
`;

// Body of the invariant block in the ROOT <vault>/.gitignore (Etap
// 6.5). Forces conflict-sibling files (`<base>.conflict-from-<label>-
// <iso-no-colons>.<ext>`) to never be pushed: they're per-device
// markers, propagating them across devices would create feedback
// loops where one device's deferred state shows up on others as
// unrelated user files. Splice-on-edit semantics, same as configDir.
const ROOT_INVARIANT_BLOCK = `${INVARIANT_BEGIN}
# Editing this block triggers a rewrite to canonical on next load.

# Conflict-resolver sibling files — per-device markers that must
# never propagate via sync.
*.conflict-from-*
${INVARIANT_END}`;

// Recommended root-level defaults seeded ONLY when sync2 first
// creates <vault>/.gitignore. Pre-existing files keep user content
// untouched below the invariant block.
const ROOT_RECOMMENDED_DEFAULTS = `# Recommended defaults — feel free to edit.

# OS noise
.DS_Store
Thumbs.db
desktop.ini

# Editor/backup junk
*~
*.swp
*.swo
.vscode/
.idea/`;

export interface GitignoreInvariantsDeps {
  vault: Vault;
  store: SnapshotStore;
  configDir: string;
  selfPluginId: string;
}

// Owner of the two managed gitignore files. Public surface:
//   - enforce(): bring both files into canonical state, skipping work
//                when on-disk mtime+hash match the cached state.
//   - notePathSelfWritten(path): used by Sync2Manager.recordSync after
//                a sync2-driven push of one of these files, so the
//                next enforce() sees an immediate cache hit.
export default class GitignoreInvariants {
  private readonly vault: Vault;
  private readonly store: SnapshotStore;
  private readonly configDirGitignorePath: string;
  private readonly selfPluginGitignorePath: string;
  // Root <vault>/.gitignore. Bare ".gitignore" — relative to vault root.
  private readonly rootGitignorePath = ".gitignore";

  constructor(deps: GitignoreInvariantsDeps) {
    this.vault = deps.vault;
    this.store = deps.store;
    this.configDirGitignorePath = `${deps.configDir}/.gitignore`;
    this.selfPluginGitignorePath = `${deps.configDir}/plugins/${deps.selfPluginId}/.gitignore`;
  }

  // Path of <configDir>/.gitignore. Exposed so callers (e.g.
  // Sync2Manager.recordSync) can recognise self-written paths.
  get configDirPath(): string {
    return this.configDirGitignorePath;
  }

  get selfPluginPath(): string {
    return this.selfPluginGitignorePath;
  }

  get rootPath(): string {
    return this.rootGitignorePath;
  }

  // Verify and, if needed, rewrite all three invariant gitignore
  // files. Cheap path: stat each, compare mtime to recorded; if
  // equal, do nothing else. Slow path (mtime moved): read content,
  // compare hash; if hash matches recorded, refresh just the mtime
  // cache. Only when hash truly changed do we rewrite.
  async enforce(): Promise<void> {
    await this.enforceConfigDirGitignore();
    await this.enforceSelfPluginGitignore();
    await this.enforceRootGitignore();
  }

  // Called by Sync2Manager.recordSync after a successful self-push of
  // one of the invariant files. Updates the cached mtime+hash so the
  // next sync's enforce() short-circuits without re-reading.
  async notePathSelfWritten(path: string): Promise<void> {
    if (path === this.configDirGitignorePath) {
      await this.refreshState("configDirGitignore", path);
    } else if (path === this.selfPluginGitignorePath) {
      await this.refreshState("selfPluginGitignore", path);
    } else if (path === this.rootGitignorePath) {
      await this.refreshState("rootGitignore", path);
    }
  }

  // ── internal ────────────────────────────────────────────────────────

  private async enforceConfigDirGitignore(): Promise<void> {
    const slot = "configDirGitignore" as const;
    const path = this.configDirGitignorePath;
    const recorded = this.store.getInvariantState()[slot];

    const stat = await this.vault.adapter.stat(path);
    if (!stat) {
      // Fresh install: file doesn't exist. Seed the full template
      // (invariant block + recommended defaults) once.
      const content = `${CONFIG_DIR_INVARIANT_BLOCK}\n\n${CONFIG_DIR_RECOMMENDED_DEFAULTS}\n`;
      await this.write(path, content);
      await this.refreshState(slot, path);
      return;
    }

    if (recorded && recorded.mtime === stat.mtime) return;

    // mtime moved (or no record yet) — read and inspect.
    const content = await this.vault.adapter.read(path);
    const hash = await sha1Of(content);
    if (recorded && recorded.hash === hash) {
      // Touched-but-unchanged: refresh mtime only, no rewrite.
      this.store.setInvariantState(slot, { mtime: stat.mtime, hash });
      return;
    }

    // Real edit somewhere in the file. If the user kept the invariant
    // block intact, this is a no-op rewrite below the markers — the
    // splice produces the same content. If they tampered with the
    // block, the splice restores it; the rest of their edits are
    // preserved verbatim.
    const fixed = spliceInvariantBlock(content, CONFIG_DIR_INVARIANT_BLOCK);
    if (fixed === content) {
      // Nothing to change on disk; just refresh the cache.
      this.store.setInvariantState(slot, { mtime: stat.mtime, hash });
      return;
    }
    await this.write(path, fixed);
    await this.refreshState(slot, path);
  }

  // Same shape as enforceConfigDirGitignore but for the ROOT vault
  // gitignore. The forced rule here is `*.conflict-from-*`, which
  // pins per-device conflict-sibling files to local-only.
  private async enforceRootGitignore(): Promise<void> {
    const slot = "rootGitignore" as const;
    const path = this.rootGitignorePath;
    const recorded = this.store.getInvariantState()[slot];

    const stat = await this.vault.adapter.stat(path);
    if (!stat) {
      // Fresh install: file doesn't exist. Seed invariant block + a
      // small set of recommended OS/editor noise defaults so the user
      // gets a sensible starting point. Pre-existing root gitignores
      // (e.g. user already had one) skip this branch entirely.
      const content = `${ROOT_INVARIANT_BLOCK}\n\n${ROOT_RECOMMENDED_DEFAULTS}\n`;
      await this.write(path, content);
      await this.refreshState(slot, path);
      return;
    }

    if (recorded && recorded.mtime === stat.mtime) return;

    const content = await this.vault.adapter.read(path);
    const hash = await sha1Of(content);
    if (recorded && recorded.hash === hash) {
      this.store.setInvariantState(slot, { mtime: stat.mtime, hash });
      return;
    }

    const fixed = spliceInvariantBlock(content, ROOT_INVARIANT_BLOCK);
    if (fixed === content) {
      this.store.setInvariantState(slot, { mtime: stat.mtime, hash });
      return;
    }
    await this.write(path, fixed);
    await this.refreshState(slot, path);
  }

  private async enforceSelfPluginGitignore(): Promise<void> {
    const slot = "selfPluginGitignore" as const;
    const path = this.selfPluginGitignorePath;
    const recorded = this.store.getInvariantState()[slot];

    const stat = await this.vault.adapter.stat(path);
    if (!stat) {
      await this.write(path, SELF_PLUGIN_GITIGNORE);
      await this.refreshState(slot, path);
      return;
    }

    if (recorded && recorded.mtime === stat.mtime) return;

    const content = await this.vault.adapter.read(path);
    const hash = await sha1Of(content);
    if (content === SELF_PLUGIN_GITIGNORE) {
      // Already canonical, just touched.
      this.store.setInvariantState(slot, { mtime: stat.mtime, hash });
      return;
    }

    // Sync2 owns this file outright — overwrite anything the user (or
    // anything else) wrote into it.
    await this.write(path, SELF_PLUGIN_GITIGNORE);
    await this.refreshState(slot, path);
  }

  private async refreshState(
    slot: keyof ReturnType<SnapshotStore["getInvariantState"]>,
    path: string,
  ): Promise<void> {
    const stat = await this.vault.adapter.stat(path);
    if (!stat) return;
    const content = await this.vault.adapter.read(path);
    const hash = await sha1Of(content);
    this.store.setInvariantState(slot as never, {
      mtime: stat.mtime,
      hash,
    } as InvariantFileState);
  }

  private async write(path: string, content: string): Promise<void> {
    await this.ensureParentDir(path);
    await this.vault.adapter.write(path, content);
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
}

// Replace the existing invariant block (between the BEGIN/END markers)
// with `block`. If markers aren't both present, prepend the block at
// the top of the file with a blank-line separator. Pure function for
// testability.
export function spliceInvariantBlock(
  existing: string,
  block: string,
): string {
  const beginIdx = existing.indexOf(INVARIANT_BEGIN);
  const endIdx = existing.indexOf(INVARIANT_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    // Markers missing or malformed — prepend canonical block.
    if (existing.length === 0) return `${block}\n`;
    return `${block}\n\n${existing}`;
  }
  const before = existing.substring(0, beginIdx);
  const afterStart = endIdx + INVARIANT_END.length;
  const after = existing.substring(afterStart);
  return `${before}${block}${after}`;
}

async function sha1Of(content: string): Promise<string> {
  const buf = new TextEncoder().encode(content).buffer as ArrayBuffer;
  return await calculateGitBlobSHA(buf);
}
