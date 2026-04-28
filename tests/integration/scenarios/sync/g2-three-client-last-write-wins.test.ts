import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  readRemoteFile,
  readVaultFile,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  writeVaultFile,
} from "../../helpers";

// G2 — three clients independently edit the SAME file, sync
// sequentially with conflictHandling=overwriteRemote → last writer
// wins on remote, and earlier writers eventually catch up.
//
// Flow:
//   1. ClientA primes the branch with a baseline file. ClientB and
//      ClientC each first-sync-from-remote so all three share the
//      same manifest entry for placeholder.md.
//   2. All three clients edit placeholder.md with distinct content
//      locally — no syncing yet, so each client's manifest still
//      points at the baseline SHA.
//   3. Each client syncs IN ORDER. The first sync goes through with
//      no conflict (remote SHA == manifest baseline still). The
//      second and third hit a real conflict (remote SHA changed
//      under their feet, AND they have local edits) — the
//      overwriteRemote setting auto-resolves by uploading the local
//      version, so the latest sync wins.
//   4. Earlier writers re-sync to converge.
//
// Asserts: remote ends up holding ClientC's content, all three
// vaults read it back identical after the convergence pass.
describe.skipIf(!integrationEnabled())(
  "G2 — three clients edit same file, last-write-wins via overwriteRemote",
  () => {
    let clientA: TestClient | undefined;
    let clientB: TestClient | undefined;
    let clientC: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("g2");
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
      "last sync wins on remote; prior clients catch up to the same content",
      async () => {
        const target = "Notes/contended.md";
        const baseline = "# baseline\nshared starting point.\n";
        const editA = "# edit from A\nfirst writer.\n";
        const editB = "# edit from B\nsecond writer.\n";
        const editC = "# edit from C\nthird writer — should win on remote.\n";

        // ---- prime the branch with the baseline -----------------
        clientA = createClient({
          branch,
          deviceName: "g2-A",
          conflictHandling: "overwriteRemote",
        });
        await clientA.sync.loadMetadata();
        await syncAndAssertNoErrors(clientA);
        await writeVaultFile(clientA.vault, target, baseline);
        await clientA.sync.loadMetadata();
        await syncAndAssertNoErrors(clientA);

        // ---- B and C pull baseline ------------------------------
        clientB = createClient({
          branch,
          deviceName: "g2-B",
          conflictHandling: "overwriteRemote",
        });
        await clientB.sync.loadMetadata();
        await syncAndAssertNoErrors(clientB);
        expect(await readVaultFile(clientB.vault, target)).toBe(baseline);

        clientC = createClient({
          branch,
          deviceName: "g2-C",
          conflictHandling: "overwriteRemote",
        });
        await clientC.sync.loadMetadata();
        await syncAndAssertNoErrors(clientC);
        expect(await readVaultFile(clientC.vault, target)).toBe(baseline);

        // ---- everyone edits the same file locally ---------------
        // No syncing here — each client's manifest still references
        // the baseline SHA, while disk holds three different versions.
        await writeVaultFile(clientA.vault, target, editA);
        await writeVaultFile(clientB.vault, target, editB);
        await writeVaultFile(clientC.vault, target, editC);

        // ---- sync in order: A, B, C -----------------------------
        // A: no conflict (remote SHA still == manifest baseline) →
        // straight upload of editA.
        await clientA.sync.loadMetadata();
        await syncAndAssertNoErrors(clientA);
        expect(await readRemoteFile(branch, target)).toBe(editA);

        // B: remote SHA now == editA's; B's manifest still says
        // baseline → both sides diverged → conflict. With
        // overwriteRemote, B's local editB takes the remote slot.
        await clientB.sync.loadMetadata();
        await syncAndAssertNoErrors(clientB);
        expect(await readRemoteFile(branch, target)).toBe(editB);

        // C: same conflict, editC wins on remote.
        await clientC.sync.loadMetadata();
        await syncAndAssertNoErrors(clientC);
        expect(await readRemoteFile(branch, target)).toBe(editC);

        // ---- A and B catch up — they should now download editC --
        // No local edit on A or B since their last sync, so this is
        // a clean remote-only change → download action, no conflict.
        await clientA.sync.loadMetadata();
        await syncAndAssertNoErrors(clientA);
        await clientB.sync.loadMetadata();
        await syncAndAssertNoErrors(clientB);

        expect(await readVaultFile(clientA.vault, target)).toBe(editC);
        expect(await readVaultFile(clientB.vault, target)).toBe(editC);
        expect(await readVaultFile(clientC.vault, target)).toBe(editC);
        expect(await readRemoteFile(branch, target)).toBe(editC);
      },
      300_000,
    );
  },
);
