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

// J1 — invalid GitHub token. Returns 401 on every API call. 401 is
// NOT retriable (isRetriableStatus), so sync2 fails fast, surfaces a
// notice, and the batch persists in the queue. Restore a valid token
// and the next sync drains the same batch successfully.

describe.skipIf(!integrationEnabled())(
  "sync2 J1 — invalid token (401)",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-j1-bad-token");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "invalid token → sync fails with notice; batch persists; valid token recovers",
      async () => {
        client = await createSync2Client({ branch });
        const goodToken = client.settings.githubToken;
        await client.vault.adapter.write("a.md", "a\n");

        // Swap to a real-looking-but-fake token. GitHub answers
        // every authenticated call with 401 — fail-fast path.
        client.settings.githubToken =
          "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

        let thrown: unknown = null;
        await client.manager.syncAll().catch((e) => {
          thrown = e;
        });
        // syncAll surfaced the auth error to the caller (main.ts
        // wires this to "Error syncing." notice in the plugin).
        expect(thrown).not.toBeNull();
        expect(String(thrown)).toMatch(/401|authoriz|token/i);

        // The local batch is still on disk waiting. Restore the
        // good token; the same a.md lands on remote without us
        // re-staging it.
        client.settings.githubToken = goodToken;
        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, "a.md")).toBe("a\n");
      },
      300_000,
    );
  },
);
