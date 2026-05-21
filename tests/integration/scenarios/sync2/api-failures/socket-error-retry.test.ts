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
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// Socket-level connection error mid-sync — undici-style transient
// failure that bypasses HTTP-status retry but is recovered by the
// new throw-side branch of retryUntil (src/utils.ts).
//
// Scenario: first `createTree` request gets terminated at the TCP
// layer (server closed before any response). retryUntil catches the
// throw, classifies via isRetriableError (cause.code === "UND_ERR_-
// SOCKET"), waits + retries. Second attempt goes to real GitHub
// and succeeds. The whole sync finishes without an error notice.

describe.skipIf(!integrationEnabled())(
  "sync2 — socket-level connection error mid-push is retried",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-socket-retry");
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
      "first POST /git/trees throws UND_ERR_SOCKET → retryUntil retries → sync completes",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("note.md", "v1\n");

        let throwsRemaining = 1;
        installRequestFaultInjector({
          intercept(url, method) {
            if (
              throwsRemaining > 0 &&
              method === "POST" &&
              /\/git\/trees$/.test(url)
            ) {
              throwsRemaining -= 1;
              // Shape matches what undici raises for "server closed
              // the connection before responding". retryUntil's
              // isRetriableError walks the cause chain and matches
              // UND_ERR_SOCKET on the inner SocketError.
              const innerSocketError = Object.assign(
                new Error("other side closed"),
                { code: "UND_ERR_SOCKET" },
              );
              return Object.assign(new TypeError("fetch failed"), {
                cause: innerSocketError,
              });
            }
            return null;
          },
        });

        await sync2AllAndAssertNoErrors(client);

        // Throws were exhausted (only 1 was scheduled, so 0 remain).
        // Sync succeeded after the retry — assertion is implicit in
        // sync2AllAndAssertNoErrors not throwing.
        expect(throwsRemaining).toBe(0);
      },
      120_000,
    );
  },
);
