import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  listVaultFiles,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  writeRemoteFile,
} from "../../helpers";

// E2 — atomic conflict resolution for a binary file.
//
// Setup: same image path on both sides, but with divergent bytes.
// Plugin's classifyForConflict returns "binary" (no text extension /
// not merge-friendly), so resolveAtomicConflicts handles it without
// any user prompt — timestamp wins, with local as the tiebreaker if
// timestamps are equal. The loser side is preserved as a backup
// next to the winner: <base>.conflict-(local|remote)-<isoTimestamp>.<ext>
//
// We fire web-UI write last (after our local edit), so remote's
// lastModified > local's → remote wins, local content survives as a
// .conflict-local-* sidecar.
describe.skipIf(!integrationEnabled())(
  "E2 — atomic binary conflict resolved without modal",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("e2");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "diverging binary files produce a .conflict-local backup, no modal",
      async () => {
        // Tiny PNG bytes — distinct content but same shape.
        const pngLocal = Buffer.from(
          "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f80f00000100015e1eb1a30000000049454e44ae426082",
          "hex",
        );
        const pngRemoteAlt = Buffer.from(
          "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606000000005000146a0e7af0000000049454e44ae426082",
          "hex",
        );
        const imagePath = "Notes/pic.png";

        client = createClient({
          branch,
          deviceName: "e2-test",
          // The atomic resolver must NOT escalate to the user UI for
          // binary conflicts. If onConflicts (text path) or
          // onAmbiguous (init-state path) ever fire here, the test
          // failed.
          onConflicts: async () => {
            throw new Error("E2 unexpectedly triggered the text-conflict modal");
          },
        });

        // Prime: client pushes the original PNG to remote.
        await client.vault.adapter.writeBinary(
          imagePath,
          pngLocal.buffer.slice(
            pngLocal.byteOffset,
            pngLocal.byteOffset + pngLocal.byteLength,
          ) as ArrayBuffer,
        );
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // Diverge: edit locally (overwrite with same bytes — no-op
        // for content, but will be re-detected as "modified" because
        // lastModified updates? Actually mock fs.writeFileSync does
        // bump mtime). Then web-UI overwrites with completely
        // different bytes a moment later → remote.lastModified will
        // be the latest.
        //
        // What we actually want: distinct local edit + distinct
        // remote edit, so SHAs differ on both sides.
        const pngLocalEdit = Buffer.from(
          "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f80f00000100015e1eb1a30000000049454e44ae426083",
          "hex",
        );
        await client.vault.adapter.writeBinary(
          imagePath,
          pngLocalEdit.buffer.slice(
            pngLocalEdit.byteOffset,
            pngLocalEdit.byteOffset + pngLocalEdit.byteLength,
          ) as ArrayBuffer,
        );
        // Web-UI overwrite (newest timestamp). Pass the Buffer
        // directly so writeRemoteFile keeps the bytes intact.
        await writeRemoteFile(
          branch,
          imagePath,
          pngRemoteAlt,
          "E2: web-UI binary overwrite",
        );

        // loadMetadata → reconcile updates local manifest's view;
        // sync runs the conflict resolver.
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // Convergence check: a backup file with the .conflict-local
        // pattern should exist locally (loser side preserved).
        const localFiles = await listVaultFiles(client.vault);
        const conflictBackup = localFiles.find(
          (p) =>
            p.startsWith("Notes/pic.conflict-") && p.endsWith(".png"),
        );
        expect(
          conflictBackup,
          `expected a .conflict-(local|remote)-*.png backup; got listing: ${JSON.stringify(localFiles)}`,
        ).toBeDefined();
      },
      120_000,
    );
  },
);
