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
  failOnNthMatch,
  getDefaultBranchHead,
  installRequestFaultInjector,
  integrationEnabled,
  readRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// J4 — network drop mid-sync. A thrown Error from inside requestUrl
// simulates connectivity loss. The batch on disk (the push-queue
// snapshot) is the source of truth — when the network comes back,
// the next sync drains it.

describe.skipIf(!integrationEnabled())(
  "sync2 J4 — network drop",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-j4-netdrop");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      installRequestFaultInjector(null);
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "throw on first GitHub call → batch persists; clear fault → next sync recovers",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("a.md", "a\n");

        // Throw on the very first GitHub call regardless of method.
        installRequestFaultInjector(
          failOnNthMatch(
            (url) => url.startsWith("https://api.github.com/"),
            1,
            "Simulated network drop",
          ),
        );

        // First sync fails. Don't assert on notice contents — what
        // we care about is the persistence of the batch.
        await client.manager.syncAll().catch(() => {});

        // Clear fault, retry → the same a.md still on disk, drains.
        installRequestFaultInjector(null);
        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, "a.md")).toBe("a\n");
      },
      300_000,
    );
  },
);
