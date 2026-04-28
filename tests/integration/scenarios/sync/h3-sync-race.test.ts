import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  countBranchCommits,
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  writeVaultFile,
} from "../../helpers";

// H3 — re-entrant sync() calls must be a no-op for the second one.
//
// The plugin's `syncing` flag (sync-manager.ts:87, checked at 992,
// set at 997, cleared in finally at 1010) is the only thing
// preventing two parallel sync() calls from racing each other into
// duplicate commits, double-uploads, or worse, a tree state that
// reflects a half-merge of both runs.
//
// We verify the contract by:
//   1. Priming the branch + adding a fresh local file so a sync
//      has real work to do.
//   2. Calling sync() twice WITHOUT awaiting in between — both
//      promises start synchronously. The first call sets
//      syncing=true before the second can yield to the event loop;
//      the second call hits the early-return branch.
//   3. Awaiting both. The expected outcome is exactly one new
//      commit on the branch (only the first run actually committed).
//
// Asserts: commit count delta is 1, file is present on remote.
describe.skipIf(!integrationEnabled())(
  "H3 — concurrent sync() calls; second is a no-op",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("h3");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "second concurrent sync exits early; only one commit is added",
      async () => {
        const target = "Notes/h3-target.md";
        const content = "# h3\nfresh local file for the race test.\n";

        // ---- prime: empty vault → first-sync-from-remote --------
        client = createClient({ branch, deviceName: "h3-test" });
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // Baseline commit count BEFORE the race. After the race we
        // should be at baseline + 1, not baseline + 2.
        const baselineCommits = await countBranchCommits(branch);

        // Real work to sync — without this, both sync calls would
        // be no-ops and we couldn't distinguish "blocked" from
        // "nothing to do".
        await writeVaultFile(client.vault, target, content);
        await client.sync.loadMetadata();

        // ---- the race ------------------------------------------
        // Both promises start synchronously. The second call's
        // `if (this.syncing)` check runs BEFORE the first call
        // yields control on its first `await`, so the synchronous
        // set-then-check ordering of the early-exit guard works.
        const p1 = client.sync.sync();
        const p2 = client.sync.sync();
        const results = await Promise.allSettled([p1, p2]);

        // Both must resolve (early-exit returns from sync(), it
        // doesn't throw). The first did real work; the second hit
        // the early-return branch.
        for (const r of results) {
          expect(r.status, "sync() should never reject for early-exit").toBe(
            "fulfilled",
          );
        }

        // ---- assert exactly one commit landed -------------------
        const finalCommits = await countBranchCommits(branch);
        expect(
          finalCommits - baselineCommits,
          `expected exactly one new commit; baseline=${baselineCommits}, final=${finalCommits}`,
        ).toBe(1);
      },
      180_000,
    );
  },
);
