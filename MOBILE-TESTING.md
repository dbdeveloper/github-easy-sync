# Mobile testing (Android-focused)

Manual checklist for verifying sync2 works on Obsidian Mobile. Primary target: Android. iOS notes appear inline where behaviour diverges.

## Why this is manual

The unit suite mocks `obsidian` via a Node-side stand-in (`mock-obsidian.ts`). Obsidian Mobile is a Capacitor build with a stripped JS runtime — no Node, no `fs`, a different `vault.adapter` implementation backed by Android's content-resolver / iOS' NSFileManager. We can't drive that programmatically from `vitest`, so the only honest verification is "install the build on a real device and walk through the cases below."

## Install via BRAT (no public store)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) is the standard "beta installer" plugin. Steps:

1. Install Obsidian on the phone, create or open a test vault.
2. Install BRAT through the in-app community-plugin store.
3. In BRAT settings: **Add Beta Plugin** → paste this repo's URL → BRAT pulls `main.js` + `manifest.json` from the latest release tag (or a specific tag if you specify one).
4. Reload Obsidian Mobile; the plugin appears under installed Community Plugins.
5. Configure the GitHub PAT, owner, repo, branch in the settings tab.

To test an unreleased branch: push a tag (`X.Y.Z-beta`) — the existing `release.yml` workflow cuts the artifact BRAT can fetch.

## Checklist

Run each of these on the device, with the result column filled in. "Pass" means the documented contract on desktop holds identically on mobile.

### Core flow

| # | Scenario | Expected | Result |
|---|---|---|---|
| 1 | Click Sync on an idle vault (no local changes, no remote changes) | Brief "No changes" flash, no other notice | |
| 2 | Edit one note, click Sync | Brief "Commit 1 file" flash; if heavy (>500 KB), then "Push 0/1 files to GitHub" → "Push 1/1 files to GitHub" → "Sync done" | |
| 3 | Edit multiple notes (3+), click Sync | "Commit N files" flash; for heavy bundle: "Push X/N files to GitHub" ticks through; final "Sync done" | |
| 4 | First sync against a non-bare remote (adoption) | Local files are kept where their mtime is newer than the remote commit date; remote-newer files overwrite local. No data loss. | |
| 5 | First sync against an empty remote (bare repo) | `.gitignore` seed commit + content commit appear on GitHub | |

### Pull side

| # | Scenario | Expected | Result |
|---|---|---|---|
| 6 | Make a change on GitHub web UI, then click Sync on phone | Local file updates; "Sync done (1 file updated from GitHub)" flashes briefly | |
| 7 | Same path edited locally AND remotely (text) | 3-way merge modal opens; pick "Resolve now" — type/edit the merged content, save | |
| 8 | Same path edited locally AND remotely (binary, e.g. `.png`) | Atomic mtime resolution; newer side wins. No modal. | |
| 9 | Same path edited locally AND remotely (plugin `main.js`) | Semver compare on `manifest.json`; higher version wins. No modal. | |

### Conflict deferral

| # | Scenario | Expected | Result |
|---|---|---|---|
| 10 | On the 3-way merge modal, pick "Later" | Sibling file `<name>.conflict-from-<device>-<ts>.<ext>` appears next to the original. The 🔀 status-bar count ticks up. | |
| 11 | Open the sibling, edit local file manually, delete the sibling through Obsidian's file menu | ConflictStore notices the delete; conflict closes; next Sync pushes the merged content | |
| 12 | Same as 11 but delete the sibling via the device's file manager (outside Obsidian) | Same outcome on next Obsidian launch (orphan cleanup at ConflictStore.load) | |

### Offline + recovery

| # | Scenario | Expected | Result |
|---|---|---|---|
| 13 | Turn on airplane mode, click Sync 3× with different edits between each | Each click queues a new batch (visible as folders under `.obsidian/plugins/github-gitless-sync/.push-queue/`). Notice flashes "Commit N files" each time; no error toast. | |
| 14 | Turn off airplane mode; wait for next interval tick (5 min by default) | Watchdog drain fires; all 3 batches push sequentially to GitHub. Final flash "Sync done". | |
| 15 | Force-quit Obsidian mid-push, relaunch | onload's drain picks up the half-pushed batch; resume layer (uploadedBlobs) skips blobs already on GitHub | |

### Settings + UI

| # | Scenario | Expected | Result |
|---|---|---|---|
| 16 | Toggle "Auto-canonicalize text files" off | Subsequent pulls keep CRLF / BOM bytes as-is in the local vault | |
| 17 | Toggle "Sync configs" on, change a theme | The theme file syncs across devices on the next click | |
| 18 | Change Sync interval from 5 to 1 minute | Timer restarts; next tick fires after ~60 s instead of 5 min | |
| 19 | Reset settings via Danger Zone (type RESET) | Token + repo + snapshot wiped; local vault untouched | |

## Known Android limitations

These are platform behaviours, not plugin bugs. Document them in the README so users know what to expect:

- **Background-throttled timer.** Once Obsidian is backgrounded, Android may suspend the JS runtime within seconds; `Window.setInterval` stops firing. Watchdog drain only resumes when the user returns to the app. Workaround: the interval timer also runs on every app foregrounding via the existing onload hook (effectively a manual tick). Long-running pushes won't survive backgrounding mid-flight either — they'll resume on next foreground via the `.attempted` marker.

- **No File Watcher for external deletions.** Files removed via Android's Files app (not Obsidian) won't fire `vault.on("delete")`. ConflictStore's orphan cleanup at `load()` catches this on the next plugin start, but mid-session deletions stay invisible.

- **Storage Access Framework constraints.** Some Android versions restrict which vault locations BRAT can read. Vaults under `/Android/data/md.obsidian/` work; arbitrary external paths may need user-granted access on each launch.

- **Large file uploads (>10 MB).** Memory-constrained devices may struggle with createBlob's base64 encoding step (~33% size inflation in memory). Behaviour: either the push completes slowly, or Obsidian crashes with OOM. The push-queue persists the batch on disk; restart + retry usually succeeds since the resume layer skips already-uploaded blobs.

## iOS notes (if you find a tester)

iOS background suspension is more aggressive than Android (~30 s typical). Otherwise the contract should be the same. iOS's file watcher fires `delete` events reliably for in-Obsidian operations; external file-manager operations (via Files.app) are inconsistent.

## Reporting issues

Open a GitHub issue with:

- Device + Android/iOS version + Obsidian version
- The scenario number above that failed
- Expected vs observed result
- A snapshot of `<vault>/.obsidian/plugins/github-gitless-sync/.push-queue/` (paths only — content may carry private data)
- Anything `<vault>/.obsidian/github-easy-sync.log` says when "Enable logging" was on
