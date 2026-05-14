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
  readRemoteFile,
  removeRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// D5 — mirror of D4: local modify + remote delete on DIFFERENT
// files. No path overlap → no conflict. After sync: the remotely-
// deleted file disappears locally; the locally-modified file lands
// on remote with the new content.

describe.skipIf(!integrationEnabled())(
  "sync2 D5 — local modify + remote delete (different files, no conflict)",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-d5-mod-vs-del-diff");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "modify x locally + delete y remotely → x has new content on remote, y gone locally",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("x.md", "x v1\n");
        await client.vault.adapter.write("y.md", "y v1\n");
        await sync2AllAndAssertNoErrors(client);

        await client.vault.adapter.write("x.md", "x v2 local\n");
        await removeRemoteFile(branch, "y.md", "[other] delete y.md");

        await sync2AllAndAssertNoErrors(client);

        // x.md has new content on remote.
        expect(await readRemoteFile(branch, "x.md")).toBe("x v2 local\n");
        // y.md gone locally (and stays gone on remote).
        expect(fs.existsSync(path.join(client.vaultPath, "y.md"))).toBe(false);
        const remoteFiles = await listRemoteFiles(branch);
        expect(remoteFiles).not.toContain("y.md");
        expect(remoteFiles).toContain("x.md");
      },
      240_000,
    );
  },
);
