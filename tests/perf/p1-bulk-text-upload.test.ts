import { describe, it, beforeAll, beforeEach, afterEach } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  writeVaultFile,
} from "../integration/helpers";
import { timed } from "./perf-helpers";

// P1 — bulk text upload. Three sizes so we can see whether the
// per-sync cost scales linearly or has a plateau (createTree ships
// all text content inline, so the upload is one big POST regardless
// of file count, modulo body size).
//
// What we time: the SECOND sync (the one that uploads the bulk),
// not the priming first-sync-from-remote. The first sync just pulls
// the branch's baseline (Welcome.md, .gitignore, manifest seed) and
// has nothing to do with the bulk-upload number we want.
//
// Outputs (one line per case):
//   PERF_BASELINE {"name":"P1-100","ms":...,"files":100,...}
//   PERF_BASELINE {"name":"P1-250","ms":...,"files":250,...}
//   PERF_BASELINE {"name":"P1-500","ms":...,"files":500,...}
describe.skipIf(!integrationEnabled())(
  "P1 — bulk text upload baselines (100 / 250 / 500 files)",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("p1");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it.each([100, 250, 500])(
      "P1 with %i files",
      async (count) => {
        client = createClient({ branch, deviceName: `p1-${count}` });
        await client.sync.loadMetadata();
        // Prime so the timed block measures pure incremental upload,
        // not the first-sync-from-remote handshake on a fresh client.
        await syncAndAssertNoErrors(client);

        // Stage N small markdown files. Path layout mixes a flat
        // "Notes/" folder + a nested "Notes/sub-XX/" folder so the
        // tree has some depth (closer to a real vault than a flat
        // batch).
        let bytesStaged = 0;
        for (let i = 0; i < count; i++) {
          const subfolder = (i % 10).toString().padStart(2, "0");
          const p = `Notes/sub-${subfolder}/note-${String(i).padStart(4, "0")}.md`;
          const c = `# Note ${i}\n\nGenerated for P1 perf baseline.\n` +
            `Body line filler so each file has a non-trivial SHA.\n`;
          bytesStaged += Buffer.byteLength(c, "utf-8");
          await writeVaultFile(client.vault, p, c);
        }

        // Reconcile so loadMetadata picks up everything we just
        // wrote BEFORE the timed block starts (we don't want the
        // walk's cost in the perf number).
        await client.sync.loadMetadata();

        await timed(
          `P1-${count}`,
          { files: count, bytes: bytesStaged },
          () => syncAndAssertNoErrors(client as TestClient),
        );
      },
      30 * 60_000,
    );
  },
);
