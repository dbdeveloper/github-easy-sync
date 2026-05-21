// Originally authored by Silvano Cerza (https://silvanocerza.com).
// Modified by Claude Code under the attentive guidance of Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { requestUrl } from "obsidian";
import Logger from "src/logger";
import { GitHubSyncSettings } from "src/settings/settings";
import {
  isRetriableStatus,
  isWriteRetriableStatus,
  retryUntil,
} from "src/utils";

export type RepoContent = {
  files: { [key: string]: GetTreeResponseItem };
  sha: string;
};

/**
 * Represents a single item in a tree response from the GitHub API.
 */
export type GetTreeResponseItem = {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size: number;
  url: string;
};

export type NewTreeRequestItem = {
  path: string;
  mode: string;
  type: string;
  sha?: string | null;
  content?: string;
};

/**
 * Response received when we create a new binary blob on GitHub
 */
export type CreatedBlob = {
  sha: string;
};

/**
 * Represents a git blob response from the GitHub API.
 */
export type BlobFile = {
  sha: string;
  node_id: string;
  size: number;
  url: string;
  content: string;
  encoding: string;
};

/**
 * Custom error to make some stuff easier
 */
class GithubAPIError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export default class GithubClient {
  constructor(
    private settings: GitHubSyncSettings,
    private logger: Logger,
  ) {}

  headers() {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.settings.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  // Wraps every requestUrl with timing + size instrumentation so a single
  // sync run shows up in the log as a sequence of "HTTP …" entries with
  // wall-clock duration, status, and body sizes. retryUntil calls fn()
  // once per attempt, so each retry shows up as its own line — handy for
  // pinning down whether a slow sync is one big call or a retry storm.
  private async timed(
    opts: Parameters<typeof requestUrl>[0],
    label: string,
  ): Promise<ReturnType<typeof requestUrl> extends Promise<infer R> ? R : never> {
    const method = (opts as { method?: string }).method ?? "GET";
    const body = (opts as { body?: string | ArrayBuffer }).body;
    const reqBytes =
      typeof body === "string"
        ? body.length
        : body instanceof ArrayBuffer
        ? body.byteLength
        : 0;
    const t0 = Date.now();
    const res = await requestUrl(opts);
    const dt = Date.now() - t0;
    const respBytes = res.arrayBuffer?.byteLength ?? 0;
    void this.logger.info(
      `HTTP ${method} ${label} duration=${dt}ms status=${res.status} reqKB=${(reqBytes / 1024).toFixed(1)} respKB=${(respBytes / 1024).toFixed(1)}`,
    );
    return res;
  }

  /**
   * Gets the content of the repo.
   *
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   * @returns Array of files in the directory in the remote repo
   */
  async getRepoContent({
    retry = false,
    maxRetries = 5,
  } = {}): Promise<RepoContent> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/trees/${this.settings.githubBranch}?recursive=1`,
            headers: this.headers(),
            throw: false,
          },
          "tree?recursive=1",
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0, // Use 0 retries if retry is false
    );

    if (response.status < 200 || response.status >= 400) {
      // 404/409 specifically mean "no commits in this repo yet" — that's
      // how analyzeRemoteState detects a bare repo. It's an expected
      // signal, not an error, so log at info level to avoid noise in the
      // log file. Anything else really is unexpected and stays at error.
      if (response.status === 404 || response.status === 409) {
        await this.logger.info("Repo has no commits yet (bare)", {
          status: response.status,
        });
      } else {
        await this.logger.error("Failed to get repo content", response);
      }
      throw new GithubAPIError(
        response.status,
        `Failed to get repo content, status ${response.status}`,
      );
    }

    const files = response.json.tree
      .filter((file: GetTreeResponseItem) => file.type === "blob")
      .reduce(
        (
          acc: { [key: string]: GetTreeResponseItem },
          file: GetTreeResponseItem,
        ) => ({ ...acc, [file.path]: file }),
        {},
      );
    return { files, sha: response.json.sha };
  }

  /**
   * Creates a new tree in the GitHub repository.
   *
   * @param tree The tree object to create
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   * @returns The SHA of the created tree
   */
  async createTree({
    tree,
    retry = false,
    maxRetries = 5,
  }: {
    // base_tree is optional: omit when bootstrapping a brand-new repo
    // (no commits yet, no tree to base on).
    tree: { tree: NewTreeRequestItem[]; base_tree?: string };
    retry?: boolean;
    maxRetries?: number;
  }) {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/trees`,
            headers: this.headers(),
            method: "POST",
            body: JSON.stringify(tree),
            throw: false,
          },
          `tree (entries=${tree.tree.length})`,
        );
      },
      (res) => !isWriteRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to create tree", response);
      throw new GithubAPIError(
        response.status,
        `Failed to create tree, status ${response.status}`,
      );
    }
    return response.json.sha;
  }

  /**
   * Creates a new commit in the repository.
   *
   * @param message The commit message
   * @param treeSha The SHA of the tree
   * @param parent The SHA of the parent commit. Omit (or pass undefined)
   *   to create a root commit — needed when bootstrapping a brand-new
   *   repo that doesn't have any commits yet.
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   * @returns The SHA of the created commit
   */
  async createCommit({
    message,
    treeSha,
    parent,
    parents,
    retry = false,
    maxRetries = 5,
  }: {
    message: string;
    treeSha: string;
    // Single parent (existing call sites). Mutually exclusive with
    // `parents`; if both are passed, `parents` wins.
    parent?: string;
    // Multi-parent (pseudo-merge stage 7+: manual merge commits land
    // tree-of-main with parents=[main.head, branch.head]).
    parents?: string[];
    retry?: boolean;
    maxRetries?: number;
  }): Promise<string> {
    const parentsArr =
      parents !== undefined ? parents : parent !== undefined ? [parent] : [];
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/commits`,
            headers: this.headers(),
            method: "POST",
            body: JSON.stringify({
              message: message,
              tree: treeSha,
              parents: parentsArr,
            }),
            throw: false,
          },
          "commit",
        );
      },
      (res) => !isWriteRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to create commit", response);
      throw new GithubAPIError(
        response.status,
        `Failed to create commit, status ${response.status}`,
      );
    }
    return response.json.sha;
  }

  /**
   * Fetch a single commit's metadata (we only need its tree SHA).
   * Sync2 uses this during conflict reconciliation: after a HEAD
   * drift, we re-target the in-flight batch onto the new head, which
   * requires the head's tree SHA as `base_tree`.
   */
  async getCommit({
    sha,
    retry = false,
    maxRetries = 5,
  }: {
    sha: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<{
    tree: { sha: string };
    committer: { date: string };
    // Full commit message. Sync2 reads the trailing " (label)"
    // suffix here via parseDeviceSuffix to identify which device
    // authored a conflict's "theirs" side. Falls back to "" when
    // the API response is missing the field, which parses to the
    // UNKNOWN_DEVICE_LABEL sentinel.
    message: string;
  }> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/commits/${sha}`,
            headers: this.headers(),
            throw: false,
          },
          "commit",
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );
    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to get commit", response);
      throw new GithubAPIError(
        response.status,
        `Failed to get commit, status ${response.status}`,
      );
    }
    return {
      tree: { sha: response.json.tree.sha },
      committer: {
        date:
          response.json.committer?.date ??
          response.json.author?.date ??
          new Date(0).toISOString(),
      },
      message:
        typeof response.json.message === "string"
          ? response.json.message
          : "",
    };
  }

  /**
   * Fetch the base64-encoded blob content at a specific commit ref.
   * Sync2 uses this for both base (lastSyncCommitSha) and theirs
   * (currentHead) sides of a 3-way merge during conflict
   * reconciliation. Returns null on 404 (path absent at that commit
   * — e.g. force-pushed history).
   */
  async getContentsAtRef({
    path: filePath,
    ref,
    retry = false,
    maxRetries = 5,
  }: {
    path: string;
    ref: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<{ content: string; sha: string } | null> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/contents/${filePath}?ref=${ref}`,
            headers: this.headers(),
            throw: false,
          },
          `contents/${filePath}@${ref.slice(0, 7)}`,
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to get contents at ref", response);
      throw new GithubAPIError(
        response.status,
        `Failed to get contents at ref, status ${response.status}`,
      );
    }
    return {
      content: response.json.content,
      sha: response.json.sha,
    };
  }

  /**
   * Lists files changed between two refs. Sync2 uses this in the
   * pull pass to discover remote-driven adds/modifies/deletes that
   * landed since the last successful sync. Returns the list as-is
   * from GitHub's compare API; the caller filters by gitignore /
   * isSyncable.
   */
  async compare({
    base,
    head,
    retry = false,
    maxRetries = 5,
  }: {
    base: string;
    head: string;
    retry?: boolean;
    maxRetries?: number;
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
  }> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/compare/${base}...${head}`,
            headers: this.headers(),
            throw: false,
          },
          `compare ${base.slice(0, 7)}...${head.slice(0, 7)}`,
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );
    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to compare refs", response);
      throw new GithubAPIError(
        response.status,
        `Failed to compare ${base}...${head}, status ${response.status}`,
      );
    }
    return {
      status: response.json.status,
      files: (response.json.files ?? []).map((f: Record<string, unknown>) => ({
        filename: f.filename as string,
        status: f.status as
          | "added"
          | "modified"
          | "removed"
          | "renamed"
          | "copied"
          | "changed"
          | "unchanged",
        sha: (f.sha as string | null) ?? null,
        previous_filename: f.previous_filename as string | undefined,
      })),
    };
  }

  /**
   * Creates a new branch reference pointing at a commit. Used when
   * bootstrapping a bare repo: after we've made the root commit via
   * createCommit (no parent), we still need to publish a ref so HEAD
   * resolves and the next sync's getRepoContent finds the tree.
   */
  async createReference({
    ref,
    sha,
    retry = false,
    maxRetries = 5,
  }: {
    ref: string;
    sha: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<void> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/refs`,
            headers: this.headers(),
            method: "POST",
            body: JSON.stringify({ ref, sha }),
            throw: false,
          },
          "refs (create)",
        );
      },
      (res) => !isWriteRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to create reference", response);
      throw new GithubAPIError(
        response.status,
        `Failed to create reference, status ${response.status}`,
      );
    }
  }

  /**
   * Updates an arbitrary ref (not just the configured `githubBranch`)
   * to point at a new commit. Pseudo-merge mode uses this for conflict
   * branches (refs/heads/easy-sync-conflicts-*). Pass `ref` without
   * the "refs/" prefix — same shape GitHub's API expects after
   * "/git/refs/".
   *
   * @param ref e.g. "heads/easy-sync-conflicts-Obsidian-20260520143022-847"
   */
  async updateReference({
    ref,
    sha,
    force = false,
    retry = false,
    maxRetries = 5,
  }: {
    ref: string;
    sha: string;
    force?: boolean;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<void> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/refs/${ref}`,
            headers: this.headers(),
            method: "PATCH",
            body: JSON.stringify({ sha, force }),
            throw: false,
          },
          `ref ${ref}${force ? " (force)" : ""}`,
        );
      },
      (res) => !isWriteRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error(`Failed to update ref ${ref}`, response);
      throw new GithubAPIError(
        response.status,
        `Failed to update ref ${ref}, status ${response.status}`,
      );
    }
  }

  /**
   * Delete a ref. Used to drop a conflict branch after finalize merge
   * back to main. Returns 204 on success and 422 if the ref does not
   * exist — the latter is treated as success ("already gone").
   */
  async deleteReference({
    ref,
    retry = false,
    maxRetries = 5,
  }: {
    ref: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<void> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/refs/${ref}`,
            headers: this.headers(),
            method: "DELETE",
            throw: false,
          },
          `ref ${ref}`,
        );
      },
      (res) => !isWriteRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status === 204) return;
    if (response.status === 422) return; // already gone
    await this.logger.error(`Failed to delete ref ${ref}`, response);
    throw new GithubAPIError(
      response.status,
      `Failed to delete ref ${ref}, status ${response.status}`,
    );
  }

  /**
   * List refs whose names start with the given prefix. Pseudo-merge
   * uses this to enumerate active conflict branches during the
   * recovery sweep — e.g. `getMatchingRefs("heads/easy-sync-conflicts-")`.
   * Returns an empty array on 404 (no matches).
   */
  async getMatchingRefs({
    prefix,
    retry = false,
    maxRetries = 5,
  }: {
    prefix: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<Array<{ ref: string; sha: string }>> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/matching-refs/${prefix}`,
            headers: this.headers(),
            throw: false,
          },
          `matching-refs ${prefix}`,
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status === 404) return [];
    if (response.status < 200 || response.status >= 400) {
      await this.logger.error(
        `Failed to get matching refs for ${prefix}`,
        response,
      );
      throw new GithubAPIError(
        response.status,
        `Failed to get matching refs ${prefix}, status ${response.status}`,
      );
    }
    const arr = response.json as Array<{ ref: string; object: { sha: string } }>;
    return arr.map((r) => ({
      ref: r.ref.replace(/^refs\//, ""),
      sha: r.object.sha,
    }));
  }

  /**
   * Gets the SHA of the branch head.
   *
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   * @returns The SHA of the branch head
   */
  async getBranchHeadSha({ retry = false, maxRetries = 5 } = {}) {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/refs/heads/${this.settings.githubBranch}`,
            headers: this.headers(),
            throw: false,
          },
          "branch head",
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to get branch head sha", response);
      throw new GithubAPIError(
        response.status,
        `Failed to get branch head sha, status ${response.status}`,
      );
    }
    return response.json.object.sha;
  }

  /**
   * Updates the branch head to point to a new commit.
   *
   * @param sha The SHA of the commit to point to
   * @param force If true, allow non-fast-forward updates (e.g. pointing the
   *   ref to an unrelated root commit). Used by bootstrap to collapse the
   *   bare-repo seed commit and the real initial commit into a single
   *   visible "Initial commit" on the branch.
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   */
  async updateBranchHead({
    sha,
    force = false,
    retry = false,
    maxRetries = 5,
  }: {
    sha: string;
    force?: boolean;
    retry?: boolean;
    maxRetries?: number;
  }) {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/refs/heads/${this.settings.githubBranch}`,
            headers: this.headers(),
            method: "PATCH",
            body: JSON.stringify({
              sha: sha,
              force,
            }),
            throw: false,
          },
          `branch head${force ? " (force)" : ""}`,
        );
      },
      (res) => !isWriteRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to update branch head sha", response);
      throw new GithubAPIError(
        response.status,
        `Failed to update branch head sha, status ${response.status}`,
      );
    }
  }

  /**
   * Creates a new blob in the GitHub remote, this is mainly used to upload binary files.
   *
   * @param content The content of the blob to upload
   * @param encoding Content encoding, can be "utf-8" or "base64". Defaults to "base64"
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   * @returns The SHA of the newly uploaded blob
   */
  async createBlob({
    content,
    encoding = "base64",
    retry = false,
    maxRetries = 5,
  }: {
    content: string;
    encoding?: "utf-8" | "base64";
    retry?: boolean;
    maxRetries?: number;
  }): Promise<CreatedBlob> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/blobs`,
            headers: this.headers(),
            method: "POST",
            body: JSON.stringify({ content, encoding }),
            throw: false,
          },
          `blob (${encoding})`,
        );
      },
      (res) => !isWriteRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to create blob", response);
      throw new GithubAPIError(
        response.status,
        `Failed to create blob, status ${response.status}`,
      );
    }
    return {
      sha: response.json["sha"],
    };
  }

  /**
   * Gets a blob from its sha
   *
   * @param sha The SHA of the blob
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   * @returns The blob file
   */
  async getBlob({
    sha,
    retry = false,
    maxRetries = 5,
  }: {
    sha: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<BlobFile> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/blobs/${sha}`,
            headers: this.headers(),
            throw: false,
          },
          `blob ${sha.slice(0, 7)}`,
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to get blob", response);
      throw new GithubAPIError(
        response.status,
        `Failed to get blob, status ${response.status}`,
      );
    }
    return response.json;
  }

  /**
   * Create a new file in the repo via the Contents API, the content must be
   * base64 encoded or the request will fail.
   *
   * The Contents API is the only thing that works on a brand-new bare
   * repository (no commits yet) — Git Data API endpoints return 409
   * "Git Repository is empty" until at least one ref exists. We use
   * createFile to seed the repo with its first commit, then switch to
   * Git Data API for everything that follows.
   *
   * Returns the SHAs the API gave us in the response — using these
   * directly avoids the eventual-consistency race that biting
   * getRepoContent right after a write would have.
   *
   * @param path Path to create in the repo
   * @param content Base64 encoded content of the file
   * @param message Commit message
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   */
  async createFile({
    path,
    content,
    message,
    retry = false,
    maxRetries = 5,
  }: {
    path: string;
    content: string;
    message: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<{ blobSha: string; treeSha: string; commitSha: string }> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/contents/${path}`,
            headers: this.headers(),
            method: "PUT",
            body: JSON.stringify({
              message: message,
              content: content,
              branch: this.settings.githubBranch,
            }),
            throw: false,
          },
          `contents/${path}`,
        );
      },
      (res) => !isWriteRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to create file", response);
      throw new GithubAPIError(
        response.status,
        `Failed to create file, status ${response.status}`,
      );
    }
    return {
      blobSha: response.json.content.sha,
      treeSha: response.json.commit.tree.sha,
      commitSha: response.json.commit.sha,
    };
  }

}
