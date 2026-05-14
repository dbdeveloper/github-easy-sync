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
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// H1 — someone modifies a tracked file directly on GitHub between
// our syncs (web UI / gh CLI / another tool). On the next syncAll,
// sync2 must pull the change down. Local copy is otherwise unchanged
// so no conflict path runs — straight pull.

describe.skipIf(!integrationEnabled())(
  "sync2 H1 — out-of-band web-UI modify between syncs",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-h1-oob-modify");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "remote file modified out-of-band → pulled cleanly on next sync",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("note.md", "v1\n");
        await sync2AllAndAssertNoErrors(client);

        // Out-of-band edit (simulating web UI / gh CLI).
        await writeRemoteFile(
          branch,
          "note.md",
          "v2 from web\n",
          "[web] edit note.md",
        );

        // Sync again, no local edits → straight pull.
        await sync2AllAndAssertNoErrors(client);

        expect(
          fs.readFileSync(path.join(client.vaultPath, "note.md"), "utf8"),
        ).toBe("v2 from web\n");
      },
      210_000,
    );
  },
);
