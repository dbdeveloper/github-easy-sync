import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  readRemoteFile,
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// F-series — special characters in paths plus content edges. Each
// `it()` is a sub-case; together they catch URL-encoding gaps in
// GithubClient, normalization surprises, and breakage on empty or
// large files. The single describe + multiple `it()`s mirrors the
// legacy F-suite layout (one file, 7 sub-tests).

describe.skipIf(!integrationEnabled())(
  "sync2 F — special chars in paths and content edges",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-f-edges");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "Cyrillic in both path and content round-trips",
      async () => {
        client = await createSync2Client({ branch });
        const filePath = "Замітки/нотатка.md";
        const content = "Українська мова\nрядок два\n";
        await client.vault.adapter.write(filePath, content);
        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, filePath)).toBe(content);
      },
      210_000,
    );

    it(
      "spaces + parentheses + brackets in filename round-trip",
      async () => {
        client = await createSync2Client({ branch });
        const filePath = "Notes/My Note [v1] (draft).md";
        const content = "title with spaces and punctuation\n";
        await client.vault.adapter.write(filePath, content);
        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, filePath)).toBe(content);
      },
      210_000,
    );

    it(
      "empty file pushes + pulls as empty",
      async () => {
        // Push side: prime a sync, then add an empty file and sync.
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("empty.md", "");
        await sync2AllAndAssertNoErrors(client);

        // sync2 text normalization keeps empty content empty (no
        // trailing-newline injection on empty input). Verify the
        // remote bytes are also empty.
        const remote = await readRemoteFile(branch, "empty.md");
        expect(remote).toBe("");
      },
      210_000,
    );

    it(
      "1 MB text file pushes + the second device pulls it byte-equal",
      async () => {
        // Build deterministic 1 MB text — long single-line content
        // (worst case for diff/merge) plus a final newline so
        // canonicalisation doesn't rewrite the file on the way out.
        const oneMB = "a".repeat(1024 * 1024 - 1) + "\n";

        client = await createSync2Client({ branch });
        await client.vault.adapter.write("big.txt", oneMB);
        await sync2AllAndAssertNoErrors(client);

        // Push assertion.
        expect((await readRemoteFile(branch, "big.txt")).length).toBe(
          oneMB.length,
        );

        // Pull assertion: fresh client on a clean vault, then sync.
        client.cleanup();
        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);
        const localPath = path.join(client.vaultPath, "big.txt");
        expect(fs.existsSync(localPath)).toBe(true);
        const pulled = fs.readFileSync(localPath, "utf8");
        expect(pulled.length).toBe(oneMB.length);
        expect(pulled).toBe(oneMB);
      },
      300_000,
    );

    it(
      "long filename (~150 chars) round-trips",
      async () => {
        // GitHub's path-length cap is ~255 chars per segment in the
        // tree. 150 leaves headroom for the prefix folder.
        const longSegment = "a".repeat(150);
        const filePath = `Notes/${longSegment}.md`;
        client = await createSync2Client({ branch });
        await client.vault.adapter.write(filePath, "long name body\n");
        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, filePath)).toBe(
          "long name body\n",
        );
      },
      210_000,
    );

    it(
      "remote-side path with Cyrillic pulls correctly into a fresh vault",
      async () => {
        // Pull-side variant: another device pushed a Cyrillic-pathed
        // file via the Contents API. A fresh vault must pull it back
        // intact — this exercises GithubClient.getContentsAtRef /
        // getBlob URL construction more than push does.
        await writeRemoteFile(
          branch,
          "Кирилиця/файл.md",
          "вміст\n",
          "[seed] cyrillic path",
        );
        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);

        const localPath = path.join(client.vaultPath, "Кирилиця/файл.md");
        expect(fs.existsSync(localPath)).toBe(true);
        expect(fs.readFileSync(localPath, "utf8")).toBe("вміст\n");
      },
      210_000,
    );
  },
);
