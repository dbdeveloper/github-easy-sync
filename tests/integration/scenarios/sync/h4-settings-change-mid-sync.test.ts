import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getBranchHead,
  getDefaultBranchHead,
  integrationEnabled,
  requireEnv,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  writeVaultFile,
} from "../../helpers";

/**
 * Read a commit's message via the Git Data API. Inline because no
 * other test needs it; promote to helpers.ts if a second caller
 * appears.
 */
async function fetchCommitMessage(sha: string): Promise<string> {
  const { token, owner, repo } = requireEnv();
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/commits/${sha}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) throw new Error(`fetchCommitMessage → ${res.status}`);
  const json = (await res.json()) as { message: string };
  return json.message;
}

// H4 — settings mutated mid-sync; the next sync still works and
// reflects the new setting.
//
// What we DON'T test (intentionally):
//   * Mutating `githubToken` mid-sync. Real-world disaster scenario,
//     but a flaky test — in-flight requests carry the stale auth
//     header and may fail mid-batch with surprising error shapes.
//     If we want token-rotation coverage we should design a
//     deterministic auth-error test on its own (J-series).
//   * Mutating `githubBranch` or `githubRepo` mid-sync. The first
//     sync would partially talk to one repo, the second to another;
//     the resulting state is by design ill-defined.
//
// What we DO test: `deviceName`. It only flows into commit
// messages (sync-manager.ts:1982) and into log lines, never into
// network calls — so changing it during a sync can't break the
// in-flight requests, but the CHANGE must be picked up on the next
// sync. That's the user's expectation: "I renamed my device, my
// next sync should show the new name in the GitHub history."
//
// Sequence:
//   1. Prime: client syncs empty vault, then writes + syncs a file
//      under the original deviceName.
//   2. Start a new sync for a fresh local edit, but DON'T await.
//      Mutate `client.settings.deviceName` immediately. Because
//      JS is single-threaded the mutation lands while the sync's
//      in flight (somewhere between gitignoreCache.refreshIfChanged
//      and updateBranchHead). Await sync.
//   3. Make another local edit. Sync.
//   4. Inspect the latest branch commit's message — it should
//      contain the new deviceName. (Earlier commits' messages may
//      contain either name; that's an implementation detail of
//      timing we don't pin down.)
describe.skipIf(!integrationEnabled())(
  "H4 — mutating deviceName mid-sync doesn't break next sync",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("h4");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "deviceName change between syncs flows into the next commit message",
      async () => {
        const originalName = "h4-old-laptop";
        const renamedName = "h4-new-laptop";

        client = createClient({ branch, deviceName: originalName });
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // Sync something so the original deviceName lands in a
        // commit message.
        await writeVaultFile(client.vault, "Notes/h4-a.md", "first.\n");
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // ---- mid-sync mutation ---------------------------------
        // Kick off another sync, then mutate deviceName before
        // awaiting. The sync's already past the `if (this.syncing)`
        // gate at this point, but its commit message read happens
        // inside the same microtask sequence — the mutation may
        // race the read or not. We don't pin that down because the
        // test asserts on the NEXT sync (which definitely runs
        // after the mutation) so the contract is robust either way.
        await writeVaultFile(client.vault, "Notes/h4-b.md", "during rename.\n");
        await client.sync.loadMetadata();
        const inFlight = client.sync.sync();
        client.settings.deviceName = renamedName;
        await inFlight;

        // ---- next sync after the mutation ----------------------
        await writeVaultFile(client.vault, "Notes/h4-c.md", "after rename.\n");
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // ---- inspect latest commit message ---------------------
        // commitSync builds the message as `Sync from ${deviceName}
        // ${ISOTimestamp}` (sync-manager.ts:1982), so the renamed
        // identifier must literally appear in the latest commit.
        const head = await getBranchHead(branch);
        expect(head, "branch should have a commit").not.toBeNull();
        const message = await fetchCommitMessage(head as string);
        expect(
          message,
          `expected the latest commit to be authored by ${renamedName}; got: ${message}`,
        ).toContain(renamedName);
      },
      240_000,
    );
  },
);
