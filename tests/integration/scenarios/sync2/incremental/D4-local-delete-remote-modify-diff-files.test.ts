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
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// D4 — local deletion + remote modification on DIFFERENT files. No
// path overlap → no conflict. After sync: the deleted-locally file
// disappears from remote; the remote-modified file appears locally
// with the new content.

describe.skipIf(!integrationEnabled())(
  "sync2 D4 — local delete + remote modify (different files, no conflict)",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-d4-del-vs-mod-diff");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "delete x locally + modify y remotely → x gone on remote, y new content local",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("x.md", "x v1\n");
        await client.vault.adapter.write("y.md", "y v1\n");
        await sync2AllAndAssertNoErrors(client);

        await client.vault.adapter.remove("x.md");
        await writeRemoteFile(
          branch,
          "y.md",
          "y v2 from other device\n",
          "[other] modify y.md",
        );

        await sync2AllAndAssertNoErrors(client);

        // x.md removed on remote.
        const remoteFiles = await listRemoteFiles(branch);
        expect(remoteFiles).not.toContain("x.md");
        // y.md has new content locally and remotely.
        expect(await readRemoteFile(branch, "y.md")).toBe(
          "y v2 from other device\n",
        );
        const yLocal = fs.readFileSync(
          path.join(client.vaultPath, "y.md"),
          "utf8",
        );
        expect(yLocal).toBe("y v2 from other device\n");
      },
      240_000,
    );
  },
);
