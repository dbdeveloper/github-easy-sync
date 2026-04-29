import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  installRequestFaultInjector,
  integrationEnabled,
  listRemoteFiles,
  respondForFirstN,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  writeVaultFile,
} from "../../helpers";

// J2 — 429 rate-limit triggers retryUntil's exponential backoff,
// then the sync converges once the fake responses stop.
//
// Background: prior to this series the retry condition was
// `(res) => res.status !== 422` — only a 422 would loop. As part
// of the J-series refactor we widened the condition to
// `!isRetriableStatus(status)` (utils.ts:isRetriableStatus), which
// retries on 422, 429, and 5xx. This test is the regression guard
// for that change: if someone narrows the condition again, J2
// breaks loudly.
//
// We use the new fault-injector capability to return synthesized
// HTTP responses (mock-obsidian.ts:FakeResponse). Two consecutive
// fake 429s on the very first GET /git/trees/<branch>?recursive=1
// (the getRepoContent call that opens every sync), then real
// traffic. retryUntil's first-attempt + 5 retries window comfortably
// covers two retries.
//
// Sequence:
//   1. Prime branch with one note via a clean sync.
//   2. Stage a new local edit.
//   3. Inject 2 fake 429s on the next 2 calls to GET /git/trees.
//   4. Sync: getRepoContent retries through both 429s, eventually
//      gets a real 200, sync proceeds and uploads the new edit.
//   5. Assert: no error notices; new edit is on remote.
describe.skipIf(!integrationEnabled())(
  "J2 — 429 retried via retryUntil; sync recovers",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("j2");
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
      "two synthetic 429s on getRepoContent absorb cleanly via backoff",
      async () => {
        client = createClient({ branch, deviceName: "j2-test" });
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);
        await writeVaultFile(client.vault, "Notes/j2-prime.md", "prime.\n");
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // Stage the edit that should land AFTER the rate-limit
        // dance.
        const target = "Notes/j2-after-429.md";
        const content = "uploaded after backoff absorbed two 429s.\n";
        await writeVaultFile(client.vault, target, content);

        // Two fake 429s on the next two GET /git/trees calls. The
        // sync's first call is getRepoContent → matches. retryUntil
        // (utils.ts:322) starts at 1000 ms then doubles, so the
        // total wait is ~3 s — well under the test's 240 s budget.
        installRequestFaultInjector(
          respondForFirstN(
            (url, method) =>
              method === "GET" && /\/git\/trees\//.test(url),
            2,
            {
              status: 429,
              headers: { "Retry-After": "1" },
              body: JSON.stringify({
                message: "API rate limit exceeded for test",
                documentation_url:
                  "https://docs.github.com/rest/overview/resources-in-the-rest-api#secondary-rate-limits",
              }),
            },
          ),
        );

        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // Assertion: edit landed → retry loop succeeded after the
        // 2 fake 429s.
        const remote = await listRemoteFiles(branch);
        expect(
          remote,
          `expected ${target} to land after the rate-limit retry. Tree: ${JSON.stringify(remote)}`,
        ).toContain(target);
      },
      300_000,
    );
  },
);
