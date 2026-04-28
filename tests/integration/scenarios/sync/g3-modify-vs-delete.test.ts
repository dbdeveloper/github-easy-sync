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
  readVaultFile,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  vaultFileExists,
  writeVaultFile,
} from "../../helpers";

// G3 — same file, A modifies + B deletes; with default conflict
// handling (overwriteLocal), the modification wins via the text-
// conflict path.
//
// Why this exercises the conflict pipeline (not the modify-vs-delete
// branch in determineSyncActions):
//   * findDivergedPaths checks `actualLocalSHA != localFile.sha`
//     (line 1407). When B deleted foo.md, actualLocalSHA = null, so
//     local is treated as "modified" — which combined with A's real
//     modification (remote SHA != manifest SHA) trips all three
//     divergence flags → text conflict.
//   * .md files classify as "text" → conflict resolution emits a
//     `download` action (overwriteLocal mode), so foo.md is REFETCHED
//     to B's disk with A's modified content.
//   * The determineSyncActions modify-vs-delete branch (line 1716)
//     never fires because foo.md is in the conflictFiles list.
//
// User-facing meaning: "I deleted this on my phone, but I edited it
// on my laptop earlier — when I sync the laptop's edit wins, my
// deletion doesn't silently nuke the edit." That's the safe default.
//
// Sequence:
//   1. A primes branch with foo.md. B downloads.
//   2. A modifies foo.md, syncs.
//   3. B deletes foo.md from disk. loadMetadata reconcile marks
//      `deleted=true, deletedAt=now` on B's local manifest entry.
//   4. B syncs. Plugin detects text conflict; overwriteLocal emits
//      `download` → foo.md restored on B with A's content.
//
// Asserts: remote keeps A's modified content; B's vault gets it
// back; A is unchanged.
describe.skipIf(!integrationEnabled())(
  "G3 — same file: A modifies, B deletes — modification wins via overwriteLocal",
  () => {
    let clientA: TestClient | undefined;
    let clientB: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("g3");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      clientA?.cleanup();
      clientB?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "A's modification re-downloads to B, defeating B's deletion",
      async () => {
        const target = "Notes/contended.md";
        const baseline = "# baseline\nstart shared.\n";
        const modified = "# modified\nA's edit — should survive on remote.\n";

        // ---- prime: A creates + syncs, B downloads -------------
        clientA = createClient({ branch, deviceName: "g3-A" });
        await clientA.sync.loadMetadata();
        await syncAndAssertNoErrors(clientA);
        await writeVaultFile(clientA.vault, target, baseline);
        await clientA.sync.loadMetadata();
        await syncAndAssertNoErrors(clientA);

        clientB = createClient({ branch, deviceName: "g3-B" });
        await clientB.sync.loadMetadata();
        await syncAndAssertNoErrors(clientB);
        expect(await readVaultFile(clientB.vault, target)).toBe(baseline);

        // ---- A modifies + syncs ---------------------------------
        await writeVaultFile(clientA.vault, target, modified);
        await clientA.sync.loadMetadata();
        await syncAndAssertNoErrors(clientA);
        expect(await readRemoteFile(branch, target)).toBe(modified);

        // ---- B deletes locally + syncs --------------------------
        // Both sides have moved since last common sync (A modified,
        // B deleted), so the file shows up in findDivergedPaths.
        // Default conflictHandling=overwriteLocal → text conflict
        // resolves to download → modification wins on B.
        await clientB.vault.adapter.remove(target);
        await clientB.sync.loadMetadata();
        await syncAndAssertNoErrors(clientB);

        // ---- assert modification survives -----------------------
        expect(
          await readRemoteFile(branch, target),
          "remote should still hold A's modified content",
        ).toBe(modified);
        expect(await listRemoteFiles(branch)).toContain(target);
        expect(
          await vaultFileExists(clientB.vault, target),
          "B's deletion is undone — file restored locally with A's content",
        ).toBe(true);
        expect(await readVaultFile(clientB.vault, target)).toBe(modified);

        // A remains untouched.
        expect(await readVaultFile(clientA.vault, target)).toBe(modified);
      },
      300_000,
    );
  },
);
