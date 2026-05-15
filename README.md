# GitHub Easy Sync

> Sync your Obsidian vault with a GitHub repository — no `git` binary,
> no `isomorphic-git`, identical behaviour on desktop and mobile.

Version `2.0.0-beta` · AGPL-3.0 · Fork of
[`github-gitless-sync`](https://github.com/silvanocerza/github-gitless-sync)

---

## Why another GitHub sync plugin?

Most existing Obsidian-to-Git plugins either rely on the `git` CLI
being installed (which excludes mobile entirely) or bundle a heavy
JavaScript git reimplementation (`isomorphic-git`) that struggles on
mobile WebViews when vaults grow past a few hundred files.

**GitHub Easy Sync goes a third way**: it talks to GitHub through the
**REST API only**. No git binary on disk, no JS git engine in the
bundle. The exact same sync logic runs on macOS, Windows, Linux,
iOS, and Android — and survives vaults with thousands of files on
mid-range Android devices without OOM crashes.

### How it stacks up

| Plugin | Engine | Mobile-friendly | Best for |
|---|---|---|---|
| **GitHub Easy Sync** (this) | GitHub REST API only | ✅ Large vaults work | Two-way sync without git skills; phones that just need to work |
| [`obsidian-git`](https://github.com/Vinzent03/obsidian-git) | `isomorphic-git` (or native `git`) | ⚠️ Flaky on large vaults | Full git semantics — branches, rebase, custom hosts |
| [`github-gitless-sync`](https://github.com/silvanocerza/github-gitless-sync) | GitHub REST API only | ✅ | The original; this plugin is a heavily-refactored fork of it |
| [`Obsidian-GitHub-Sync`](https://github.com/kevinmkchin/Obsidian-GitHub-Sync) | Bash scripts + `git` | ❌ Desktop only | Simple desktop-only workflows |
| [`obsidian-github-sync-multi-platform`](https://github.com/thiter/obsidian-github-sync-multi-platform) | Mixed | Partial | Cross-platform attempts with mixed results |

### What this plugin does well

- **Mobile that actually works.** The bundle has zero Node imports at
  the module-load level — Obsidian Mobile's Capacitor WebView loads
  it cleanly on Android and iOS. Verified on Android with 250+ file
  vaults.
- **No catastrophic-history risk on first setup.** "Adoption" (the
  very first sync on a non-empty vault against a non-empty remote)
  never silently overwrites local files: it mtime-checks every
  divergence and keeps local when local is newer.
- **Polling, not events.** The plugin walks the vault on each sync
  click instead of subscribing to live events, so edits made while
  the plugin was disabled are picked up on the next click — no
  "missed events" failure mode.
- **Click feels instant.** The click path writes the commit batch to
  disk and returns immediately; the network work happens in the
  background. Idle syncs stay silent; only heavy ones show a progress
  notice.
- **Resume on crash.** Four layers of resume cover adoption pull,
  incremental pull, push blob upload, and the find-changes → queue
  bridge. A push interrupted mid-flight (Obsidian closed, phone
  backgrounded, network drop) finishes on the next trigger without
  duplicating commits.
- **Privacy-conservative defaults.** Plugin `data.json` files
  (which routinely store API tokens) and per-device configs
  (`workspace.json`, `community-plugins.json`) are blocked from
  sync by default; flipping a toggle in settings opt-ins.
- **Test-connection probe** under the credentials section: one
  click verifies token + owner/repo + branch and explains exactly
  what's wrong if anything fails.

### What this plugin deliberately doesn't do

- No branches, no merge commits, no rebase, no manual stash. One
  branch per device, one linear history per repo.
- No non-GitHub hosts (no GitLab, Gitea, Bitbucket, etc.). The REST
  API endpoints are GitHub-specific.
- No automatic conflict resolution that could lose data — when text
  files diverge on both sides without a common base, the conflict
  is surfaced for you to resolve.

---

## Installation

### Setting up GitHub

> If you already have a GitHub account, a repo, and a fine-grained
> Personal Access Token (PAT) with `Contents: Read and write` on
> that repo, skip to **Installing the plugin** below.

#### 1. Create a GitHub account

Go to [github.com](https://github.com) and sign up. Free accounts are
sufficient — private repos are now unlimited on the free tier.

#### 2. Create the sync repository

[github.com/new](https://github.com/new) → give it a name (e.g.
`my-obsidian-vault`) → choose **Private** unless you specifically
want your notes public → leave "Initialize with README" unchecked
(an empty repo is fine; the plugin will seed it on first sync).

<!-- SCREENSHOT: empty repo creation form -->

#### 3. Generate a fine-grained Personal Access Token

[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)

- **Token name**: e.g. `obsidian-easy-sync`
- **Expiration**: 90 days is a reasonable default (you'll rotate
  before it expires)
- **Repository access**: **Only select repositories** → pick the one
  you created above. Don't use "All repositories" — keep the blast
  radius small.
- **Permissions** → **Repository permissions**:
  - **Contents**: Read and write
  - **Metadata**: Read-only (auto-selected when Contents is on)

Click **Generate token** and **copy the token immediately** — GitHub
shows it once.

<!-- SCREENSHOT: fine-grained PAT permissions screen -->

> Classic PATs with `repo` scope also work, but fine-grained tokens
> are strongly preferred — they're scoped to one repo and limit
> the damage if leaked.

### Installing the plugin

The plugin isn't in the Obsidian Community Plugins store yet (it's
in beta). Install via **BRAT** (Beta Reviewers Auto-update Tool).

#### 1. Install BRAT

In Obsidian → **Settings → Community plugins → Browse** → search for
**BRAT** by TfTHacker → Install → Enable.

#### 2. Add this plugin via BRAT

BRAT settings → **Add Beta Plugin** → paste this repo's URL:

```
https://github.com/dbdeveloper/github-easy-sync
```

BRAT pulls the latest release; the plugin appears under
**Settings → Community plugins → Installed plugins**. Toggle it on.

<!-- SCREENSHOT: BRAT Add Beta Plugin dialog -->

#### 3. Fill in credentials

Open the plugin settings (**Settings → GitHub Easy Sync**) and fill:

- **GitHub token**: the PAT you generated above
- **Owner**: your GitHub username (case-sensitive)
- **Repository**: the repo name you created
- **Repository branch**: usually `main` (check the default on the
  GitHub repo page if you're not sure)

<!-- SCREENSHOT: credentials filled in -->

> Android keyboards often append a trailing space when pasting from
> the suggestion bar. The plugin auto-trims values on save and on
> load, so paste-then-leave-field is safe.

#### 4. Test the connection

Click **Test** under the credentials. The button runs a one-shot
read-only probe against GitHub and reports back:

- **✓ All good** → ready to sync
- **✗ 401 Unauthorized** → token invalid or expired
- **✗ 403 Forbidden** → token missing required permissions
- **✗ 404 Not Found** → owner/repo typo, or fine-grained PAT
  doesn't include this repo

<!-- SCREENSHOT: test-connection result blocks (success + failure example) -->

#### 5. First sync

Click **Sync with GitHub** in the side ribbon (or run the
`Sync with GitHub` command via the command palette).

What happens on the first click depends on what's on each side:

| Local vault | Remote repo | First-click behaviour |
|---|---|---|
| Empty | Empty | Plugin seeds `.gitignore` + your invariant block on the remote |
| Has files | Empty | Plugin pushes everything on the next click |
| Empty | Has files | Plugin pulls everything into your local vault |
| Has files | Has files | **Adoption**: identical files are recorded silently; divergent files are kept according to mtime (the newer side wins); local-only files are pushed |

> **Adoption is non-destructive.** Local files with a newer mtime
> than the remote's last commit are kept verbatim, then pushed on
> the next sync. No silent overwrites.

---

## Settings reference

### Remote repository

- **GitHub token** — fine-grained PAT or classic token with
  read+write Contents access.
- **Owner / Repository / Repository branch** — case-sensitive
  identifiers. The **Test** button verifies all four at once.

### Sync

- **Device label** — text appended to each commit message
  (`Sync … (MyMacBook)`). Helps tell which device produced which
  commit. Also used in conflict-resolution sibling filenames.
- **Sync strategy** — `Manually` (default) or `On Interval`. Manual
  means the plugin only acts when you click; Interval polls.
- **Sync interval** — minutes between automatic syncs when strategy
  is `On Interval`. Default 5 min.
- **Sync on startup** — when on, fires one sync when Obsidian
  finishes loading. Off by default; the plugin is otherwise silent
  on enable.
- **Auto-commit on interval sync** — governs both interval ticks
  and the startup pulse. When ON, every tick does a full commit
  pass (same as a manual click). When OFF (default), ticks only
  pull and retry pending pushes; your local edits stay
  uncommitted until you click Sync yourself.
- **Accumulate offline syncs** — when on, clicks that arrive while
  a previous push is still in flight are folded into a single
  larger commit. Off by default (each click is its own commit).
- **Auto-canonicalize text files** — when on, text files (`.md`,
  `.txt`, …) get rewritten locally to LF / no-BOM / trailing-NL
  on pull and on enqueue. Off by default. Turn it on if you want
  canonical text on disk and don't mind a one-commit convergence
  push on first setup against a CRLF-history repo.

### Sync configs

- **Sync configs** — when on, files under `<vault>/.obsidian/` are
  synced (theme settings, plugin settings, etc.). Off by default;
  multi-device users typically don't want one machine's layout
  overwriting another's.

### Push plugins data.json

- **Push plugins data.json** — when on, the `data.json` files of
  other community plugins are also synced. Off by default — these
  files frequently store API tokens, credentials, and license keys.
  Our own `data.json` is **always** blocked regardless of this
  toggle.

### Danger zone

- **Reset plugin state** — wipes credentials, snapshot, push queue,
  conflict store. Type `RESET` to confirm. Local vault files are
  not touched. Use after a token leak or for a clean fresh start.

### Logging

- **Enable logging** — appends every operation to
  `<vault>/.obsidian/github-easy-sync.log`. Off by default. Turn it
  on temporarily when reproducing a bug for an issue report.

---

## Conflict resolution

> **Status: works but not exhaustively tested.** The atomic paths
> (binary, plugin files) and the simple 3-way text merge are
> well-covered by integration tests; the diff-edit UI for unresolved
> text conflicts works on desktop and Android but the UX is still
> rough. Treat this section as a beta feature: it won't lose data
> (sibling-file deferral guarantees that), but it may surprise you.

A conflict happens when the same file changed on both sides since
the last sync — for example, you edited a note on your phone, then
edited the same note on your laptop, then clicked Sync on the
laptop. The plugin classifies the path and picks a resolver:

| What changed | Resolver |
|---|---|
| Binary (`.png`, `.pdf`, …) | **Atomic mtime** — the newer side wins. No merge attempt, no prompt. |
| Plugin's `main.js` or `manifest.json` | **Atomic semver** — the higher version from `manifest.json` wins, with mtime as tie-break. Merging minified plugin code would crash Obsidian, so we don't try. |
| Other text (`.md`, `.txt`, …) | **3-way merge** against the last-synced base. If the merge is clean, applied silently. If it produces conflict markers, the diff view opens. |
| Local deleted + remote modified | **Surfaced as a conflict** — pick: keep delete / take remote / merge / defer. |

When the diff view opens, you get three resolution choices:

- **Resolve now** — edit the merged content directly in the diff
  view, then save. The resolved content lands in the next push.
- **Merge into one** — concatenates both versions with clear
  separators. Useful when both edits should be preserved verbatim
  (you'll clean up the result later in your normal editor).
- **Defer** — keep your local version as-is and write the remote
  version next to it as a sibling file named
  `<note>.conflict-from-<deviceLabel>-<timestamp>.md`. Sync
  resumes; you resolve at your own pace. Deleting the sibling
  closes the conflict.

<!-- SCREENSHOT: conflict view, both panes visible -->

Deferred conflicts show up as a 🔀 counter in the status bar
(click it to open the list).

The `.conflict-from-…` sibling files are gitignored by default —
they stay strictly local. If you want them to sync across devices,
edit `<vault>/.gitignore` and remove the `*.conflict-from-*` line.

---

## Commands and integrations

The plugin registers four commands (all available via the command
palette and assignable to hotkeys):

- `Sync with GitHub` — full vault sync
- `Sync with GitHub (custom message)…` — same, prompts for a
  custom commit message
- `Sync current file with GitHub` — pushes just the active file
- `Sync current file with GitHub (custom message)…` — same, with
  custom message

### Vim mode integration

<!-- TODO: add example after testing -->

If you use Obsidian's Vim mode, you can bind these commands to
your normal-mode commands via the `obsidian-vimrc-support` plugin.
Example (`.obsidian.vimrc`):

```vim
" Sync current file with one keystroke
exmap syncFile obcommand github-easy-sync:sync-current-file
nmap <leader>gs :syncFile<CR>
```

<!-- SCREENSHOT: vim-mode binding in action -->

---

## Troubleshooting

When something doesn't behave the way you expect:

1. **Turn on logging** in plugin settings (`Enable logging`).
2. **Reproduce** the issue.
3. **Copy the log** from the settings page (there's a copy button).
4. **Open an issue** at
   [github.com/dbdeveloper/github-easy-sync/issues](https://github.com/dbdeveloper/github-easy-sync/issues)
   and paste the log along with:
   - Platform (macOS / Windows / Linux / iOS / Android)
   - Obsidian version
   - Plugin version (from the settings page)
   - What you expected to happen vs. what actually happened
5. **Turn logging off** afterwards — log files grow over time and
   sync with the vault if `Sync configs` is on.

### Common gotchas

- **"Sync done" notice right after enabling the plugin** — that's
  the plugin draining a pending batch left over from a previous
  failed session. Happens when a previous push didn't finish
  cleanly (network drop, Obsidian quit mid-push). Normal recovery.
- **404 Not Found despite a valid-looking token** — almost always
  a fine-grained PAT whose "Repository access" list doesn't
  include your sync repo. Either add it, or generate a new PAT
  with the right scope. The **Test connection** button identifies
  this case specifically.
- **Settings field paste-with-trailing-space** — the plugin trims
  values on save, but if you somehow got a whitespace-poisoned
  value in before this fix (or if it came from another source),
  the plugin self-heals on next restart.
- **Large initial adoption on Android** — keep Obsidian in the
  foreground until the progress notice clears. Android suspends
  the JS runtime aggressively in the background; a paused
  adoption resumes safely on the next foreground click, but the
  one-shot flow is faster.

---

## Acknowledgements

This plugin is a heavily-refactored fork of
[`github-gitless-sync`](https://github.com/silvanocerza/github-gitless-sync)
by **Silvano Cerza**. The original gave us:

- The core idea of syncing through GitHub's REST API instead of
  shipping a git binary or `isomorphic-git`.
- The initial `GithubClient` REST wrapper (`src/github/client.ts`).
- The plugin scaffolding (settings tab structure, lifecycle hooks,
  logger).

About 8% of the current source code (~824 lines across 6 files) is
preserved from the original. Every source file that contains
Silvano's code carries an attribution header in its first three
lines.

Thanks for the foundation — without it this fork wouldn't exist.

The current sync engine, conflict resolution, adoption flow, resume
strategies, integration test suite, and mobile compatibility work
were rebuilt from scratch under the AGPL-3.0 license (carried over
unchanged from upstream).

---

## License

[AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.en.html) — same as
upstream. If you redistribute a modified version, you must keep the
source available; if you run a modified version as a network
service, that source-availability obligation extends to your users.
See [LICENSE](./LICENSE) for the full text.
