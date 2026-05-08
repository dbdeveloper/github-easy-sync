import { describe, it, beforeEach, afterEach, expect } from "vitest";
import {
  bootstrapEnabled,
  countBranchCommits,
  createClient,
  getBranchHead,
  listRemoteFiles,
  readRemoteFile,
  recreateRepo,
  requireBootstrapEnv,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
} from "../../helpers";

// Skip the whole file when the bootstrap env isn't set up. Bootstrap
// tests need a classic PAT with public_repo + delete_repo scope on a
// dedicated public ephemeral repo — separate from the fine-grained
// PAT + private repo used by every other integration test.
describe.skipIf(!bootstrapEnabled())(
  "A1 — bootstrap on a bare repo",
  () => {
    let client: TestClient;
    let branch: string;

    beforeEach(async () => {
      // Bootstrap requires a truly bare repo (no commits, no default
      // branch). GitHub auto-promotes the first branch to default and
      // refuses to let it be deleted, so the only way back to bare is
      // delete + recreate the whole repo. recreateRepo() does that
      // against the public ephemeral test repo.
      await recreateRepo(requireBootstrapEnv());
      // Recreate is slow on GitHub's side; give the new repo a moment
      // to settle before subsequent calls.
      await new Promise((r) => setTimeout(r, 1500));
      branch = uniqueBranchName("a1");
    });

    afterEach(async () => {
      client?.cleanup();
      // Repo state doesn't need per-test cleanup: the next beforeEach
      // wipes it. afterEach just frees the local tempdir.
    });

    it(
      "creates a single 'Initial commit' with .gitignore + manifest on a fresh branch",
      async () => {
        const env = requireBootstrapEnv();
        client = createClient({ branch, deviceName: "a1-test", env });

        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        const head = await getBranchHead(branch, env);
        expect(head, `branch ${branch} should exist after sync`).not.toBeNull();

        const commitCount = await countBranchCommits(branch, env);
        expect(commitCount).toBe(1);

        const remoteFiles = await listRemoteFiles(branch, env);
        expect(remoteFiles).toContain(".gitignore");
        expect(remoteFiles).toContain(
          ".obsidian/github-easy-sync-metadata.json",
        );

        const manifestText = await readRemoteFile(
          branch,
          ".obsidian/github-easy-sync-metadata.json",
          env,
        );
        const manifest = JSON.parse(manifestText);
        expect(manifest.lastSync).toBeGreaterThan(0);
        expect(manifest.firstSyncFromLocalInProgress).toBeUndefined();
        expect(manifest.firstSyncFromRemoteInProgress).toBeUndefined();
        expect(manifest.pluginCreatedGitignores).toBeUndefined();
        expect(manifest.preExistingGitignoreShas).toBeUndefined();
      },
      // Bootstrap test includes recreateRepo (GitHub's repo deletion
      // can take 30-90 s), so override the default 120 s file timeout.
      180_000,
    );
  },
);
