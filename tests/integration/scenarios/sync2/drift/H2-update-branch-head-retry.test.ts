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
  failOnNthMatch,
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

// H2 — transient failure on updateBranchHead. The previous tree +
// commit calls already succeeded, so on the underlying retry the
// SAME commit sha is reused: exactly one user-visible commit lands,
// not two, no orphans we'd need to clean up.

describe.skipIf(!integrationEnabled())(
  "sync2 H2 — updateBranchHead transient failure recovery",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    let baselineCommits = 0;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-h2-ref-fail");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
      baselineCommits = await countBranchCommits(branch);
    });

    afterEach(async () => {
      installRequestFaultInjector(null);
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "503 on first PATCH /git/refs/heads → retry succeeds, exactly one new commit",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("note.md", "first\n");

        // Fail the FIRST PATCH-to-refs call with a retriable 503. The
        // write-side retry policy treats 5xx as transient, so the
        // backoff loop re-issues with the same commit sha.
        installRequestFaultInjector(
          respondForFirstN(
            (url, method) =>
              method === "PATCH" && /\/git\/refs\/heads\//.test(url),
            1,
            { status: 503, body: '{"message":"upstream unavailable"}' },
          ),
        );

        await sync2AllAndAssertNoErrors(client);

        // Push succeeded — content visible on remote.
        expect(await readRemoteFile(branch, "note.md")).toBe("first\n");
        // Exactly one new commit relative to baseline (no double-push).
        const after = await countBranchCommits(branch);
        expect(after - baselineCommits).toBe(1);
      },
      240_000,
    );

    it(
      "non-retriable failure (e.g. throw) on PATCH → batch stays pending, next sync recovers",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("note.md", "v1\n");

        // First PATCH throws (simulates network drop AFTER commit was
        // created on GitHub side). The throw is NOT retriable inside
        // the same call — the batch will be marked attempted and the
        // user's next click handles it as a fresh push.
        installRequestFaultInjector(
          failOnNthMatch(
            (url, method) =>
              method === "PATCH" && /\/git\/refs\/heads\//.test(url),
            1,
            "Simulated network drop after createCommit",
          ),
        );

        await client.manager.syncAll().catch(() => {});

        // Confirm nothing landed on remote yet (the orphaned commit
        // is unreachable from the ref).
        const afterFail = await countBranchCommits(branch);
        expect(afterFail - baselineCommits).toBe(0);

        // Clear fault, sync again — second click recovers cleanly.
        installRequestFaultInjector(null);
        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, "note.md")).toBe("v1\n");
        const afterRecover = await countBranchCommits(branch);
        expect(afterRecover - baselineCommits).toBe(1);
      },
      240_000,
    );
  },
);
