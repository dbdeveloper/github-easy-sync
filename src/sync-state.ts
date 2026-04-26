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

  if (manifestExists) {
    return { kind: "has-manifest", fileCount: syncableFiles.length };
  }

  if (syncableFiles.length === 0) {
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

/**
 * The decision table. Pure function — given snapshots, returns what to do.
 *
 * For the "both sides have content but no shared history" cases the result
 * is `needs-adoption-analysis`: the caller must run compareForAdoption
 * to learn whether the divergence is recoverable (silent adopt) or needs
 * the user to pick a side.
 *
 * `isResume` short-circuits to first-sync-from-remote: a previous download
 * attempt was interrupted, so local now looks "has-content" without a
 * manifest, but we *want* to resume — not treat it as a fresh ambiguity.
 */
export function decideInitAction(
  local: LocalState,
  remote: RemoteState,
  isResume: boolean,
): InitAction {
  if (isResume) {
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
  const remoteSHAs: { [path: string]: string } = {};
  for (const [path, item] of Object.entries(remoteFiles)) {
    if (path === manifestPath) continue;
    if (!isSyncable(path, configDir, syncConfigDir)) continue;
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
