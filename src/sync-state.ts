import { Vault, normalizePath } from "obsidian";
import GithubClient, {
  GetTreeResponseItem,
  RepoContent,
} from "./github/client";
import { MANIFEST_FILE_NAME, Metadata } from "./metadata-store";
import {
  calculateGitBlobSHA,
  decodeBase64String,
  isSyncable,
} from "./utils";
import manifest from "../manifest.json";

const SELF_PLUGIN_ID = manifest.id;

/**
 * Decide whether a syncable path counts as auto-managed infrastructure
 * (and so doesn't make the vault "non-empty" for sync routing) vs.
 * actual user content.
 *
 * The user's mental model of "empty vault" is: "I created a vault,
 * installed this plugin, and did nothing else." The state at that
 * moment looks like:
 *   - Welcome.md at root (Obsidian creates on every new vault)
 *   - <configDir>/* (Obsidian's own settings, themes, snippets…)
 *   - <configDir>/plugins/<our-plugin-id>/* (the plugin we just installed)
 *   - <configDir>/.gitignore + <configDir>/plugins/<our-id>/.gitignore
 *     + (root) .gitignore — written by GitignoreCache.initialize on
 *     first plugin run
 *
 * Anything *outside* that set is real user content — notes the user
 * authored, other plugins they installed, .gitignore files they
 * placed before the plugin existed.
 *
 * The root .gitignore is the only ambiguous case: it lives outside
 * <configDir>/, so we have no path-based way to tell ours apart from
 * a user-authored one. We track creation in
 * Metadata.pluginCreatedGitignores and pass that set in here.
 */
function isInfraPath(
  path: string,
  configDir: string,
  pluginCreatedGitignores: Set<string>,
): boolean {
  if (path === "Welcome.md") return true;
  if (pluginCreatedGitignores.has(path)) return true;
  if (path.startsWith(`${configDir}/`)) {
    if (path.startsWith(`${configDir}/plugins/`)) {
      const sub = path.substring(`${configDir}/plugins/`.length);
      const pluginId = sub.split("/")[0];
      // Only our own plugin's folder is infra. Other plugins under
      // <configDir>/plugins/<other-id>/ mean the user installed
      // something — that's user activity, not "fresh vault".
      return pluginId === SELF_PLUGIN_ID;
    }
    // Anything else inside configDir (app.json, appearance.json,
    // workspace.json, themes/, snippets/, etc.) is Obsidian's own
    // state, never user-authored content.
    return true;
  }
  return false;
}

/**
 * Structured snapshot of the local vault's sync-relevant state. Built by
 * walking the vault and applying isSyncable. Used by decideInitAction to
 * pick the right initial-sync flow without the cascade of ifs that
 * firstSyncImpl used to be.
 */
export type LocalState =
  | { kind: "empty" }
  | { kind: "has-manifest"; fileCount: number }
  | {
      kind: "has-content-no-manifest";
      fileCount: number;
      sampleFiles: string[];
    };

/**
 * Structured snapshot of what the remote repository looks like. The "bare"
 * case covers brand-new repos with no commits at all (404/409 from the tree
 * API). The other two cases differ only in whether our manifest file is
 * present in the tree.
 */
export type RemoteState =
  | { kind: "bare"; reason: string }
  | {
      kind: "has-manifest";
      treeSha: string;
      files: { [key: string]: GetTreeResponseItem };
      manifest: Metadata;
    }
  | {
      kind: "has-content-no-manifest";
      treeSha: string;
      files: { [key: string]: GetTreeResponseItem };
      sampleFiles: string[];
    };

/**
 * Per-side breakdown when local and remote both have files but no shared
 * manifest. Built by compareForAdoption(): we hash every local syncable
 * file and intersect with the remote tree's SHAs. The categorization
 * decides whether we can silently adopt the existing state (no destructive
 * choice required) or have to prompt the user.
 */
export type AdoptionAnalysis = {
  /** Path → SHA for all syncable local files (used downstream to seed metadata). */
  localFileSHAs: { [path: string]: string };
  /** Same path AND same SHA on both sides. */
  identical: string[];
  /** Path exists locally but not remotely. */
  localOnly: string[];
  /** Path exists remotely but not locally. */
  remoteOnly: string[];
  /** Path exists on both sides with different SHA — a real conflict. */
  conflicting: string[];
};

/**
 * Should we silently adopt the current state, or prompt the user?
 *
 * Rule: adopt silently whenever there's no real conflict — i.e. no path
 * exists on both sides with diverging content. One-sided extras (only
 * local, only remote, or both) are fine: they get reconciled by the
 * follow-up regular sync (locals upload, remotes download). The user
 * never sees a prompt unless content actually disagrees.
 */
export function shouldAutoAdopt(analysis: AdoptionAnalysis): boolean {
  return analysis.conflicting.length === 0;
}

/**
 * What the orchestrator should do next, given local and remote analyses.
 *   - regular-sync: both sides have manifests; let incremental sync handle it.
 *   - bootstrap-empty: both sides empty — write the first manifest commit.
 *   - first-sync-from-local: push local up, overwriting whatever's on remote.
 *   - first-sync-from-remote: pull remote down, overwriting local.
 *   - needs-adoption-analysis: caller must call compareForAdoption to refine.
 *   - adopt: take both sides as-is, create manifest from current state, then
 *     reconcile any one-sided extras via regular sync.
 *   - ambiguous: real conflict or mutual-extras — user must pick a side.
 */
export type InitAction =
  | { kind: "regular-sync" }
  | { kind: "bootstrap-empty" }
  | { kind: "first-sync-from-local"; remote: RemoteState }
  | { kind: "first-sync-from-remote"; remote: RemoteState }
  | { kind: "needs-adoption-analysis"; remote: RemoteState }
  | {
      kind: "adopt";
      remote: RemoteState;
      analysis: AdoptionAnalysis;
    }
  | {
      kind: "ambiguous";
      local: LocalState;
      remote: RemoteState;
      analysis: AdoptionAnalysis;
    };

/**
 * Walk the vault and classify what's there from the sync's point of view.
 * isSyncable filters out things we'd never sync (junk, plugin internals,
 * configDir when disabled), so the file count we report is what would
 * actually go through the pipeline.
 */
export async function analyzeLocalState(
  vault: Vault,
  syncConfigDir: boolean,
  gitignoreMatcher?: { isIgnored(path: string): boolean },
  pluginCreatedGitignores: Set<string> = new Set(),
): Promise<LocalState> {
  const manifestPath = `${vault.configDir}/${MANIFEST_FILE_NAME}`;
  const manifestExists = await vault.adapter.exists(manifestPath);

  const files: string[] = [];
  const folders: string[] = [vault.getRoot().path];
  while (folders.length > 0) {
    const folder = folders.pop();
    if (folder === undefined) continue;
    const res = await vault.adapter.list(folder);
    files.push(...res.files);
    folders.push(...res.folders);
  }

  // Manifest doesn't count as "user content" — we're tracking whether the
  // vault has anything *we'd ship to GitHub on a first push*.
  const syncableFiles = files.filter(
    (p) =>
      p !== manifestPath &&
      isSyncable(p, vault.configDir, syncConfigDir, gitignoreMatcher),
  );

  // Neither the manifest's presence nor its file-entry count is a
  // reliable "prior sync happened" signal:
  //   - MetadataStore.load() creates the manifest file at plugin start.
  //   - The events listener can populate file entries (sha=null,
  //     dirty=true) for everything Obsidian/plugins create during init
  //     — Welcome.md, the .gitignore files we seed, plus configDir
  //     defaults if syncConfigDir is on. None of that represents an
  //     actual sync event.
  // The one field that's only ever set inside commitSync is lastSync,
  // so it's the trustworthy marker that some sync truly completed in
  // this vault before. Without this check, opening the plugin in a
  // fresh vault routes through regular-sync — which then sees those
  // dirty=true infra entries and tries to *upload* the local
  // Welcome.md / .gitignore over the remote versions instead of
  // pulling the user's notes down.
  let hasRealManifest = false;
  if (manifestExists) {
    try {
      const raw = await vault.adapter.read(manifestPath);
      const parsed = JSON.parse(raw) as { lastSync?: number };
      hasRealManifest =
        typeof parsed.lastSync === "number" && parsed.lastSync > 0;
    } catch {
      // Corrupt manifest — treat as fresh.
    }
  }

  if (hasRealManifest) {
    return { kind: "has-manifest", fileCount: syncableFiles.length };
  }

  // Per-path infra check (see isInfraPath docstring): Welcome.md,
  // plugin-created .gitignore files, all of <configDir>/* except for
  // OTHER plugins' folders. If nothing on disk is real user content,
  // route through the empty/fresh-vault flows.
  const userContent = syncableFiles.filter(
    (p) => !isInfraPath(p, vault.configDir, pluginCreatedGitignores),
  );
  if (userContent.length === 0) {
    return { kind: "empty" };
  }

  return {
    kind: "has-content-no-manifest",
    fileCount: syncableFiles.length,
    sampleFiles: syncableFiles.slice(0, 10),
  };
}

/**
 * Probe the remote and classify it. Bare-repo detection uses the same
 * 404/409 trick the old code did (GitHub returns one of those when there
 * are no commits at all). When the manifest is present we fetch and parse
 * it here so the caller doesn't have to make a second round-trip.
 */
export async function analyzeRemoteState(
  client: GithubClient,
  configDir: string,
): Promise<RemoteState> {
  let res: RepoContent;
  try {
    res = await client.getRepoContent({ retry: true });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404 || status === 409) {
      return { kind: "bare", reason: `repo returned ${status}` };
    }
    throw err;
  }

  const manifestPath = `${configDir}/${MANIFEST_FILE_NAME}`;
  const manifestItem = res.files[manifestPath];

  if (manifestItem) {
    const blob = await client.getBlob({
      sha: manifestItem.sha,
      retry: true,
    });
    const manifest: Metadata = JSON.parse(decodeBase64String(blob.content));
    return {
      kind: "has-manifest",
      treeSha: res.sha,
      files: res.files,
      manifest,
    };
  }

  return {
    kind: "has-content-no-manifest",
    treeSha: res.sha,
    files: res.files,
    sampleFiles: Object.keys(res.files).slice(0, 10),
  };
}

/** Which (if any) interrupted first-sync attempt we're resuming. */
export type ResumeKind = null | "from-remote" | "from-local";

/**
 * The decision table. Pure function — given snapshots, returns what to do.
 *
 * For the "both sides have content but no shared history" cases the result
 * is `needs-adoption-analysis`: the caller must run compareForAdoption
 * to learn whether the divergence is recoverable (silent adopt) or needs
 * the user to pick a side.
 *
 * `resume` short-circuits to the matching first-sync path: a previous
 * download/upload attempt was interrupted, so local state may now look
 * ambiguous, but we want to keep going on the same path rather than
 * re-analyse it. "from-local" wins if both flags are set (shouldn't
 * happen in practice — only one path runs at a time).
 */
export function decideInitAction(
  local: LocalState,
  remote: RemoteState,
  resume: ResumeKind,
): InitAction {
  if (resume === "from-local") {
    if (remote.kind === "bare") {
      // Remote went bare while we were uploading. Bootstrap will be
      // re-done, then the resume marker still triggers the upload path.
      return { kind: "first-sync-from-local", remote };
    }
    return { kind: "first-sync-from-local", remote };
  }
  if (resume === "from-remote") {
    if (remote.kind === "bare") {
      // Remote went bare while we were resuming. Best we can do is start
      // over by writing an empty manifest there.
      return { kind: "bootstrap-empty" };
    }
    return { kind: "first-sync-from-remote", remote };
  }

  if (remote.kind === "bare") {
    if (local.kind === "empty") return { kind: "bootstrap-empty" };
    return { kind: "first-sync-from-local", remote };
  }

  if (remote.kind === "has-manifest") {
    if (local.kind === "empty") {
      return { kind: "first-sync-from-remote", remote };
    }
    if (local.kind === "has-manifest") {
      return { kind: "regular-sync" };
    }
    // local has content but no manifest — needs adoption analysis
    return { kind: "needs-adoption-analysis", remote };
  }

  // remote has files but no manifest
  if (local.kind === "empty") {
    return { kind: "first-sync-from-remote", remote };
  }
  return { kind: "needs-adoption-analysis", remote };
}

/**
 * Compare local vault state to remote tree at the file level. Hashes
 * every syncable local file and intersects with the remote tree's SHAs.
 * Used only when decideInitAction returns "needs-adoption-analysis" — so
 * the cost (one read + SHA per local file) is paid only in the rare
 * first-sync-without-manifest case, never on regular syncs.
 */
export async function compareForAdoption(
  vault: Vault,
  configDir: string,
  syncConfigDir: boolean,
  remoteFiles: { [key: string]: GetTreeResponseItem },
  gitignoreMatcher?: { isIgnored(path: string): boolean },
): Promise<AdoptionAnalysis> {
  const manifestPath = `${configDir}/${MANIFEST_FILE_NAME}`;

  // Walk local vault and pick syncable files.
  const allLocalFiles: string[] = [];
  const folders: string[] = [vault.getRoot().path];
  while (folders.length > 0) {
    const folder = folders.pop();
    if (folder === undefined) continue;
    const res = await vault.adapter.list(folder);
    allLocalFiles.push(...res.files);
    folders.push(...res.folders);
  }
  const localSyncableFiles = allLocalFiles.filter(
    (p) =>
      p !== manifestPath &&
      isSyncable(p, configDir, syncConfigDir, gitignoreMatcher),
  );

  // Hash each local file in parallel. (Vault adapter cache makes the second
  // pass fast; we already paid disk I/O during the walk.)
  const localFileSHAs: { [path: string]: string } = {};
  await Promise.all(
    localSyncableFiles.map(async (path) => {
      const buffer = await vault.adapter.readBinary(normalizePath(path));
      localFileSHAs[path] = await calculateGitBlobSHA(buffer);
    }),
  );

  // Build remote syncable map (path → sha), excluding manifest.
  // Pass the gitignore matcher so a remote file that the user has
  // chosen to ignore (e.g. *.log) doesn't get categorized for adoption
  // — adoption would otherwise either re-download it or treat it as a
  // remote-only "needs adoption" path.
  const remoteSHAs: { [path: string]: string } = {};
  for (const [path, item] of Object.entries(remoteFiles)) {
    if (path === manifestPath) continue;
    if (!isSyncable(path, configDir, syncConfigDir, gitignoreMatcher)) continue;
    remoteSHAs[path] = item.sha;
  }

  // Categorize.
  const identical: string[] = [];
  const localOnly: string[] = [];
  const remoteOnly: string[] = [];
  const conflicting: string[] = [];
  const allPaths = new Set<string>([
    ...Object.keys(localFileSHAs),
    ...Object.keys(remoteSHAs),
  ]);
  for (const path of allPaths) {
    const lSHA = localFileSHAs[path];
    const rSHA = remoteSHAs[path];
    if (lSHA && rSHA) {
      (lSHA === rSHA ? identical : conflicting).push(path);
    } else if (lSHA) {
      localOnly.push(path);
    } else {
      remoteOnly.push(path);
    }
  }

  return {
    localFileSHAs,
    identical,
    localOnly,
    remoteOnly,
    conflicting,
  };
}
