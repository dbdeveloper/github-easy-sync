import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  listRemoteFiles,
  readRemoteFile,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  writeVaultFile,
} from "../../helpers";

// I1 — `Reset metadata` button (settings tab → resetMetadata) wipes
// the local manifest. The next sync routes through fresh-adoption
// because vault has content but the manifest reads as "no real
// manifest" (lastSync=0, empty files map). Files on disk that match
// remote should silently adopt; nothing destructive should happen.
//
// Why this matters: the reset button is a deliberate "I want to
// start over" escape hatch. The contract is "resync from remote
// without losing my local files". If the post-reset sync ever
// routed through first-sync-from-local instead of adoption, it
// would force-push the local view and silently overwrite remote
// changes another device pushed since.
//
// Sequence:
//   1. Client primes branch with two notes, syncs. Manifest is
//      stamped (lastSync > 0).
//   2. Call sync.resetMetadata() — this is exactly what main.ts:318
//      does inside plugin.reset(). data.files cleared, lastSync=0,
//      flags reset.
//   3. Vault on disk is unchanged. Sync.
//   4. analyzeLocalState sees lastSync=0 → hasRealManifest=false.
//      Vault has files → not empty. Remote has manifest → routes
//      into adoption.
//   5. compareForAdoption finds local content matches remote
//      (identical=N, conflicting=0) → silent auto-adopt.
//
// Asserts:
//   * No ambiguous-state modal fires (we wire onAmbiguous to throw).
//   * Remote tree still contains both notes.
//   * Manifest's lastSync is back > 0 after the silent adopt.
describe.skipIf(!integrationEnabled())(
  "I1 — resetMetadata leaves vault intact; next sync silently re-adopts",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("i1");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "post-reset sync re-adopts via the silent path; remote unchanged",
      async () => {
        const files: { [path: string]: string } = {
          "Notes/i1-a.md": "# alpha\nfirst note.\n",
          "Notes/i1-b.md": "# beta\nsecond note.\n",
        };

        client = createClient({
          branch,
          deviceName: "i1-test",
          onAmbiguous: async (info) => {
            throw new Error(
              "I1: ambiguous-state modal fired but local matches remote — " +
                JSON.stringify({
                  identical: info.analysis.identical.length,
                  localOnly: info.analysis.localOnly,
                  remoteOnly: info.analysis.remoteOnly,
                  conflicting: info.analysis.conflicting,
                }),
            );
          },
        });

        // ---- prime ----------------------------------------------
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);
        for (const [p, c] of Object.entries(files)) {
          await writeVaultFile(client.vault, p, c);
        }
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        const remoteBefore = await listRemoteFiles(branch);
        for (const p of Object.keys(files)) {
          expect(remoteBefore).toContain(p);
        }

        // ---- the reset ------------------------------------------
        // resetMetadata() clears `lastSync`, `files`, and the resume
        // flags (metadata-store.ts:136). The manifest entry for
        // .obsidian/github-sync-metadata.json gets re-seeded by the
        // next loadMetadata().
        await client.sync.resetMetadata();
        const metadataStore = (client.sync as unknown as {
          metadataStore: {
            data: { lastSync: number; files: Record<string, unknown> };
          };
        }).metadataStore;
        expect(metadataStore.data.lastSync).toBe(0);

        // ---- next sync should silently adopt --------------------
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // Remote is intact, manifest is alive again, and the same
        // notes still round-trip with identical content.
        const remoteAfter = await listRemoteFiles(branch);
        for (const p of Object.keys(files)) {
          expect(remoteAfter).toContain(p);
          expect(await readRemoteFile(branch, p)).toBe(files[p]);
        }
        expect(
          metadataStore.data.lastSync,
          "lastSync should be re-stamped after the silent adoption",
        ).toBeGreaterThan(0);
      },
      180_000,
    );
  },
);
