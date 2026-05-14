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

// G2 — two devices edit the SAME text file at non-overlapping
// lines. Pull-side 3-way merge against the last shared sync resolves
// cleanly; both edits land in the merged result on the device that
// syncs second.

describe.skipIf(!integrationEnabled())(
  "sync2 G2 — same-file, disjoint edits across two devices",
  () => {
    let deviceA: Sync2TestClient | undefined;
    let deviceB: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-g2-disjoint");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      deviceA?.cleanup();
      deviceB?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "A edits line 1, B edits line 3 on the same file → merged result has both",
      async () => {
        // Seed both devices with a common base.
        deviceA = await createSync2Client({ branch });
        await deviceA.vault.adapter.write(
          "notes.md",
          "line 1\nline 2\nline 3\n",
        );
        await sync2AllAndAssertNoErrors(deviceA);

        deviceB = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(deviceB);
        expect(
          fs.readFileSync(path.join(deviceB.vaultPath, "notes.md"), "utf8"),
        ).toBe("line 1\nline 2\nline 3\n");

        // A edits line 1; pushes.
        await deviceA.vault.adapter.write(
          "notes.md",
          "line 1 — edited by A\nline 2\nline 3\n",
        );
        await sync2AllAndAssertNoErrors(deviceA);

        // B edits line 3 (without pulling A's edit yet); pushes.
        await deviceB.vault.adapter.write(
          "notes.md",
          "line 1\nline 2\nline 3 — edited by B\n",
        );
        await sync2AllAndAssertNoErrors(deviceB);

        // After B's sync, the remote and B's local both carry the
        // merged content (both edits, in their respective places).
        const merged = "line 1 — edited by A\nline 2\nline 3 — edited by B\n";
        expect(
          fs.readFileSync(path.join(deviceB.vaultPath, "notes.md"), "utf8"),
        ).toBe(merged);
        expect(await readRemoteFile(branch, "notes.md")).toBe(merged);

        // A pulls and ends up with the same merged content.
        await sync2AllAndAssertNoErrors(deviceA);
        expect(
          fs.readFileSync(path.join(deviceA.vaultPath, "notes.md"), "utf8"),
        ).toBe(merged);
      },
      360_000,
    );
  },
);
