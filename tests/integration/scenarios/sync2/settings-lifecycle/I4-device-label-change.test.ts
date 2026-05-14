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
  getBranchCommitMessages,
  getDefaultBranchHead,
  integrationEnabled,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// I4 — deviceLabel changed between syncs.
//
// The deviceLabel is appended as a trailing " (label)" suffix to
// every commit message. After we changed deviceLabel in settings,
// the very next syncAll must reflect the new label — no plugin
// reload needed, because the manager reads deviceLabel through a
// live getter.

describe.skipIf(!integrationEnabled())(
  "sync2 I4 — deviceLabel change between syncs",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-i4-devlabel");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "two syncs with different deviceLabel → suffixes match the live setting",
      async () => {
        client = await createSync2Client({ branch });
        client.settings.deviceLabel = "LaptopA";

        await client.vault.adapter.write("a.md", "a\n");
        await sync2AllAndAssertNoErrors(client);

        // Mutate live setting, then a second push.
        client.settings.deviceLabel = "PhoneB";
        await client.vault.adapter.write("b.md", "b\n");
        await sync2AllAndAssertNoErrors(client);

        const messages = await getBranchCommitMessages(branch);
        // Order: newest first. Both messages must carry the suffix
        // that was *current at the time of the push*, not the value
        // that was current when the manager was constructed.
        expect(messages[0]).toMatch(/\(PhoneB\)$/);
        expect(messages[1]).toMatch(/\(LaptopA\)$/);
      },
      240_000,
    );
  },
);
