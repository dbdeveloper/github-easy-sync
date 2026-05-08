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

// Etap 6.6 — binaries are byte-exact regardless of byte sequences
// that look like CRLF or BOM. PNG files routinely contain 0x0D 0x0A
// pairs (the standard PNG signature ends with one) and arbitrary
// 0xFE 0xFF bytes that decoders would interpret as BOM-like. None
// of those should be touched by the canonicalisation pipeline —
// hasTextExtension(path) is the gate.

describe.skipIf(!integrationEnabled())(
  "sync2 normalization — binary files round-trip byte-exact",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-norm-binary");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "PNG with embedded CRLF/BOM-like bytes round-trips byte-exact",
      async () => {
        // Build a deliberately CRLF/BOM-rich byte sequence under a
        // .png extension. Includes the canonical PNG magic which
        // already ends with 0x0D 0x0A.
        const bytes = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
          0xef, 0xbb, 0xbf,                                // BOM bytes
          0x0d, 0x0a, 0x0d,                                // CRLF + lone CR
          0x00, 0x01, 0x02, 0xff,                          // body bytes
        ]);
        await writeRemoteFile(branch, "img.png", bytes, "[web] add PNG");

        // Pull side: bytes arrive byte-exact in the local vault.
        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);
        const localPulled = fs.readFileSync(
          path.join(client.vaultPath, "img.png"),
        );
        expect(localPulled.equals(bytes)).toBe(true);

        // Push side: rewriting the file (different bytes) must also
        // not be touched by normalize. Use a fresh, distinctively
        // crafted buffer with more CRLF-looking bytes inside.
        const newBytes = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          0x00, 0xfe, 0xff, 0x0d, 0x0a, 0x0d, 0xff, 0xff,
        ]);
        fs.writeFileSync(
          path.join(client.vaultPath, "img.png"),
          newBytes,
        );
        await sync2AllAndAssertNoErrors(client);

        // Local copy is whatever we wrote (push doesn't normalize
        // binaries, so no write-back).
        const localAfter = fs.readFileSync(
          path.join(client.vaultPath, "img.png"),
        );
        expect(localAfter.equals(newBytes)).toBe(true);
      },
      240_000,
    );
  },
);
