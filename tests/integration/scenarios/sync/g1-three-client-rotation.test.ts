import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  listRemoteFiles,
  readVaultFile,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  writeVaultFile,
} from "../../helpers";

// G1 — three clients rotate through the same branch and converge.
//
// Pattern: A→sync, B(downloads A)→adds→sync, C(downloads A+B)→adds→sync,
// A→sync(downloads B+C). Each client adds its OWN distinct file, so
// no per-file conflicts arise — this isolates the multi-device
// state-machine flow. We exercise:
//   * each new client routes through first-sync-from-remote on its
//     empty vault, then incremental upload of the new local file
//   * existing clients pick up the others' contributions through
//     incremental download in regular-sync mode
//   * the manifest's per-device fields (deviceName) don't accumulate
//     stale state — only the latest writer's deviceName sticks
// Final assertion: all three vaults end up with the same three files
// + identical content; remote tree matches.
describe.skipIf(!integrationEnabled())(
  "G1 — three-client rotation converges on every device",
  () => {
    let clientA: TestClient | undefined;
    let clientB: TestClient | undefined;
    let clientC: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("g1");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      clientA?.cleanup();
      clientB?.cleanup();
      clientC?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "rotation A→B→C→A converges with all three files on every device",
      async () => {
        const fileA = "Notes/from-a.md";
        const fileB = "Notes/from-b.md";
        const fileC = "Notes/from-c.md";
        const contentA = "# from A\nfirst contributor\n";
        const contentB = "# from B\nsecond contributor\n";
        const contentC = "# from C\nthird contributor\n";

        // ---- A: empty vault + branch-has-manifest → first-sync-from-
        // remote pulls baseline (Welcome.md, .gitignore, manifest).
        // After that A is in regular-sync, writes fileA, syncs again.
        // Splitting the seed-first-then-edit flow keeps every client
        // on the same routing path (regular-sync incremental), which
        // is what the "rotation" test is supposed to exercise.
        clientA = createClient({ branch, deviceName: "g1-A" });
        await clientA.sync.loadMetadata();
        await syncAndAssertNoErrors(clientA);
        await writeVaultFile(clientA.vault, fileA, contentA);
        await clientA.sync.loadMetadata();
        await syncAndAssertNoErrors(clientA);
        expect(await listRemoteFiles(branch)).toContain(fileA);

        // ---- B: empty vault + branch-has-manifest → first-sync-from-
        // remote. After download, B writes fileB and syncs again.
        clientB = createClient({ branch, deviceName: "g1-B" });
        await clientB.sync.loadMetadata();
        await syncAndAssertNoErrors(clientB);
        expect(await readVaultFile(clientB.vault, fileA)).toBe(contentA);
        await writeVaultFile(clientB.vault, fileB, contentB);
        await clientB.sync.loadMetadata();
        await syncAndAssertNoErrors(clientB);
        let remote = await listRemoteFiles(branch);
        expect(remote).toContain(fileA);
        expect(remote).toContain(fileB);

        // ---- C: same pattern.
        clientC = createClient({ branch, deviceName: "g1-C" });
        await clientC.sync.loadMetadata();
        await syncAndAssertNoErrors(clientC);
        expect(await readVaultFile(clientC.vault, fileA)).toBe(contentA);
        expect(await readVaultFile(clientC.vault, fileB)).toBe(contentB);
        await writeVaultFile(clientC.vault, fileC, contentC);
        await clientC.sync.loadMetadata();
        await syncAndAssertNoErrors(clientC);
        remote = await listRemoteFiles(branch);
        expect(remote).toContain(fileA);
        expect(remote).toContain(fileB);
        expect(remote).toContain(fileC);

        // ---- A re-syncs: must download fileB + fileC, ending with
        // the same file set as B and C.
        await clientA.sync.loadMetadata();
        await syncAndAssertNoErrors(clientA);
        expect(await readVaultFile(clientA.vault, fileA)).toBe(contentA);
        expect(await readVaultFile(clientA.vault, fileB)).toBe(contentB);
        expect(await readVaultFile(clientA.vault, fileC)).toBe(contentC);

        // ---- And to fully close the loop: B re-syncs to pick up
        // fileC (B never saw it because C synced after B did).
        await clientB.sync.loadMetadata();
        await syncAndAssertNoErrors(clientB);
        expect(await readVaultFile(clientB.vault, fileC)).toBe(contentC);

        // Final convergence: all three vaults read identical content
        // for every file.
        for (const [p, c] of [
          [fileA, contentA],
          [fileB, contentB],
          [fileC, contentC],
        ]) {
          expect(await readVaultFile(clientA.vault, p)).toBe(c);
          expect(await readVaultFile(clientB.vault, p)).toBe(c);
          expect(await readVaultFile(clientC.vault, p)).toBe(c);
        }
      },
      240_000,
    );
  },
);
