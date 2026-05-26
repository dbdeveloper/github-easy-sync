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
  integrationEnabled,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../../sync2/helpers";

// n03 — R3.5 layer 2 (sweepOlderThan) end-to-end backstop.
//
// User deletes a gitignored file (.log). findChanges ignores it, so
// no batch carries the path in deleted-paths.txt → layer 1a never
// fires for it. The trash entry's id is set at intercept time (BEFORE
// the next drain.startedAt), so layer 2's `id < drain.startedAt`
// predicate matches at drain end → entry wiped.
//
// Variants in this test:
//   (a) Single gitignored file — sweep wipes it on the very next drain.
//   (b) Multiple gitignored files — single notify, batch wipe.

describe.skipIf(!integrationEnabled())(
  "sync2 diff2 n03 — gitignored deletes swept via layer 2",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("diff2-n03");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "gitignored file deleted → trash entry → next sync layer 2 wipes",
      async () => {
        client = await createSync2Client({ branch });

        // *.log is in the seeded gitignore (gitignore-invariants.ts).
        const logPath = "app.log";
        await client.vault.adapter.write(logPath, "log content\n");

        // Simulate user-driven UI delete.
        await client.trashStore.intercept(logPath);
        await client.vault.adapter.remove(logPath);

        const beforeSync = await client.trashStore.list();
        expect(beforeSync).toHaveLength(1);
        expect(beforeSync[0].originalPath).toBe(logPath);

        // Sync — findChanges ignores .log (gitignored), so no batch
        // carries it. processBatch never fires confirmDeleted for this
        // path. At drain end, sweepOlderThan(drain.startedAt) sees the
        // entry's id < threshold → wipes.
        await sync2AllAndAssertNoErrors(client);

        const afterSync = await client.trashStore.list();
        expect(afterSync).toEqual([]);
      },
      210_000,
    );

    it(
      "multiple gitignored deletes swept in single layer-2 pass",
      async () => {
        client = await createSync2Client({ branch });

        const paths = ["a.log", "b.log", "c.log"];
        for (const p of paths) {
          await client.vault.adapter.write(p, "log\n");
          await client.trashStore.intercept(p);
          await client.vault.adapter.remove(p);
        }

        const beforeSync = await client.trashStore.list();
        expect(beforeSync).toHaveLength(3);

        await sync2AllAndAssertNoErrors(client);

        const afterSync = await client.trashStore.list();
        expect(afterSync).toEqual([]);
      },
      210_000,
    );
  },
);
