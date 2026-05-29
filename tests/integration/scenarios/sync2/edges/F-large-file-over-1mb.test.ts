import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  readRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// Field-incident regression test (2.0.1-beta5 hotfix). GitHub's
// Contents API has a hard ~1 MB inline-content limit: for files
// >1 MB and ≤100 MB it returns status 200 with `content: ""` and
// `encoding: "none"`, expecting the caller to fall back to the
// Blobs API. Before the fix, sync2 silently decoded the empty
// content as a 0-byte ArrayBuffer, ran 3-way merge against
// "remote=∅", and concluded "ours wins" — pushing local content
// (which could itself be corrupted) over the legitimate >1 MB
// remote file. Reproduced as catastrophic data loss on a user
// vault with ~1.5 MB markdown notes; rolled back via
// `git revert` and patched here.
//
// These tests exercise the FULL roundtrip with a real 1.5 MB
// markdown file against real GitHub:
//   1. push: upload 1.5 MB file from vault, verify remote size
//   2. fetch-back: read remote file, verify bytes match
//   3. reconcile: small local change + remote unchanged → push must
//      land cleanly (the path that was broken in the field
//      incident: reconcile fetched theirsBytes:0 from empty
//      Contents response, then ran auto-merge against empty base,
//      then "modify-wins" overrode the legitimately-large remote).
//
// The 210s / 300s timeouts mirror the rest of the F-bucket to
// accommodate live GitHub variance.

function makeLargeMarkdown(targetBytes: number): string {
  // Deterministic ~1.5 MB content. Avoid pure repetition (`x` *
  // 1_500_000) so that diff/normalize code paths see real structure.
  const lines: string[] = ["# Big Markdown File\n"];
  // Each line is ~80 bytes; tune count to hit targetBytes.
  let bytes = "# Big Markdown File\n".length;
  let i = 0;
  while (bytes < targetBytes) {
    const line = `Line ${i.toString().padStart(7, "0")}: lorem ipsum dolor sit amet consectetur adipiscing elit\n`;
    lines.push(line);
    bytes += line.length;
    i += 1;
  }
  return lines.join("");
}

describe.skipIf(!integrationEnabled())(
  "sync2 F — large file (>1 MB) Contents API fallback",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-f-large-file");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "1.5 MB markdown file round-trips through push + remote read",
      async () => {
        client = await createSync2Client({ branch });
        const filePath = "BigNotes/large.md";
        const content = makeLargeMarkdown(1_500_000);
        expect(content.length).toBeGreaterThan(1_048_576); // > 1 MB

        await client.vault.adapter.write(filePath, content);
        await sync2AllAndAssertNoErrors(client);

        // Read remote: the helper uses our patched getContentsAtRef
        // path, which is the one exercised by the field incident.
        // Without the fix, this would return "" (empty) for a >1 MB
        // file. With the fix, the Blobs API fallback returns the
        // full content.
        const remote = await readRemoteFile(branch, filePath);
        expect(remote.length).toBe(content.length);
        expect(remote).toBe(content);
      },
      300_000,
    );

    it(
      "reconcile path: local small change + remote >1 MB unchanged → ours pushes cleanly without clobbering",
      async () => {
        // Reproduces the exact shape of the field incident:
        // - File on GitHub is >1 MB
        // - User makes a small local change
        // - sync2 enters the reconcile path
        // - getContentsAtRef on BOTH base and theirs refs would have
        //   returned empty content (bug), so 3-way merge would have
        //   computed against base=∅ + theirs=∅ + ours=1.5 MB
        //   → "ours wins" → push (correct outcome by coincidence
        //   here, but the symptom we care about is the data-loss
        //   inverse: corrupted local files pushed over fine remote).
        //
        // With the fix, base + theirs both resolve to the real
        // ~1.5 MB content, and the reconcile decision is computed
        // against true bytes — no surprises.
        client = await createSync2Client({ branch });
        const filePath = "BigNotes/reconcile.md";
        const original = makeLargeMarkdown(1_500_000);

        // Seed: push original 1.5 MB file.
        await client.vault.adapter.write(filePath, original);
        await sync2AllAndAssertNoErrors(client);

        // Sanity: remote = local at this point.
        expect(await readRemoteFile(branch, filePath)).toBe(original);

        // Append a small line locally — sync2 will detect change and
        // push. The reconcile pre-flight fetch (getContentsAtRef of
        // base) is the exact call path that was broken.
        const appended = original + "\nAppended after first sync\n";
        await client.vault.adapter.write(filePath, appended);
        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, filePath)).toBe(appended);
      },
      420_000,
    );
  },
);
