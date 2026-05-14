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
  installRequestFaultInjector,
  integrationEnabled,
  readRemoteFile,
  respondForFirstN,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// J2 — 429 rate-limit retry. retryUntil's exponential backoff
// considers 429 retriable for both reads and writes. We feed two
// 429s into the FIRST blob upload, then let everything else go to
// the real GitHub. Sync still completes successfully — the retry
// loop just paid a little wall-clock for the backoff.

describe.skipIf(!integrationEnabled())(
  "sync2 J2 — 429 rate-limit retry",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-j2-429");
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
      "two 429s on createTree → backoff + retry → push lands cleanly",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("a.md", "a\n");

        // First TWO POST /git/trees calls get a synthesized 429. The
        // third (= retryUntil attempt #3) passes through to real
        // GitHub. retryUntil's max-retries default is 5, plenty of
        // headroom.
        installRequestFaultInjector(
          respondForFirstN(
            (url, method) =>
              method === "POST" && /\/git\/trees\b/.test(url),
            2,
            {
              status: 429,
              headers: { "Retry-After": "1" },
              body: '{"message":"You have exceeded a secondary rate limit."}',
            },
          ),
        );

        await sync2AllAndAssertNoErrors(client);
        expect(await readRemoteFile(branch, "a.md")).toBe("a\n");
      },
      300_000,
    );
  },
);
