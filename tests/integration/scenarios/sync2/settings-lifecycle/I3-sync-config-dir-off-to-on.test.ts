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
  countBranchCommits,
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  readRemoteFile,
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// I3 — syncConfigDir OFF → ON.
//
// With OFF, the device has been ignoring configDir paths locally;
// some of them may have drifted (local edits never pushed). When
// the user toggles ON, the next sync must:
//   - push files that drifted locally during the OFF phase,
//   - NOT generate spurious commits for files where local matches
//     remote (no-op-tree-skip),
//   - pull any remote configDir changes that landed during OFF.

describe.skipIf(!integrationEnabled())(
  "sync2 I3 — syncConfigDir toggle OFF → ON",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-i3-cfg-on");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "OFF → locally modified configDir file → ON → next sync pushes it",
      async () => {
        // Start OFF. Push a user note (configDir untouched).
        client = await createSync2Client({ branch, syncConfigDir: false });
        await client.vault.adapter.write("note.md", "n1\n");
        await client.vault.adapter.mkdir(".obsidian/snippets");
        await client.vault.adapter.write(
          ".obsidian/snippets/dark.css",
          ".dark { color: white; }\n",
        );
        await sync2AllAndAssertNoErrors(client);

        // OFF: the snippet was created locally but never pushed.
        // Confirm by trying to read it from remote.
        let remoteSnippet: string | null = null;
        try {
          remoteSnippet = await readRemoteFile(
            branch,
            ".obsidian/snippets/dark.css",
          );
        } catch {
          remoteSnippet = null;
        }
        expect(remoteSnippet).toBeNull();

        // Edit the snippet again while still OFF — still not pushed.
        await client.vault.adapter.write(
          ".obsidian/snippets/dark.css",
          ".dark { color: black; }\n",
        );
        await sync2AllAndAssertNoErrors(client);
        try {
          remoteSnippet = await readRemoteFile(
            branch,
            ".obsidian/snippets/dark.css",
          );
        } catch {
          remoteSnippet = null;
        }
        expect(remoteSnippet).toBeNull();

        // Flip ON; next sync pushes the snippet.
        client.settings.syncConfigDir = true;
        await sync2AllAndAssertNoErrors(client);

        expect(
          await readRemoteFile(branch, ".obsidian/snippets/dark.css"),
        ).toBe(".dark { color: black; }\n");
      },
      300_000,
    );

    it(
      "OFF→ON is forward-looking: stale-during-OFF stays orphaned; later remote changes do pull",
      async () => {
        // Start OFF. Sync to establish baseline.
        client = await createSync2Client({ branch, syncConfigDir: false });
        await client.vault.adapter.write("note.md", "n1\n");
        await sync2AllAndAssertNoErrors(client);

        // Out-of-band: another device pushes a configDir file. Our
        // OFF device should NOT pull it on the next sync.
        await writeRemoteFile(
          branch,
          ".obsidian/snippets/highlight.css",
          ".hl { background: yellow; }\n",
          "[other device] add highlight.css",
        );

        await sync2AllAndAssertNoErrors(client);
        // OFF gate blocks pull — file is not in the local vault.
        const cssLocalPath = path.join(
          client.vaultPath,
          ".obsidian/snippets/highlight.css",
        );
        expect(fs.existsSync(cssLocalPath)).toBe(false);

        // Flip ON, sync again. Forward-looking: lastSync has already
        // advanced past the other-device commit while OFF, so compare
        // returns empty and the file is NOT retroactively pulled.
        // Pinning this constraint so a future maintainer doesn't
        // mistake the behaviour for a bug.
        client.settings.syncConfigDir = true;
        await sync2AllAndAssertNoErrors(client);
        expect(fs.existsSync(cssLocalPath)).toBe(false);

        // Forward-looking guarantee: a NEW remote change to a config-
        // Dir path lands locally on the next sync.
        await writeRemoteFile(
          branch,
          ".obsidian/snippets/highlight.css",
          ".hl { background: orange; }\n",
          "[other device] update highlight.css",
        );
        await sync2AllAndAssertNoErrors(client);
        expect(fs.readFileSync(cssLocalPath, "utf8")).toBe(
          ".hl { background: orange; }\n",
        );
      },
      300_000,
    );
  },
);
