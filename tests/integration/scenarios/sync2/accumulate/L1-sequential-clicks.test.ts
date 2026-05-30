import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import {
  countBranchCommits,
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

// L1 — consolidateCommits=ON, three sequential successful Sync
// clicks. Each click's processQueue completes (B1 commits and is
// deleted from the queue) before the next click fires, so the next
// click finds an empty queue and enqueues a fresh batch. End state:
// three separate commits, each with its own templated message.
//
// This documents that the accumulate-as-bandwidth-saver pattern only
// fires inside a real concurrency window (a click landing while a
// previous batch is mid-push). Happy-path successive clicks each
// produce their own commit regardless of the toggle. (L2/L4 cover
// the more interesting branches.)

describe.skipIf(!integrationEnabled())(
  "sync2 L1 — accumulate=ON, sequential successful clicks: 3 commits",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-l1-accum-sequential");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "3 std-syncs with accumulate=ON → 3 separate commits on the branch",
      async () => {
        client = await createSync2Client({
          branch,
          consolidateCommits: true,
        });

        // Prime: invariants land in their own commit.
        await sync2AllAndAssertNoErrors(client);
        const commitsAfterPrime = await countBranchCommits(branch);

        // Click #1 — edit a.md.
        await client.vault.adapter.write("a.md", "v1\n");
        await sync2AllAndAssertNoErrors(client);
        const commitsAfterClick1 = await countBranchCommits(branch);
        expect(commitsAfterClick1).toBe(commitsAfterPrime + 1);

        // Click #2 — edit b.md.
        await client.vault.adapter.write("b.md", "v1\n");
        await sync2AllAndAssertNoErrors(client);
        const commitsAfterClick2 = await countBranchCommits(branch);
        expect(commitsAfterClick2).toBe(commitsAfterClick1 + 1);

        // Click #3 — edit c.md.
        await client.vault.adapter.write("c.md", "v1\n");
        await sync2AllAndAssertNoErrors(client);
        const commitsAfterClick3 = await countBranchCommits(branch);
        expect(commitsAfterClick3).toBe(commitsAfterClick2 + 1);

        // Each file got its own commit; final remote state has all
        // three with correct content.
        expect(await readRemoteFile(branch, "a.md")).toBe("v1\n");
        expect(await readRemoteFile(branch, "b.md")).toBe("v1\n");
        expect(await readRemoteFile(branch, "c.md")).toBe("v1\n");

        // Queue is empty after the last click drained.
        expect(await client.queue.list()).toEqual([]);
      },
      300_000,
    );
  },
);
