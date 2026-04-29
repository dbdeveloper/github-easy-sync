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

// I4 — `deviceName` setting changes flow into commit messages.
//
// commitSync builds the message as `Sync from ${deviceName} ${ISO}`
// (sync-manager.ts:1982). Each sync re-reads `this.settings.
// deviceName`, so a rename takes effect on the very next commit
// without a plugin restart. This is the only "personalization"
// signal the user has in the GitHub history; if it lagged behind
// the setting, multi-device users couldn't tell which laptop made
// what change.
//
// H4 covered the mid-sync mutation case (settings change while a
// sync is in flight). I4 is the simpler workflow lifecycle: rename
// across multiple completed syncs and confirm each commit message
// reflects the deviceName at the time of that sync.
//
// Sequence:
//   1. Sync once with deviceName=A. Commit message contains "A".
//   2. Rename to B. Sync. Commit message contains "B".
//   3. Rename to C. Sync. Commit message contains "C".
//   4. Re-read message of every commit on the chain; each should
//      carry the name in effect when it landed.
describe.skipIf(!integrationEnabled())(
  "I4 — deviceName changes propagate into commit messages",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("i4");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "renaming across syncs records each name on its corresponding commit",
      async () => {
        client = createClient({ branch, deviceName: "i4-laptop-A" });
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // ---- sync 1: name A ------------------------------------
        await writeVaultFile(client.vault, "Notes/i4-1.md", "first under A.\n");
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);
        const commit1 = await getBranchHead(branch);

        // ---- rename + sync 2: name B ---------------------------
        client.settings.deviceName = "i4-laptop-B";
        await writeVaultFile(client.vault, "Notes/i4-2.md", "second under B.\n");
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);
        const commit2 = await getBranchHead(branch);

        // ---- rename + sync 3: name C ---------------------------
        client.settings.deviceName = "i4-laptop-C";
        await writeVaultFile(client.vault, "Notes/i4-3.md", "third under C.\n");
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);
        const commit3 = await getBranchHead(branch);

        // ---- pull each commit's message + assert ---------------
        expect(commit1, "branch head missing after sync 1").not.toBeNull();
        expect(commit2, "branch head missing after sync 2").not.toBeNull();
        expect(commit3, "branch head missing after sync 3").not.toBeNull();
        expect(commit2, "sync 2 should have advanced HEAD").not.toBe(commit1);
        expect(commit3, "sync 3 should have advanced HEAD").not.toBe(commit2);

        const msg1 = await fetchCommitMessage(commit1 as string);
        const msg2 = await fetchCommitMessage(commit2 as string);
        const msg3 = await fetchCommitMessage(commit3 as string);
        expect(msg1).toContain("i4-laptop-A");
        expect(msg2).toContain("i4-laptop-B");
        expect(msg3).toContain("i4-laptop-C");
        // And no cross-talk: commit 1 must not mention the later names.
        expect(msg1).not.toContain("i4-laptop-B");
        expect(msg1).not.toContain("i4-laptop-C");
      },
      240_000,
    );
  },
);

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
