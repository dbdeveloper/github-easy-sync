import { describe, it, beforeAll, beforeEach, afterEach } from "vitest";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  uniqueBranchName,
} from "../integration/helpers";
import {
  makeSync2Engine,
  ParametricEngine,
} from "../integration/scenarios/parametric/engine-factory";
import { deterministicBytes, timed } from "./perf-helpers";

// P4 (sync2) — full A3-style vault: 245 mixed files (200 notes,
// 30 daily entries, 10 PNGs, 5 configDir snippets). Direct
// counterpart to legacy P4. The configDir snippets exercise sync2's
// invariant-gitignore enforce path; the binary count exercises the
// createBlob Promise.all from P3's setup at scale.
//
// Output:
//   PERF_BASELINE {"name":"P4-sync2-A3-245","ms":...,"files":245,"bytes":...}
describe.skipIf(!integrationEnabled())(
  "P4 (sync2) — A3-style 245-file vault upload baseline",
  () => {
    let engine: ParametricEngine | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("p4-sync2");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      engine?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "245-file vault primes + uploads in one sync (sync2)",
      async () => {
        engine = makeSync2Engine({ branch });
        await engine.syncAll();

        let bytesStaged = 0;

        // 200 notes across 10 folders.
        for (let i = 0; i < 200; i++) {
          const folder = (i % 10).toString().padStart(2, "0");
          const p = `Notes/topic-${folder}/note-${String(i).padStart(4, "0")}.md`;
          const body =
            `# Note ${i}\n\nOne paragraph of body content for note ${i}.\n\n` +
            `Tags: #topic-${folder} #idx-${i}\n\nLinked: [[note-${(i + 1) %
              200}]]\n`;
          bytesStaged += Buffer.byteLength(body, "utf-8");
          await engine.vault.adapter.write(p, body);
        }

        // 30 daily-journal entries.
        for (let i = 0; i < 30; i++) {
          const p = `Daily/2026-04-${String(i + 1).padStart(2, "0")}.md`;
          const body = `# 2026-04-${String(i + 1).padStart(2, "0")}\n\n` +
            `Quick journal entry for the day.\n`;
          bytesStaged += Buffer.byteLength(body, "utf-8");
          await engine.vault.adapter.write(p, body);
        }

        // 10 PNG-ish attachments.
        for (let i = 0; i < 10; i++) {
          const p = `Assets/clip-${String(i).padStart(2, "0")}.png`;
          const buf = deterministicBytes(`p4-png-${i}`, 2048);
          bytesStaged += buf.byteLength;
          await engine.vault.adapter.writeBinary(
            p,
            buf.buffer.slice(
              buf.byteOffset,
              buf.byteOffset + buf.byteLength,
            ) as ArrayBuffer,
          );
        }

        // 5 configDir snippets.
        for (let i = 0; i < 5; i++) {
          const p = `${engine.vault.configDir}/snippets/snippet-${i}.json`;
          const body = JSON.stringify({ id: i, name: `snippet-${i}` }) + "\n";
          bytesStaged += Buffer.byteLength(body, "utf-8");
          await engine.vault.adapter.write(p, body);
        }

        await timed(
          "P4-sync2-A3-245",
          { files: 245, bytes: bytesStaged, engine: "sync2" },
          () => (engine as ParametricEngine).syncAll(),
        );
      },
      30 * 60_000,
    );
  },
);
