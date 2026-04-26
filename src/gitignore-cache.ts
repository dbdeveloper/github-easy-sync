import { Vault, normalizePath } from "obsidian";
import ignore, { Ignore } from "ignore";
import manifest from "../manifest.json";

const SELF_PLUGIN_ID = manifest.id;

const INVARIANT_BEGIN =
  "# ===== github-gitless-sync invariants — DO NOT EDIT =====";
const INVARIANT_END = "# ===== end of invariants =====";

/**
 * Canonical contents of the invariant block at the top of <configDir>/.gitignore.
 * Rewrite-to-canonical: any tampering inside the block (or removal of the block)
 * triggers a rewrite on the next plugin load. The rules here are the things we
 * cannot let users opt out of without breaking the sync protocol or shipping
 * per-device state across machines.
 */
const INVARIANT_BLOCK = `${INVARIANT_BEGIN}
# Editing this block triggers a rewrite to canonical on next load.

# Sync manifest — must always be tracked.
!github-sync-metadata.json

# .gitignore files themselves — rules must propagate across devices.
!.gitignore

# Per-device state — never propagate between machines.
workspace.json
workspace-mobile.json
community-plugins.json
${INVARIANT_END}`;

/**
 * Seeded patterns added below the invariant block ONLY when <configDir>/.gitignore
 * didn't exist before plugin start. Users can edit or remove freely.
 */
const CONFIG_DIR_SEED = `# Recommended defaults — feel free to edit.

# Logs (covers the plugin's own github-sync.log and any other *.log).
*.log

# Plugin folder allowlist — by default sync only the four canonical files.
plugins/*/*
!plugins/*/
!plugins/*/data.json
!plugins/*/main.js
!plugins/*/manifest.json
!plugins/*/styles.css`;

/**
 * Seeded patterns for vault-root .gitignore, written ONLY when no root
 * .gitignore exists (typical first-time install). Users can edit or remove.
 */
// Note: `.git/` is intentionally absent — it's hardcoded in isSyncable
// (rule 3) and can never be overridden, so duplicating it here would
// only invite confusion ("I removed the line, why is it still ignored?").
const ROOT_SEED = `# Defaults from github-gitless-sync — feel free to edit.

# OS / IDE noise
.DS_Store
Thumbs.db
desktop.ini
.idea/
.vscode/
.trash/
node_modules/

# Editor backups
*~
*.swp
*.bak
*.orig

# Plugin-generated conflict backups (loser side of atomic conflict
# resolution is saved next to the winner). Remove to share backups
# between devices.
*.conflict-local-*
*.conflict-remote-*`;

/**
 * Auto-rewritten on every plugin load — users cannot edit. Locks our own
 * plugin folder to the four canonical files plus the .gitignore itself
 * (so the file syncs to other devices and the rule propagates).
 */
const SELF_PLUGIN_STRICT = `# Auto-rewritten on every plugin load. Do not edit.
*
!.gitignore
!main.js
!manifest.json
!styles.css`;

interface CachedFile {
  path: string;
  mtime: number;
  matcher: Ignore;
}

/**
 * Loads, caches, and applies the user's .gitignore rules. Three sources:
 *   - <root>/.gitignore — patterns relative to vault root.
 *   - <configDir>/.gitignore — patterns relative to <configDir>/.
 *   - <configDir>/plugins/<self>/.gitignore — patterns relative to that folder.
 *
 * On initialize() we ensure all three files exist with the right content
 * (canonical/seed/strict per file). We then build a combined matcher with
 * paths re-prefixed so a single isIgnored() call covers all three layers.
 *
 * mtime is checked before each sync via refreshIfChanged() — if any file
 * was edited, we re-parse it and rebuild the matcher.
 */
export class GitignoreCache {
  private root: CachedFile | null = null;
  private configDir: CachedFile | null = null;
  private selfPlugin: CachedFile | null = null;
  private combined: Ignore = ignore();

  constructor(private vault: Vault) {}

  /**
   * One-time setup: ensure files exist with the right content, then load
   * them into the matcher. Call once after plugin onload, before any sync.
   */
  async initialize(): Promise<void> {
    await this.ensureSelfPluginGitignore();
    await this.ensureConfigDirGitignore();
    await this.ensureRootGitignore();
    await this.reload();
  }

  /**
   * Cheap check — re-parse only files whose mtime changed since last load.
   * Call before each sync (it's tiny: three stat() calls).
   */
  async refreshIfChanged(): Promise<void> {
    let changed = false;
    if (await this.fileChanged(this.root?.path ?? this.rootPath(), this.root)) {
      changed = true;
    }
    if (
      await this.fileChanged(
        this.configDir?.path ?? this.configDirPath(),
        this.configDir,
      )
    ) {
      changed = true;
    }
    if (
      await this.fileChanged(
        this.selfPlugin?.path ?? this.selfPluginPath(),
        this.selfPlugin,
      )
    ) {
      changed = true;
    }
    if (changed) {
      await this.reload();
    }
  }

  /**
   * The combined matcher's verdict for a path (relative to vault root).
   */
  isIgnored(filePath: string): boolean {
    return this.combined.ignores(filePath);
  }

  // -- file lifecycle ---------------------------------------------------

  private async ensureRootGitignore(): Promise<void> {
    const path = this.rootPath();
    if (await this.vault.adapter.exists(path)) return;
    await this.vault.adapter.write(path, ROOT_SEED + "\n");
  }

  private async ensureConfigDirGitignore(): Promise<void> {
    const path = this.configDirPath();
    const existing = (await this.vault.adapter.exists(path))
      ? await this.vault.adapter.read(path)
      : null;

    if (existing === null) {
      // First creation: full canonical + seed.
      await this.vault.adapter.write(
        path,
        INVARIANT_BLOCK + "\n\n" + CONFIG_DIR_SEED + "\n",
      );
      return;
    }

    // File exists — check whether the canonical block is intact at the top.
    if (existing.startsWith(INVARIANT_BLOCK)) {
      return; // unchanged, leave alone
    }

    // Tampered or missing block. Strip any old block (between BEGIN/END
    // markers) and prepend the canonical block. Don't touch user content
    // outside the invariant region, including any seed they may have edited.
    const cleaned = stripInvariantRegion(existing).trimStart();
    const rebuilt =
      INVARIANT_BLOCK + (cleaned ? "\n\n" + cleaned : "\n");
    await this.vault.adapter.write(path, rebuilt);
  }

  private async ensureSelfPluginGitignore(): Promise<void> {
    const path = this.selfPluginPath();
    const existing = (await this.vault.adapter.exists(path))
      ? await this.vault.adapter.read(path)
      : null;
    if (existing === SELF_PLUGIN_STRICT + "\n" || existing === SELF_PLUGIN_STRICT) {
      return;
    }
    await this.vault.adapter.write(path, SELF_PLUGIN_STRICT + "\n");
  }

  // -- load + combined matcher build -----------------------------------

  private async reload(): Promise<void> {
    this.root = await this.loadOne(this.rootPath(), "");
    this.configDir = await this.loadOne(
      this.configDirPath(),
      this.vault.configDir + "/",
    );
    this.selfPlugin = await this.loadOne(
      this.selfPluginPath(),
      `${this.vault.configDir}/plugins/${SELF_PLUGIN_ID}/`,
    );

    // Build combined matcher with patterns reprefixed to vault-root scope so
    // a single ignores() call considers every layer.
    const combined = ignore();
    if (this.root) combined.add(this.root.matcher);
    // For the prefixed sources we need to feed the lib lines re-prefixed.
    // We re-read the raw content for that — cached via the loadOne pass.
    if (this.configDir) {
      combined.add(
        prefixPatterns(
          await this.readSafe(this.configDirPath()),
          `${this.vault.configDir}/`,
        ),
      );
    }
    if (this.selfPlugin) {
      combined.add(
        prefixPatterns(
          await this.readSafe(this.selfPluginPath()),
          `${this.vault.configDir}/plugins/${SELF_PLUGIN_ID}/`,
        ),
      );
    }
    this.combined = combined;
  }

  private async loadOne(
    path: string,
    _scopePrefix: string,
  ): Promise<CachedFile | null> {
    if (!(await this.vault.adapter.exists(path))) return null;
    const content = await this.vault.adapter.read(path);
    const stat = await this.vault.adapter.stat(path);
    const matcher = ignore().add(content);
    return {
      path,
      mtime: stat?.mtime ?? Date.now(),
      matcher,
    };
  }

  private async readSafe(path: string): Promise<string> {
    try {
      return await this.vault.adapter.read(path);
    } catch {
      return "";
    }
  }

  private async fileChanged(
    path: string,
    cached: CachedFile | null,
  ): Promise<boolean> {
    if (!(await this.vault.adapter.exists(path))) {
      return cached !== null; // file was deleted since last load
    }
    const stat = await this.vault.adapter.stat(path);
    if (!cached) return true;
    return (stat?.mtime ?? 0) !== cached.mtime;
  }

  private rootPath(): string {
    return normalizePath(".gitignore");
  }
  private configDirPath(): string {
    return normalizePath(`${this.vault.configDir}/.gitignore`);
  }
  private selfPluginPath(): string {
    return normalizePath(
      `${this.vault.configDir}/plugins/${SELF_PLUGIN_ID}/.gitignore`,
    );
  }
}

/**
 * Extract anything between INVARIANT_BEGIN and INVARIANT_END (inclusive).
 * If only BEGIN is present, drop everything from there to the file end —
 * that's the safer assumption when an obviously-tampered block has no
 * matching close marker.
 */
function stripInvariantRegion(content: string): string {
  const beginIdx = content.indexOf(INVARIANT_BEGIN);
  if (beginIdx === -1) return content;
  const endIdx = content.indexOf(INVARIANT_END, beginIdx);
  if (endIdx === -1) {
    return content.substring(0, beginIdx);
  }
  return (
    content.substring(0, beginIdx) +
    content.substring(endIdx + INVARIANT_END.length)
  );
}

/**
 * Re-write each non-empty, non-negation line as `<prefix><pattern>`. Lines
 * starting with `!` keep the `!` and get the prefix after it. Comments and
 * blank lines pass through.
 */
function prefixPatterns(content: string, prefix: string): string {
  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      if (trimmed.startsWith("!")) {
        return "!" + prefix + trimmed.substring(1);
      }
      return prefix + trimmed;
    })
    .join("\n");
}

// Expose canonical strings for tests.
export const __test__ = {
  INVARIANT_BEGIN,
  INVARIANT_END,
  INVARIANT_BLOCK,
  CONFIG_DIR_SEED,
  ROOT_SEED,
  SELF_PLUGIN_STRICT,
  stripInvariantRegion,
  prefixPatterns,
};
