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
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// Stage 6.6 — pull-side text canonicalisation against a real GitHub
// branch. Web-UI committed a CRLF-laden file before our sync ever
// touched it; the first syncAll must:
//   1. Write the LF version locally.
//   2. Auto-republish the canonical version back to GitHub in the
//      same syncAll call (the "preferred clean server" rule).
// After convergence the second sync is a no-op (covered by the
// idempotency suite).

describe.skipIf(!integrationEnabled())(
  "sync2 normalization — pull of CRLF from web",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-norm-crlf");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "CRLF on remote → local LF + remote also becomes LF after sync",
      async () => {
        // Web-UI commits a file with CRLF line endings — bytes are
        // preserved exactly as we send them through the Contents API.
        const crlf = "first line\r\nsecond line\r\nthird line\r\n";
        await writeRemoteFile(branch, "doc.md", crlf, "[web] add CRLF");

        // Sanity: the bytes really are CRLF on the server.
        const remoteBefore = await readRemoteFile(branch, "doc.md");
        expect(remoteBefore).toBe(crlf);

        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);

        // Local file is canonical (LF + trailing-NL invariant).
        const local = fs.readFileSync(
          path.join(client.vaultPath, "doc.md"),
          "utf8",
        );
        expect(local).toBe("first line\nsecond line\nthird line\n");

        // Auto-republish converted the server copy too.
        const remoteAfter = await readRemoteFile(branch, "doc.md");
        expect(remoteAfter).toBe("first line\nsecond line\nthird line\n");
      },
      180_000,
    );
  },
);
