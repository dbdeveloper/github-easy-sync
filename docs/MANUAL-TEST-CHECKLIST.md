# Manual / Playwright Test Checklist

This checklist covers behaviour that the automated suites **cannot** verify:

- the real Obsidian UI (ribbons, status bar, settings, modals);
- mobile / Capacitor behaviour (iOS & Android);
- layout-dependent CodeMirror behaviour that needs real geometry (line
  wrapping, Page Up/Down, vertical caret movement, Home/End);
- physical failure modes (low-memory kill, battery death mid-write);
- end-to-end sync flows against a real GitHub repository, exercised the way a
  user would.

Everything else is pinned by the unit suite (`pnpm test`) and the integration
suite (`pnpm test:integration`).

**How to use**

- Run the relevant sections before each release — especially `-beta` builds on
  mobile.
- Tick `[x]` for each item you verify; record the **version, platform, and
  date** in your run notes.
- When you find a bug, file an issue and, where feasible, add a unit or
  integration test so the case is caught automatically next time.

**Legend**  🖥️ desktop · 📱 mobile (iOS/Android) · 🌐 needs a real GitHub repo ·
⏳ feature not yet bundled into `main.js` (test once it ships).

---

## 1. Platform & build

- [ ] 🖥️ `pnpm build` is green; `main.js` loads in Obsidian (desktop) with no console errors.
- [ ] 📱 The plugin **enables** in the community-plugins list on iOS and Android **without crashing**. (Regression guard: no file-scope `require("fs")` / `require("path")` in `main.js` — `grep -E '=require\("fs"\)|=require\("path"\)' main.js` must return zero.)
- [ ] 📱 `styles.css` is applied (check both light and dark themes).
- [ ] 🖥️📱 The same repo synced from both a desktop and a mobile vault stays consistent.

## 2. Sync — end-to-end flows (🌐 real GitHub)

- [ ] 🖥️ **Bare-repo bootstrap:** the first sync into an empty repo creates the structure, `.gitignore`, and the snapshot manifest.
- [ ] 🖥️ **Adoption:** the first sync against a non-empty repo produces no duplicates or losses; conflicts are classified.
- [ ] 🖥️ **Incremental:** edit a file → `[Sync]` → it commits and pushes; delete a file → the deletion reaches the remote.
- [ ] 🖥️ **Pending deletions:** delete a file and sync → it is removed on the remote; on a second device, pull removes it locally.
- [ ] 🖥️ **"Sync starts with commit" = off:** `[Sync]` only pulls/pushes; the `[Commit]` ribbon button (or the *Commit local changes* command) commits separately.
- [ ] 🖥️ **Interval scheduler:** the periodic tick syncs automatically; an initial sync runs shortly after the vault opens.
- [ ] 🖥️ **Ribbon & status bar:** sync/commit icons work; the conflict counter (🔀) updates; the status reads *Syncing… / idle / Last error*.
- [ ] 🖥️ **Push-queue persistence:** start a sync, force-quit Obsidian mid-push, relaunch → the queue is drained to completion by the recovery sweep.
- [ ] 🖥️ **Large vault** (1000+ files): syncing does not freeze the UI (heavy work runs off the main thread).

## 3. Mobile-specific (📱 — Capacitor is not unit-tested)

- [ ] 📱 **Capacitor rename:** conflict resolution and atomic writes never fail with *"Destination file already exists"* (iOS/Android `rename` does not overwrite; the code must remove-then-rename).
- [ ] 📱 **Binary files** (PNG, PDF) sync without corruption (binary read/write path, not the text path).
- [ ] 📱 **Token with trailing whitespace** (pasted from the keyboard suggestion bar) still works — input is trimmed and existing values self-heal on restart.
- [ ] 📱 **Low-memory kill:** while editing or syncing, let the OS kill Obsidian → on relaunch the vault is consistent and the recovery sweep has run.
- [ ] 📱 **Battery death** (let the device power off below 1% mid-sync) → on relaunch, no corruption and no 0-byte files.
- [ ] 📱 **Touch:** ribbon, settings, and the conflict list respond to taps as they do to clicks on desktop.

## 4. Conflict resolution / pseudo-merge — end-to-end (🌐)

- [ ] 🖥️📱 Two devices edit the same file → a conflict sibling `*.conflict-from-<device>-<timestamp>.*` is created.
- [ ] 🖥️ The conflict counter (🔀) in the status bar updates as siblings appear and clear.
- [ ] 🖥️ **Auto-merge:** non-overlapping edits merge cleanly (3-way); overlapping edits produce a sibling.
- [ ] 🖥️ **Edit while in conflict:** editing the base file while a sibling exists does not lose the edit.
- [ ] 🖥️ The pre-sync conflict dialog shows the count and lets you confirm.
- [ ] 🖥️ When a sibling is reconciled to match the base (identical content), the sibling is cleared on the next sync.
- [ ] 🖥️ **Multi-device rotation:** run a realistic round-trip across 2+ devices.

## 5. Diff-editor widget (⏳ once bundled into `main.js`)

> The editor **model** is fully unit-tested (`tests/diff2/`). This section covers
> what needs real layout/geometry and the end-to-end user experience.

**Layout / geometry (Playwright or a real device):**

- [ ] **Wrapping:** a 200-character line in a narrow editor (~30 columns) wraps; the `↵` glyph appears **only** at real newlines, and wrapped continuation rows have an empty gutter (one line number for the whole logical line).
- [ ] **Vertical arrows** within a wrapped long line move row by row (they do not jump over the line).
- [ ] **Page Up / Page Down** over large change blocks (10+ lines) scroll and position the caret correctly.
- [ ] **Ctrl/Cmd-Home / Ctrl/Cmd-End** jump to the first/last line — verify the case where the first line is a **hidden empty "local" block** and the last is a **hidden empty "remote" block** (they reveal/activate correctly).
- [ ] **Home / End** on a wrapped line behave sensibly (visual vs logical line start/end).
- [ ] **Entering an empty change block:** pressing Down from a normal line above an empty block reveals a temporary blank line; pressing Down again without typing collapses it and moves on. Up from below is the mirror.
- [ ] **Markers:** the `<<<<<` / `=====` / `>>>>>` rows render as block widgets; the action buttons (apply / remove / both / neither / join) are clickable; the device label shows on the top/bottom markers.
- [ ] **Colours:** the local side is red, the remote side green, and intra-line word differences get a yellow overlay (blending to orange / olive).
- [ ] **No-trailing-newline edge:** a whole-file single-line difference (e.g. local `"abc"` vs remote `"XYZ"`) renders without errors and without a marker landing mid-line.

**End-to-end UX:**

- [ ] Opening the editor from each entry point (file menu *Resolve conflict*, the diff ribbon icon, the post-sync summary modal).
- [ ] Resolving via the buttons and via the hotkeys (`Ctrl+Enter` / `Ctrl+Backspace` / `Ctrl+Shift+Enter` / `Ctrl+Shift+Backspace` / `Ctrl+Shift+.`).
- [ ] **`[← Back]`** writes the resolved file, removes a now-redundant sibling, and returns to the list.
- [ ] **`[×]`** (tab close) discards the session; the vault is left as it was before editing.
- [ ] **One editor at a time:** clicking another conflict during an active edit shows a *"close the current edit first"* notice instead of losing work.
- [ ] **Select all + delete** then `[← Back]` saves a single newline (not a 0-byte file).
- [ ] **Standard editing commands** (delete line, delete word, Home/End, Page Up/Down) behave normally and never corrupt the merged view. (Note: *delete to end of line* / Ctrl+K is not bound yet — verify if/when added.)

**Autosave & recovery (⏳ later milestone):**

- [ ] Edit, force-quit Obsidian, reopen the conflict → a recovery dialog offers *Continue editing*, which restores the in-progress state with the caret roughly where it was; Undo steps back through the edits.
- [ ] *Start over* discards the session and starts fresh from the current files.
- [ ] If the underlying files changed during the session (a sync pulled new content), a dialog offers *restore the previous version / discard / cancel*.
- [ ] If the files changed by the time you press `[← Back]`, a dialog offers *save to alternative paths / overwrite / cancel*.

## 6. Settings & lifecycle (🖥️📱)

- [ ] Token / owner / repo / branch fields trim input; invalid values produce a clear error (not a silent 404).
- [ ] The settings connection test works and does not disturb sync state.
- [ ] **Reset** (type the confirmation phrase) wipes the token, repo settings, sync history, pending queue, and conflicts; local vault files are untouched; unresolved siblings are renamed to `.unresolved`.
- [ ] Toggling **"sync config folder"** includes/excludes `.obsidian/*` accordingly.
- [ ] Changing the **device label** makes new commits carry the new `(label)` suffix.
- [ ] Switching repositories resets state correctly.
- [ ] The **max auto-merge size** setting prevents very large files from being auto-merged.
- [ ] Token expiry (401/403) shows the token-expired recovery dialog.

## 7. Self-update (🖥️📱)

- [ ] Updating the plugin through itself: it completes and restarts after the update.
- [ ] 📱 On mobile the plugin auto-reloads (disable + enable) after a self-update, with no manual step.

## 8. Crash / recovery / edge cases (🖥️📱)

- [ ] A crash between atomic-write steps is completed forward by the recovery sweep on the next launch.
- [ ] **Zero-byte restore guard:** a file that had content but accidentally became 0 bytes is restored to its last good version, and the empty copy never reaches the server.
- [ ] Out-of-band drift (another tool changed the repo) reconciles correctly.
- [ ] Disabling then re-enabling the plugin mid-sync causes no double-run or corruption.

## 9. Performance (📱)

- [ ] **Mobile autosave benchmark** (Settings → *Run mobile autosave benchmark*): run on a mid-tier Android and on iOS; collect the p50/p95/p99 figures and send the log so the autosave timing can be tuned.
- [ ] A large conflict (hundreds of change blocks) in the diff editor stays responsive on mobile.

---

*Keep this checklist current as features are added that automated tests do not
cover. When a ⏳ feature ships, drop the marker and fold it into the release run.*
