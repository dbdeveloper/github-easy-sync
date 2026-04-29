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
import { deterministicBytes, timed } from "./perf-helpers";

// P4 — A3-shaped full-vault sync: 245 mixed files in a layout that
// mirrors a moderately-active personal vault (notes, attachments,
// daily-journal directory, a few subfolders).
//
// Why 245: matches the figure the test plan called out as the
// "A3-style" reference vault. The number roughly mirrors what an
// average user has after a year of light note-taking (one note a
// day-and-a-half, plus a few clipped images per week).
//
// Layout (totals to 245):
//   * 200 markdown notes split across 10 subfolders
//   * 30 daily-journal entries (single flat folder)
//   * 10 PNG attachments (small, deterministic bytes)
//   *  5 JSON snippets in `.obsidian/snippets/` (configDir on)
//
// Output:
//   PERF_BASELINE {"name":"P4-A3-245","ms":...,"files":245,"bytes":...}
describe.skipIf(!integrationEnabled())(
  "P4 — A3-style 245-file vault upload baseline",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("p4");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "245-file vault primes + uploads in one sync",
      async () => {
        client = createClient({ branch, deviceName: "p4-test" });
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        let bytesStaged = 0;

        // 200 notes across 10 folders.
        for (let i = 0; i < 200; i++) {
          const folder = (i % 10).toString().padStart(2, "0");
          const path = `Notes/topic-${folder}/note-${String(i).padStart(4, "0")}.md`;
          const body =
            `# Note ${i}\n\nOne paragraph of body content for note ${i}.\n\n` +
            `Tags: #topic-${folder} #idx-${i}\n\nLinked: [[note-${(i + 1) %
              200}]]\n`;
          bytesStaged += Buffer.byteLength(body, "utf-8");
          await writeVaultFile(client.vault, path, body);
        }

        // 30 daily-journal entries, one folder.
        for (let i = 0; i < 30; i++) {
          const path = `Daily/2026-04-${String(i + 1).padStart(2, "0")}.md`;
          const body = `# 2026-04-${String(i + 1).padStart(2, "0")}\n\n` +
            `Quick journal entry for the day.\n`;
          bytesStaged += Buffer.byteLength(body, "utf-8");
          await writeVaultFile(client.vault, path, body);
        }

        // 10 PNG-ish attachments. Deterministic bytes, ~2 KB each.
        for (let i = 0; i < 10; i++) {
          const path = `Assets/clip-${String(i).padStart(2, "0")}.png`;
          const buf = deterministicBytes(`p4-png-${i}`, 2048);
          bytesStaged += buf.byteLength;
          await client.vault.adapter.writeBinary(
            path,
            buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
          );
        }

        // 5 small JSON snippets under configDir. Tests the
        // syncConfigDir=on path that real users with theme/snippet
        // sync see.
        for (let i = 0; i < 5; i++) {
          const path = `${client.vault.configDir}/snippets/snippet-${i}.json`;
          const body = JSON.stringify({ id: i, name: `snippet-${i}` }) + "\n";
          bytesStaged += Buffer.byteLength(body, "utf-8");
          await writeVaultFile(client.vault, path, body);
        }

        await client.sync.loadMetadata();

        await timed(
          "P4-A3-245",
          { files: 245, bytes: bytesStaged },
          () => syncAndAssertNoErrors(client as TestClient),
        );
      },
      30 * 60_000,
    );
  },
);
