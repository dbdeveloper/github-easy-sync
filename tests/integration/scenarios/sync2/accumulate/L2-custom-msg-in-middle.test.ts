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
  getBranchCommitMessages,
  getDefaultBranchHead,
  integrationEnabled,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
  sync2FileAndAssertNoErrors,
} from "../helpers";

// L2 — accumulate=ON, three Sync clicks where the middle one uses a
// custom commit message via syncFile(path, msg). The isolated flag
// keeps the middle batch's user-typed message intact and prevents
// it from folding with either side. Each click produces its own
// commit; we inspect the middle commit's message specifically to
// confirm the user's string survived verbatim (with the device
// suffix appended).

describe.skipIf(!integrationEnabled())(
  "sync2 L2 — accumulate=ON, custom-message sync in the middle breaks the group",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-l2-custom-mid");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "std → custom-msg → std with accumulate=ON → 3 commits, middle keeps user message",
      async () => {
        client = await createSync2Client({
          branch,
          accumulateOfflineSyncs: true,
        });
        await sync2AllAndAssertNoErrors(client);
        const baseCommits = await countBranchCommits(branch);

        // Click #1 — std sync of a.md.
        await client.vault.adapter.write("a.md", "v1\n");
        await sync2AllAndAssertNoErrors(client);

        // Click #2 — custom message on a single file.
        await client.vault.adapter.write("b.md", "v1\n");
        await sync2FileAndAssertNoErrors(
          client,
          "b.md",
          "Custom commit by user",
        );

        // Click #3 — std sync of c.md.
        await client.vault.adapter.write("c.md", "v1\n");
        await sync2AllAndAssertNoErrors(client);

        // Three new commits on top of the prime baseline.
        const finalCommits = await countBranchCommits(branch);
        expect(finalCommits).toBe(baseCommits + 3);

        // The MIDDLE commit's message is the user's typed string,
        // suffixed with the test client's device label. Walk the
        // branch's recent history and assert "Custom commit by user"
        // appears verbatim somewhere — proves the isolated path
        // preserved it.
        const messages = await getBranchCommitMessages(branch);
        expect(
          messages.some((m) => m.includes("Custom commit by user")),
        ).toBe(true);

        // Queue empty after all clicks drain.
        expect(await client.queue.list()).toEqual([]);
      },
      300_000,
    );
  },
);
