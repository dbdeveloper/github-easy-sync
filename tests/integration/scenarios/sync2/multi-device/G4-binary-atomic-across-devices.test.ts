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
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// G4 — atomic mtime resolution on a BINARY file across two real
// sync2 devices. E2 covers binary atomic against a fake "remote
// modification" written through the Contents API; this is the same
// outcome through a full sync2-on-sync2 round trip. Newer mtime
// wins; both sides end up with that side's bytes.

function bytesEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}

describe.skipIf(!integrationEnabled())(
  "sync2 G4 — binary atomic mtime, two devices",
  () => {
    let deviceA: Sync2TestClient | undefined;
    let deviceB: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-g4-binary-atomic");
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
      "A and B both modify img.png; B's mtime is newer → B's bytes on both sides",
      async () => {
        // Seed: A creates and pushes img.png.
        deviceA = await createSync2Client({ branch });
        const seed = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
        ]);
        await deviceA.vault.adapter.writeBinary(
          "img.png",
          seed.buffer.slice(
            seed.byteOffset,
            seed.byteOffset + seed.byteLength,
          ) as ArrayBuffer,
        );
        await sync2AllAndAssertNoErrors(deviceA);

        // B pulls.
        deviceB = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(deviceB);

        // Both diverge. A modifies + pushes first (older mtime).
        const aBytes = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa,
        ]);
        await deviceA.vault.adapter.writeBinary(
          "img.png",
          aBytes.buffer.slice(
            aBytes.byteOffset,
            aBytes.byteOffset + aBytes.byteLength,
          ) as ArrayBuffer,
        );
        const aImgPath = path.join(deviceA.vaultPath, "img.png");
        const aTs = (Date.now() - 60_000) / 1000;
        fs.utimesSync(aImgPath, aTs, aTs);
        await sync2AllAndAssertNoErrors(deviceA);

        // B modifies locally (newer mtime) — has NOT pulled A's edit.
        const bBytes = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xbb,
        ]);
        await deviceB.vault.adapter.writeBinary(
          "img.png",
          bBytes.buffer.slice(
            bBytes.byteOffset,
            bBytes.byteOffset + bBytes.byteLength,
          ) as ArrayBuffer,
        );
        const bImgPath = path.join(deviceB.vaultPath, "img.png");
        const bTs = (Date.now() + 60_000) / 1000;
        fs.utimesSync(bImgPath, bTs, bTs);

        // B's sync sees A's remote commit + own local mod → atomic
        // mtime resolution. B is newer → B wins on both sides.
        await sync2AllAndAssertNoErrors(deviceB);

        const bLocalAfter = fs.readFileSync(bImgPath);
        expect(bytesEqual(bLocalAfter, bBytes)).toBe(true);

        const { files } = await deviceB.client.getRepoContent({
          retry: true,
        });
        const blob = await deviceB.client.getBlob({
          sha: files["img.png"].sha,
          retry: true,
        });
        const remoteRaw = Buffer.from(blob.content, "base64");
        expect(bytesEqual(remoteRaw, bBytes)).toBe(true);

        // A pulls — gets B's bytes.
        await sync2AllAndAssertNoErrors(deviceA);
        const aLocalAfter = fs.readFileSync(aImgPath);
        expect(bytesEqual(aLocalAfter, bBytes)).toBe(true);
      },
      360_000,
    );
  },
);
