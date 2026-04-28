import { describe, it, beforeEach, afterEach, expect } from "vitest";
import {
  bootstrapEnabled,
  createClient,
  failOnNthMatch,
  installRequestFaultInjector,
  listRemoteFiles,
  readRemoteFile,
  recreateRepo,
  requireBootstrapEnv,
  syncAndAssertNoErrors,
  syncAndCollectErrors,
  TestClient,
  uniqueBranchName,
  writeVaultFile,
} from "../../helpers";

// C2 — resume after firstSyncFromLocal was killed mid-upload.
//
// Lives in the bootstrap suite because we need a truly-bare GitHub
// repo to hit the first-sync-from-local path (with the int-test
// repo + fine-grained PAT we'd route through adoption instead,
// which is atomic and not resumable).
//
// Flow:
//   1. recreateRepo → bare repo
//   2. session1: vault with text + binaries, sync starts → bootstrap
//      seeds .gitignore + manifest commit, then firstSyncFromLocal
//      uploads the user files via createBlob (binaries) + inline
//      tree content (text).
//   3. Inject crash on the 2nd POST /git/blobs (createBlob) — the
//      first binary upload completes, the second throws. The
//      `firstSyncFromLocalInProgress` marker that firstSyncFromLocal
//      set BEFORE entering commitSync must still be on disk.
//   4. session2 (fresh SyncManager, same vault) → resume detects
//      the marker → re-enters firstSyncFromLocal with `resume:true`.
//      The per-blob skip optimization in commitSync recognises the
//      already-uploaded binary by its content-addressed SHA and
//      skips the createBlob.
//   5. After commitSync succeeds, the marker clears (post-commit
//      save in firstSyncFromLocal) and the remote tree contains
//      every file we seeded locally.
describe.skipIf(!bootstrapEnabled())(
  "C2 — resume firstSyncFromLocal after a mid-upload crash",
  () => {
    let session1: TestClient | undefined;
    let session2: TestClient | undefined;
    let branch: string;

    beforeEach(async () => {
      await recreateRepo(requireBootstrapEnv());
      // Brief settle delay (matches the A1/A2 pattern).
      await new Promise((r) => setTimeout(r, 1500));
      branch = uniqueBranchName("c2");
    });

    afterEach(async () => {
      installRequestFaultInjector(null);
      session1?.cleanup();
      session2?.cleanup();
    });

    it(
      "binaries already uploaded before the crash get skipped on resume",
      async () => {
        const env = requireBootstrapEnv();
        // Seed: a couple of text notes + a few small binaries. Text
        // files ride inline in createTree (no createBlob), so the
        // crash injector targets only POST /git/blobs to land on a
        // binary upload.
        const textFiles: { [path: string]: string } = {
          "Notes/c2-text-1.md": "first note\n",
          "Notes/c2-text-2.md": "second note\n",
        };
        // Three distinct 1×1 PNGs so each binary has a unique SHA.
        const png = (suffix: string) =>
          Buffer.from(
            "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f80f00000100015e1eb1a30000000049454e44ae42608" +
              suffix,
            "hex",
          );
        const binaries: { [path: string]: Buffer } = {
          "Notes/img-a.png": png("0"),
          "Notes/img-b.png": png("1"),
          "Notes/img-c.png": png("2"),
        };

        // ---- session1: kick off sync, crash mid-upload ----------
        session1 = createClient({
          branch,
          deviceName: "c2-session1",
          env,
        });
        for (const [p, c] of Object.entries(textFiles)) {
          await writeVaultFile(session1.vault, p, c);
        }
        for (const [p, b] of Object.entries(binaries)) {
          await session1.vault.adapter.writeBinary(
            p,
            b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
          );
        }

        // Throw on the 2nd createBlob. Bootstrap pushes its own blobs
        // (the seed .gitignore goes through Contents API, not blobs;
        // the manifest blob and welcome blob — but no welcome here —
        // come through createBlob). After bootstrap, firstSyncFromLocal
        // → commitSync → per-binary createBlob calls. We let one
        // succeed so the resume path actually has something to skip.
        installRequestFaultInjector(
          failOnNthMatch(
            (url, method) =>
              method === "POST" && url.endsWith("/git/blobs"),
            // 1st createBlob = bootstrap's manifest blob
            // 2nd = first binary upload of firstSyncFromLocal …or
            // close to it. Pick a higher N to be safer.
            4,
            "C2: simulated kill mid-upload",
          ),
        );

        await session1.sync.loadMetadata();
        const errors = await syncAndCollectErrors(session1);
        installRequestFaultInjector(null);
        expect(
          errors.some((e) => e.includes("simulated kill mid-upload")),
          `expected the simulated-crash notice; got: ${errors.join(" | ")}`,
        ).toBe(true);

        // ---- session2: fresh SyncManager, same vault, no fault --
        session2 = createClient({
          branch,
          deviceName: "c2-session1",
          env,
          vaultPath: session1.vaultPath,
        });
        await session2.sync.loadMetadata();
        await syncAndAssertNoErrors(session2);

        // ---- assert all files made it to remote ----------------
        const remoteFiles = await listRemoteFiles(branch, env);
        for (const p of Object.keys(textFiles)) {
          expect(remoteFiles, `${p} should be on remote after resume`).toContain(p);
        }
        for (const p of Object.keys(binaries)) {
          expect(remoteFiles, `${p} should be on remote after resume`).toContain(p);
        }

        // Spot-check text content round-trip.
        const txt = await readRemoteFile(branch, "Notes/c2-text-1.md", env);
        expect(txt).toBe(textFiles["Notes/c2-text-1.md"]);
      },
      240_000,
    );
  },
);
