# Pseudo-Merge Mode: Resolving Synchronisation Conflicts Through Filesystem Operations

> A design rationale for the conflict-resolution layer in the
> `github-easy-sync` Obsidian plugin.

## Abstract

This article describes **pseudo-merge mode**, the conflict-resolution
mechanism used by `github-easy-sync` to keep an Obsidian vault in step
with a GitHub repository across multiple devices. The plugin operates
under two hard constraints — it speaks only the GitHub REST API (no
`git` binary, no `isomorphic-git`) and it must work identically on
desktop and on a smartphone — so the resolution layer cannot reuse the
machinery a developer takes for granted (merge markers in an editor, an
interactive rebase, a graphical three-pane diff tool). Pseudo-merge
mode instead translates every conflict into a pair of ordinary files in
the vault and asks the user to resolve the conflict with the file
operations they already know: *delete*, *rename*, *edit*. Below the
surface, every step is backed by a private per-device branch on GitHub
that preserves the user's full edit history — including every
iteration produced while a conflict was being resolved — and by a
crash-tolerant atomic write protocol that makes the on-disk state
always recoverable. The resulting GitHub repository is, by
construction, a durable archive of every commit the user ever caused
the plugin to create; no resolution discards a previously-committed
version, even when the version is superseded.

The article assumes a reader who has used `git` casually at least once
and who can read a file path; it does not assume kernel-level
familiarity with version-control internals. Where git terminology
appears, a one-paragraph refresher is provided before it is used.

---

## 1. The Problem: Vault Synchronisation Without git

Consider a writer who keeps a vault of Markdown notes in Obsidian on a
laptop and on a phone. The same file, `Notes/idea.md`, lives on both
devices. On the laptop, the writer adds a line to the file. Later, on
the phone, with no recent network synchronisation in between, the
writer adds a different line. Both devices then attempt to publish
their version to a shared GitHub repository.

If both devices were running a full `git` installation, the conflict
would be resolved by `git pull --no-rebase`: the second device would
detect the divergence, attempt a three-way textual merge, succeed if
the edits did not overlap, or fall back to inserting `<<<<<<<` /
`=======` / `>>>>>>>` conflict markers into the file for the writer to
disentangle. None of this is available to `github-easy-sync` by
design. The plugin runs inside Obsidian's process — including
Obsidian's Capacitor-based mobile build — and ships with **no `git`
binary and no JavaScript reimplementation of git's merge algorithm**.
The only tool at its disposal is the GitHub REST API, and the only
file operations available are those exposed by Obsidian's vault
adapter: read, write, delete, rename, and directory listing.

Even if a full git implementation were available, two of git's
default conflict workflows degrade badly under the plugin's actual
usage:

* **Merge markers inside text files** assume an environment in which
  the user is already in a code editor with the file open, with
  surrounding context visible, and with the cognitive bandwidth to
  triage `<<<<<<<` blocks. On a phone — Obsidian's mobile build is a
  full-featured target, not an afterthought — this assumption fails.
* **Binary files cannot be three-way-merged at all.** A modified PNG
  attachment on one device and a different modified PNG on the other
  has no meaningful merge result. Real `git` falls back to *"both
  modified — pick one"*, which is exactly the choice the user needs
  surfaced visually, not as a stash-and-checkout dance in a terminal.

The plugin therefore needs a conflict-resolution protocol that:

1. Never requires the user to open a terminal, an editor extension, or
   a modal dialog they did not initiate.
2. Treats text files and binary files uniformly at the level of *how
   the user resolves them*, even if the underlying detection logic
   differs.
3. Survives an interrupted operation — the mobile OS suspending the
   app mid-write, the laptop running out of battery during a push —
   without leaving the vault in a state from which recovery requires
   manual archaeology.
4. Allows the user to keep working on the file even while it is in a
   conflict, because waiting for the conflict to be resolved before
   typing the next sentence is a hostile constraint for a writer.

Pseudo-merge mode is the protocol that meets these four requirements.
It does so by replacing the metaphor of "the editor merges conflicting
versions for you" with the metaphor of "the vault grows an extra
sibling file per conflict, and you resolve the conflict by managing
those files yourself."

---

## 2. A Minimum-Viable Model of git

Pseudo-merge mode is built on top of GitHub's REST API, which in turn
exposes git's underlying data model directly. The article references
four primitives — **blob**, **tree**, **commit**, **branch** — plus
one structural property, **reachability**. A reader already fluent in
git may skim this section; the rest of the article uses these terms
without further explanation.

### 2.1 Blob, Tree, Commit

A **blob** is the content of a single file, addressed by the SHA-1
hash of those bytes. Blobs have no name and no location of their own;
the hash *is* the identity. Two files with identical bytes — say,
`README.md` in different folders — share a single blob in git's
storage.

A **tree** is a directory listing: an ordered collection of `(name,
mode, child_sha)` triples. A tree's `child_sha` may point at a blob
(meaning "this entry is a file") or at another tree (meaning "this
entry is a subdirectory"). Trees are themselves content-addressed: the
SHA of a tree object is determined by the SHAs of its children.

A **commit** is a snapshot, not a diff. It carries exactly one root
tree, a list of zero or more parent commits, an author, a committer, a
timestamp, and a free-form message. The root tree captures the entire
state of the project at that moment; the parents establish history.

```
commit  C2                           commit  C1
  tree     T2                          tree     T1
  parents  [C1]                        parents  []
  msg      "add second note"           msg      "initial commit"

           T2                                   T1
           ├── Notes/                           └── Notes/
           │    ├── idea.md  (blob B1)              └── idea.md  (blob B1)
           │    └── todo.md  (blob B2)
           └── ...
```

Notice that the blob `B1` for `idea.md` appears in both trees: the
file did not change between `C1` and `C2`, so git reuses the same
content-addressed blob.

### 2.2 HEAD and Branches

A **branch** in git is, mechanically, a movable label that points at
one commit. The label `main`, for example, is just an entry in a
table — `refs/heads/main → <some commit SHA>`. Pushing a new commit
to `main` updates the label to point at the new commit; the previous
commit is still in the database, still reachable through the new
commit's parent pointer, but `main` no longer names it directly.

**HEAD** is the special label that denotes "where you are right now"
in a local working copy. Pseudo-merge mode does not maintain a
working-copy HEAD in the conventional sense — the vault on disk plays
that role — but the *remote* HEAD of each branch on GitHub matters at
every step, because every push must build on top of the current remote
HEAD of the branch it targets.

### 2.3 Merge-Commit and Reachability

A **merge-commit** is a commit with two or more parents. It does not
introduce any file changes of its own; its tree is typically identical
to one of its parents (or a hand-built combination of them). The
purpose of a merge-commit is purely structural: it records that two
lines of history have been joined.

```
                  M  (merge-commit)
                 / \
                A   B
                 \ /
                  C  (common ancestor)
```

After `M` exists, both `A` and `B` are **reachable** from `M` by
walking parent pointers. Reachability is the property git's garbage
collector uses to decide what to keep: any commit reachable from a
named branch (or from `HEAD`, or from a tag) is preserved
indefinitely; an unreachable commit becomes a candidate for eventual
deletion.

Pseudo-merge mode exploits reachability deliberately: it creates and
later deletes branch labels, but it ensures that every commit ever
made on a conflict branch ends up reachable through a merge-commit on
`main`. Deleting the branch label does **not** delete the commits it
once named, because those commits still have an inbound parent edge
from the merge-commit. The user's edit history — including all the
intermediate attempts during conflict resolution — survives the
session and remains visible in the GitHub network graph.

---

## 3. Why the Conventional Resolution Toolkit Does Not Fit

Suppose the plugin attempted to forward git's standard conflict
behaviour directly to the user. The laptop pushed first; the phone
attempted to push second; GitHub rejected the phone's push because
its parent commit no longer matched `main`'s tip. Three options
present themselves:

**Option A: Insert text merge markers into `idea.md` on the phone.**
This is what `git pull` would do. It requires the user to open the
file, find the `<<<<<<<` blocks, decide what to keep, delete the
markers, save, and commit. On a phone — soft keyboard, small screen,
unstable cellular connection — every one of those steps is more
expensive than on a laptop. Worse, if the user opens the file in a
preview pane (the default in Obsidian Mobile), the markers render as
literal text in the rendered note. The "conflict" leaks into the
user's reading experience until they manually clean it up.

**Option B: Open a modal dialog showing both versions side by side.**
This is what most cloud-storage clients do (Dropbox, iCloud, etc.).
The dialog interrupts the user, forces a decision, and disappears
once a choice is made. Pseudo-merge mode rejects this because: (a)
modal dialogs during a background sync are a known UX failure pattern;
(b) the dialog can only show one conflict at a time, but the same
sync may produce conflicts on many files; (c) on a phone, the dialog
is small enough that the user often cannot see enough context to
choose; (d) once dismissed without a choice ("decide later"), the
state has nowhere to live except a parallel data structure the user
cannot see.

**Option C: Refuse the push and tell the user to fix it somewhere
else.** This is the safest option but it stalls all other
synchronisation. The user cannot push *any* file, including ones
entirely unrelated to the conflict, until the conflict is resolved.
For a vault of hundreds of notes, this is unacceptable.

Pseudo-merge mode takes a fourth path: it converts the conflict into
*two ordinary files in the vault* — the local version under its
original name, and the remote version under a sibling name — and
moves on. Synchronisation of unrelated files continues immediately.
The user resolves the conflict at their leisure, with the same file
operations they already use every day in Obsidian's file explorer.

---

## 4. Pseudo-Merge Mode: The Core Idea

> *How can a divergent file be brought into the vault without showing
> raw merge markers, without launching a modal dialog, and without
> blocking the rest of the synchronisation?*

The answer has three moving parts:

### 4.1 Try to Auto-Merge First

Before any conflict is registered, the plugin attempts an
**auto-merge** appropriate to the file's type. For ordinary text
files, this is a standard three-way merge using the diff3 algorithm:
given the **base** (the last commit both devices agreed on), **ours**
(the local version), and **theirs** (the remote version), it produces
a clean merged result whenever the edits did not overlap. For the
single specific case of an Obsidian plugin bundle
(`<configDir>/plugins/<id>/main.js` or its `manifest.json`), it
compares semantic versions and picks the higher one — three-way
merging a minified JavaScript bundle would produce garbage that
crashes Obsidian on load, so this case gets atomic resolution by
authorial intent (semver) rather than syntactic merge. For everything
else — images, PDFs, archives — auto-merge is not attempted; a binary
"merge" has no useful definition.

When auto-merge succeeds, the merged content goes straight to GitHub
as if no conflict had ever existed. The user is never informed,
because there is nothing to inform them about: their intent and the
other device's intent were already reconcilable.

When auto-merge fails — text edits on the same line, two different
versions of the same image, plugin bundles with identical versions —
the next two mechanisms engage.

### 4.2 Sibling Files in the Vault

A **sibling file** is created next to the conflicting file, carrying
the remote version's content under a derived name. For
`Notes/idea.md`, the sibling has the form:

```
Notes/idea.conflict-from-<remote-device>-<isoTimestamp>.md
```

For example, if the remote version came from a device labelled
"Phone" at 14:30:22 UTC on 8 May 2026:

```
Notes/
├── idea.md                                                 ← the user's local version (unchanged)
└── idea.conflict-from-Phone-2026-05-08T15-30-00Z.md        ← the remote version, written here
```

The original file is **not** overwritten. The local version of
`idea.md` continues to be the file the user sees in their notes list,
opens, edits, and ultimately publishes — until they decide otherwise.
The sibling is a peer artefact, fully visible in Obsidian's file
explorer, and the user can open it, read it, copy parts of it,
delete it, or rename it on top of `idea.md`, all using the standard
file operations they already know.

A single file may carry more than one sibling: if the user has
conflicts pending from two different remote devices, each device
contributes its own sibling, distinguishable by the `<remote-device>`
segment of the filename. The path is "in conflict" as long as at
least one sibling exists.

### 4.3 A Per-Device Conflict Branch on GitHub

Sibling files address the user-facing half of the problem. The
*remote* half — how to safely push the local version somewhere so it
is not lost, without forcing it onto `main` where other devices would
see it — is addressed by a **conflict branch**.

When a conflict is first detected on a device, the plugin creates a
GitHub branch named:

```
github-easy-sync-conflicts-<deviceLabel>-<YYYYMMDDHHMMSS>-<mmm>
```

For example, `github-easy-sync-conflicts-Laptop-20260508153022-847`.
The local version of the conflicting file is pushed to this branch;
unrelated files in the same sync continue to flow to `main`. From
the perspective of any other device synchronising against the same
repository, the conflict branch is invisible — only `main` matters
for incoming pulls. The conflict therefore stays strictly *private to
the device that detected it* until the user explicitly resolves it.

When the resolution is complete (the local version of `idea.md` has
been settled and the sibling has been removed), a **merge-commit** is
constructed manually on `main` whose two parents are: (a) the current
tip of `main`, and (b) the current tip of the conflict branch. The
branch label is then deleted. By the reachability argument from
§2.3, every commit ever made on the branch — including every
intermediate "I edited the file again while trying to resolve this"
commit — remains reachable from `main` through the merge-commit's
second parent. Nothing the user did is lost.

### 4.4 Preserving the Full Edit History

The previous paragraph deserves to be stated as a design goal in its
own right rather than as an emergent consequence of git's reachability
semantics, because it shapes several decisions throughout the
protocol: **every commit the user ever caused the plugin to create
remains accessible in the GitHub repository forever, including the
commits made during a conflict resolution session.**

A naïve conflict-resolution scheme would treat the in-progress
versions of `idea.md` as scratch state — useful for the user
mid-resolution, discardable once the conflict is closed. Pseudo-merge
mode takes the opposite position: those in-progress versions are not
scratch, they are *history*. A writer who deliberated for thirty
minutes between two phrasings produced a record of that deliberation;
discarding it silently is a form of data loss, even if the surviving
final version is the "correct" one.

The mechanism by which this preservation is achieved is the
combination of:

1. **Each iteration is its own commit on the conflict branch.** Six
   `[Sync]` clicks while a file is in conflict produce six commits on
   the branch, not one collapsed commit. (Even with
   `accumulateOfflineSyncs = true`, which folds queued user batches
   together to reduce GitHub API traffic, every distinct push
   produces a distinct commit on the branch.)
2. **The finalise step uses a true merge-commit on `main`**, not a
   fast-forward or a squash. The merge-commit has two parents — the
   prior `main` tip and the conflict-branch tip — so the entire
   branch is reachable from `main` through the second parent.
3. **The branch label is deleted after the merge.** Deleting a label
   does not delete the commits it once named; the commits remain in
   the repository, reachable from `main` through the merge-commit.
   The GitHub Network graph shows the branch as a short side-arm
   joined back to `main` even though no label currently points at
   its tip.

The practical consequence: months or years later, a user can browse
the GitHub repository's history, find the merge-commit for any
resolved conflict, follow its second parent backwards, and see the
sequence of intermediate versions that led to the final resolution.
Nothing about the resolution erases the journey to it. This contrasts
with several competing approaches — e.g., squash-merge workflows or
"resolve in place and discard the working copies" — where the only
artefact preserved is the outcome, not the path. Pseudo-merge mode
treats the repository as a durable archive of the user's actual
edits, not as a presentation layer for their final state.

This benefit compounds with `accumulateOfflineSyncs = false` (the
default): under that setting, every distinct `[Sync]` click on a
device with pending local edits produces a distinct commit, regardless
of whether the affected paths are in conflict. The repository thus
holds, in addition to the conflict-resolution history described
above, the full per-click commit log of the user's normal
synchronisation activity. The setting can be enabled for users who
prefer fewer commits at the cost of less granular history; the
default favours preservation.

---

## 5. Architecture: Three Layers, Three Trigger Models

> *Where does state change happen, and how does the plugin keep the
> three concerns — pushing changes, reflecting them in the UI, and
> resolving conflicts — from racing against each other?*

The plugin is organised into three layers, each with a different
trigger model:

| Layer                              | What it does                                                 | When it runs                                                              | Mutates state? |
|------------------------------------|--------------------------------------------------------------|---------------------------------------------------------------------------|----------------|
| **Sync engine**                    | Detects local changes; pushes to GitHub; pulls from GitHub.  | On `[Sync]` click, on interval tick, on plugin load.                      | Yes            |
| **Conflict counter** (UI badge)    | Counts pending unresolved conflicts for status-bar + ribbon. | On any vault `delete` / `modify` / `rename` event affecting a known path. | **No**         |
| **Conflict resolution detection**  | Detects user-completed resolutions; finalises the branch.    | At the start of every `drain()` call.                                     | Yes            |

The strict separation of "things that mutate state" from "things that
only read state" is the most important architectural property of the
design. Vault event listeners — `delete`, `modify`, `rename` — fire
at unpredictable times: the user dragging a sibling to the trash, an
external editor saving a file, the OS replaying a `.swp` cleanup. If
those listeners were allowed to mutate the conflict store directly,
they could race with the sync engine's own writes during a `drain`
(the engine writes a sibling, the listener immediately observes it
and tries to "resolve" the conflict the engine just created, etc.).
Pseudo-merge mode forbids this category of race by construction: the
listener does only one thing — call `counter.markDirty()`, an
idempotent O(1) flag-set — and all real resolution work happens at a
single well-defined moment: the start of the next `drain` cycle.

The drain itself reads:

```
drain():
  if store.records.length > 0:                ← guard: empty store, skip the rest
      evaluateConflictState():
          Phase A: for each record, remove sibling if siblingSha == baseSha
                   or drop record if sibling was deleted by user
          Phase B: for each path whose records are all gone, synthesise
                   a side-batch propagating the live vault state to main

  pull main as usual
  for each batch in queue:                    ← side-batches from Phase B included
      processBatch(batch)
      
  if store.records.length == 0 and conflict branch exists:
      finalise: marker commit, merge-commit on main, deleteRef branch
```

In ninety per cent of `drain()` invocations the store is empty and
the conflict-related code path is skipped entirely; the conflict
machinery imposes no runtime cost on the normal synchronisation path.

---

## 6. The Three Kinds of Conflict

The mechanism above is uniform, but the **detection** of a conflict
depends on what each side did to the file. Three cases arise:

### 6.1 Modify-vs-Modify

Both devices edited the same file independently of each other. This
is the canonical conflict.

```
Common ancestor                Local (laptop)        Remote (phone, on main)
# Project Aurora               # Project Aurora      # Project Aurora
Launch by Friday.              Launch by Monday.     Launch by Thursday.
```

The plugin first attempts an auto-merge. For a text file, this is a
three-way merge against the common ancestor; for our example, both
sides modified the same line, so the merge fails. The plugin then
creates a sibling holding the remote content:

```
Notes/idea.md                                              ← "Launch by Monday." (local)
Notes/idea.conflict-from-Phone-2026-05-08T15-30-00Z.md     ← "Launch by Thursday." (remote)
```

The local file is untouched. The user resolves at their convenience.

### 6.2 Delete-vs-Modify

The local device deleted the file; the remote device modified it. The
local intent ("this file should be gone") and the remote intent ("this
file matters and has been improved") are genuinely incompatible — the
plugin cannot decide which one to honour without asking.

A sibling carrying the remote modified content is created. There is
no local file to put next to it; the sibling stands alone in its
parent directory. The user resolves in one of two ways:

* **Delete the sibling** — the local "delete" intent wins; the next
  sync propagates the deletion to `main`.
* **Rename the sibling to the original name** (`idea.conflict-from-...md`
  → `idea.md`) — the remote "modify" intent wins; the next sync
  publishes that content as the current `idea.md`.

### 6.3 Modify-vs-Delete (Asymmetric: Auto-Resolves)

The local device modified the file; the remote device deleted it.
Symmetric with 6.2 in terms of git mechanics, but pseudo-merge mode
treats it asymmetrically and resolves it automatically in favour of
the local modification.

The reasoning: the user **already** demonstrated intent towards this
file by modifying it. The earlier deletion on the other device may
have been a mistake, a stale draft cleanup, or an action the user
themselves no longer endorses. To resolve the conflict in favour of
deletion would discard the more recent and more deliberate signal.

Concretely, the auto-merge gate returns the outcome `modify-wins`:
the file is published to `main` as if the deletion never happened.
On the next sync of the other device, the file is pulled back ("the
file has reappeared"), restoring the same state on both sides. No
sibling is created, no conflict branch is opened, and the user is
not informed — the resolution is deterministic and safe.

The asymmetry between 6.2 and 6.3 is recorded explicitly in the
conflict-kind type: only `modify-vs-modify` and `delete-vs-modify`
exist as registrable kinds. `modify-vs-delete` is not a kind at all —
it is a transient classification that the auto-merge gate intercepts
and resolves before any record is ever written.

---

## 7. Auto-Merge Strategies in Detail

Section 4.1 introduced auto-merge as the first thing tried on any
divergent path. The full dispatch table is:

| Classifier match                                       | Strategy                                                                                                 | Outcome on success  | Outcome on failure                                |
|--------------------------------------------------------|----------------------------------------------------------------------------------------------------------|---------------------|---------------------------------------------------|
| `theirs === null` (remote deleted, local modified)     | None — short-circuit                                                                                     | `modify-wins`       | (cannot fail)                                     |
| `isAtomicPluginFile(path)` — plugin's `main.js` / `manifest.json` | Atomic semver from `manifest.json` (higher version wins; identical versions fall back to mtime) | `atomic: ours / theirs` | `register-conflict` (identical version & mtime)   |
| `hasTextExtension(path)`                               | Three-way diff3 (`mergeText(ours, base, theirs)`)                                                        | `clean: <bytes>`    | `register-conflict` (overlapping or no base)      |
| else (binary)                                          | None                                                                                                     | —                   | `register-conflict` unconditionally               |

A few clarifications on the table:

**`atomic` versus `clean`.** A `clean` outcome means the algorithm
produced *new* bytes by combining inputs. An `atomic` outcome means
the algorithm chose one of the two existing sides verbatim. Both are
treated identically by the caller — the resolved bytes are pushed to
`main`; no conflict is registered — but the distinction matters for
logging and for reasoning about what was lost (in `atomic`, the
losing side's bytes are no longer in the resolved file, though they
remain reachable in git history).

**Why binary always registers a conflict.** A plausible alternative
for binary files would be an *atomic mtime* picker — whichever side
has the more recent modification time wins, silently. This is
correct in the trivial case (one device truly has the newer
version) but catastrophic in the non-trivial case (both devices
edited the same image independently — the older version is
destroyed without the user ever knowing). Pseudo-merge mode rejects
the silent picker for that reason: binary files always produce a
sibling so that the user can see both versions and decide. The
user's resolution path is the same as for text — delete the sibling
or rename it over the base — but neither version is discarded
without their consent.

**Why plugin bundles use atomic semver.** The bundled `main.js` of
an Obsidian plugin is minified JavaScript. A three-way diff3 of two
minified bundles produces text that compiles to garbage and crashes
Obsidian when it loads. Sibling-based resolution is awkward for the
same reason: the user is unlikely to want to edit `main.js` by hand.
The atomic semver pick is the safe default because semver is an
explicit declaration of authorial intent — "version `1.4.0` is later
than `1.3.5`" carries actual semantic weight, not just a syntactic
guess.

---

## 8. Editing While in Conflict — A Distinguishing Feature

> *Why must a conflict block further edits to a file? It need not.*

A conventional VCS treats a file in conflict as inert: until the
conflict is resolved, the file is in a peculiar half-merged state and
the user is expected to stop working on it. Pseudo-merge mode removes
this restriction. **The user can keep editing `idea.md` even while
the conflict on it is pending,** and those edits flow into the same
private conflict branch the original local version was pushed to.
Other devices remain unaware of all of this until the user finalises
the resolution.

The mechanism is mechanical and uses no new primitives:

1. The user edits `idea.md`. Obsidian writes the new content to
   disk. The `mtime` of the file changes.
2. On the next `[Sync]` click, the sync engine's normal change
   detector walks the vault, sees that `idea.md` has been modified,
   and enqueues it in a batch as any other change would be.
3. When the batch reaches `processBatch`, the engine **partitions**
   it: paths in conflict (`idea.md` is one) go to the conflict
   branch; paths not in conflict go to `main`. This is the "split
   push" described in §5.
4. The conflict branch grows a new commit holding the latest local
   version of `idea.md`. The conflict branch's tree is always
   rebased forward — its base is the *current* `main.tree` plus the
   override entries for conflicting paths — so when the branch is
   eventually merged back, the merge is trivial.

Branch state during a multi-edit conflict session

```
main:    ── C0 ── C1 ── C2 ── C3 ──────────────────────────── (unrelated edits on main)
                  │
                  └── X1 ─── X2 ─── X3 ─── X4 (marker = "final state")
                      "Mon"  "Tue"  "Wed"  current local content
```
                      
After resolution and finalise:
```
                                    
main:    ── C0 ── C1 ── C2 ── C3 ──────────────── M (merge-commit)
                  │                              /
                  └── X1 ── X2 ── X3 ── X4 ─────/
                  (all commits remain reachable from M's second parent)
```

The motivation is the **preserve-all-commits** principle introduced
in §4.4. Editing while in conflict is the user-facing consequence of
the design's commitment to durability: every iteration the user
deliberately committed must survive in the repository, retrievable
months later through the GitHub Network graph or `git log --all`
against a cloned copy. Were the plugin to absorb multiple in-flight
edits into a single "resolution" commit, that contract would be
broken; the user's thirty-minute deliberation between two phrasings
would collapse into a single artefact stripped of the reasoning. The
private conflict branch is the durable archive of that reasoning, and
the final merge-commit on `main` is what ensures the archive remains
reachable after the branch label is deleted.

Three implications follow:

* **Other devices see nothing.** Until `main` advances (via the
  finalise merge), the conflict branch is invisible to peers. The
  user can experiment freely without polluting collaborators'
  workspaces.
* **The conflict branch may accumulate many commits.** A session
  spanning hours of work may produce dozens of branch commits before
  resolution. This is not a problem: the branch is private, GitHub
  imposes no practical limit, and the final merge-commit on `main` is
  always exactly one commit regardless of branch length.
* **Resolution is still tied to the sibling file.** No matter how
  many times the user edits `idea.md`, the conflict is not resolved
  until the sibling file (`idea.conflict-from-...md`) goes away or
  matches `idea.md` byte-for-byte. The sibling is the user's todo
  list; the branch is the user's history.

---

## 9. Crash Protection: Two Suffixes, One Recovery Sweep

> *Three things can happen between "the user clicked Sync" and "the
> next stable state of the vault": the network can drop, the operating
> system can suspend the app, the device can lose power. At what
> intermediate states is the vault on disk recoverable, and by what
> mechanism?*

The plugin writes to the vault from **two distinct contexts**, both of
which must be crash-safe. Each context uses one or both of two staging
suffixes — `.sync-tmp` and `.sync-bak` — and each suffix carries a
**single, consistent semantic role** independent of which context
produced it:

* `.sync-tmp` is always **new bytes destined for a target file**
  (forward direction). It is the file that *will* be there once the
  protocol completes.
* `.sync-bak` is always **old bytes preserved before an overwrite**
  (rollback direction). It is the file that *was* there before the
  protocol started.

This naming-to-meaning correspondence is the property §9 walks through.
It is what lets a reader look at any staging file on disk and know
immediately what it represents, regardless of which protocol produced
it. The recovery sweep on plugin load uses the same correspondence as
its first decision axis.

### 9.1 The Two Callsites at a Glance

| Write path                                       | When it runs                                                                                                  | Uses `.sync-tmp`?                                            | Uses `.sync-bak`?                                                  |
|--------------------------------------------------|---------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------|--------------------------------------------------------------------|
| **Pull-replace** (`atomicWriteFile`)             | A non-conflicting file changed on `main`; the plugin pulls the new bytes and overwrites the local vault file. | Yes — for the transient new bytes during the swap.           | Yes — for the rollback backup of the old bytes.                    |
| **Sibling registration** (`ConflictStore.create`) | A conflict was detected; the plugin writes a new sibling file holding the remote (theirs) content.            | Yes — for the new bytes destined to become the sibling file. | **No** — there is no pre-existing file to back up; this is purely additive. |

The asymmetry is unavoidable: a brand-new sibling file has no prior
version to preserve, so there is nothing for `.sync-bak` to hold. Both
callsites therefore use `.sync-tmp` whenever new bytes are in flight,
but only `atomicWriteFile` ever produces a `.sync-bak`. This is the
property that makes the unified recovery sweep tractable (§9.5).

### 9.2 The Staging-Path Naming Convention

Both suffixes follow the same naming rule: the final path with the
suffix inserted as a **pre-suffix**, immediately before the file
extension. The pre-suffix placement is deliberate. Most file
managers — and Obsidian's own file explorer — preserve the trailing
extension when deciding which icon to show, whether to render a
preview, and so on. A staging file named `note.md.sync-tmp` would
look like a file of unknown type; `note.sync-tmp.md` looks like a
Markdown file with an unusual stem, which is exactly what it is.

The algorithm, parameterised by which suffix to use:

```
stagingPathFor(finalPath, which ∈ {"tmp", "bak"}):
    suffix = which == "tmp" ? ".sync-tmp" : ".sync-bak"
    if finalPath has no extension OR is a hidden file (".gitignore"):
        return finalPath + suffix              ← appended
    else:
        stem, ext = split on last dot
        return stem + suffix + ext             ← inserted
```

Examples (showing both suffix variants):

| Final path                                  | `.sync-tmp` variant                                | `.sync-bak` variant                                |
|---------------------------------------------|----------------------------------------------------|----------------------------------------------------|
| `Notes/idea.md`                             | `Notes/idea.sync-tmp.md`                           | `Notes/idea.sync-bak.md`                           |
| `Notes/idea.conflict-from-Phone-...md`      | `Notes/idea.conflict-from-Phone-....sync-tmp.md`   | (never produced — Path B is additive)              |
| `attachments/diagram.png`                   | `attachments/diagram.sync-tmp.png`                 | `attachments/diagram.sync-bak.png`                 |
| `.gitignore`                                | `.gitignore.sync-tmp`                              | `.gitignore.sync-bak`                              |
| `README`                                    | `README.sync-tmp`                                  | `README.sync-bak`                                  |

The patterns `*.sync-tmp*` and `*.sync-bak*` are added to the plugin's
recommended `.gitignore` invariants, so neither variant ever leaks
into a commit if it survives a crash. Each glob catches both forms —
pre-suffix (`*.sync-tmp.md`) and trailing-suffix (`.gitignore.sync-tmp`)
— because gitignore's `*` matches any sequence of characters
including the dot.

### 9.3 Path A — Pull-Replace via `atomicWriteFile` (Five Steps)

The first context that produces staging files is the ordinary pull-side
overwrite. When the plugin's pull observes that a file on `main` has
new bytes since the last sync, it must replace the local copy. A
naïve `writeBinary(path, newBytes)` would be hostile to a crash: if
the write started but did not finish, the file on disk would be a
truncated mix of old and new — *neither version recoverable, both
versions corrupted*. The plugin instead routes every pull-side
overwrite through `atomicWriteFile`, which uses a five-step protocol
that uses **both** suffixes in complementary roles:

```
Step 1: writeBinary(<path>.sync-tmp, newBytes)
            ← new bytes land in a transient staging file
              (.sync-tmp = forward target, the file that will be there)

Step 2: if exists(<path>):
            rename(<path>, <path>.sync-bak)
            ← live file moved aside as the rollback backup
              (.sync-bak = the file that was there)

Step 3: rename(<path>.sync-tmp, <path>)
            ← new bytes promoted to the live name (atomic at OS level)

Step 4: afterCommit()   (typically recordSync)
            ← snapshot updated to match the new live content

Step 5: remove(<path>.sync-bak)
            ← rollback backup is no longer needed
```

The two suffixes here are not interchangeable — they encode the
two facts a recovery agent needs to know if a crash occurs:

* `.sync-tmp` exists ⇒ "new bytes were staged but may not have been
  promoted to the live name yet."
* `.sync-bak` exists ⇒ "the old bytes are still recoverable here, in
  case the new bytes turn out not to have been committed."

Both files coexist briefly during Steps 2–3 of every overwrite, then
the `.sync-tmp` disappears at Step 3 (renamed away), the snapshot is
updated at Step 4, and `.sync-bak` disappears at Step 5.

The order is significant. The snapshot update (Step 4) happens
**between** the rename-into-place (Step 3) and the backup cleanup
(Step 5). This ordering is the **integrity witness** the recovery
sweep will later use to decide what an in-progress state means: if
the snapshot says "this path has remote SHA `X`" and the live file's
SHA matches `X`, then the new write committed successfully and the
remaining `.sync-bak` is only a cleanup leftover. If the snapshot and
the live file disagree, either the write was partial or the snapshot
update never ran — in both cases, the `.sync-bak` is the trustable
copy and the sweep restores it.

The protocol covers all four crash points uniformly:

| Crash between                  | What remains on disk                                                       | What the sweep concludes                                                              |
|--------------------------------|----------------------------------------------------------------------------|---------------------------------------------------------------------------------------|
| Step 1 and Step 2              | `.sync-tmp` exists; live file unchanged; no `.sync-bak`.                   | `.sync-tmp` is a transient artefact — delete it. Next sync repeats the operation.     |
| Step 2 and Step 3              | `.sync-tmp` exists; `.sync-bak` exists; live path missing.                 | Restore `.sync-bak` → live path; delete `.sync-tmp`. Pre-write state recovered.       |
| Step 3 and Step 4              | Live file = new bytes; `.sync-bak` = old bytes; snapshot still says "old". | SHA(live) ≠ snapshot.remoteSha → restore `.sync-bak`. Conservative; treats Step 4 as "did not commit." |
| Step 4 and Step 5              | Live file = new bytes; `.sync-bak` = old bytes; snapshot says "new".       | SHA(live) === snapshot.remoteSha → delete `.sync-bak`. Cleanup leftover only.         |

### 9.4 Path B — Sibling Registration via `ConflictStore.create` (Three Steps)

The second context is the registration of a new conflict. The crucial
difference from pull-replace is that **the final sibling path does not
exist before this operation**. There is nothing to move aside, nothing
to roll back to: the operation is purely additive. The protocol
therefore uses **only `.sync-tmp`** (no `.sync-bak`) and only three
steps:

```
Step 1: writeBinary(<siblingPath>.sync-tmp.<ext>, theirsContent)
            ← new bytes land in staging
              (.sync-tmp = forward target, same semantics as Path A's Step 1)

Step 2: atomicWrite of meta.json
            ← conflict record persisted (tmp + rename, separate nested atomic op)

Step 3: rename(<siblingPath>.sync-tmp.<ext> → <siblingPath>.<ext>)
            ← staging file promoted to its final name
```

The choice of `.sync-tmp` here is not an arbitrary convention; it is
the semantically correct suffix for what is happening. The staging
file holds **new bytes** that have not yet been given their final
identity — exactly the property `.sync-tmp` denotes in Path A. The
sibling file is brand new (no prior version on disk to back up), so
`.sync-bak` would be a misnomer and is not used.

The protocol uses three steps rather than five because the additive
nature removes two concerns:

1. There is no live file to move aside — Path A's Step 2 has no
   analogue here, because the sibling path is fresh.
2. There is no need for a separate live-bytes-versus-new-bytes
   distinction — only new bytes exist. The staging file *is* the
   eventual sibling, just sitting at its staging name until Step 3
   renames it.

Step 2 is itself a nested atomic operation (`meta.json.tmp` →
`meta.json`), embedded inside the larger 3-step protocol. The
conflict record is deliberately written **between** the sibling bytes
landing on disk (Step 1) and the final rename (Step 3). This
ordering is the **integrity witness** for this path: a `.sync-tmp`
whose final-path is named by a `ConflictStore` record is a
forward-direction staging file that the sweep can safely promote; the
sweep compares the staging file's actual content SHA to
`record.theirsBlobSha` to decide whether Step 3 can be completed or
whether the staging file must be discarded.

The protocol covers all three crash points uniformly:

| Crash between                  | What remains on disk                                                         | What the sweep concludes                                                                              |
|--------------------------------|------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------|
| Step 1 and Step 2              | `.sync-tmp` exists; no `meta.json`; no sibling.                              | No conflict-store record names this final path → treat as orphan, delete `.sync-tmp`. The conflict will be re-detected on the next sync if still relevant. |
| Step 2 and Step 3              | `.sync-tmp` exists; `meta.json` exists; no sibling.                          | SHA(`.sync-tmp`) === record.theirsBlobSha → rename `.sync-tmp` → sibling. Step 3 completed.            |
| After Step 3 (cleanup leftover) | Sibling exists; `.sync-tmp` may or may not exist.                            | If `.sync-tmp` survived, sibling already exists → delete the staging file (stale).                     |

### 9.5 The Unified Recovery Sweep

`AtomicWriteRecovery.sweep()` runs on plugin load, **before** the
sync engine starts touching the vault. It walks the entire vault
tree looking for any file whose name matches the staging convention
in either form — pre-suffix (`note.sync-tmp.md`) or trailing-suffix
(`.gitignore.sync-tmp`) — using `parseStagingPath` (the inverse of
`stagingPathFor`).

The sweep proceeds in two passes, one per suffix. The two passes are
**asymmetric**, in the way the asymmetry of the protocols themselves
predicts: `.sync-tmp` can come from either Path A or Path B, so it
needs an ownership dispatch; `.sync-bak` can come only from Path A,
so it does not.

**`.sync-tmp` pass — ownership dispatch.** For every `.sync-tmp` it
finds, the sweep computes the corresponding final-path (the inverse
of `stagingPathFor`) and asks the conflict store:

```ts
record = conflictStore.getBySibling(finalPath)
```

The answer determines which integrity witness — and therefore which
recovery direction — applies.

**If a record exists** — this `.sync-tmp` is a Path B staging file,
and the witness is `record.theirsBlobSha`:

| Vault state                                                | Recovery action                                                                                                                                                                                  |
|------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| finalPath exists                                           | Delete `.sync-tmp`; Step 3 already completed, the staging file is stale.                                                                                                                          |
| finalPath missing, SHA(`.sync-tmp`) === `record.theirsBlobSha` | Rename `.sync-tmp` → finalPath; this completes the interrupted Step 3.                                                                                                                            |
| finalPath missing, SHA mismatches                          | Delete `.sync-tmp` and log a warning. The record will be dropped by the next drain's Phase B (its sibling is missing); the conflict will be re-detected on the next sync if still relevant. Data integrity outranks resolution completeness. |

**If no record exists** — this `.sync-tmp` is a Path A transient
artefact (a crashed pull-replace that did not complete Step 3). The
new bytes have no recovery value: the next sync will discover that
`main` still has them and run the overwrite again. The sweep deletes
the file unconditionally.

**`.sync-bak` pass — snapshot-based recovery only.** Because Path B
never produces `.sync-bak`, there is no ownership question to ask.
The witness is always `snapshot.remoteSha`:

| Vault state                                                | Recovery action                                                                                                                                                                                  |
|------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| finalPath missing                                          | Rename `.sync-bak` → finalPath; restore the pre-write state. (Crash between Steps 2 and 3 of Path A.)                                                                                              |
| finalPath exists, SHA(file) === `snapshot.remoteSha`       | Delete `.sync-bak`; the write committed (Step 4 ran), only the cleanup (Step 5) did not.                                                                                                          |
| finalPath exists, SHA(file) ≠ `snapshot.remoteSha`         | Restore from `.sync-bak`: delete finalPath, rename `.sync-bak` → finalPath. The new write was partial or the snapshot update never ran; the backup is the trustable copy.                          |
| finalPath exists, no snapshot entry                        | Conservative restore: same as the row above. An unverified live file is worth less than a known-good backup.                                                                                       |

The two integrity witnesses — `record.theirsBlobSha` for the
`.sync-tmp` ownership-dispatched-to-Path-B branch,
`snapshot.remoteSha` for the `.sync-bak` branch and the
Path-A-orphan `.sync-tmp` branch — are themselves the durable
artefacts that make the protocol work. Both are written *before* the
corresponding staging file is finalised (the record in Path B's
Step 2; the snapshot in Path A's Step 4), so a crash that destroys
the protocol's progress nonetheless leaves enough information on disk
for the sweep to decide what was supposed to happen.

Ownership dispatch lives on the `.sync-tmp` pass for a structural
reason: forward-direction staging is the operation common to both
callsites, and `.sync-tmp` is the suffix that denotes that
operation regardless of which callsite produced it. The
ownership-versus-orphan question is therefore native to `.sync-tmp`
and has no analogue on `.sync-bak`, which is unambiguous by
construction (only `atomicWriteFile` ever produces it). Confining
the dispatch to `.sync-tmp` keeps each suffix readable in isolation:
a `.sync-bak` on disk always means "backup of a previous file
version," and the question of ownership only arises where the
filesystem itself cannot decide which protocol a staging file
belongs to.

### 9.6 Why Vault-Level Staging

Path B's staging file lives in the vault, co-located with the
eventual sibling — not in a private area under the plugin's config
directory parallel to the conflict record. Two properties motivate
this placement:

1. **The atomic-write infrastructure is shared with Path A.** Path A
   uses `atomicWriteFile` with a recovery sweep that walks the vault
   for staging files. Routing Path B through the same primitive
   removes a class of bespoke recovery code and ensures that any
   change to atomic-write semantics propagates to the conflict-store
   path automatically. The single unified sweep described in §9.5
   is the direct dividend.
2. **The staging file is recoverable in place.** If the rename in
   Path B's Step 3 fails (the OS reports an I/O error, the destination
   suddenly exists, etc.), no copying is required to recover — the
   bytes are already at the right parent directory, and the recovery
   sweep only needs to perform the rename a second time.

### 9.7 The Boundary Between `load()` and the Recovery Sweep

The conflict store's `load()` does **not** check the vault for
sibling files. It reads `meta.json` files from the conflict-records
directory and builds its in-memory index purely from that. The
recovery sweep described in §9.5 runs separately, and the
*resolution* of conflicts based on what is or is not in the vault
happens only at the next `drain()`.

This split is deliberate: it makes **filesystem state authoritative**
for resolution. A missing sibling means the user wanted it gone, and
no part of the load path treats it as something to "restore." The
alternative — having `load()` re-emit a missing sibling from a
durable backup — would silently undo the user's intentional deletes
across a plugin restart, which is exactly the failure mode the
"trust the filesystem" rule prevents.

---

## 10. Scenarios

The mechanism above is best understood by tracing it through complete
sessions. The following scenarios use one running file,
`Notes/idea.md`, on two devices: a **Laptop** (`deviceLabel = "Laptop"`)
and a **Phone** (`deviceLabel = "Phone"`). Both started from a
common state in which the file contained:

```
# Project Aurora

Launch by Friday.
```

### Scenario A: Simple Modify-vs-Modify, Resolved By Deleting the Sibling

The Laptop edits the file to `Launch by Monday.` and syncs. `main`
on GitHub now holds the Laptop's version.

The Phone, unaware of this, edits the same line to `Launch by
Thursday.` and clicks `[Sync]`. The phone's `drain()` runs:

1. **Pull from `main`** discovers that `idea.md` has a remote SHA
   different from the Phone's snapshot's recorded SHA. The Phone's
   local file is also modified relative to the snapshot — both
   sides changed. The plugin attempts a three-way merge: the base
   is "Launch by Friday."; ours is "Launch by Thursday."; theirs is
   "Launch by Monday." The same line was edited on both sides, so
   the merge produces conflict markers — the auto-merge gate
   returns `register-conflict`.
2. The plugin creates a conflict branch
   `github-easy-sync-conflicts-Phone-20260508153022-847` on the
   current `main` HEAD and pushes the Phone's version of `idea.md`
   to it.
3. A sibling is written to the vault using the `.sync-tmp` staging
   protocol (§9.4):
   `Notes/idea.conflict-from-Laptop-2026-05-08T15-30-00Z.md`
   containing `Launch by Monday.`
4. A conflict record is persisted under
   `.obsidian/plugins/github-easy-sync/.conflicts/<id>/meta.json`.

The status bar shows `🔀 1`. The Phone's `idea.md` still reads
`Launch by Thursday.` — the user can continue editing it.

The user inspects both files, decides the Laptop's "Monday" version
is the right one, opens the file explorer, and **deletes**
`Notes/idea.md` (their own version), then **renames** the sibling
back to `idea.md`. On the next `[Sync]`:

1. `evaluateConflictState`'s **Phase A** runs first. The record's
   sibling path is `idea.conflict-from-Laptop-...md`, but that file
   no longer exists (the user renamed it onto `idea.md`). The
   record is dropped from the store.
2. **Phase B** observes that the path `idea.md` no longer has any
   open records. The store synthesises a side-batch whose effect is
   "push the current vault content of `idea.md` to main." This
   batch is added to the queue.
3. `processBatch` runs over the side-batch. It pushes the new
   content of `idea.md` to `main`.
4. After the queue drains, the conflict-record store is empty and
   the branch exists. The finalise block runs: a marker commit is
   written to the branch capturing the final state, then a
   merge-commit on `main` is constructed manually with two parents
   (the current `main` head and the branch head). The merge-commit
   becomes the new `main` tip, and the branch label is deleted.

The Laptop's next sync sees the merge-commit on `main`, pulls the
new tree, and writes the updated `idea.md`. Convergence achieved.

### Scenario B: A Long Offline Period and Accumulated Edits

The Phone has been offline for two weeks. During that time the
user has, on the Phone, edited `idea.md` six times — each edit
producing a separate commit batch on disk because of the
`accumulateOfflineSyncs = false` setting. Meanwhile, the Laptop has
been online and has made eleven of its own edits to the same file,
all pushed to `main`.

The user opens the Phone, connects to Wi-Fi, and clicks `[Sync]`.

The Phone's queue holds six batches: B1, B2, B3, B4, B5, B6 — each
one containing a successively more refined version of `idea.md`.
The drain processes them sequentially.

For **B1**, the pull-side step observes that `main` has eleven
commits the Phone has not seen. The plugin attempts auto-merge
against the base (the snapshot from two weeks ago), the Phone's B1
content, and the current `main` content. The text diverges — same
line, different edits — and auto-merge fails. A conflict branch is
created, B1's content is pushed to it, a sibling file is written.

For **B2 through B6**, the file is now in `inConflictFiles`. Each
batch's `processBatch` partitions the file into the "conflicting"
side: the content of `idea.md` for that batch is pushed as another
commit on the conflict branch, alongside B1. None of them go to
`main`. None of them update the existing sibling — only the
**branch** grows. The sibling continues to show the version of
`idea.md` that `main` currently has (the Laptop's most recent
version), unchanged.

After all six batches drain, the branch holds seven commits
(B1, B2, B3, B4, B5, B6, plus a `final state` marker added when the
queue empties). The Phone shows `🔀 1` in the status bar. The user
sees a single sibling file with the Laptop's version and the
current local file with the user's own latest version.

The user resolves the conflict — say by choosing their own version —
by deleting the sibling. The next `[Sync]` runs Phases A and B as
described in Scenario A: the record is dropped, the side-batch
propagates the current local content to `main`, and the
merge-commit on `main` lands. The merge-commit's second parent is
the branch head, so all seven branch commits remain reachable.

When the Laptop next synchronises, it pulls the merge-commit, sees
the new `idea.md`, and overwrites its own version. The Phone's
intent — accumulated over six iterations — is now the canonical
state, and the network graph on GitHub shows the full record of how
the Phone arrived at it.

### Scenario C: Multi-Sibling From Multiple Devices

A vault is shared across three devices: Laptop, Phone, Tablet. All
three edit `idea.md` independently during a brief no-connection
window. The Laptop syncs first (its version reaches `main`). The
Phone syncs second:

* Pull from `main` reveals divergence with the Laptop. Auto-merge
  fails (overlapping edits). A sibling is created:
  `idea.conflict-from-Laptop-2026-05-08T15-30-00Z.md` with the
  Laptop's content.
* A conflict branch is created on the Phone; the Phone's version of
  `idea.md` is pushed to it.

The Tablet now syncs. `main` still holds the Laptop's version (the
Phone's branch has not been merged). The Tablet's pull sees the
same divergence the Phone saw, but against the *Laptop's* content,
not the Phone's. Auto-merge fails; the Tablet writes its own
sibling:
`idea.conflict-from-Laptop-2026-05-08T15-30-01Z.md`. The Tablet
opens its own private conflict branch and pushes its own version of
`idea.md` to it.

The Phone now syncs again, having received a notification of the
Tablet's activity. The Phone's pull from `main` reveals no change
(the Tablet's branch is private). But suppose the user has switched
to the Laptop and resolved the original conflict — the Laptop's
merge-commit is now on `main`. The Phone's next pull sees that
`main` has a new version of `idea.md` (the Laptop's resolved
content). Because `idea.md` is already in conflict on the Phone,
the pull-side handler writes a **second** sibling on the Phone:
`idea.conflict-from-Laptop-2026-05-08T15-30-22Z.md`. The Phone now
has two siblings for the same base file, each from a different
"version of the Laptop." The resolution rule generalises naturally:
the conflict on `idea.md` is closed only when **every** sibling for
that path is gone (or matches the base byte-for-byte). The user
deletes or merges siblings one at a time; the path remains "in
conflict" until the last one is settled.

### Scenario D: Crash Mid-Create

The Phone is processing the conflict from Scenario A. Step 1 (write
`idea.conflict-from-Laptop-...sync-tmp.md`) completes. Step 2 (write
`meta.json`) begins. The OS suspends the app before `meta.json` is
fully written.

On the next plugin load:

1. The atomic-write recovery sweep walks the vault, finds the
   `.sync-tmp` staging file, and consults the conflict-record store.
   The record does not exist (Step 2 never finished). Per §9.5's
   `.sync-tmp` pass: no record names this final path → the staging
   file is dropped as a Path A transient (the only safe assumption
   when there is no ownership claim).
2. The conflict store loads (zero records).
3. The next `[Sync]` runs as if the confliet never happened. The
   pull re-encounters the divergence between Phone and `main`,
   auto-merge fails again, and the protocol restarts at Step 1 with
   a fresh record. The user sees the same end state as if the crash
   had not occurred — modulo the (effectively invisible) time
   between attempts.

Had the crash occurred between Step 2 and Step 3 instead — i.e.,
the record was written but the final rename did not happen — the
recovery sweep would find both the `.sync-tmp` staging file and a
record naming the final path. The SHA-verify check would succeed
(the bytes match `record.theirsBlobSha` because they were written
from `theirsContent` in Step 1), and the sweep would complete
Step 3 by performing the rename. The user opens Obsidian and sees
the sibling at its final name; nothing visible suggests anything
went wrong.

### Scenario E: Partial Resolution of a Multi-Path Conflict Session

Scenarios A through D all involved a single conflicted path. Real
multi-device usage routinely produces several conflicts in one
sync. This scenario traces how those resolve one at a time, and
what the relationship is between per-file resolution and the
conflict branch's final merge.

Consider a wider divergence than Scenario A: while the Phone was
offline, the user edited three files on it — `Notes/idea.md`,
`Notes/plan.md`, and `Notes/todo.md` — and the Laptop, online,
edited the same three files. All three pairs of edits land on
overlapping lines, so auto-merge fails on each.

When the Phone reconnects and clicks `[Sync]`, the drain processes
its queued batch:

1. Pull from `main` discovers that all three files diverge.
   Auto-merge attempts run, all three fail, and three conflicts are
   registered in sequence:
   - A conflict branch is created on the first registration —
     `github-easy-sync-conflicts-Phone-20260508153022-847` — at
     the current `main` HEAD. The Phone's pre-conflict version of
     `idea.md` is pushed to it as the first commit
     (`message: "conflict (Phone)"`).
   - The second and third registrations each append one commit to
     the **same** conflict branch, carrying the Phone's
     pre-conflict versions of `plan.md` and `todo.md` respectively.
   - Three sibling files are written next to the originals:
     - `Notes/idea.conflict-from-Laptop-...md`
     - `Notes/plan.conflict-from-Laptop-...md`
     - `Notes/todo.conflict-from-Laptop-...md`
   - Three conflict records are persisted, one per file.

State after the drain:

```
GitHub:
  main:       ── ... ── Cn (Laptop's three edits) ───────────
                            │
                            └── X1 ── X2 ── X3
                              (idea  (plan   (todo
                               Phone) Phone)  Phone)
                                              ↑
                                              conflict branch tip

Phone vault:
  Notes/idea.md                                  ← Phone's version
  Notes/idea.conflict-from-Laptop-...md          ← sibling (Laptop's)
  Notes/plan.md                                  ← Phone's version
  Notes/plan.conflict-from-Laptop-...md          ← sibling (Laptop's)
  Notes/todo.md                                  ← Phone's version
  Notes/todo.conflict-from-Laptop-...md          ← sibling (Laptop's)

Status bar: 🔀 3
```

Three records in the conflict store, one conflict branch with three
commits, three pairs of files in the vault. `main` is unchanged
relative to before the Phone's sync — none of the conflicted files
have reached it.

**First resolution — `idea.md`, by deleting the sibling.** The user
inspects, decides their Phone version of `idea.md` is correct, and
deletes the sibling `idea.conflict-from-Laptop-...md`. On the next
`[Sync]`:

- **Phase A** finds the record for `idea.md` has `!siblingExists`
  (user-deleted) → record dropped from store.
- **Phase B** observes that `idea.md` now has zero records →
  `enqueueSynthetic({path: "idea.md", content: <Phone's bytes>,
  parentCommitSha: lastSync, ...})` adds a side-batch to the queue.
- `processBatch` runs over the side-batch. The path is no longer in
  `inConflictFiles` (no records), so it partitions into `plainPaths`,
  and the new content of `idea.md` is pushed **to `main`** as an
  ordinary commit (`message: "resolve conflict (Phone)"`,
  `meta.synthetic: true`).
- **Finalise gate:** `store.records.length === 2` — `plan.md` and
  `todo.md` still have records. The finalise block at the end of the
  drain skips. The conflict branch is untouched.

```
GitHub:
  main:       ── ... ── Cn ── M1
                            │  ↑
                            │  "resolve conflict (Phone)" — idea.md
                            │
                            └── X1 ── X2 ── X3   (unchanged)

Status bar: 🔀 2
```

**Second resolution — `plan.md`, by renaming the sibling onto the
base.** The user prefers the Laptop's version of `plan.md`. They
rename `plan.conflict-from-Laptop-...md` → `plan.md`, overwriting
the Phone's version. On the next `[Sync]`:

- **Phase A** finds the record for `plan.md` has `!siblingExists`
  (renamed away) → record dropped.
- **Phase B** synthesises a side-batch for `plan.md` containing the
  bytes now sitting at `plan.md` (the Laptop's version).
- `processBatch` pushes the new `plan.md` content to **`main`** as
  another ordinary commit.
- **Finalise gate:** `store.records.length === 1` — `todo.md` still
  pending. Finalise still does not run.

```
GitHub:
  main:       ── ... ── Cn ── M1 ── M2
                            │       ↑
                            │       "resolve conflict (Phone)" — plan.md
                            │
                            └── X1 ── X2 ── X3   (still unchanged)

Status bar: 🔀 1
```

**Third (and last) resolution — `todo.md`, by hand-merging.** The
user opens both `todo.md` and its sibling, copies the wanted lines
from each into `todo.md`, then deletes the sibling. On the next
`[Sync]`:

- **Phase A** finds the record for `todo.md` has `!siblingExists`
  → record dropped.
- **Phase B** synthesises a side-batch for `todo.md` with the
  merged content.
- `processBatch` pushes the merged `todo.md` to `main` as the third
  "resolve conflict (Phone)" commit.
- **Finalise gate:** `store.records.length === 0` **and** the
  conflict branch exists → the finalise block fires:
  1. A marker commit (`final state (Phone)`) is written to the
     branch's tip, preserving the Phone's final state on the branch.
  2. A manual `createCommit({message: "merge conflict-branch
     (Phone)", treeSha: main.tree, parents: [main.head,
     branch.head]})` constructs the merge-commit on `main`.
  3. `updateBranchHead` makes the merge-commit `main`'s new tip.
  4. `deleteReference("heads/github-easy-sync-conflicts-Phone-...")`
     removes the branch label. The four branch commits remain
     reachable through the merge-commit's second parent (§2.3).
  5. `lastSyncCommitSha` is advanced to the merge-commit.

```
GitHub:
  main:       ── ... ── Cn ── M1 ── M2 ── M3 ── M (merge-commit)
                            │                  /
                            └── X1 ── X2 ── X3 ── X4 (final state)
                            (branch label deleted; commits still reachable through M)

Status bar: (empty — no conflicts pending)
```

**Net history view.** The repository now shows, in chronological
order on `main`:

- `Cn` — the Laptop's pre-conflict commits.
- `M1`, `M2`, `M3` — three separate "resolve conflict (Phone)"
  commits, one per resolved file. Each commit touches exactly its
  one file; no batching, no cross-contamination between resolutions.
- `M` — the merge-commit that joins the conflict branch back into
  `main`. Its second parent is the branch tip; the four branch
  commits (X1, X2, X3, X4) remain part of the repository's history
  forever, visible in the GitHub Network graph as a four-commit side
  arm joining `main` at `M`.

**The structural property to note.** The conflict branch was alive
for the full duration of the multi-conflict session — through all
three per-file resolutions — and was only finalised when the
**last** record disappeared from the store. Each per-file resolution
published its result to `main` as an ordinary commit by the same
Phase B → side-batch → `processBatch` → main-push pipeline that any
non-conflicting file would use. The branch and its merge-commit
exist for one reason only: to keep the Phone's pre-conflict and
in-conflict edits to *every* file in this session permanently
reachable from `main`. Per-file closure is therefore cheap and
local — one ordinary commit on `main`, no branch round-trips — and
the branch lifecycle is governed strictly by the "store empty?"
predicate at drain end.

---

## 11. Cross-Platform Contracts

The conflict-resolution layer of §4–§10 works because the underlying
file primitives behave the same way on every platform the plugin
ships to. They do not — Obsidian Mobile (Android + iOS, Capacitor)
and Obsidian Desktop (Electron) diverge in three places that matter
to the protocol. The plugin pays the cost of normalising these once,
in a single module (`src/sync2/cross-platform.ts`), rather than
scattering the workarounds across every call site that would
otherwise hit one of the divergences.

Three contracts live in that module.

**Filename character set.** Obsidian Android refuses to create a file
whose name contains any of the Windows FAT/NTFS-forbidden ASCII
characters (`< > : " | ? * \`). The rejection is platform policy,
not filesystem policy — the bridge layer enforces it even on
filesystems that would happily store the bytes. Obsidian itself
(Desktop *and* Mobile) rejects a second family (`# ^ [ ]`) because
those characters have grammar meaning in wiki-links
(`[[note#heading]]`, `[[note^block-id]]`, `[[link]]`). The two
families together are 12 ASCII characters that are unsafe in any
vault path the plugin needs to materialise. They can still arrive
from outside — a Desktop user creating a name on macOS, the GitHub
web UI, raw git, a different tool committing to the repo — and the
protocol has to canonicalise them on the way through.

`sanitizeFilename(path)` rewrites every forbidden character to its
visually-faithful Unicode counterpart (curly quote for `"`,
modifier-letter colon for `:`, fullwidth glyphs for the rest). The
12-character map is stable, deterministic, and round-trips through
the sync protocol cleanly because every replacement is a single
Unicode codepoint outside both forbidden families and is accepted by
every vault adapter the plugin ships to. `needsSanitization(path)`
is a cheap fast-path predicate so the common case (a clean path)
costs O(n) regex match and no allocation.

Both functions fire on two surfaces. The push side runs them over
the vault walk before `findChanges`: any local file whose name
contains a forbidden character is renamed in place through
Obsidian's link-aware rename API (so wiki-links pointing at the old
name follow the file), and only then does change-detection see the
canonical form. The pull side runs them over the incoming GitHub
paths: any forbidden-named GitHub file is materialised under its
canonical local name, and the forbidden remote path is recorded in
the pending-deletions queue (§12.2) so the next push cleans GitHub.
A multi-device vault that started with a forbidden-named file ends
up — after one round-trip of sync from any device — with that file
present under its canonical name on every device and on GitHub.

**URL encoding for GitHub Contents API paths.** The
`/repos/.../contents/<path>` endpoint embeds the path directly in
the URL. Characters with URL syntax meaning — `?`, `#`, ` `, `%` —
terminate the path component on the server side: a request for the
path `[1] File ^ opa?.md` reaches the API as the path
`[1] File ^ opa` with `md` as a query parameter, and the API
truthfully returns 404 for a file that doesn't exist at the
truncated path. `encodePathForGithub(path)` percent-encodes per
segment, preserving `/` as the structural separator. The plugin's
GitHub client routes every contents-API URL construction through
this helper so the policy "no raw path interpolation into a URL" is
enforced at the one place where it matters.

**Adapter rename portability.** Capacitor's `adapter.rename` on
Android and iOS throws "Destination file already exists" when the
destination is occupied. POSIX `rename` (Desktop's path) silently
overwrites. The portable pattern — `if (exists(dst)) remove(dst);
rename(src, dst)` — is wrapped as `safeRename(adapter, src, dst)`.
Every protocol step that ends in a rename — the staging-file
promotion of §9.3 Step 3; the conflict-store `meta.json.tmp` rename
in §9.4; the pending-deletions store's persistRecord; the atomic-
write rollback path — calls this helper rather than inlining the
dance. A future contributor who introduces a new write-then-rename
step gets the cross-platform behaviour for free, and the rationale
for the existence of the dance lives in one place rather than
duplicated across five call sites.

These three contracts are not optional decoration. They are
load-bearing properties of the protocol: the conflict layer depends
on `safeRename` to land its `meta.json` atomically, the push
pipeline depends on `encodePathForGithub` to identify the right
remote path under any vault filename, and pull-side reconciliation
depends on `sanitizeFilename` to materialise files Mobile can store.
They share a module because they share an invariant: "anything the
plugin must do differently on Mobile vs. Desktop goes here first;
the call sites do not see the difference."

---

## 12. The Push Pipeline

The conflict-resolution layer of §4–§10 describes WHEN a path goes
to the conflict branch and HOW its sibling is constructed. The push
pipeline of this section describes WHAT happens when a
non-conflicting batch reaches GitHub. The path is simple at the top
— fetch HEAD, build tree, create commit, fast-forward branch — but
three structural guarantees make it robust against the failure modes
that show up in multi-device traffic.

### 12.1 Pre-flight validation

Every `createTree` request the plugin sends carries some combination
of file additions, modifications, and deletions. Additions and
modifications include inline content; GitHub assembles them
server-side with no further round-trips to anywhere else. Deletions
are different: they reference a path by name with `sha: null`, and
GitHub interprets the entry as "remove this path from the new tree."
For the interpretation to succeed the path must exist at the parent
tree the create-request is rebasing onto. If it doesn't — if the
path was deleted by another device, or by a manual GitHub web edit,
between when our batch was constructed and when our push reaches the
server — GitHub responds 422 `GitRPC::BadObjectState` and the whole
tree-create fails. Repeated retries fail identically until the local
state is reconciled.

A stale deletion is a structural risk for any multi-device sync —
not a bug to be patched once but a class of inconsistency that the
protocol has to absorb on every push. The plugin's defence is to
validate every deletion entry against `currentHead` before the
tree-create request leaves. The validator lives in `processBatch`
between `TreeBuilder.buildTreeEntries` and `client.createTree`. For
each entry with `sha: null` it calls `getContentsAtRef(path,
currentHead)`. If the path exists at currentHead, the deletion is
kept. If the path is absent (the API returns null), the deletion is
dropped — and the matching snapshot row is removed too, so the next
change-detection pass does not re-emit the same stale deletion. The
batch is sent only with entries that match remote state at push time.

The validator handles its own failure mode explicitly. If
`getContentsAtRef` itself throws (network timeout, GitHub 5xx,
dropped connection), the validator throws and the push aborts;
`lastSync` does not advance, the queued batch survives on disk, the
next drain retries. This is intentional. Pre-flight validation is a
safety net, not a performance optimisation. If the net cannot run,
the engine defers to the next drain rather than optimistically
proceeding and risking the 422 the net was designed to prevent.
From the user's perspective: one click "didn't go through"; the
next click (or interval tick) succeeds once the network recovers.

The validator does not check additions or modifications — those
have content the server resolves regardless of base-tree state.
The discipline is targeted at the one entry shape that turns
"remote state changed under us" into a hard failure.

### 12.2 Pending-deletions queue

Pull-side sanitize (§11) materialises a forbidden-named GitHub file
under its canonical local name and needs a way to record "delete
this forbidden path on the next push." The naïve approach — write a
`SnapshotStore` entry at the forbidden path so the next change-
detection pass emits a deletion — fits the existing diff-driven
push pipeline but violates the snapshot store's contract: every
snapshot entry is documented as "what we observed on GitHub at the
recorded SHA," and a phantom-for-delete-intent entry is not an
observation. The protocol uses an explicit store instead.

The pending-deletions store lives at
`<configDir>/plugins/<self>/.pending-deletions/`, one folder per
entry, each containing a `meta.json` with the path, the source
(`pull-side-sanitize` / `migration-from-snapshot` / `manual`), the
GitHub commit SHA at which the path was last observed present, and
the blob SHA at that commit. The `processBatch` consumer injects
every queue entry as an additional deletion in the tree-create
request; pre-flight validation (§12.1) covers it just like a
change-detector-emitted deletion; a successful push clears the
matching queue entry; a failed push leaves the entry untouched for
the next drain.

The separation has two structural pay-offs. The snapshot store
stays a verifiable cache — every row is now "we observed this path
with this SHA at this commit on GitHub" — and any reader can trust
its values without checking which entries are real and which are
delete-intents. The pending-deletions store is named for what it
does — its content type is "delete these paths from GitHub on the
next push" — and the activity log entries that reference it
(sources, dropped-as-stale events, successful clear-on-push events)
are diagnosable on their own terms.

Reset semantics are uniform. Plugin Reset (Settings → Reset) wipes
the pending-deletions store alongside the snapshot, the push-queue,
and the conflict store; the store cannot outlive an explicit Reset
action. Plugin uninstall removes `<configDir>/plugins/<self>/`
recursively through Obsidian's own cleanup; the store cannot outlive
the plugin installation. Both lifecycles are honest about ownership.

### 12.3 Push-queue depth as user signal

The ribbon `[Sync with GitHub]` icon carries a numeric badge. The
number it shows is the count of batches currently on disk under
`.push-queue/`, waiting for `drain()` to dispatch them. Depth 0
hides the badge; depth ≥ 1 shows `(N)` in a small green pill at
the corner of the icon. The signal is updated after every persistent
queue mutation: `enqueueOrMerge` writes a new batch (depth +1, or
+0 if folded into an existing one); `processBatch` deletes a
successfully-pushed batch (depth −1); the empty-after-reconcile
branch deletes the queue entry too. On plugin start, the icon is
seeded with the current queue depth from disk so the badge reflects
state even after a restart.

The signal is read-only and load-bearing for the user's mental
model of "I clicked Sync; where did my work go?". The badge appears
the moment a batch lands on disk, persists while drain processes it
(typically 1–3 seconds of HTTP round-trips), and clears when the
push succeeds. Offline syncs accumulate batches — the badge climbs
`(1)` → `(2)` → `(3)` — and the next reconnection drains them with
the badge decrementing in lock-step. The user has direct visibility
into the engine's state without needing to open the activity log.

The badge does not show the unresolved-conflict count. That signal
lives on the status-bar `🔀 N` indicator (§5), which is the
canonical home for the conflict layer's state. The two surfaces are
deliberately distinct: the sync icon reflects pipeline state (do I
have outbound work pending?), the status-bar reflects collaboration
state (do I have unresolved conflicts to address?). The diff2
widget (`DIFF2_IMPLEMENTATION_PLAN.md` R2.7.4) introduces a third
surface — a separate ribbon icon — that mirrors the status-bar
conflict count for users who prefer the ribbon as their primary
visual area.

---

## 13. Error Taxonomy

A sync engine that talks to GitHub fields four broad kinds of
failure: network-level (connection dropped before any HTTP response
was assembled), HTTP-level (GitHub returned a 4xx or 5xx that the
engine must dispatch on), platform-level (the local OS or WebView
refused a vault operation), and inconsistency-level (the engine
observed two pieces of remote state that contradict each other
within a single sync click). The plugin models all four as a typed
class hierarchy in `src/errors.ts`:

```
SyncError                  (abstract base — never thrown directly)
├── NetworkError           (transient — retriable=true)
├── GithubAPIError         (typed HTTP response from GitHub)
│   ├── NotFoundError      (404)
│   ├── ConflictError      (409 — bare repo, ref mismatch)
│   ├── ValidationError    (422 — malformed request OR stale state
│   │                        per body.message)
│   ├── AuthError          (401, 403 — token problems)
│   └── RateLimitError     (429 — retriable=true)
├── PlatformError          (Capacitor / WebView refused a vault
│                            operation — non-retriable, user-visible)
└── StaleStateError        (two pieces of remote state observed in
                              one sync click no longer agree)
```

Three properties make the hierarchy useful at the catch site.

First, **`instanceof` dispatch.** A catch site that needs to handle
"any GitHub HTTP error" matches on `GithubAPIError`; one that needs
only the 404 case matches on `NotFoundError`. The same error
instance answers both queries because TypeScript classes form a real
inheritance tree. No status-code switch is needed; no string
matching on `error.message`; no duck-typing on `(err as { status?:
number }).status`. The catch is as specific or as broad as the
handling demands, no more.

Second, **the `retriable` getter.** Every class declares whether
retrying the operation that produced it can plausibly succeed.
`NetworkError.retriable` is true (a network blip resolves on next
attempt); `ValidationError.retriable` is false (a malformed payload
stays malformed); `RateLimitError.retriable` is true (with backoff);
`PlatformError.retriable` is false (the WebView's rejection is
deterministic until the input changes). The retry policy lives on
the class, not on the catch site, and the retryUntil predicate
consults `error.retriable` rather than re-deriving the answer from
status codes at every call.

Third, **the `name` field.** Every subclass sets `this.name =
new.target.name`, so `String(err)` reads "StaleStateError: ..."
rather than the generic "Error: ...". The activity log and bug
reports get classifiable error names automatically through
`describeError()`'s `ctor` field. Failure modes are filterable in
the log without inspecting the message string; users who paste a
log snippet into an issue carry the class name with it.

The 422 case deserves a note. GitHub returns 422 for two distinct
sub-causes — malformed payload, and `GitRPC::BadObjectState` from
remote state drift (§12.1) — and the type system models both as
`ValidationError`. Catch sites that need the distinction read
`error.body?.message` directly. The choice was pragmatic: the
second sub-cause is rare once pre-flight validation runs, and
splitting the type would couple every catch site to the specific
GitHub message string rather than to the class. The same logic
applies in reverse to `StaleStateError`: the engine raises it for
several causes (compare/fetch disagreement from a client bug, token
permission drift, replica consistency lag, force-push race), all of
which share the same retry policy ("retry one drain; if it repeats,
the operator needs to investigate") and so do not need separate
subclasses.

The hierarchy is deliberately flat. Adding a sixth or seventh
status-code subclass is easy when the engine starts caring about a
new code; adding parallel sub-hierarchies is also possible but
currently unnecessary — catch sites distinguish the rare sub-causes
by reading log context, not by `instanceof`.

---

## 14. Skip-Class Discipline

Loops over remote-change lists and batch entries are full of
`continue` and early `return` statements. Each one represents a
deliberate decision by the loop body to not process the current
item the way it processes its siblings. The decisions look identical
at the language level but mean very different things — and the
consequences of confusing them are visible in the protocol's
history. The discipline below codifies the meanings so future
contributors can audit a skip in isolation.

Four labels enumerate every legitimate reason to skip:

**`applied`** — the operation completed via a non-default code path.
A sibling write that landed the same bytes as the base; a deletion
processed inline rather than through the main flow; a sanitize
migration that ran on the spot. The cursor (snapshot row, lastSync,
queue entry) advances normally; the work is done, just not through
the loop's main branch.

**`deferred`** — the operation is intentionally postponed to a
different code path. The push-queue overlap case is the canonical
instance: when a pull-side change targets a path that has an in-
flight push batch, the pull defers to the post-reconcile drain
rather than racing the push. The cursor does NOT advance for this
path; an `anyOverlapDeferred` flag tells the caller to hold
`lastSync` so the deferred change is not lost on the next
incremental sync.

**`already-correct`** — the desired state is already on disk. SHA-
match resume during pull is the canonical instance: a previous pull
pass wrote the bytes and crashed before recording the snapshot row,
so the next pass reads the local file, hashes it, finds the SHA
matches the expected one, refreshes the snapshot stat-cache, and
skips. The skip is a true no-op for the disk; the snapshot row is
the only thing advancing.

**`unexpected`** — the operation could not be applied and the loop
body does not know why. This is the dangerous case. A silent
`continue` here advances loop state past the failure; if the loop
also advances any cursor (lastSync, snapshot row, queue entry),
the failure is permanently masked — the next sync's compare diff
no longer surfaces the path because the state appears consistent.
The discipline is: an `unexpected` skip is never a `continue`. It
is `throw new StaleStateError(...)`. The error propagates to the
per-file catch in the calling loop, which logs the exact path and
re-throws; the outer loop aborts; the cursor does not advance; the
next sync retries.

Every skip in the seven loops at the heart of the sync engine —
`pullIfNeeded`, `applyRemoteAddOrModify`, `applyRemoteDeletion`,
`processBatch`, `reconcileBatchAgainstHead`, `bootstrapFromRemote`,
`adoptionPullAndRecord` — is annotated with one of these four
labels as a source comment immediately preceding the `continue` or
`return`. The annotation is documentation for future readers, but
it also enforces the protocol's most important contract: there is
no fifth category. If the loop body cannot place a skip into one of
the four buckets, the bucket is `unexpected` and the line should be
a `throw`, not a `continue`.

---

## 15. What Pseudo-Merge Mode Does *Not* Promise

Honest engineering documentation must enumerate what the design does
not solve, in addition to what it does. Four points deserve explicit
mention:

**Ping-pong between two devices on the same file is possible.** If
Device A and Device B both detect a conflict on `idea.md` at
roughly the same time, each opens its own private conflict branch.
When A resolves and merges, `main` advances. The next sync on B
sees that advance, may itself detect a fresh conflict against the
new `main` (B's local version still differs from the post-merge
state), and produces *yet another* sibling on B. This is a
fundamental property of distributed concurrent edit, not a flaw in
the protocol. The user resolves it with the same workflow as any
other conflict; the only consequence is that "resolve once and be
done" requires the absence of further independent edits during the
resolution.

**Atomicity per `[Sync]` click no longer holds.** A single click
may produce some commits on `main` (for non-conflicting files) and
some commits on a conflict branch (for conflicting files). This is
analogous to `git pull --rebase` splitting local commits into
patches, and is unavoidable given that the protocol must always be
able to publish non-conflicting changes without waiting on a
human-in-the-loop conflict resolution.

**The conflict branch is private and not shareable.** Another
device — even one owned by the same user — cannot help resolve the
conflict; the branch is invisible to peers, and finalising it can
only be done by the device that opened it. This is a deliberate
trade-off in favour of conceptual simplicity: every sync involves
exactly two entities (this device and `main`), never a triangle.

**Orphan conflict branches accumulate.** If a device is permanently
retired — uninstalled, lost, factory-reset — its conflict branches
remain on GitHub, with no automated cleanup. The user can delete
them manually through the GitHub web UI at any time; the plugin
itself does not enumerate-and-prune, on the principle that doing so
would be too easy to invoke accidentally and would silently destroy
work the user might still want.

---

## 16. Field Postmortems

The design as described in §1–§15 reads as a single coherent
protocol, but the path to that protocol passed through specific
field incidents that surfaced specific structural gaps. The five
postmortems below preserve the historical record: each one captures
the symptom that was reported, the proximate cause that was
identified, and the section above whose discipline now makes the
class of failure unreachable. Future contributors investigating a
similar symptom can use the list as a triage index.

### 16.1 `FILE_NOTCREATED` on Obsidian Android (2026-05-25)

**Symptom.** Mobile sync of a desktop-created file named
`Actual-projects/Ладовіра/Штрихи до "святої" книги "Віра в Лад".md`
failed with a Notice `Error syncing. Error: FILE_NOTCREATED`. The
plugin log surfaced the full bridge-layer message only after the
observability fix below; the underlying rejection came from
`win.androidBridge.onmessage`.

**Cause.** Obsidian Android refuses to create files whose name
contains any of the Windows FAT/NTFS-forbidden ASCII characters
(`< > : " | ? * \`) — independently of the underlying filesystem,
as a cross-platform-compatibility safeguard so a vault that syncs to
a Windows desktop won't break. Desktop Obsidian on macOS or Linux
happily creates such names because the underlying POSIX filesystem
allows them, and the asymmetry was invisible until the file crossed
platforms.

**Now-covered-by:** §11 *Cross-Platform Contracts* (the
`sanitizeFilename` / `needsSanitization` discipline rewrites the
12-character forbidden set to canonical Unicode replacements on
both push and pull sides; multi-device vaults converge on the
canonical form after one round-trip).

### 16.2 `err: {}` in the plugin log (2026-05-25)

**Symptom.** Every recorded sync failure showed
`additional_data: {"err": {}}` — the captured error object
serialised as an empty object. Bug reports were unactionable: a sync
failure was visible in the log but its cause was not.

**Cause.** Two layers. (1) The `sync()` and `syncCurrentFile()`
click handlers caught errors and showed a Notice but never called
`logger.error`. The toast disappeared in seconds; the log saw
nothing. (2) When the catch site DID reach a logger call (e.g. the
interval-drain handler), `safeStringify` only unwrapped
`v instanceof Error` to extract `name`/`message`/`stack`.
Capacitor's native-bridge errors on Android come through as objects
whose `instanceof Error` evaluates to `false` (different JS realm)
and whose Error-shape fields live on the prototype rather than as
own enumerable properties. `JSON.stringify` of such an object
produces `{}`.

**Now-covered-by:** `src/utils.ts::describeError(err)` extracts
`type`, `ctor`, `string` (via `String(err)`), and the Error-shape
fields via direct property access that survives prototype-only
definitions. `src/logger.ts::safeStringify` mirrors the same
extraction so any `logger.error(msg, { err })` site benefits
automatically. The two click handlers log before showing a Notice.
The typed-error hierarchy of §13 makes the resulting log entries
classifiable by `name` for filtering.

### 16.3 `404` on GitHub Contents URLs containing `?`, `#`, etc. (2026-05-25)

**Symptom.** A file named `[1] File ^ opa?.md` pushed via the
GitHub web UI was unreachable by pull. `GET contents/[1] File ^
opa?.md` returned 404 despite the file existing in the GitHub tree.

**Cause.** The GitHub Contents-API URL was constructed by direct
string interpolation of the path. URL-syntax characters (`?`, `#`,
` `, …) terminate the path component on the server side: the API
saw the path as `[1] File ^ opa` with `md` as a query parameter —
no such file at that path → 404.

**Now-covered-by:** §11 *Cross-Platform Contracts*
(`encodePathForGithub` percent-encodes per segment; every Contents-
API URL construction routes through it; raw path interpolation is
forbidden by convention and missing from the GitHub client code).

### 16.4 Orphaned state after silent skip on null fetch (2026-05-25)

**Symptom.** After the URL-encoding bug in 16.3 was hit on mobile,
the `[1] File ^ opa?.md` file remained absent from the mobile vault
on every subsequent sync — even after the encoding fix shipped. A
Plugin Reset (full re-bootstrap) was required to recover.

**Cause.** `applyRemoteAddOrModify` treated a
`safeFetchContents → null` result as "raced with subsequent remote
delete; skip this file." The 404 from the URL-encoding bug returned
null. The pull loop continued; `lastSync` advanced to the new
branch head. From the next sync forward, the compare diff between
`lastSync` and `currentHead` no longer surfaced the file as a
change — it was present at both ends with the same SHA — and the
file became invisible to incremental sync.

**Now-covered-by:** §14 *Skip-Class Discipline*. The compare-listed-
but-fetch-null case is now `unexpected` and throws
`StaleStateError`. The per-file catch in `pullIfNeeded` logs the
exact path; the loop aborts; `lastSync` stays at the prior
`expectedHead`; the next sync retries. Either succeeds (transient
race resolved, permission drift fixed, fixed-client deployed) or
re-fails until the underlying cause is gone — no orphan state.

### 16.5 `GitRPC::BadObjectState` (422) on stale deletion entries (2026-05-25)

**Symptom.** Two desktop syncs within thirty minutes of one
release produced six retries each (~17 seconds of network noise)
and a final `Error: Failed to create tree, status 422`. Both pushes
carried a deletion entry for a path that had been sanitized away on
a different device hours earlier.

**Cause.** Pull-side sanitize wrote a *phantom snapshot entry* at
the forbidden GitHub path with the GitHub blob SHA. ChangeDetector
Pass 2 saw the snapshot entry had no local file → emitted a
deletion change → TreeBuilder built a `sha:null` entry → push
attempted `createTree` with a deletion targeting a path another
device's sanitize-push had already removed. GitHub responded 422
`GitRPC::BadObjectState`. The bug was rare before pull-side
sanitize existed (the only way to produce a stale deletion was a
manual edit on GitHub web between two syncs) and systemic
afterward (any forbidden path migrated by Device A produced a
phantom on Device B that became stale as soon as Device B pulled
post-migration).

**Now-covered-by:** §12.1 *Pre-flight validation* (the validator
drops stale deletions before `createTree`; the matching snapshot
row is removed so ChangeDetector does not re-emit the same stale
deletion next sync) and §12.2 *Pending-deletions queue* (sanitize
intent is recorded in an explicit store, not as a phantom snapshot
entry; the snapshot invariant "every row is an observation, not a
delete-intent" is restored).

### 16.6 `theirsBytes:0` on >1 MB files → silent overwrite of remote (2026-05-29)

**Symptom.** A Desktop sync push converted eight remote files on
GitHub `main` into 47-byte stubs that contained only the heading
inserted by another Obsidian plugin (filename-as-heading
auto-prepender). Three of the affected files had been >1 MB
markdown notes on GitHub; the overwriting commit was authored by
sync2 with the standard `Sync at <ts> (<device>)` message. Plugin
log showed `Sync2 reconcile path bytes-resident
oursBytes:47 theirsBytes:0` for each file, then silently chose
"ours wins" with no explicit decision log.

**Cause.** Two faults stacked.

1. *Local trigger.* The three large notes had previously become
   0 bytes on Desktop (root cause not in sync2 — most likely an
   external write or a crash mid-write through an unrelated
   plugin). When the user next opened them, the filename-as-heading
   plugin observed empty content and prepended a `# <basename>`
   line, leaving a 47-byte file. Local-only state is by definition
   sync2's input, not sync2's output — so the plugin had no notion
   that the change was unintended.

2. *Reconcile blind spot (the structural bug).* GitHub's Contents
   API has a hard ~1 MB inline-content limit. For files between
   1 MB and 100 MB the API returns status 200 with
   `content: ""` and `encoding: "none"`, expecting the caller to
   fall back to the Blobs API by the file's blob SHA.
   `GithubClient.getContentsAtRef` returned the empty `content`
   verbatim. The reconcile call site decoded it as a 0-byte
   `ArrayBuffer`, computed a 3-way merge against `base=∅, theirs=∅,
   ours=47 bytes`, and concluded `modify-wins → push ours`. The
   resulting tree carried 47-byte blobs for paths that had been
   ~1 MB on remote, and the push committed cleanly because GitHub
   itself does not care about size delta.

**Now-covered-by:** §11 *Cross-Platform Contracts* extended with
the Contents-API size discipline.
`GithubClient.getContentsAtRef` now inspects `size` and `encoding`
on the response: when `size > 0` and `content === ""` (the
documented "too large for inline" case), it fetches the actual
bytes via `getBlob({ sha })`. The fallback path is INFO-logged
with `{ path, ref, size, encoding, sha }` so a production sync
that hits a large file leaves a visible breadcrumb. A unit suite
(`tests/sync2/github-client-large-file.test.ts`, 5 cases) covers
the four branches — inline-content path, legitimately-empty file,
documented-empty large file with Blobs fallback, defensive
`content: null` variant — and an integration suite
(`tests/integration/scenarios/sync2/edges/F-large-file-over-1mb.test.ts`)
exercises a real 1.5 MB markdown round-trip through push, remote
read, and an incremental reconcile cycle. The companion
defensive-guard work (zero-byte → conflict instead of push;
>90 % shrink heuristic; explicit reconcile decision logging) is
tracked as separate hardening tasks and ships in a follow-up
release; this postmortem covers the structural fix that resolves
the primary failure mode.

---

## 17. Glossary

The following terms appear repeatedly in the article. Definitions are
intentionally concise; consult the relevant section for context.

**Auto-merge** — The first step on any divergent path: an attempt to
reconcile the two sides without surfacing a conflict to the user.
Succeeds for non-overlapping text edits, plugin bundles with
differing semantic versions, and modify-vs-delete pairs; otherwise
the path is registered as a conflict.

**Base** — The last commit (and its corresponding file content) that
both diverging sides agreed on. The "common ancestor" in three-way
merge terminology. Stored locally in the snapshot store
(`metadata.json`'s `lastSyncCommitSha`) and re-fetched as needed
during pull-side reconciliation.

**Batch** — A unit of synchronisation work persisted on disk under
`.obsidian/plugins/github-easy-sync/.push-queue/<id>/`. Holds the
files about to be committed, their target commit message, and the
parent commit SHA the push will build on.

**Blob** — A file's content addressed by the SHA-1 hash of its bytes.
The fundamental unit of git's object storage; has no name and no
location of its own.

**Commit** — A snapshot of a tree, accompanied by a list of parent
commits, an author, a committer, and a message. The unit of
historical record in git.

**Conflict branch** — A per-device GitHub branch named
`github-easy-sync-conflicts-<deviceLabel>-<timestamp>-<msec>` to
which the device's local version of every conflicting file is
pushed. Invisible to other devices until finalised through a
merge-commit on `main`.

**Conflict record** — A persisted entry in the conflict store binding
a vault path to its sibling file, the remote content's SHA, the
remote device's label, and cached `(mtime, size, sha)` triples for
fast freshness checks. Stored on disk as one
`meta.json` per record under
`.obsidian/plugins/github-easy-sync/.conflicts/<id>/`.

**Conflict store** — The in-memory plus on-disk index of all active
conflict records. The single source of truth for "what is in
conflict on this device"; the set of in-conflict file paths is
derived from the store, not stored separately.

**Drain** — The plugin's network worker loop, executed once per
`[Sync]` click (and on interval ticks). One iteration of the loop
pulls from `main`, then pushes one batch from the queue, then
repeats until the queue is empty.

**Finalise** — The closing sequence when a conflict branch's last
record is dropped: marker commit on the branch, a manually
constructed merge-commit on `main` whose parents are
`[main.head, branch.head]`, and a `deleteRef` removing the branch
label. All branch commits remain reachable through the
merge-commit's second parent.

**HEAD** — A label naming "the current commit." On GitHub, every
branch has a HEAD (its tip); the plugin reads each branch's HEAD
during pull and updates `main`'s HEAD on push. The plugin does not
maintain a working-copy HEAD — the vault on disk plays that role.

**Merge-commit** — A commit with two or more parents. Records that
two lines of history have been joined; does not introduce file
changes of its own. The finalise step builds one of these manually
to merge a conflict branch back into `main`.

**Phase A / Phase B** — The two phases of `evaluateConflictState`,
the only function that mutates the conflict store at runtime. Phase
A is per-record: it removes engine-deletable siblings (where the
sibling and base contents are identical) and drops records whose
siblings the user already deleted. Phase B is per-path: for every
path whose records all disappeared during Phase A, it synthesises a
side-batch that propagates the live vault state to `main`.

**Reachability** — A commit is reachable from a label (a branch, a
tag, HEAD) if there is a chain of parent pointers leading from the
label's commit to the commit in question. git's garbage collector
preserves all reachable commits indefinitely; pseudo-merge mode
exploits this to keep branch history alive after the branch label is
deleted.

**Reconciliation (push-side)** — The handling in `processBatch` of
the situation in which `main`'s HEAD advanced between the batch's
creation and its push. The same auto-merge gate as on the pull side
runs against the new `main` tree; failure registers the path as a
conflict, the same as a pull-side detection would.

**Sibling file** — An additional file in the vault next to a
conflicting base file, named
`<basename>.conflict-from-<remoteDevice>-<isoTimestamp>.<ext>` and
carrying the remote side's content. The user resolves the conflict
by manipulating this file with standard operations: delete it, edit
it, rename it onto the base, etc.

**Side-batch** — A batch synthesised inline by Phase B of
`evaluateConflictState` to propagate a resolved file's live content
to `main`. Marked `synthetic: true` in its meta.json; treated as a
solo batch by the queue (never folded into other user batches).

**Snapshot store** — The local persistent record of "what each path
looked like in the version of the repository this device most
recently synchronised against." Stored at
`.obsidian/plugins/github-easy-sync/github-easy-sync-metadata.json`.
Used by the change detector and by pull-side reconciliation to
distinguish "this file changed locally" from "this file changed
remotely" from "this file changed on both sides."

**Staging path / `.sync-tmp` / `.sync-bak`** — The intermediate
location of a file during the atomic write protocols. `.sync-tmp`
holds new bytes destined for a target path (forward direction;
both Path A and Path B produce these). `.sync-bak` holds the old
bytes of a file moved aside before an overwrite (rollback
direction; only Path A produces these). Both use pre-suffix form
(e.g., `note.sync-tmp.md`, `note.sync-bak.md`) so that the file
extension is preserved and gitignore's `*.sync-tmp*` / `*.sync-bak*`
patterns catch them. See §9.

**Tree** — A directory listing in git's object storage: an ordered
collection of `(name, mode, sha)` entries where each `sha` points
at a blob (file) or another tree (subdirectory). Trees are
content-addressed; identical directory contents produce the same
tree SHA regardless of where in the project they appear.

**Watermark** — A timestamp threshold used to skip stat-and-hash
work for unchanged files. The change detector compares each
vault file's `mtime` to `SnapshotStore.lastCommitMtime` and only
considers files modified since that point as candidates for a real
diff. The same pattern is used per-record in the conflict store for
the cached `(siblingMtime, siblingSize, siblingSha)` triple.

**Cross-platform contract** — A rule of the form "this filesystem
/ URL / adapter behaves differently on platform X than on platform
Y" that the protocol normalises in one place. The three current
contracts (forbidden-character set, GitHub Contents URL encoding,
Capacitor-rename-doesn't-overwrite) live in
`src/sync2/cross-platform.ts`; see §11.

**Forbidden character (filename)** — One of the 12 ASCII characters
rejected either by the host platform (Family 1: `< > : " | ? *
\` — Obsidian Android only) or by Obsidian itself (Family 2: `# ^
[ ]` — both platforms, because of wiki-link grammar). Replaced by
`sanitizeFilename()` with visually-faithful Unicode counterparts;
see §11.

**Pending-deletions queue** — Explicit on-disk store at
`<configDir>/plugins/<self>/.pending-deletions/` recording paths
the engine must delete from GitHub on the next push. Used by pull-
side sanitize (§11) when a forbidden-named GitHub file is
materialised locally under its canonical name and the forbidden
path itself needs cleanup. Replaces the older phantom-snapshot
mechanism; see §12.2.

**Pre-flight validation** — A check performed on a push-side
operation (every `createTree` request that carries deletion
entries) *before* the request is sent, against current GitHub
state, to verify the operation's assumptions still hold. The
opposite of optimistic write-and-retry; see §12.1.

**Stale-state error** (`StaleStateError`) — Typed error raised when
two pieces of remote state observed within one sync click no
longer agree. Causes include client URL-encoding bugs, token
permission drift, replica eventual consistency, and concurrent
force-push that rewrote currentHead. Always non-retriable on its
own surface: the per-file catch aborts the loop, the cursor stays
put, the next drain retries. See §13.

**Skip-class** — One of four labels (`applied`, `deferred`,
`already-correct`, `unexpected`) annotated as a source-code
comment on every `continue` / `return` inside the seven core loop
bodies of the sync engine. The `unexpected` class is never a
`continue` — it is `throw new StaleStateError(...)`. See §14.

**Push-queue depth** — Count of batches currently on disk under
`.push-queue/`, waiting to be drained. Surfaced as a numeric badge
on the `[Sync with GitHub]` ribbon icon: depth 0 hides the badge,
depth ≥ 1 shows `(N)` in a green pill. The signal updates after
every persistent queue mutation; see §12.3.
