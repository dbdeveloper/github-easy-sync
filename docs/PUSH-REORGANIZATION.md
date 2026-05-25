    # Push Pipeline Reorganization

    > Design rationale for the push-side reorganization following the
    > 2026-05-23..25 series of cross-platform and cross-device sync bugs.

    ## Abstract

  Between 23 May and 25 May 2026 the `github-easy-sync` plugin shipped a
  release (`2.0.1-beta` → `2.0.1-beta2`) that fixed two long-standing
  field bugs — Obsidian Mobile refusing to materialise files with
  Windows-forbidden characters in the name, and the GitHub Contents
  endpoint silently 404-ing URLs containing query-syntax characters —
  but in the process amplified the frequency of a third bug that had
  existed at low volume since pseudo-merge mode landed: `GitRPC::
  BadObjectState` (HTTP 422) on every push whose batch carries a
  deletion entry for a path no longer present at GitHub's current head.

  The five bugs of the 2026-05 series are not five independent
  incidents. Each one is an instance of the same structural class:
  **a push operation acts on an assumption about remote state that may
  not hold by the time the operation reaches GitHub.** The pull-side
  sanitize work that landed in `2.0.1-beta2` doesn't *cause* the 422 —
  it produces phantom snapshot entries that make the assumption hold
  less often. The bug class itself is older and broader.

  This document proposes a phased reorganisation of the push pipeline
  that removes the class, not just the most recent instance of it. The
  reorganisation is composed of five structural shifts; each can ship
  independently as a separate PR; the first shift (pre-flight validation
  in `createTree`) alone makes the immediate 422 case unreachable and is
  the candidate for the next hotfix release. The remaining four lift
  the rest of the class out of reach over the following weeks.

  The document assumes a reader who has skimmed
  [`PSEUDO-MERGE-MODE.md`](./PSEUDO-MERGE-MODE.md) (for the architectural
  context — what `processBatch`, snapshot store, `evaluateConflictState`
  mean) but is otherwise approaching the push pipeline fresh.

  ---

  ## 1. The Bug Catalog (2026-05-23 to 2026-05-25)

  Five bugs in seven days. Each is recorded with its log signature, its
  proximate cause, and the fix that did or did not land in `2.0.1-beta2`.
  Listed in the order they were diagnosed.

  ### 1.1 `FILE_NOTCREATED` on Obsidian Android

  **Symptom.** Mobile sync of a desktop-created file named
  `Actual-projects/Ладовіра/Штрихи до "святої" книги "Віра в Лад".md`
  failed with a Notice `Error syncing. Error: FILE_NOTCREATED`. The
  plugin log captured the error only after the observability fixes
  (§1.2) landed; the full message was an Obsidian-internal "this name
  is invalid on this platform" rejection from `win.androidBridge.
  onmessage`.

  **Cause.** Obsidian Android refuses to create files whose name
  contains any of the Windows FAT/NTFS-forbidden ASCII characters
  (`< > : " | ? * \`) — independently of the underlying filesystem,
  likely as a cross-platform-compatibility safeguard so a vault that
  syncs to a Windows desktop won't break. Desktop Obsidian on macOS or
  Linux happily creates such names because the underlying POSIX
  filesystem allows them.

  **Fix in `2.0.1-beta2`.** `src/sync2/filename-sanitizer.ts` rewrites
  the offending ASCII characters (plus the Obsidian-wiki-link-forbidden
  set `# ^ [ ]`) to canonical Unicode replacements (curly quote for `"`,
  modifier-letter colon for `:`, fullwidth glyphs for the rest) on both
  the push side (pre-sync vault walk, before `findChanges`) and the pull
  side (incoming GitHub paths get rewritten to the canonical form
  locally, with a snapshot entry at the original forbidden path so the
  next push emits a deletion that cleans GitHub).

  ### 1.2 `err: {}` in the plugin log

  **Symptom.** Every recorded sync failure showed `additional_data:
  {"err": {}}` — the captured error object serialised as an empty
  object. Bug reports were unactionable: we knew sync had failed, but
  not why or where.

  **Cause.** Two layers. (1) The `sync()` and `syncCurrentFile()`
  click handlers in `main.ts` caught errors and showed a Notice but
  never called `logger.error`. The toast disappeared in seconds; the
  log saw nothing. (2) When the catch site DID reach a logger call
  (e.g. the interval-drain handler), `safeStringify` only unwrapped
  `v instanceof Error` to extract `name`/`message`/`stack`. Capacitor's
  native-bridge errors on Android come through as objects whose
  `instanceof Error` evaluates to `false` (different JS realm) and
  whose Error-shape fields live on the prototype rather than as own
  enumerable properties. `JSON.stringify` of such an object produces
  `{}`.

  **Fix in `2.0.1-beta2`.** `src/utils.ts::describeError(err)`
  deterministically extracts `type`, `ctor`, `string` (via
  `String(err)`), and the Error-shape fields via direct property access
  that survives prototype-only definitions. `src/logger.ts::
  safeStringify` mirrors the same extraction so any `logger.error(msg,
  { err })` site benefits without explicit wrapping. The two click
  handlers in `main.ts` log before the Notice.

  ### 1.3 `404` on GitHub Contents URLs containing `?`, `#`, etc.

  **Symptom.** A file named `[1] File ^ opa?.md` pushed via the GitHub
  web UI was unreachable by pull. `GET contents/[1] File ^ opa?.md`
  returned 404 despite the file existing in the GitHub tree.

  **Cause.** `src/github/client.ts` interpolated the file path directly
  into the Contents-API URL with no encoding. URL-syntax characters
  (`?`, `#`, ` `, etc.) terminate the path component on the server side:
  the API saw the path as `[1] File ^ opa` with `md` as a query
  parameter — no such file at that path → 404.

  **Fix in `2.0.1-beta2`.** `encodePathForGithub(path)` splits the path
  on `/` (preserving the structural separator), percent-encodes each
  segment via `encodeURIComponent`, and rejoins. Applied at both
  Contents-API URL construction sites in `src/github/client.ts`.

  ### 1.4 Orphaned state after silent skip on null fetch

  **Symptom.** After the URL-encoding bug in (1.3) was hit on mobile,
  the `[1] File ^ opa?.md` file remained absent from the mobile vault
  on every subsequent sync — even after the encoding fix shipped to
  mobile. A Plugin Reset (full re-bootstrap) was required to recover.

  **Cause.** `applyRemoteAddOrModify` in `sync2-manager.ts` treated a
  `safeFetchContents → null` result as "raced with subsequent remote
  delete; skip this file." The 404 from the URL-encoding bug returned
  null. The pull loop continued; `lastSync` advanced to the new branch
  head. From the next sync forward, the compare diff between
  `lastSync` and `currentHead` no longer surfaces the file as a change
  (it's present at both ends with the same SHA — what differs is the
  local state, which compare doesn't see). The file became invisible
  to incremental sync.

  **Fix in `2.0.1-beta2`.** `applyRemoteAddOrModify` now throws when
  `safeFetchContents` returns null on a path the compare diff lists as
  added or modified. The per-file catch in `pullIfNeeded` logs the
  exact path; the loop aborts; `lastSync` stays at the prior
  `expectedHead`; the next sync retries. Either succeeds (transient
  race, permission drift, deploy of fixed client) or re-fails until
  the underlying cause is fixed — no orphan state.

  ### 1.5 `GitRPC::BadObjectState` (422) on stale deletion entries

  **Symptom.** Two desktop syncs within thirty minutes of the
  `2.0.1-beta2` release produced six retries each (~17 seconds of
  network noise) and a final `Error: Failed to create tree, status
  422`. Both pushes carried a deletion entry for a path that had been
  sanitized away on a different device hours earlier. The user had
  *never* seen this error in `2.0.1-beta` and saw it twice in half an
  hour in `2.0.1-beta2`.

  **Cause.** The pull-side sanitize in `pullIfNeeded` writes incoming
  GitHub forbidden-named files to canonical local paths and records a
  **phantom snapshot entry** at the *forbidden* GitHub path with the
  GitHub blob SHA. `ChangeDetector` Pass 2 sees this snapshot entry
  has no local file → emits a deletion change → `TreeBuilder` builds a
  `sha:null` entry for the forbidden path → push attempts to
  `createTree` with a deletion targeting a path that has already been
  deleted from GitHub by another device's sanitize-push earlier.
  GitHub responds 422 `GitRPC::BadObjectState`.

  The 422 itself is a GitHub server-side reaction we cannot prevent
  from the client — we can only avoid sending tree requests whose
  deletion entries reference already-absent paths.

  The bug existed before `2.0.1-beta2` (memory file `project-github-422-
  on-deletion-entry.md` records an earlier occurrence) but was rare
  because the only way to produce a stale deletion was a manual edit on
  GitHub web between the user's two syncs. Pull-side sanitize introduced
  a SYSTEMATIC source: any forbidden path migrated by Device A produces a
  phantom on Device B that becomes stale as soon as Device B pulls
  post-migration. Frequency went from "occasional" to "every multi-device
  sanitize cycle."

  **Fix in `2.0.1-beta2`.** None. The bug was diagnosed post-release.
  This document's Phase 1 proposes the structural fix.

  ---

  ## 2. The Patterns Underneath

  Five bugs is enough to draw a pattern. Each is an instance of one or
  more of these five fragility patterns. The patterns are listed in
  rough order of how load-bearing they are — the first three explain
  four of the five bugs; the last two are amplifiers.

  ### 2.1 Optimistic operations against unvalidated remote state

  The push pipeline sends `createTree` requests built from local
  in-memory state (the batch, the snapshot, the ChangeDetector output)
  without checking that the remote state matches what the local state
  assumes. The most visible instance is the 422 on stale deletion
  entries (1.5): we send a deletion for a path that local state thinks
  exists on GitHub, but GitHub already deleted it. A less visible
  instance is the URL-encoding 404 (1.3): we constructed a Contents-API
  URL from a local-format path without checking it round-trips through
  URL-syntax rules.

  The cure is **pre-flight validation**: before any operation that
  targets specific GitHub objects, validate the targets against current
  remote state.

  ### 2.2 State assumptions that decay over wall-clock time

  The pull-side phantom snapshot (1.5) is the cleanest example. At the
  moment the phantom is set, the assertion "GitHub has this forbidden
  path with this SHA" is true. Five minutes later — after another
  device's sanitize-push — the assertion is false. The assumption
  decayed silently; nothing in the code notices.

  The same shape appears across the codebase: `lastSyncCommitSha`
  captured at sync-start can be stale by push time if another device
  pushed concurrently (handled by reconcile); `parentTreeSha` recorded
  in a queued batch can be stale across plugin restarts; the
  `isSyncable` decision is cached against a gitignore that the user can
  edit between calls.

  The cure is **explicit time-bounded state**: any state whose validity
  depends on remote-side conditions should carry the commit SHA it was
  captured at, and any operation that consumes it should verify the SHA
  still matches.

  ### 2.3 Silent skips that corrupt invariants

  The orphan-state bug (1.4) is the textbook case. `applyRemoteAddOrModify`
  returned early without throwing on a null fetch; the loop continued;
  `lastSync` advanced; the file became invisible. The skip looked
  "defensive" — it avoided crashing on an edge case — but the edge case
  was a real failure that needed an explicit response, not silent
  absorption.

  Less visible instances: the gitignore-ignored remote path is
  "silently dropped" from the pull diff (correct behaviour, but only
  because the snapshot delete is also gated on the same predicate —
  brittle); `applyRemoteDeletion` no-ops when the local file is already
  gone (correct, but if the snapshot still has an entry, the no-op
  leaves the snapshot stale).

  The cure is **explicit reasons for every skip**: a single audit pass
  to enumerate every `return;` and `continue;` in the push and pull
  loops, label each with one of {"already-applied", "deferred-by-design",
  "unexpected-state"}, and ensure the third case logs at `error`
  level and either throws or sets a deferred-retry flag — never
  advances cursor state.

  ### 2.4 Errors swallowed without diagnostic data

  The empty-`err: {}` log (1.2) was a pure observability failure: the
  catch site existed, but the data it captured was useless. The fix
  (§1.2) was small mechanically but very valuable: every catch site now
  produces an inspectable record.

  The general lesson is that **logging contracts** need to be
  load-bearing, not afterthoughts. The plugin's logger has a clear
  contract (`info` / `warn` / `error`, structured `additional_data`,
  size-bounded), but call sites historically were inconsistent: some
  catches logged before showing a Notice, some didn't; some passed the
  raw `err`, some passed `${err}` (which calls `Error.prototype.toString`
  and loses the stack), some passed `{ err: ${err} }`. After `2.0.1-
  beta2`'s push-side `describeError` helper, the rule is consistent:
  every catch site calls `describeError(err)` before logging or formatting
  for the Notice.

  The cure is **a `Logger` API that makes the wrong thing harder than
  the right thing** — accept `err` directly, run it through
  `describeError` internally, never accept a stringified error. (The
  existing `safeStringify` does most of this; the next step is to make
  the call-site contract more explicit, possibly via a typed
  `LogContext` parameter.)

  ### 2.5 Scattered cross-platform contracts

  The forbidden-character set lives in `src/sync2/filename-sanitizer.ts`.
  The URL-encoding rules live in `src/github/client.ts`. The
  Capacitor-rename-doesn't-overwrite pattern lives in
  `src/sync2/atomic-write.ts` and `src/sync2/conflict-store.ts`. The
  `isSyncable` blocklist lives in `src/sync2/change-detector.ts`. The
  Mobile-vs-Desktop quirk inventory lives nowhere — it's distributed
  across CLAUDE.md prose, code comments, and inline `Platform.
  isDesktopApp` checks.

  Each individual location is correct in isolation. The problem is
  that **adding a new cross-platform constraint requires touching N
  files**, and a future contributor (or future-us) is likely to update
  some but not all. The 422-on-stale-deletion case (1.5) is structurally
  adjacent to this pattern: the sanitize mechanism understands forbidden
  chars but doesn't understand that "deletion entries need pre-flight
  validation against GitHub state" — these are two pieces of one
  contract held in separate modules.

  The cure is **a single `cross-platform-contracts.ts` module** that
  owns: the forbidden-character set, the URL-encoding policy, the
  adapter-rename-semantics differences, the Mobile-vs-Desktop platform
  gates, and (newly) the validation-before-push policy. Other modules
  import from it; nobody encodes a contract inline.

  ---

  ## 3. Architectural Shifts

  The five shifts below address the five patterns above. They are
  ordered by cost-to-value: shift #1 buys the most safety per line of
  code, shift #5 is the longest-running cultural change. Each shift is
  independent — they can ship in any order — but the listed order is
  what we'd recommend for sequencing.

  ### 3.1 Pre-flight validation in `createTree`

  The 422-on-stale-deletion bug is unreachable if every `createTree`
  call validates its deletion entries before sending. Validation is
  cheap (per-entry `getContentsAtRef` against `currentHead`, or one
  `tree?recursive=1` fetch for batches with many deletions) and the
  result is conclusive — either the path exists at `currentHead` and
  the deletion is legitimate, or it doesn't and the deletion is stale
  and must be dropped.

  The validator lives between `TreeBuilder.buildTreeEntries` and
  `client.createTree` inside `processBatch`. It receives the entries
  list and `currentHead`, returns a filtered entries list. Entries
  with `sha:null` are checked; entries with inline `content` or with
  an existing blob `sha` are passed through unchanged. If the filtered
  batch becomes empty (no `content` entries AND no remaining
  deletions), the push is skipped and the batch is deleted from the
  queue — mirroring the existing "empty after reconcile" branch.

  The validator MUST also drop the matching snapshot entry when it
  drops a deletion. Without this, `ChangeDetector`'s next pass would
  re-emit the same stale deletion and the next push would re-validate
  and re-drop it — a no-op loop that wastes one HTTP call per sync.
  With the snapshot drop, the system self-heals: after one
  sync-with-drop, the phantom is gone and no future ChangeDetector
  pass references it.

  Out of scope here: validating non-deletion entries (modifications,
  additions). Those have content the server will resolve regardless
  of base-tree state; their failure modes are different and rarer.
  We address only the specific structural pattern that produced 1.5.

  ### 3.2 Replace phantom snapshots with an explicit pending-deletions queue

  The pull-side sanitize's phantom snapshot trick is clever but
  semantically dishonest: the snapshot store is documented as "what we
  believe GitHub had at the last sync we observed" — a phantom entry
  violates that contract, because the entry's purpose isn't "remember
  this is on GitHub" but "remember to delete this from GitHub later."

  A cleaner shape is an explicit `pending-deletions` queue stored in
  `<configDir>/plugins/<self>/.pending-deletions/<id>/`. Each entry
  records the path, the source (`pull-side-sanitize` / `manual` /
  `tool-other-than-obsidian`), and the GitHub commit SHA at which the
  path was last observed present. The push pipeline reads from this
  queue alongside the normal change-detector output, builds deletion
  entries from it, and on successful push, deletes the corresponding
  queue entries. Pre-flight validation (§3.1) becomes a property of
  queue entries (skip-and-delete when the path is already absent at
  current HEAD) rather than a special case in `createTree`.

  This shift also makes the snapshot store invariant cleaner. Without
  phantoms, every snapshot entry is "we observed this path with this
  SHA at this commit on GitHub" — a verifiable fact. Anyone reading
  the snapshot can trust its values without checking whether each
  entry is real or a delete-intent.

  The migration is one-way and read-only safe: on first plugin load
  after the shift lands, snapshot entries whose path is identified as
  phantom (mtime=0, size=0 — the current phantom signature) get
  extracted into the new pending-deletions queue and removed from the
  snapshot. After that, the snapshot has only real entries; pending
  deletions live in their own store.

  **Reset semantics.** The new queue is plugin-managed state — Plugin
  Reset (Settings → Reset) wipes it along with the snapshot, the
  push-queue, the conflict store, and the rest. Plugin uninstall
  (Settings → Community plugins → Uninstall) removes the entire
  `<configDir>/plugins/<self>/` directory through Obsidian's own
  cleanup, so the queue cannot outlive the plugin. There is no
  uninstall-cleanup step to author — the only Reset-relevant change
  for this store is one line in `resetPluginState`: also clear
  `.pending-deletions/`.

  ### 3.3 Centralize cross-platform contracts

  A new module `src/sync2/cross-platform.ts` owns the union of
  platform-specific contracts:

  - The forbidden-character set and its Unicode replacements (currently
    in `filename-sanitizer.ts`).
  - The URL-encoding policy for GitHub API paths (currently in
    `github/client.ts`).
  - The adapter-rename-doesn't-overwrite pattern as a callable helper
    `safeRename(adapter, src, dst)` (currently inlined into
    `atomic-write.ts` and `conflict-store.ts`).
  - The platform-gate predicates (`Platform.isDesktopApp` checks
    currently scattered across `main.ts`, `settings/tab.ts`, and the
    external-diff-tool code).
  - The validation-before-push policy from §3.1 (so the validator's
    decision about which characters/paths need extra validation is
    collocated with the rest of the contracts).

  The shift is mechanical: extract, leave thin re-exports in the old
  locations during one release cycle to avoid breaking external
  references (if any), then delete the re-exports in the cycle after.
  No behavioural change; the win is that adding a new platform quirk
  in the future touches one file.

  ### 3.4 Typed error classes

  The push pipeline currently distinguishes errors by reading
  `(err as { status?: number }).status` — duck-typing against GitHub's
  HTTP error envelope plus ad-hoc message-string matching. The
  condition for retry (in `retryUntil`) is a status-code-driven
  predicate. The condition for "treat-as-not-found" (in
  `safeFetchContents`) is `status === 404`. The condition for "treat
  as bare repo" is `status === 404 || status === 409`. These read
  like magic numbers.

  Introducing a small hierarchy of error classes makes the dispatch
  explicit:

  ```
  SyncError  (base — never thrown directly)
  ├── NetworkError  (transient — retry)
  ├── GithubAPIError  (already exists — typed status code)
  │   ├── NotFoundError  (404)
  │   ├── ConflictError  (409 — bare repo, ref mismatch)
  │   ├── ValidationError  (422 — malformed request envelope, missing required fields)
  │   ├── AuthError  (401, 403 — token problems)
  │   └── RateLimitError  (429 — backoff)
  ├── PlatformError  (Capacitor / WebView — non-retriable, user-visible)
  └── StaleStateError  (local state contradicts current GitHub state — covers
                       the 1.5 `GitRPC::BadObjectState` 422 sub-case where the
                       entries are well-formed but reference paths that drifted
                       under us; see Open Questions for the dispatch rule)
  ```

  Each catch site dispatches on type, not status code. The retry
  predicate lives on the error class itself (`error.retriable`). The
  user-facing Notice text is derived from the error class. Logging
  records the class name instead of just "Error" — bug reports become
  classifiable.

  The migration is gradual: new code throws typed errors immediately;
  old code paths get migrated one at a time as bugs hit them. No
  big-bang rewrite needed.

  ### 3.5 No silent skips: every operation logs an explicit outcome

  This is the cultural shift, not a code shift. The audit pass:

  1. Enumerate every `return;` and `continue;` in `pullIfNeeded`,
     `applyRemoteAddOrModify`, `applyRemoteDeletion`, `processBatch`,
     `reconcileBatchAgainstHead`, `bootstrapFromRemote`, and
     `adoptionPullAndRecord`.
  2. For each, label as one of:
     - **applied** — the operation completed; the cursor (snapshot,
       lastSync, queue) advances normally.
     - **deferred** — the operation is intentionally postponed; some
       other code path will handle it; the cursor does NOT advance for
       this path.
     - **already-correct** — the desired state is already on disk;
       skip is a true no-op; the cursor may advance.
     - **unexpected** — the operation could not be applied and we don't
       know why; the cursor MUST NOT advance; log at error level.
  3. Replace each unlabeled `continue` with a labeled helper:
     `skipApplied("reason")`, `skipDeferred("reason")`,
     `skipAlreadyCorrect("reason")`, or — for the unexpected case —
     `throw new StaleStateError("reason", { context })`.

  The "unexpected" category is the one we keep getting wrong. The
  2.0.1-beta2 fix to throw on unexpected null fetch (1.4) is one
  instance of this audit. There are others; we just haven't been bitten
  by them yet.

  ### 3.6 Visible push-queue depth on the ribbon sync icon

  The plugin's ribbon `[Sync with GitHub]` icon currently carries a
  numeric badge whose meaning is "how many unresolved conflicts the
  user has." That signal is redundant with the status-bar `🔀 N`
  indicator (which is the canonical home for the conflict count —
  see PSEUDO-MERGE-MODE.md §5), and it tells the user nothing about
  the state of the push pipeline itself. The most common
  field-confusion pattern is: a user clicks Sync, the click body
  finishes locally, drain runs in the background, the user can't
  tell whether the click landed — so they click again and inflate
  the queue.

  Replace the badge with **the current depth of the push-queue** —
  the number of batches currently on disk under `.push-queue/`
  waiting for `drain()` to dispatch them.

  **Display rules:**

  - 0 batches on disk → no badge (idle state — same visual as
    "nothing to sync").
  - N > 0 batches → badge shows `(N)`.

  **Lifecycle transitions** match the user's mental model of "I
  clicked Sync; where did my work go?":

  1. User clicks `[Sync with GitHub]`. The click body (local-only —
     no network at this stage) materialises one batch into
     `.push-queue/`. The badge flips to `(1)`.
  2. `drain()` runs (immediately on the same click, or on the
     interval tick). When the batch's push succeeds, the queue
     directory is deleted; the badge returns to no-display.
  3. **Offline scenario:** `drain()` raises a network error;
     the batch survives on disk; the badge stays `(1)`. The
     user notices the click "didn't go anywhere" without having
     to inspect the log. Another click adds a second batch (or
     accumulates into the first, per
     `accumulateOfflineSyncs`) — badge becomes `(2)`. Continues
     accumulating while offline.
  4. **Reconnection:** the interval-tick drain processes the
     queued batches one at a time. Badge decrements: `(3)` →
     `(2)` → `(1)` → no-display. The decrement is the
     reassurance signal — the user sees backlog shrinking.

  **Why this is honest signal.** The push-queue depth is a
  *real* property of the plugin's on-disk state; the conflict
  count was a *derived* property of the snapshot + sibling
  index. The push-queue depth changes only when an operation
  the user themselves initiated (Sync click) or completed (drain
  finish) modifies the queue — there's no surprise update. The
  conflict count, by contrast, can change because *another
  device* pushed a conflicting edit, which is an event the
  ribbon icon has no business surfacing as a delta on the *Sync*
  surface.

  **Where the conflict count lives instead.** Two surfaces, both
  opt-in via settings:

  - Status bar `🔀 N` — unchanged from current behaviour.
  - A NEW ribbon icon dedicated to the diff2 widget (see
    `DIFF2_IMPLEMENTATION_PLAN.md` R2.7.4 — outside the scope of
    this push-pipeline doc).

  The sync icon stops being a status indicator for the conflict
  layer; it becomes a status indicator for the push pipeline
  alone. Cleaner separation.

  **Implementation surface (notes for the implementer).**

  - `PushQueue.depth()` (or similar) returns the count of
    directory entries under `.push-queue/`. Cheap — already
    listed by `queue.list()` in multiple places.
  - The ribbon icon component subscribes to a "queue-depth-
    changed" signal. Sources of changes:
    - `enqueueOrMerge` (after persisting a new batch) emits +1
      or +0 (depending on whether merge fold-in happened).
    - `processBatch` (after `queue.delete(id)`) emits -1.
    - Any startup path that finds pre-existing batches on disk
      emits the current count once.
  - This is a UI subscriber pattern — **no push-pipeline
    behavior changes**. The queue is the source of truth; the
    badge is a read-only mirror.

  **Independence.** This shift is purely additive to Phases 1–5
  and orthogonal to them. It can land in any release; sequencing
  doesn't matter. The PR is small (one new event subscriber, one
  badge-format change, the conflict-count badge removal). Its
  shipping order in the broader plan is flexible — recommended
  bundling with Phase 4 (typed errors) since both touch the
  ribbon-status code path, but no hard dependency exists.

  ---

  ## 4. Phased Implementation

  Five phases, each shippable independently with its own PR, tag, and
  beta. Sequencing reflects the cost-to-value ordering of §3 — Phase 1
  is the immediate hotfix candidate; later phases are weeks of
  back-to-back work.

  | # | Status | Scope | Approx. effort | Acceptance |
  |---|---|---|---|---|
  | 1 | **hotfix** | Pre-flight validation in `createTree` (§3.1) | ~1–2 days impl + review | The 422-on-stale-deletion case from 1.5 is unreachable. Stale deletion entries are dropped with a log line and the matching snapshot entry is removed. If the batch becomes empty after filtering, push is skipped. New unit test with a faked `getContentsAtRef` returning null; new integration test seeding a stale deletion via cross-device race (multi-client fault-injection setup is the bulk of the test work — separate from code). Release as `2.0.1-beta3`. |
  | 2 | minor | Pending-deletions queue (§3.2) | ~1 week | Pull-side sanitize writes to the new queue instead of the snapshot. ChangeDetector reads from both. One-way migration on plugin load extracts existing phantom entries from the snapshot. All sync2 unit tests pass unchanged; one new test for the queue's persistence + recovery; one integration test for the round-trip "sanitize-on-pull → push delete → queue entry removed." Release as `2.0.2-beta`. |
  | 3 | minor | `cross-platform.ts` module (§3.3) | ~3 days | Forbidden-character set, URL encoding, `safeRename`, platform predicates, validation-policy callable all live in one module. Old locations have thin re-exports with `@deprecated` JSDoc. No behavioural change; full unit + integration suite still green. Release with Phase 2 if timing aligns. |
  | 4 | minor | Typed error classes (§3.4) | ~1 week | New error hierarchy under `src/errors.ts`. GitHub client throws typed errors. `retryUntil` dispatches on class. Three highest-traffic catch sites (`sync()` in main, `processBatch`, `applyRemoteAddOrModify`) migrated to type-based dispatch. Logger records class name. Rest of the codebase migrates opportunistically. Release as `2.0.3-beta`. |
  | 5 | refactor | Silent-skip audit (§3.5) | ~3 days | One audit doc enumerating every skip site with its label. Every "unexpected" site throws `StaleStateError`. Every "deferred" / "already-correct" / "applied" site has a one-line comment with the label and reasoning. No behavioural change for the first three categories; the "unexpected" category gains explicit error surfacing. Release with Phase 4. |
  | 6 | minor | Push-queue depth badge on the ribbon sync icon (§3.6) | ~2 days impl + review | Ribbon `[Sync with GitHub]` badge now reflects `PushQueue.depth()` rather than the conflict count. The conflict count moves off this icon entirely (status-bar `🔀 N` and the diff2 ribbon icon — see DIFF2 plan — are the two surfaces it lives on). Verify lifecycle transitions manually: click on idle vault → `(1)` → drain success → no-badge; offline → click → `(1)` accumulates; reconnect → decrement to no-badge. No automated test required for the badge text (UI surface), but the underlying `PushQueue.depth()` gets unit coverage. Release independently — any beta cycle, no dependency on Phases 1–5. |

  Dependencies between phases are minimal:

  - Phase 1 stands alone (the hotfix candidate).
  - Phase 2 depends on Phase 1 only in the sense that pre-flight
    validation is what makes the new queue safe (without it, stale
    queue entries would still 422); but it can ship without Phase 1
    if pre-flight validation lands inside the queue's push logic.
  - Phase 3 stands alone.
  - Phase 4 stands alone but is cleanest if it lands before Phase 5
    (so the audit has typed errors to use).
  - Phase 5 depends on Phase 4 for `StaleStateError`.
  - Phase 6 stands alone. Touches the ribbon-status component (also
    touched by Phase 4) but the two are orthogonal in code.

  Skipping any phase doesn't break the others. The roadmap is a budget
  allocation, not a critical path.

  ---

  ## 5. What Stays the Same

  To make clear this is not a rewrite, here is what is explicitly out
  of scope:

  - **The pseudo-merge conflict layer** (§4–§10 of
    [`PSEUDO-MERGE-MODE.md`](./PSEUDO-MERGE-MODE.md)). The conflict
    branch, sibling files, Phase A/B at drain start, the three-step and
    five-step atomic write protocols, the unified recovery sweep — all
    untouched. The reorganisation lives one layer above the conflict
    layer and consumes its outputs (the snapshot, the queue, the
    conflict store) as read-only state.

  - **The `findChanges` + ChangeDetector mechanism.** Pre-sync vault
    walks, `mtime` watermarks, the gitignore filter, the snapshot
    diff — all unchanged. The reorganisation only changes how the
    push pipeline acts on the change list, not how the change list is
    computed.

  - **The bootstrap-from-remote flow.** First-ever sync against a
    non-bare repo, the per-file SHA-match resume, the
    canonicalize-aware skip — all untouched. The reorganisation does
    not alter the adoption path.

  - **The conflict-branch finalize.** Marker commit, merge-commit on
    main, branch-label deletion — unchanged. The merge-commit's tree
    construction does not go through `createTree` with deletions, so
    pre-flight validation does not gate it.

  - **The split-push partition.** Conflicting paths go to the conflict
    branch; non-conflicting paths go to main. The split itself is
    unchanged; only the main-branch leg gets the new push-pipeline
    guarantees. The conflict-branch push is structurally simpler (a
    single commit appending the device's current view of the
    conflicting files) and doesn't need pre-flight validation in the
    same way.

  - **The test infrastructure.** `mock-obsidian.ts`, the
    `MOCK_PLATFORM`-paired tests, the F-series integration tests, the
    fault-injection helpers — all reused. New tests slot into the
    existing buckets.

  **One clarification on the boundary.** `processBatch` IS modified
  by this reorganisation — Phase 1 inserts a validation step between
  `buildTreeEntries` and `createTree`, Phase 2 adds a queue-read step
  alongside the ChangeDetector output, Phase 4 dispatches its catch on
  typed errors. But the function name and its high-level contract
  ("turn one queued batch into one main-branch commit, with reconcile
  on head drift") don't change. A reader auditing the diff will see a
  materially different body — that's by design — but the call sites
  that invoke `processBatch` from `drain` are untouched.

  ---

  ## 6. Test Strategy

  Three test categories per phase, all leveraging the existing
  infrastructure (see [`CLAUDE.md`](../CLAUDE.md) *Testing* section).

  **Unit (per phase).** A focused unit-test suite for the new module
  or shift, isolated behind a fake client. Phase 1 needs roughly five
  cases: stale deletion gets dropped; valid deletion gets kept;
  mixed batch gets partial filter; batch becomes empty after filter
  and push is skipped; validator network error aborts push and does
  not advance cursor. Phase 2 needs queue persistence + recovery
  cases. Phase 4 needs error-class dispatch cases.

  **Regression (per phase).** Each bug from §1 gets a regression test
  in the same release as the phase that addresses its structural class.
  Specifically:

  - §1.1 → already covered by `tests/sync2/filename-sanitizer.test.ts`
    and the F-series sanitize cases (landed in `2.0.1-beta2`).
  - §1.2 → covered by `tests/sync2/sync2-manager.test.ts` orphan-
    prevention test (landed in `2.0.1-beta2`); typed-error tests added
    in Phase 4.
  - §1.3 → covered by `tests/github/encode-path.test.ts` (landed in
    `2.0.1-beta2`).
  - §1.4 → covered by the orphan-prevention test (landed in
    `2.0.1-beta2`).
  - §1.5 → **Phase 1's new test:** simulate a cross-device race where
    Device A has a phantom snapshot entry for a path Device B
    sanitize-pushed away. Assert push proceeds without 422, the
    phantom is dropped from snapshot, and the batch either pushes the
    remaining entries or is skipped if empty.

  **Integration (per phase).** F-series adds one case per phase that
  exercises the new behaviour against real GitHub:

  - Phase 1: deletion entry for a path another client deleted between
    our last sync and our push — must succeed (drop or skip), no 422.
  - Phase 2: pull-side sanitize on a forbidden-named legacy file —
    must produce a queue entry, not a snapshot phantom; next sync
    must consume the queue entry and clean GitHub; reset between
    syncs must not lose the queue entry.
  - Phase 3: behavioural no-op verification — full F-series + bucket
    G/H regression remains green after the contracts module is
    introduced.
  - Phase 4: trigger each typed error class via fault-injection;
    assert correct dispatch (retry / throw / log).
  - Phase 5: explicitly inject an unexpected-state case (e.g. tree
    blob SHA out of sync with snapshot remote SHA) and assert the
    push aborts with a `StaleStateError` rather than silently
    advancing.

  ---

  ## 7. Design Decisions (questions resolved before each phase opens
       its PR — recorded here so the reasoning travels with the plan)

  ### 7.1 Phase 1 — validator network failure (resolved)

  If `getContentsAtRef` itself errors during pre-flight validation
  (network timeout, GitHub 5xx, dropped connection, rate-limit
  refusal), we cannot know whether the deletion entry is valid or
  stale. Two responses are possible:

  - **(a) Trust optimistically:** proceed with `createTree` as if
    validation never happened. If the entry was stale, we still hit
    the 422 we were trying to prevent. Validation becomes a
    best-effort net that quietly opens holes when the network is
    flaky — exactly when racey state-drift is most likely.

  - **(b) Abort the push and retry on the next drain:** the
    `processBatch` call throws, the per-batch error path is taken,
    `lastSync` is not advanced, the queued batch is preserved on
    disk for the next drain. Effect from the user's perspective:
    one push click "didn't go through"; the next click (or interval
    tick) tries again.

  **Decision: (b).** The pre-flight validator is a safety net, not
  a performance optimisation. If the safety net can't run, we
  should not pretend it ran — we should defer to the next drain.

  Operationally this matches the mental model the user proposed
  during review: "if we don't get a definitive signal from GitHub,
  treat ourselves as if offline until the next drain." The cost is
  a single user-visible error on a flaky-network click; the benefit
  is that we never silently reintroduce the 422-on-stale-deletion
  case the whole phase was built to remove. Severity of the cost is
  low — pre-flight validation only fires for batches that contain
  at least one deletion entry, which is itself a minority of
  pushes; combine that with "network was flaky during this
  specific 200ms window" and the joint frequency is small.

  The PR description for Phase 1 should state this policy
  explicitly, so a reviewer encountering an `Error: validation
  failed; will retry next sync` log line understands the policy
  reasoning without re-deriving it.

  ### 7.2 Phase 3 — re-export deprecation timeline (resolved)

  When code is extracted from `src/sync2/filename-sanitizer.ts` and
  `src/github/client.ts` into the new `src/sync2/cross-platform.ts`
  module, the old files could be left as thin re-export shims:

  ```typescript
  // src/sync2/filename-sanitizer.ts (extracted form)
  /** @deprecated since 2.0.X — import from "./cross-platform" */
  export { sanitizeFilename, needsSanitization } from "./cross-platform";
  ```

  How many release cycles should we keep these shims before
  deleting them? The original draft recommended two — based on the
  conservative assumption that some external consumer of our source
  files might exist.

  **Decision: zero cycles.** The plugin is an *application*, not a
  library. Its consumers are: (a) Obsidian, which loads the bundled
  `main.js` (not the source modules), and (b) our own tests and
  source in this repository. No third-party plugin imports
  `src/sync2/filename-sanitizer.ts` directly — they cannot, because
  the source is not part of any published `node_modules` artifact.

  Phase 3's PR therefore migrates every import call site in the
  same diff that creates `cross-platform.ts` and deletes the
  vacated files. No `@deprecated` shim layer. Simpler diff,
  shorter migration story.

  ### 7.3 Phase 4 — error class for the "compare-listed-but-fetch-null" case (resolved)

  The 1.4 bug class is: `compare` lists a path as added/modified,
  the subsequent `getContentsAtRef` returns null. Four concrete
  causes have been observed or could plausibly occur:

  - **(a) Client-side bug.** Our URL construction is malformed (the
    field-bug 1.3 — `?` not percent-encoded so the path was
    truncated server-side). Compare returned the path because it
    builds its URL differently from contents; the contents endpoint
    rejected our request. Recovery: deploy a fixed client.

  - **(b) Token permission drift.** Between the `compare` and
    `getContentsAtRef` calls, the user (or an admin of the GitHub
    org) reduced the token's scope so this specific path falls
    outside it. Recovery: the user restores permissions or the
    operator updates the token.

  - **(c) GitHub eventual consistency.** GitHub serves API requests
    from multiple replicas; in rare cases a fresh write is visible
    on one replica (the one `compare` hit) but not yet on another
    (the one `contents` hit). Recovery: retry after a few seconds.

  - **(d) Concurrent force-push.** Another device force-pushed and
    rewrote the commit SHA we're referencing in
    `getContentsAtRef(path, @<sha>)`. The contents endpoint
    returns 404 because that SHA no longer reachable on the branch.
    Recovery: refresh compare from the new head.

  All four share the same structural shape: **two pieces of remote
  state we observed within one sync click no longer agree.** Not
  a "not found" in the user-intent sense, not an "auth error" even
  for (b) (the auth state we used was valid at the previous call),
  not a transient network glitch.

  **Decision: `StaleStateError`.** The error class captures the
  inconsistency semantics directly. Catch sites can dispatch on it
  uniformly: log the case with high specificity (path, observed
  state-A, observed state-B, the two HTTP request-ids), then
  follow the same retry-or-escalate policy as other
  `StaleStateError` cases. If the cause is (c) or (d), the next
  drain usually succeeds. If the cause is (a) or (b), repeated
  log entries with the same shape signal an underlying
  client-or-permission problem that needs operator attention.

  The user's review note on this question was instructive:
  *"це допомагає нам локалізувати проблему максимально як тільки
  можна. і логувати її! І якщо проблема буде повторюватись, ми по
  логам зможемо це виявити і думати над цим далі."* — that is the
  policy in one sentence.

  ### 7.4 Phase 4 — 422 dispatch: `ValidationError` vs `StaleStateError` (resolved)

  GitHub returns 422 with a body of the form
  `{"message": "...", "documentation_url": "..."}`. The
  `message` field distinguishes two distinct sub-causes:

  - "Invalid request" / missing fields / malformed payload →
    *client* sent bad input. The client should not retry without
    fixing the request.
  - `GitRPC::BadObjectState` (the 1.5 case) → the request was
    well-formed but the remote state has drifted between when the
    client constructed it and when the server processed it. The
    client may retry once it has refreshed its state.

  Two ways to model this in the type hierarchy:

  - **(a) All 422 → `ValidationError`.** The catch site inspects
    the response body to decide whether to retry. Hierarchy stays
    flat (one class per HTTP status). Catch sites that care about
    the sub-case couple themselves to one specific message string.

  - **(b) Dispatch at parse time.** `BadObjectState` →
    `StaleStateError`, everything else → `ValidationError`. The
    hierarchy carries the semantic distinction; catch sites
    dispatch on class. The error class then depends on a GitHub
    message string in its constructor logic.

  **Decision: (a).** Phase 1's pre-flight validation will make the
  `BadObjectState` sub-case rare; conflating the two in the type
  system is acceptable. Catch sites that need the distinction
  inspect `error.body?.message` directly — explicit and local.
  Re-evaluate in a future phase only if a new 422 sub-case appears
  that requires distinct dispatch.

  ### 7.5 Phase 5 — taxonomy of skip-classes (resolved)

  The pseudo-merge "edit while in conflict" path defers
  conflicting-path mutations to the conflict branch and continues
  the main loop — this is a "deferred-by-design" skip, not a
  silent one, but distinguishing it from the "unexpected" case in
  the audit needs an explicit taxonomy.

  **Decision:** every skip in the affected loops (pullIfNeeded,
  applyRemoteAddOrModify, applyRemoteDeletion, processBatch,
  reconcileBatchAgainstHead, bootstrapFromRemote,
  adoptionPullAndRecord) gets a source-code annotation:

  ```typescript
  // skip-class: applied        ("path written via fast-path SHA match")
  // skip-class: deferred       ("path overlaps queue; reconcile will handle")
  // skip-class: already-correct ("local state matches GitHub; no-op")
  // skip-class: unexpected      → THROW StaleStateError
  ```

  The annotation is documentation for future readers (reviewing or
  modifying these loops a year from now) and a contract that any
  *unexpected*-class skip MUST throw rather than `continue`. The
  user's review observation drove this: *"якщо це допоможе точніше
  відслідковувати різні випадки і легше буде в майбутньому
  рев'ювити та відлагоджувати чи модифікувати sources"* — the
  annotations exist to make those reviews possible without
  re-deriving the taxonomy each time.

  ---

  ## 8. Glossary

  **Phantom snapshot entry.** A `SnapshotStore.set(path, ...)` call
  made not because the plugin observed the path on GitHub at the
  recorded SHA, but because the plugin *wants* a future `ChangeDetector`
  pass to emit a deletion for that path. Introduced in `2.0.1-beta2`'s
  pull-side sanitize. Section 3.2 proposes to replace these with an
  explicit pending-deletions queue.

  **Pre-flight validation.** A check performed on a push-side operation
  (in the proposed reorganisation: every `createTree` request)
  *before* the request is sent, against the current state of GitHub,
  to verify that the operation's assumptions still hold. The opposite
  of optimistic write-and-retry.

  **Stale-state error.** A failure that arises because state captured
  at time T₀ no longer matches reality at time T₁, where T₀ and T₁ are
  both within the same sync click. The 1.5 bug is the canonical
  example: the phantom snapshot was captured at the pull-side fetch
  (T₀); by the time the push reached `createTree` (T₁ ≈ T₀ + 200ms),
  another device had deleted the path on GitHub.

  **Cross-platform contract.** A rule of the form "this filesystem /
  URL / adapter behaves differently on platform X than on platform Y."
  The forbidden-character set is one; the Capacitor-rename-doesn't-
  overwrite rule is another; the URL-encoding policy is a third.
  Section 3.3 proposes to centralise these in one module.

  **Silent skip.** A `return` or `continue` in a loop or guarded code
  path that advances loop state (or cursor state like `lastSync`,
  `recordSync`) without recording in the log *why* the path was
  skipped. Distinct from a "labeled skip" — same control-flow shape,
  but with an explicit reason captured at log level. Section 3.5
  proposes to convert every silent skip to a labeled one.

  **Typed error class.** A subclass of a `SyncError` base that
  captures the *kind* of failure (network, validation, auth, etc.) in
  the type system, rather than encoding it in the message string or a
  numeric status field. Catch sites dispatch on class via
  `instanceof`; the retry predicate lives on the class. Section 3.4
  proposes a small initial hierarchy.

  **Idempotent push.** Property of a push operation that re-running it
  with the same batch produces the same result regardless of whether
  the previous run failed mid-flight, succeeded in part, or
  succeeded entirely. The current push pipeline is partially
  idempotent (the queue's `markAttempted` survives crash; reconcile
  handles head drift) but the deletion-entry validation gap (1.5) is
  one of the places it breaks down. Phase 1 closes the most visible
  gap; full idempotency is a longer-term property that emerges from
  Phases 2 + 5 together.
