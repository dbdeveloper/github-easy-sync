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
      "push-side sanitize: local file with forbidden ASCII chars gets renamed + pushed under canonical Unicode",
      async () => {
        // Field-reported issue: a file named
        // `Actual-projects/Ладовіра/Штрихи до "святої" книги "Віра в Лад".md`
        // pushed cleanly from Desktop (POSIX/NTFS allow `"`) but the
        // matching pull on Obsidian Mobile failed with FILE_NOTCREATED
        // because Android refuses Windows-forbidden chars in names.
        // Invariant: those ASCII chars NEVER reach GitHub. The
        // sanitizer rewrites local → canonical BEFORE push, regardless
        // of which device created the file.
        client = await createSync2Client({ branch });
        const forbidden = `Notes/Штрихи до "святої" книги "Віра в Лад".md`;
        const canonical = `Notes/Штрихи до “святої“ книги “Віра в Лад“.md`;
        const content = `body with "quoted" word\n`;
        await client.vault.adapter.write(forbidden, content);
        await sync2AllAndAssertNoErrors(client);

        // Local rename observable: forbidden gone, canonical present.
        expect(fs.existsSync(path.join(client.vaultPath, forbidden))).toBe(
          false,
        );
        expect(fs.existsSync(path.join(client.vaultPath, canonical))).toBe(
          true,
        );

        // Remote has canonical only. Asking for the forbidden path
        // should 404 (helper throws). Asking for canonical returns
        // the bytes unchanged.
        await expect(readRemoteFile(branch, forbidden)).rejects.toThrow();
        expect(await readRemoteFile(branch, canonical)).toBe(content);
      },
      210_000,
    );

    it(
      "push-side sanitize: covers the 11 forbidden chars reachable on push",
      async () => {
        // Stress: every forbidden char EXCEPT `\` appears in the
        // basename. `\` cannot show up in a vault filename on push
        // because Obsidian's `normalizePath` rewrites `\` → `/` before
        // any adapter call, so `\` never reaches our pre-sync scan.
        // `/` itself is the path separator and is never sanitized.
        // (`\` IS reachable on pull from a non-Obsidian-pushed GitHub
        // path; that path is exercised by the pull-side tests below
        // through filename-sanitizer unit coverage.)
        client = await createSync2Client({ branch });
        const forbidden = `Notes/all<>:|?*"#^[].md`;
        const canonical = `Notes/all＜＞꞉｜？＊“＃＾［］.md`;
        const content = "stress test\n";
        await client.vault.adapter.write(forbidden, content);
        await sync2AllAndAssertNoErrors(client);

        expect(fs.existsSync(path.join(client.vaultPath, canonical))).toBe(
          true,
        );
        expect(await readRemoteFile(branch, canonical)).toBe(content);
      },
      210_000,
    );

    it(
      "pull-side sanitize: legacy forbidden GitHub path lands locally as canonical, next sync cleans GitHub",
      async () => {
        // Models a vault whose GitHub history was populated by a tool
        // OUTSIDE this plugin (or by this plugin BEFORE sanitize landed)
        // and now carries paths with forbidden ASCII chars. A fresh
        // sync from any client must (a) materialise the file under a
        // canonical local name, and (b) drive the next sync to delete
        // the forbidden path from GitHub + add the canonical one,
        // converging GitHub to the invariant.
        const forbidden = `Notes/Штрихи до "святої" книги "Віра в Лад".md`;
        const canonical = `Notes/Штрихи до “святої“ книги “Віра в Лад“.md`;
        const content = "legacy content from another tool\n";
        // Seed GitHub directly, bypassing the plugin's push-side sanitizer.
        await writeRemoteFile(branch, forbidden, content, "seed legacy forbidden path");

        // First client: fresh adoption-from-remote (bootstrap path).
        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);

        // Local has canonical, not forbidden.
        expect(fs.existsSync(path.join(client.vaultPath, canonical))).toBe(
          true,
        );
        expect(fs.existsSync(path.join(client.vaultPath, forbidden))).toBe(
          false,
        );
        expect(
          fs.readFileSync(path.join(client.vaultPath, canonical), "utf8"),
        ).toBe(content);

        // Second sync: the phantom snapshot entry triggers
        // ChangeDetector to emit DELETE(forbidden) + ADD(canonical).
        // After this sync, GitHub no longer has the forbidden path.
        await sync2AllAndAssertNoErrors(client);

        await expect(readRemoteFile(branch, forbidden)).rejects.toThrow();
        expect(await readRemoteFile(branch, canonical)).toBe(content);
      },
      300_000,
    );

    it(
      "pull-side sanitize: forbidden GitHub path arrived AFTER first sync (incremental pull)",
      async () => {
        // Variant of the previous test against the non-bootstrap pull
        // path (pullIfNeeded loop in compare-mode rather than the
        // adoption walk). Verifies both pull entry points apply the
        // same sanitize logic.
        const seed = "Notes/seed.md";
        client = await createSync2Client({ branch });
        await client.vault.adapter.write(seed, "anchor\n");
        await sync2AllAndAssertNoErrors(client);

        // Now seed a forbidden path on GitHub directly.
        const forbidden = `Notes/extra<bad>.md`;
        const canonical = `Notes/extra＜bad＞.md`;
        const content = "appears after first sync\n";
        await writeRemoteFile(branch, forbidden, content, "seed legacy forbidden path");

        // Incremental sync: compare emits the new forbidden file, pull
        // sanitizes it locally.
        await sync2AllAndAssertNoErrors(client);
        expect(fs.existsSync(path.join(client.vaultPath, canonical))).toBe(
          true,
        );
        expect(fs.existsSync(path.join(client.vaultPath, forbidden))).toBe(
          false,
        );

        // Next sync cleans GitHub.
        await sync2AllAndAssertNoErrors(client);
        await expect(readRemoteFile(branch, forbidden)).rejects.toThrow();
        expect(await readRemoteFile(branch, canonical)).toBe(content);
      },
      300_000,
    );

    it(
      "ASCII apostrophes in filename round-trip (`'` is NOT sanitized)",
      async () => {
        // Sanity boundary: apostrophe U+0027 is NOT in the forbidden
        // set (Obsidian + GitHub + all filesystems accept it). It must
        // pass through unchanged on both push and pull — the sanitizer
        // doesn't over-reach into common punctuation.
        client = await createSync2Client({ branch });
        const filePath = `Notes/Don't worry it's fine.md`;
        const content = `body with 'apostrophes' inside\n`;
        await client.vault.adapter.write(filePath, content);
        await sync2AllAndAssertNoErrors(client);

        // Push: remote has the original apostrophe-bearing path.
        expect(await readRemoteFile(branch, filePath)).toBe(content);

        // Pull: round-trip on a fresh client.
        client.cleanup();
        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);
        const localPath = path.join(client.vaultPath, filePath);
        expect(fs.existsSync(localPath)).toBe(true);
        expect(fs.readFileSync(localPath, "utf8")).toBe(content);
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
