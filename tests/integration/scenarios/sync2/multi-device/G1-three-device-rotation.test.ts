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
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// G1 — three devices take turns. Each adds one file, syncs; the next
// device pulls (sees the previous additions) and adds its own. Tests
// the post-adoption pull → edit → push cycle composing cleanly over
// N devices.

describe.skipIf(!integrationEnabled())(
  "sync2 G1 — three-device rotation",
  () => {
    let deviceA: Sync2TestClient | undefined;
    let deviceB: Sync2TestClient | undefined;
    let deviceC: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-g1-rotation");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      deviceA?.cleanup();
      deviceB?.cleanup();
      deviceC?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "A → B → C → A picks up each device's contribution",
      async () => {
        deviceA = await createSync2Client({ branch });
        deviceB = await createSync2Client({ branch });
        deviceC = await createSync2Client({ branch });

        // A adds note-a.md and syncs.
        await deviceA.vault.adapter.write("note-a.md", "from device A\n");
        await sync2AllAndAssertNoErrors(deviceA);

        // B pulls A's file, adds note-b.md, syncs.
        await sync2AllAndAssertNoErrors(deviceB);
        expect(
          fs.readFileSync(path.join(deviceB.vaultPath, "note-a.md"), "utf8"),
        ).toBe("from device A\n");
        await deviceB.vault.adapter.write("note-b.md", "from device B\n");
        await sync2AllAndAssertNoErrors(deviceB);

        // C pulls A+B's files, adds note-c.md, syncs.
        await sync2AllAndAssertNoErrors(deviceC);
        expect(
          fs.readFileSync(path.join(deviceC.vaultPath, "note-a.md"), "utf8"),
        ).toBe("from device A\n");
        expect(
          fs.readFileSync(path.join(deviceC.vaultPath, "note-b.md"), "utf8"),
        ).toBe("from device B\n");
        await deviceC.vault.adapter.write("note-c.md", "from device C\n");
        await sync2AllAndAssertNoErrors(deviceC);

        // A pulls B+C's files. All three notes present.
        await sync2AllAndAssertNoErrors(deviceA);
        expect(
          fs.readFileSync(path.join(deviceA.vaultPath, "note-b.md"), "utf8"),
        ).toBe("from device B\n");
        expect(
          fs.readFileSync(path.join(deviceA.vaultPath, "note-c.md"), "utf8"),
        ).toBe("from device C\n");

        // Remote carries all three.
        const remoteFiles = await listRemoteFiles(branch);
        expect(remoteFiles).toContain("note-a.md");
        expect(remoteFiles).toContain("note-b.md");
        expect(remoteFiles).toContain("note-c.md");
      },
      360_000,
    );
  },
);
