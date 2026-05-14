import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  readRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// J3 — wrong repo (typo in settings). GitHub answers every API call
// with 404. 404 is NOT retriable (isRetriableStatus). Sync2 fails
// fast, surfaces a notice, the batch persists. Fixing the repo name
// makes the next sync drain the same batch onto the correct repo.

describe.skipIf(!integrationEnabled())(
  "sync2 J3 — wrong repo (404)",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-j3-wrong-repo");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "typo'd repo → sync errors; correcting the typo recovers",
      async () => {
        client = await createSync2Client({ branch });
        const goodRepo = client.settings.githubRepo;
        await client.vault.adapter.write("a.md", "a\n");

        // Type a repo name that doesn't exist for our owner. The
        // PAT is fine, but GET /repos/{owner}/{bogus}/* answers 404.
        client.settings.githubRepo = `does-not-exist-${Date.now()}`;

        let thrown: unknown = null;
        await client.manager.syncAll().catch((e) => {
          thrown = e;
        });
        expect(thrown).not.toBeNull();
        // Match the body shape of GithubAPIError or any 404-ish
        // surfacing — sync2 surfaces a few different shapes here.
        expect(String(thrown)).toMatch(/404|not found|Failed/i);

        // Restore — same batch drains onto the real repo.
        client.settings.githubRepo = goodRepo;
        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, "a.md")).toBe("a\n");
      },
      300_000,
    );
  },
);
