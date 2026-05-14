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

// I5 — pull-side parity for syncConfigDir = false. The gate has to
// be symmetric: just like OFF skips configDir on push, it must also
// skip configDir on pull. A change pushed from another device (or
// the web UI) under <configDir>/ must NOT land in our local vault
// when our toggle is OFF.
//
// Why this matters separately from I3: I3 covers the "stale-during-
// OFF stays orphaned" semantic. This test covers the simpler push-
// from-remote-WHILE-we're-OFF case — confirms checkSyncable filters
// configDir on the pull side, not just push.

describe.skipIf(!integrationEnabled())(
  "sync2 I5 — pull side ignores configDir changes when syncConfigDir = false",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-i5-pull-off");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "remote pushes .obsidian/* → OFF device does NOT pull it locally",
      async () => {
        // Establish a baseline.
        client = await createSync2Client({ branch, syncConfigDir: false });
        await client.vault.adapter.write("note.md", "n1\n");
        await sync2AllAndAssertNoErrors(client);

        // Out-of-band: another device pushes a configDir file +
        // a root-level user file in the same commit chain.
        await writeRemoteFile(
          branch,
          ".obsidian/snippets/highlight.css",
          ".hl { background: yellow; }\n",
          "[other device] add snippet",
        );
        await writeRemoteFile(
          branch,
          "note2.md",
          "another user note\n",
          "[other device] add user note",
        );

        await sync2AllAndAssertNoErrors(client);

        // Pull side at OFF: snippet does NOT land locally.
        expect(
          fs.existsSync(
            path.join(client.vaultPath, ".obsidian/snippets/highlight.css"),
          ),
        ).toBe(false);
        // Root-level user file outside configDir DOES land — the
        // gate only filters configDir.
        expect(
          fs.readFileSync(path.join(client.vaultPath, "note2.md"), "utf8"),
        ).toBe("another user note\n");
      },
      300_000,
    );
  },
);
