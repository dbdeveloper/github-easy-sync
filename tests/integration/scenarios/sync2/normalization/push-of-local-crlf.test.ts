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

// text canonicalisation — push-side write-back. User pastes CRLF text into a
// local file (e.g. from a Windows-authored email body), then hits
// Sync. The push pipeline canonicalises the snapshot AND writes the
// canonical form back to the live vault file, so after the sync the
// local copy is also LF — preserving the "ЛОКАЛЬНО все правильно"
// invariant even when the user's input was not.

describe.skipIf(!integrationEnabled())(
  "sync2 normalization — push of local CRLF",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-norm-push-crlf");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "local CRLF + Sync → local file becomes LF, GitHub gets LF",
      async () => {
        client = await createSync2Client({ branch });
        // Prime: align local snapshot with the empty-ish branch.
        await sync2AllAndAssertNoErrors(client);

        // User writes a CRLF-laden file directly to disk.
        const crlf = "alpha\r\nbeta\r\n";
        fs.writeFileSync(
          path.join(client.vaultPath, "note.md"),
          crlf,
          "utf-8",
        );

        await sync2AllAndAssertNoErrors(client);

        // Local file rewritten in place to canonical form.
        const local = fs.readFileSync(
          path.join(client.vaultPath, "note.md"),
          "utf8",
        );
        expect(local).toBe("alpha\nbeta\n");

        // Server got the canonical bytes too.
        const remote = await readRemoteFile(branch, "note.md");
        expect(remote).toBe("alpha\nbeta\n");
      },
      180_000,
    );
  },
);
