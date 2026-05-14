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
} from "../helpers";

// L3 — Sync2Manager.syncAll(customMessage) — the whole-vault custom-
// message entry point used by the new "Sync with GitHub (custom
// message)…" Obsidian command. The resulting batch is isolated:
// commits with the user-typed message verbatim, never folds with
// concurrent std-syncs.

describe.skipIf(!integrationEnabled())(
  "sync2 L3 — syncAll(customMessage) lands a single isolated commit",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-l3-syncall-custom");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "syncAll('Daily backup before vacation') → one commit with that message",
      async () => {
        client = await createSync2Client({ branch });
        // Prime with std flow so the next syncAll has changes to push.
        await client.vault.adapter.write("note.md", "important content\n");

        const baseCommits = await countBranchCommits(branch);

        // Whole-vault sync with a custom message.
        await client.manager.syncAll("Daily backup before vacation");

        // One commit landed.
        const finalCommits = await countBranchCommits(branch);
        expect(finalCommits).toBe(baseCommits + 1);

        // That commit's message is the user's typed string (with the
        // device suffix appended).
        const messages = await getBranchCommitMessages(branch);
        expect(messages[0]).toContain("Daily backup before vacation");

        // Queue empty after drain.
        expect(await client.queue.list()).toEqual([]);
      },
      300_000,
    );
  },
);
