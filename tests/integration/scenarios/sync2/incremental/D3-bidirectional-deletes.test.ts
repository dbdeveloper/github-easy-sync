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
  listRemoteFiles,
  removeRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// D3 — bidirectional deletes after a clean prime. Local deletes one
// file, another device deletes a DIFFERENT file on the remote, then
// sync: each deletion propagates to the opposite side. Third file
// stays put.

describe.skipIf(!integrationEnabled())(
  "sync2 D3 — bidirectional deletes (local delete + remote delete on different files)",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-d3-bidir-deletes");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "locally delete X + remotely delete Y + keep Z → after sync, X gone on remote, Y gone locally, Z intact",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("x.md", "x content\n");
        await client.vault.adapter.write("y.md", "y content\n");
        await client.vault.adapter.write("z.md", "z content\n");
        await sync2AllAndAssertNoErrors(client);

        // Sanity: all three on remote.
        const beforeFiles = await listRemoteFiles(branch);
        expect(beforeFiles).toContain("x.md");
        expect(beforeFiles).toContain("y.md");
        expect(beforeFiles).toContain("z.md");

        // Local delete x.md.
        await client.vault.adapter.remove("x.md");

        // Remote (another device) deletes y.md.
        await removeRemoteFile(
          branch,
          "y.md",
          "[other] delete y.md",
        );

        // Sync: x.md propagates locally→remote as a deletion;
        // y.md propagates remotely→local; z.md untouched.
        await sync2AllAndAssertNoErrors(client);

        const afterFiles = await listRemoteFiles(branch);
        expect(afterFiles).not.toContain("x.md");
        expect(afterFiles).not.toContain("y.md");
        expect(afterFiles).toContain("z.md");

        // Locally, y.md is gone but z.md remains.
        expect(
          fs.existsSync(path.join(client.vaultPath, "y.md")),
        ).toBe(false);
        expect(
          fs.existsSync(path.join(client.vaultPath, "z.md")),
        ).toBe(true);
      },
      240_000,
    );
  },
);
