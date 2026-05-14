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

// E2 — binary conflict atomic resolution. After a prime sync, a
// binary file is modified on BOTH sides. sync2 has no base for a
// 3-way merge of binaries (and merging bytes makes no sense for
// e.g. PNGs), so it falls back to atomic mtime: whichever side was
// touched more recently wins. Tie → local wins.

describe.skipIf(!integrationEnabled())(
  "sync2 E2 — binary conflict, atomic mtime resolution",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-e2-binary-atomic");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "binary changed on both sides, local mtime is newer → local bytes win, end on remote",
      async () => {
        client = await createSync2Client({ branch });
        const initial = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          0xaa,
        ]);
        await client.vault.adapter.writeBinary(
          "img.png",
          initial.buffer.slice(
            initial.byteOffset,
            initial.byteOffset + initial.byteLength,
          ) as ArrayBuffer,
        );
        await sync2AllAndAssertNoErrors(client);

        // Remote: another device modifies img.png — slightly older commit.
        const remoteBytes = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          0xbb,
        ]);
        await writeRemoteFile(
          branch,
          "img.png",
          remoteBytes,
          "[other] modify img.png",
        );

        // Local: user modifies the file and forces its mtime to a
        // moment in the future so it's unambiguously newer than the
        // remote HEAD commit's committer date.
        const localBytes = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          0xcc,
        ]);
        await client.vault.adapter.writeBinary(
          "img.png",
          localBytes.buffer.slice(
            localBytes.byteOffset,
            localBytes.byteOffset + localBytes.byteLength,
          ) as ArrayBuffer,
        );
        const imgPath = path.join(client.vaultPath, "img.png");
        const futureTs = (Date.now() + 60_000) / 1000;
        fs.utimesSync(imgPath, futureTs, futureTs);

        await sync2AllAndAssertNoErrors(client);

        // Local bytes won → both sides carry the local content.
        const localAfter = fs.readFileSync(imgPath);
        expect(localAfter.equals(localBytes)).toBe(true);
        const remoteContent = await readRemoteFile(branch, "img.png");
        expect(Buffer.from(remoteContent, "binary").equals(localBytes)).toBe(
          false,
        );
        // readRemoteFile decodes as utf-8 string; we want raw bytes.
        const { files } = await client.client.getRepoContent({ retry: true });
        const blob = await client.client.getBlob({
          sha: files["img.png"].sha,
          retry: true,
        });
        const remoteRaw = Buffer.from(blob.content, "base64");
        expect(remoteRaw.equals(localBytes)).toBe(true);
      },
      240_000,
    );

    it(
      "binary changed on both sides, local mtime is older → remote bytes overwrite local",
      async () => {
        client = await createSync2Client({ branch });
        const initial = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11,
        ]);
        await client.vault.adapter.writeBinary(
          "img.png",
          initial.buffer.slice(
            initial.byteOffset,
            initial.byteOffset + initial.byteLength,
          ) as ArrayBuffer,
        );
        await sync2AllAndAssertNoErrors(client);

        const remoteBytes = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x22,
        ]);
        await writeRemoteFile(
          branch,
          "img.png",
          remoteBytes,
          "[other] modify img.png",
        );

        const localBytes = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x33,
        ]);
        await client.vault.adapter.writeBinary(
          "img.png",
          localBytes.buffer.slice(
            localBytes.byteOffset,
            localBytes.byteOffset + localBytes.byteLength,
          ) as ArrayBuffer,
        );
        const imgPath = path.join(client.vaultPath, "img.png");
        const pastTs = (Date.now() - 60_000) / 1000;
        fs.utimesSync(imgPath, pastTs, pastTs);

        await sync2AllAndAssertNoErrors(client);

        // Remote bytes won → local file overwritten in place.
        const localAfter = fs.readFileSync(imgPath);
        expect(localAfter.equals(remoteBytes)).toBe(true);
      },
      240_000,
    );
  },
);
