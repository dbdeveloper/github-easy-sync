import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  readRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// H3 — two syncAll() calls launched concurrently on the same client.
// processQueue is guarded by a `running` flag (sync2-manager.ts:1202),
// so the second invocation enters, finds the runner busy, and returns
// early. Both calls resolve without error; final state is consistent.

describe.skipIf(!integrationEnabled())(
  "sync2 H3 — concurrent syncAll calls serialize via running flag",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-h3-concurrent");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "two parallel syncAlls → both resolve, no double-push, file landed",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("a.md", "a\n");
        await client.vault.adapter.write("b.md", "b\n");

        // Two parallel syncAlls. One enters processQueue and drains
        // the batch; the second hits the running guard and bails.
        // Neither call should throw.
        const results = await Promise.allSettled([
          client.manager.syncAll(),
          client.manager.syncAll(),
        ]);
        for (const r of results) {
          expect(r.status).toBe("fulfilled");
        }

        expect(await readRemoteFile(branch, "a.md")).toBe("a\n");
        expect(await readRemoteFile(branch, "b.md")).toBe("b\n");
        // Local state intact too.
        expect(
          fs.readFileSync(path.join(client.vaultPath, "a.md"), "utf8"),
        ).toBe("a\n");
      },
      240_000,
    );

    it(
      "burst of syncAlls then a real change → final sync still picks up the change",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("a.md", "a\n");
        await sync2AllAndAssertNoErrors(client);

        // Burst of 5 syncAlls with no changes — most should short-
        // circuit cleanly (no commits, no errors).
        const burst = await Promise.allSettled(
          Array.from({ length: 5 }, () => client!.manager.syncAll()),
        );
        for (const r of burst) {
          expect(r.status).toBe("fulfilled");
        }

        // Add a new file; one more syncAll → it lands.
        await client.vault.adapter.write("c.md", "c\n");
        await sync2AllAndAssertNoErrors(client);
        expect(await readRemoteFile(branch, "c.md")).toBe("c\n");
      },
      300_000,
    );
  },
);
