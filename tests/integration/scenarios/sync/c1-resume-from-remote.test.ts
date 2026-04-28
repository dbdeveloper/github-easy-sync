import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  failOnNthMatch,
  getDefaultBranchHead,
  installRequestFaultInjector,
  integrationEnabled,
  listVaultFiles,
  readVaultFile,
  syncAndAssertNoErrors,
  syncAndCollectErrors,
  TestClient,
  uniqueBranchName,
  writeVaultFile,
} from "../../helpers";

// C1 — resume after firstSyncFromRemote was killed mid-download.
//
// Two clients on the same branch:
//   - client1 primes the branch with a handful of notes.
//   - client2 starts on an empty vault. Routing: empty + has-manifest
//     → first-sync-from-remote → downloadAllFilesViaAPI streams
//     blobs. We inject a synthetic crash on the 4th GET /git/blobs/
//     call, which represents Obsidian being killed somewhere in the
//     middle of the download batch.
//
// On reload (a fresh SyncManager against the same vault directory)
// the resume marker `firstSyncFromRemoteInProgress` should still be
// true on disk — the subsequent sync has resume=from-remote, and
// downloadAllFilesViaAPI's per-file SHA skip optimization avoids
// re-downloading what already landed before the crash.
describe.skipIf(!integrationEnabled())(
  "C1 — resume firstSyncFromRemote after a mid-download crash",
  () => {
    let client1: TestClient | undefined;
    let client2: TestClient | undefined;
    let client3: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("c1");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      // ALWAYS clear the injector so it doesn't leak into the next
      // test, even on failure.
      installRequestFaultInjector(null);
      client1?.cleanup();
      client2?.cleanup();
      client3?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "downloads pick up where they left off after the kill+reload",
      async () => {
        // ---- prime the branch with several notes ---------------
        const fixturePaths = Array.from({ length: 8 }, (_, i) =>
          `Notes/c1-note-${String(i + 1).padStart(2, "0")}.md`,
        );
        client1 = createClient({ branch, deviceName: "c1-primer" });
        for (const p of fixturePaths) {
          await writeVaultFile(client1.vault, p, `# ${p}\nfixture content\n`);
        }
        await client1.sync.loadMetadata();
        await syncAndAssertNoErrors(client1);

        // ---- client2 starts a fresh download, will crash --------
        client2 = createClient({ branch, deviceName: "c1-resumer" });
        // Crash on the 7th blob GET. The 1st is the manifest blob
        // fetched by analyzeRemoteState, then downloads run in
        // batches of 5 (BATCH_SIZE in downloadAllFilesViaAPI).
        // Requests 2-6 = batch 1 (4 infra files + 1st fixture);
        // request 7 = first of batch 2. By the time we throw,
        // batch 1 has fully completed AND saved its metadata, so
        // disk + metadata are consistent for the first 5 files —
        // exactly the state resume needs to skip them on retry.
        installRequestFaultInjector(
          failOnNthMatch(
            (url, method) =>
              method === "GET" && /\/git\/blobs\//.test(url),
            7,
            "C1: simulated kill mid-download",
          ),
        );
        await client2.sync.loadMetadata();
        const errors = await syncAndCollectErrors(client2);
        installRequestFaultInjector(null);
        expect(
          errors.some((e) => e.includes("simulated kill mid-download")),
          `expected the simulated-crash notice; got: ${errors.join(" | ")}`,
        ).toBe(true);

        // Some files should already be on disk locally; we don't care
        // exactly how many — just that the partial-download state is
        // visible (otherwise resume has nothing to resume FROM).
        const partialFiles = await listVaultFiles(client2.vault);
        const partialFixtures = partialFiles.filter((p) =>
          p.startsWith("Notes/c1-note-"),
        );
        expect(
          partialFixtures.length,
          `expected at least one fixture downloaded before the crash; got: ${JSON.stringify(partialFiles)}`,
        ).toBeGreaterThan(0);
        expect(
          partialFixtures.length,
          `expected NOT all fixtures downloaded before the crash; got ${partialFixtures.length}/${fixturePaths.length}`,
        ).toBeLessThan(fixturePaths.length);

        // ---- reload (fresh SyncManager, same vault), no fault ---
        // resume marker on disk should be `from-remote`, so the next
        // dispatchSync picks up the partial state.
        client3 = createClient({
          branch,
          deviceName: "c1-resumer",
          vaultPath: client2.vaultPath,
        });
        await client3.sync.loadMetadata();
        await syncAndAssertNoErrors(client3);

        // ---- assert convergence --------------------------------
        const finalFiles = await listVaultFiles(client3.vault);
        for (const p of fixturePaths) {
          expect(finalFiles, `${p} should be present after resume`).toContain(p);
        }
        // Spot-check content on a file that was almost certainly NOT
        // downloaded before the crash (the last fixture).
        const lastNote = await readVaultFile(
          client3.vault,
          fixturePaths[fixturePaths.length - 1],
        );
        expect(lastNote).toContain("fixture content");
      },
      180_000,
    );
  },
);
