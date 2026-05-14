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
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// H4 — out-of-band rename. Web UI doesn't have an atomic rename;
// a user clicks "delete" on one file then "create" on another with
// the same content. From sync2's pull side this looks like: tracked
// file A is gone, untracked file B appeared. Next sync must apply
// both: remove A locally, pull B locally. The local copy of A was
// not modified, so no conflict path runs.

describe.skipIf(!integrationEnabled())(
  "sync2 H4 — out-of-band delete + create (web-UI rename)",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-h4-oob-rename");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "remote deletes old.md and creates new.md → local mirrors after next sync",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("old.md", "shared body\n");
        await sync2AllAndAssertNoErrors(client);

        // Out-of-band: delete old.md, then create new.md with the
        // same content. Simulates a user renaming on github.com.
        await removeRemoteFile(branch, "old.md", "[web] delete old.md");
        await writeRemoteFile(
          branch,
          "new.md",
          "shared body\n",
          "[web] create new.md",
        );

        await sync2AllAndAssertNoErrors(client);

        // Local: old.md gone, new.md appeared with the same body.
        expect(fs.existsSync(path.join(client.vaultPath, "old.md"))).toBe(
          false,
        );
        expect(
          fs.readFileSync(path.join(client.vaultPath, "new.md"), "utf8"),
        ).toBe("shared body\n");

        // Remote consistent.
        const remoteFiles = await listRemoteFiles(branch);
        expect(remoteFiles).not.toContain("old.md");
        expect(remoteFiles).toContain("new.md");
      },
      240_000,
    );
  },
);
