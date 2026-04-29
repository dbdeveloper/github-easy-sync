import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  failOnNthMatch,
  getBranchHead,
  getDefaultBranchHead,
  installRequestFaultInjector,
  integrationEnabled,
  listRemoteFiles,
  readRemoteFile,
  syncAndAssertNoErrors,
  syncAndCollectErrors,
  TestClient,
  uniqueBranchName,
  writeVaultFile,
} from "../../helpers";

// J5 — network drop during analyzeRemoteState's first remote read.
//
// Scope note: J5 deliberately stays at the "early in the sync,
// nothing committed" boundary. Mid-upload and mid-download recovery
// is already covered by C1/C2 (the resume tests), which exercise
// the marker-driven resume protocol with a partially-completed
// commit/download. This test pins the simpler contract: if the
// network blips at the moment getRepoContent fires, the plugin
// surfaces a clean error notice, leaves remote untouched, and the
// next clean sync converges.
//
// Implementation: the existing failOnNthMatch fault injector
// throws an Error before the request reaches fetch — exactly the
// shape Node's fetch produces on ECONNRESET / ENOTFOUND. We target
// the FIRST GET /git/trees/ call, which is analyzeRemoteState's
// getRepoContent (sync-state.ts:256). retryUntil's loop runs only
// for retriable HTTP statuses; thrown errors bubble straight up.
//
// Sequence:
//   1. Prime: client syncs, writes a note, syncs.
//   2. Stage another local edit. Capture branch head.
//   3. Inject one-shot throw on the first GET /git/trees/.
//   4. Sync — expect an error notice. Branch head unchanged.
//   5. Clear injector, sync again — expect convergence (the staged
//      edit lands).
describe.skipIf(!integrationEnabled())(
  "J5 — network drop on getRepoContent surfaces error; next sync converges",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("j5");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      installRequestFaultInjector(null);
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "thrown fetch on first /git/trees/ produces error notice; next sync recovers",
      async () => {
        client = createClient({ branch, deviceName: "j5-test" });
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);
        await writeVaultFile(client.vault, "Notes/j5-prime.md", "prime.\n");
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        const baselineHead = await getBranchHead(branch);
        expect(baselineHead).not.toBeNull();

        // Stage the edit that should land on the SECOND (recovery)
        // sync.
        const target = "Notes/j5-after-drop.md";
        const content = "should land after the network blip.\n";
        await writeVaultFile(client.vault, target, content);

        // ---- inject a thrown error on the first /git/trees/ call
        installRequestFaultInjector(
          failOnNthMatch(
            (url, method) =>
              method === "GET" && /\/git\/trees\//.test(url),
            1,
            "J5: simulated network drop",
          ),
        );

        await client.sync.loadMetadata();
        const errors = await syncAndCollectErrors(client);
        installRequestFaultInjector(null);
        expect(
          errors.some((e) => e.includes("simulated network drop")),
          `expected the simulated drop notice; got: ${errors.join(" | ")}`,
        ).toBe(true);

        // Branch HEAD must not advance — the drop hit before any
        // commit was even drafted.
        const headDuringDrop = await getBranchHead(branch);
        expect(
          headDuringDrop,
          "branch HEAD should be unchanged after a drop on getRepoContent",
        ).toBe(baselineHead);

        // ---- recovery sync ------------------------------------
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        const remote = await listRemoteFiles(branch);
        expect(remote).toContain(target);
        expect(await readRemoteFile(branch, target)).toBe(content);
      },
      240_000,
    );
  },
);
