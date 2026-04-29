import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  listRemoteFiles,
  syncAndCollectErrors,
  TestClient,
  uniqueBranchName,
  writeVaultFile,
} from "../../helpers";

// J4 — typo'd branch in settings on a non-bare repo: error notice,
// branch NOT auto-created, default branch untouched.
//
// Trace through what actually happens (this test pins the current
// behavior; if it changes, the test loudly tells you to confirm
// the new contract is what you wanted):
//
//   * analyzeRemoteState calls getRepoContent. GitHub returns 404
//     for /git/trees/<missing-branch>?recursive=1. client.ts:104-114
//     interprets 404/409 as "bare repo signal" → throws an internal
//     error → analyzeRemoteState maps that to RemoteState.kind=empty.
//   * decideInitAction sees localState=has-data + remoteState=empty
//     → routes to first-sync-from-local. That seems wrong on its
//     face (the repo is NOT empty — only that branch is missing),
//     but the plugin can't tell those cases apart from a tree
//     query alone.
//   * firstSyncFromLocal's first network call is createFile (the
//     Contents API PUT /contents/{path}). On a non-bare repo with
//     the typo'd branch, GitHub returns 404: "Branch <name> not
//     found". client.ts:479-485 raises GithubAPIError → SyncManager
//     catches → emits "Error syncing" Notice.
//
// Net effect for the user: they typo a branch name → see an error
// notice → no branch is created on remote → no commits get
// silently pushed to a wrong branch. That's the safer side of the
// trade-off (better than auto-creating a typo'd branch with the
// user's notes), so we lock it in here.
//
// If a future PR adds an explicit "branch missing — create it?"
// prompt or flips routing to error-out before createFile fires,
// this test is the one that breaks first; update it deliberately.
describe.skipIf(!integrationEnabled())(
  "J4 — typo'd branch on a non-bare repo: error notice, no auto-create",
  () => {
    let client: TestClient | undefined;
    let typoBranch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(() => {
      typoBranch = uniqueBranchName("j4-typo");
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(typoBranch);
    });

    it(
      "missing branch surfaces a 'Failed to' notice; nothing lands on the repo",
      async () => {
        // Sanity: nothing pre-creates the typo'd branch. The cleanup
        // helper in afterEach is the only mention of it in this
        // test, and uniqueBranchName guarantees no collision with a
        // leftover from a prior run.

        client = createClient({ branch: typoBranch, deviceName: "j4-test" });
        await writeVaultFile(
          client.vault,
          "Notes/j4-x.md",
          "# typo branch\nshould not land.\n",
        );

        await client.sync.loadMetadata();
        const errors = await syncAndCollectErrors(client);
        expect(
          errors.length,
          `expected an error notice on the typo'd branch; got: ${errors.join(" | ")}`,
        ).toBeGreaterThan(0);
        // Status / "Failed" hint so users can grep their log.
        const hint = errors.join("\n");
        expect(
          /404|Failed/i.test(hint),
          `expected the notice to mention 404 / 'Failed'; got: ${hint}`,
        ).toBe(true);

        // Typo'd branch was not auto-created — listRemoteFiles
        // returns [] for missing branches (helpers.ts:410).
        const remote = await listRemoteFiles(typoBranch);
        expect(
          remote,
          `expected typo branch to remain absent. Got tree: ${JSON.stringify(remote)}`,
        ).toEqual([]);

        // Default branch must be intact — sync should never have
        // touched it. Just probe that it still resolves; we don't
        // assert SHA equality because other parallel tests might
        // be advancing the int-test repo's main.
        const defaultHead = await getDefaultBranchHead();
        expect(defaultHead, "default branch head must still resolve").not.toBeNull();
      },
      180_000,
    );
  },
);
