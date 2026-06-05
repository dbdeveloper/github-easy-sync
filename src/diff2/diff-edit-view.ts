// Diff-Edit widget — the host ItemView that Obsidian opens in a tab.
//
// Phase 1 ships:
//   - Sub-tabs header (Conflicts / Deleted).
//   - Conflicts list body (real, populated via synthetic-detector).
//   - Deleted body placeholder (Phase 9b).
//   - Detail-view placeholder reachable by clicking a conflict row;
//     `[←]` back arrow returns to list. The DiffPane itself lands in
//     Phase 2 — Phase 1's detail view is a stub that just shows the
//     selected (basePath, siblingPath).
//   - Subscribes to ConflictCounter so the list refreshes when the
//     vault changes (sibling create/delete/rename).
//
// Future phases:
//   Phase 2 — DiffPane render in detail view
//   Phase 3 — chunk-action buttons + group toolbar (resolve flow)
//   Phase 5 — autosave + recovery dialog on reopen
//   Phase 6 — entry-point hooks (file-menu, post-sync modal,
//             status-bar/ribbon click already wired to activateView
//             from main.ts)
//   Phase 7 — History list + restore
//   Phase 8 — Compare picker + compare-mode
//   Phase 9b — Deleted-mode UI + restore
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.0 (single-pane shell)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.2 (conflicts list)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.7.5 (default sub-tab)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7 (DiffPane form — Phase 2)

import { ItemView, Notice, Scope, type Vault, WorkspaceLeaf } from "obsidian";
import type SnapshotStore from "../sync2/snapshot-store";
import type { ConflictCounter } from "../sync2/conflict-counter";
import type ConflictStore from "../sync2/conflict-store";
import { renderConflictsList } from "./conflicts-list";
import { isMarkdownPath } from "./conflict-merge-all";
import { DiffPane } from "./diff-pane";
import {
  DEFAULT_DIFF_EDIT_VIEW_STATE,
  DiffEditSubTab,
  DiffEditViewState,
} from "./events";
import {
  autosaveDir,
  classifyReopen,
  readResumeSession,
  startSession,
  type AutosaveMeta,
  type ResumeSession,
} from "./autosave-store";
import { reopenAction } from "./reopen-action";
import { ResumeRecoveryModal, SaveToAltModal } from "./recovery-dialog";
import { assessHistory, scanHistory } from "./history-replay";
import { persistCursor, readCursor } from "./cursor-store";
import { CursorScheduler } from "./cursor-timer";
import { HistoryWriter } from "./history-log";
import type { Segment } from "./editor-model";
import type Logger from "../logger";
import { atomicWriteFile } from "../sync2/atomic-write";
import {
  commitOrDiscardExit,
  commitToAlt,
  commitUnchangedSide,
  type ResolvedSides,
  type ToctouStatus,
} from "./exit-commit";
import { findSentinelCollision } from "./joined-doc";
import {
  autosaveIdForEntry,
  findAllConflicts,
  type ConflictEntry,
} from "./synthetic-detector";
import { renderConflictsToolbar } from "./toolbar-conflicts";

export const DIFF2_EDIT_VIEW_TYPE = "diff2-edit-view";

export interface DiffEditViewDeps {
  vault: Vault;
  conflictStore: ConflictStore;
  conflictCounter: ConflictCounter;
  // Snapshot store passed to atomicWriteFile so the post-write
  // recordSync step lines up with the snapshot's expectations.
  // Optional in test fixtures; required in production for
  // crash-safety per PSEUDO-MERGE-MODE.md §9.3 5-step protocol.
  snapshotStore?: SnapshotStore;
  // Local device label for the top-marker / "Keep all local
  // (<label>)" button text. Falls back to "local" when undefined.
  localDeviceLabel?: () => string;
  // Plugin logger — the §5.0.e one-side-silent exit logs here instead of
  // nagging the user with a Notice (no-op when logging is disabled). Optional
  // in test fixtures.
  logger?: Logger;
}

// Phase 1 owns the navigation state machine inside the view: which
// sub-tab is active, and (when in detail mode) which entry the user
// drilled into. Future phases extend this with compare/history modes.
type Phase1ViewState =
  | { mode: "list"; tab: DiffEditSubTab }
  | { mode: "detail"; entry: ConflictEntry; tab: DiffEditSubTab };

function initialState(): Phase1ViewState {
  // R2.7.5 — default sub-tab is always Conflicts (deterministic UX
  // regardless of pending-count). Even when N === 0 the conflicts
  // tab opens; user must explicitly switch to Deleted.
  return { mode: "list", tab: "conflicts" };
}

export class DiffEditView extends ItemView {
  private viewState: Phase1ViewState = initialState();
  private readonly deps: DiffEditViewDeps;
  // Unsubscribe handle from ConflictCounter.subscribe — set on open,
  // called on close.
  private unsubscribeCounter: (() => void) | null = null;
  // TODO #8 — a keymap Scope that swallows ESC (so Obsidian's default "ESC →
  // focus the markdown editor" can't pull focus out of the diff-editor). Pushed
  // only while THIS view is the active leaf (so ESC still works in other tabs).
  private escScope: Scope | null = null;
  private escScopePushed = false;
  // Active DiffPane lives only while detail-mode is shown. Replaced
  // on every detail-open; destroyed when leaving detail-mode or on
  // view close.
  private activeDiffPane: DiffPane | null = null;
  // Autosave session bound to the active DiffPane: the conflict's autosave id
  // + the meta startSession wrote. Set at mount, consumed by the `[←]`
  // commit7Step, cleared on dispose. Null when no detail editor is open.
  private activeSession: { conflictId: string; meta: AutosaveMeta } | null =
    null;
  // W2 — the history feed for the active DiffPane. Reassigned on every mount
  // (its `record` is what the DiffPane's onRecord calls); drained at the `[←]`
  // commit (Step 1) so the last edits land before the dir is removed.
  private activeWriter: HistoryWriter | null = null;
  // W3 — cursor-flush throttle for the active session (§2.9). Reassigned on
  // every mount; its pending timer is cancelled at the TOP of exitDetailView
  // (before any commit await) so a fired timer can't persistCursor into a dir
  // the commit is staging/removing. `cursorFlushing` drops an overlapping flush
  // (best-effort signal — skip, don't queue).
  private cursorScheduler: CursorScheduler | null = null;
  private cursorFlushing = false;
  // Step-0 (§5.0) — re-entrancy guard for the `[←]` commit. Set true on entry to
  // exitDetailView, reset in its finally. A second click while a commit (or its
  // §5.0.e modal) is in flight is rejected — two concurrent commit7Step runs on
  // the same dir would leave undefined vault state (the race between steps 2–7).
  private committing = false;

  constructor(leaf: WorkspaceLeaf, deps: DiffEditViewDeps) {
    super(leaf);
    this.deps = deps;
  }

  getViewType(): string {
    return DIFF2_EDIT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Diff-Edit";
  }

  getIcon(): string {
    return "git-merge";
  }

  // Phase 0 API kept for forward-compat. Phase 6 may use this to drop
  // the view straight into a particular sub-tab from external entry
  // points (file-menu, summary modal). Phase 1 ignores
  // compare/history shapes — they're stubbed out below.
  setDiffEditState(state: DiffEditViewState): void {
    if (state.kind === "sub-tab") {
      this.viewState = { mode: "list", tab: state.tab };
      this.render();
    }
    // compare-detail / history-detail not handled in Phase 1.
  }

  getDiffEditState(): DiffEditViewState {
    return this.viewState.mode === "list"
      ? { kind: "sub-tab", tab: this.viewState.tab }
      : { kind: "sub-tab", tab: this.viewState.tab };
  }

  async onOpen(): Promise<void> {
    // ConflictCounter notifies on any sibling-event vault change.
    // List-mode subscribers re-render; detail-mode just keeps showing
    // the active entry (refresh is a no-op for detail since the
    // selected sibling is stable until user clicks `[←]`).
    this.unsubscribeCounter = this.deps.conflictCounter.subscribe(() => {
      // Defer render to next microtask so multiple rapid changes
      // collapse into one re-render. Simple debounce; later phases
      // may upgrade to requestAnimationFrame if needed.
      queueMicrotask(() => {
        // ONLY the list re-renders on a count change. In detail mode a
        // re-render would re-run mountDiffPane — disposing the live DiffPane
        // (losing the in-progress edit) AND re-classifying the now-existing
        // autosave dir into a spurious "Resume previous edit session? · 0 edits"
        // modal (TODO §2 double-mount). The active entry is stable until the
        // user clicks `[←]`/back, so detail needs no refresh here (the comment
        // above always intended this no-op; the guard now enforces it).
        if (this.viewState.mode === "list") this.render();
      });
    });

    // TODO #8 — ESC must NOT move focus out of the diff-editor (Obsidian's
    // default ESC jumps focus to the last markdown editor). A keymap Scope
    // intercepts ESC through Obsidian's OWN dispatch (so it fires BEFORE the
    // built-in handler regardless of DOM phase); `() => false` swallows it. The
    // scope is pushed only while this view is the active leaf, so ESC keeps
    // working in other tabs. (A DOM capture listener was tried first but lost to
    // Obsidian's earlier-phase handler.)
    this.escScope = new Scope(this.app.scope);
    this.escScope.register([], "Escape", () => false);
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.syncEscScope(leaf);
        // TODO #8b — re-focus the editor when this leaf becomes active again
        // (e.g. user clicked another markdown tab, then back). Obsidian
        // re-focuses a MarkdownView's editor on activation but does nothing for
        // our custom ItemView, so the caret would vanish until a manual click.
        if (leaf === this.leaf) this.activeDiffPane?.focus();
      }),
    );
    this.syncEscScope(this.app.workspace.activeLeaf ?? null);

    this.viewState = initialState();
    this.render();
  }

  // TODO #8 — push the ESC-swallowing scope iff this view is the active leaf;
  // pop it otherwise. Idempotent (guarded by escScopePushed).
  private syncEscScope(activeLeaf: WorkspaceLeaf | null): void {
    if (!this.escScope) return;
    const shouldBlock = activeLeaf === this.leaf;
    if (shouldBlock && !this.escScopePushed) {
      this.app.keymap.pushScope(this.escScope);
      this.escScopePushed = true;
    } else if (!shouldBlock && this.escScopePushed) {
      this.app.keymap.popScope(this.escScope);
      this.escScopePushed = false;
    }
  }

  async onClose(): Promise<void> {
    if (this.unsubscribeCounter) {
      this.unsubscribeCounter();
      this.unsubscribeCounter = null;
    }
    // TODO #8 — pop the ESC scope if it's still on the keymap stack.
    if (this.escScope && this.escScopePushed) {
      this.app.keymap.popScope(this.escScope);
      this.escScopePushed = false;
    }
    this.escScope = null;
    this.disposeActiveDiffPane();
  }

  private disposeActiveDiffPane(): void {
    // W3 — cancel + drop the cursor timer first (a pending flush must not write
    // into a dir that's about to be torn down / re-mounted).
    this.cursorScheduler?.stop();
    this.cursorScheduler = null;
    if (this.activeDiffPane) {
      this.activeDiffPane.destroy();
      this.activeDiffPane = null;
    }
    // §4.1 zero-edit invariant: a session ABANDONED (sub-tab switch / view
    // close, i.e. the "інший механізм" exit) with ZERO recorded edits has no
    // recovery value → wipe its dir (fire-and-forget; a failure is caught by the
    // onload sweep). A session WITH edits is LEFT untouched so a crash mid-edit
    // stays recoverable. The committed/discarded `[←]` path already nulled
    // activeSession before render(), so this only fires on a genuine abandon.
    // (The counter-guard in onOpen is what makes a live session here mean a real
    // abandon — render() no longer fires spuriously in detail mode.)
    const session = this.activeSession;
    if (session && (this.activeWriter?.liveBlockCount() ?? 0) === 0) {
      void this.deps.vault.adapter
        .rmdir(autosaveDir(session.conflictId), true)
        .catch(() => {
          /* best-effort; onload sweep is the backstop */
        });
    }
    this.activeSession = null;
    this.activeWriter = null;
  }

  // ── render dispatch ───────────────────────────────────────────────

  private render(): void {
    // Dispose any active DiffPane before tearing down its parent DOM —
    // CM6 EditorView.destroy() unhooks its own event listeners + DOM
    // children. If we just empty() the parent without destroy(), we
    // leak the listeners.
    this.disposeActiveDiffPane();

    const container = this.contentEl;
    container.empty();
    container.addClass("diff2-edit-view-root");

    if (this.viewState.mode === "list") {
      this.renderHeader(container, this.viewState.tab);
      this.renderListBody(container, this.viewState.tab);
    } else {
      this.renderDetail(container, this.viewState.entry);
    }
  }

  private renderHeader(parent: HTMLElement, activeTab: DiffEditSubTab): void {
    const header = parent.createDiv({ cls: "diff2-view-header" });
    const tabs: { id: DiffEditSubTab; label: string }[] = [
      { id: "conflicts", label: "Conflicts" },
      { id: "deleted", label: "Deleted" },
    ];
    for (const t of tabs) {
      const tabEl = header.createDiv({
        cls:
          `diff2-tab diff2-tab-${t.id}` +
          (t.id === activeTab ? " diff2-tab-active" : ""),
        text: t.label,
      });
      tabEl.style.cursor = "pointer";
      tabEl.addEventListener("click", () => {
        if (this.viewState.mode !== "list" || this.viewState.tab !== t.id) {
          this.viewState = { mode: "list", tab: t.id };
          this.render();
        }
      });
    }
  }

  private renderListBody(parent: HTMLElement, tab: DiffEditSubTab): void {
    const body = parent.createDiv({ cls: "diff2-view-body" });

    if (tab === "conflicts") {
      const { entries } = findAllConflicts(
        this.deps.vault,
        this.deps.conflictStore,
      );
      renderConflictsList(body, entries, {
        onEntryClick: (entry) => {
          this.viewState = { mode: "detail", entry, tab };
          this.render();
        },
      });
      return;
    }

    // tab === "deleted" — Phase 9b placeholder.
    body.createEl("p", {
      cls: "diff2-deleted-placeholder",
      text:
        "Deleted-mode UI lands in Phase 9b. See " +
        "docs/DIFF2_IMPLEMENTATION_PLAN.md §R3.13 for the Phase 9b enumeration.",
    });
  }

  private renderDetail(parent: HTMLElement, entry: ConflictEntry): void {
    // R7.9a toolbar — [← Back] + group resolve buttons + Auto-advance
    // toggle. Phase 6 will add [Open in external tool] on the right
    // (desktop-only); Phase 5 may add an "unresolved chunks" footer.
    const isMd = isMarkdownPath(entry.basePath);
    const localLabel = this.deps.localDeviceLabel?.() ?? "local";
    const toolbar = parent.createDiv({ cls: "diff2-detail-toolbar" });

    renderConflictsToolbar(
      toolbar,
      { localLabel, remoteLabel: entry.deviceLabel },
      {
        onBack: () => {
          void this.exitDetailView(entry);
        },
        onKeepAllLocal: () => {
          this.activeDiffPane?.resolveAll("ours");
        },
        onApplyAllRemote: () => {
          this.activeDiffPane?.resolveAll("theirs");
        },
        onJoinAll: isMd
          ? () => {
              this.activeDiffPane?.resolveAll("join");
            }
          : undefined,
      },
    );

    // Title row under the toolbar — shows the conflict's identity so
    // the user always sees which file they're resolving.
    const titleRow = parent.createDiv({ cls: "diff2-detail-title-row" });
    titleRow.createEl("span", {
      cls: "diff2-detail-base-path",
      text: entry.basePath,
    });
    titleRow.createEl("span", {
      cls: "diff2-detail-meta",
      text: ` · ${entry.deviceLabel} @ ${entry.isoTimestamp}`,
    });

    // Detail body — DiffPane mount.
    const body = parent.createDiv({ cls: "diff2-detail-body" });
    void this.mountDiffPane(body, entry);
  }

  private async mountDiffPane(
    body: HTMLElement,
    entry: ConflictEntry,
  ): Promise<void> {
    const adapter = this.deps.vault.adapter;
    try {
      let ours = "";
      const baseExists = await adapter.exists(entry.basePath);
      if (baseExists) {
        ours = await adapter.read(entry.basePath);
      }
      const theirs = await adapter.read(entry.siblingPath);

      // Stale-state guard: bail if the user switched away during await.
      if (
        this.viewState.mode !== "detail" ||
        this.viewState.entry.siblingPath !== entry.siblingPath ||
        !body.isConnected
      ) {
        return;
      }

      // §1.3 fail-closed: a \0/\1 sentinel in either side is
      // incompatible with the internal joined-doc model. Don't open the
      // DiffPane; point the user at an alternative.
      const collision = findSentinelCollision(ours, theirs);
      if (collision) {
        new Notice(
          "This file contains a control character (SOH/NUL) incompatible " +
            "with the internal diff editor. Open it in your external diff " +
            "tool or the default Obsidian editor.",
        );
        body.createEl("p", {
          cls: "diff2-detail-error",
          text:
            `Cannot open diff: ${collision.side} contains a ` +
            `${collision.char === "VER_SEPARATOR" ? "SOH (U+0001)" : "NUL (U+0000)"} ` +
            "control character (§1.3 fail-closed).",
        });
        return;
      }

      // Autosave session lifecycle (DIFF-EDITOR.md §3.1 / §3.2 / §3.2.a). An
      // in-flight commit (done.json) is NEVER touched here — onload recoverCommit
      // finishes it before any mount (§5.0.a precedence); bail defensively if one
      // is present.
      const conflictId = autosaveIdForEntry(entry);
      const dir = autosaveDir(conflictId);
      if (await adapter.exists(`${dir}/done.json`)) {
        new Notice(
          "A previous save for this conflict is still recovering. " +
            "Reload the plugin and reopen.",
        );
        return;
      }
      // Classify the reopen → action (pure dispatch, W4c Step A).
      const action = reopenAction(
        await classifyReopen(
          this.deps.vault,
          conflictId,
          entry.basePath,
          entry.siblingPath,
        ),
      );

      const opts = {
        oursLabel: this.deps.localDeviceLabel?.() ?? "local",
        theirsLabel: entry.deviceLabel,
        isMarkdown: isMarkdownPath(entry.basePath),
        joinContext: {
          remoteDeviceLabel: entry.deviceLabel,
          timestamp: entry.isoTimestamp,
        },
        // W2 — the live history feed. onRecord fires only while the mounted pane
        // has recording enabled (post-mount/replay) and routes to whichever
        // writer the current mount path attached. Append errors are swallowed
        // inside HistoryWriter, never reaching CM6. W3 — an edit also pokes the
        // cursor timer on the typing cadence.
        onRecord: (change: unknown, structure: Segment[]) => {
          this.activeWriter?.record(change, structure, new Date().toISOString());
          this.cursorScheduler?.schedule("typing");
        },
        // TODO §5 — a CM6 undo drops the last history.jsonl block (so the log
        // mirrors the editor's undo depth; the net count feeds §4.1.a exit-wipe).
        onUndo: () => {
          this.activeWriter?.truncateLastBlock();
          this.cursorScheduler?.schedule("typing");
        },
        // W3 — a pure caret move pokes the cursor timer on the nav cadence. The
        // flush re-reads the LIVE selection, so we ignore the passed position.
        onSelectionChange: () => {
          this.cursorScheduler?.schedule("nav");
        },
      };

      // Bind a fresh HistoryWriter + cursor scheduler to a just-mounted pane and
      // turn recording on (the owner calls this AFTER any replay/setCursor, so
      // only live edits record / poke the timer). startSeq continues a resumed
      // history.jsonl's seq.
      const attachWriter = (pane: DiffPane, startSeq: number): void => {
        this.activeWriter = new HistoryWriter(
          this.deps.vault,
          conflictId,
          startSeq,
        );
        this.cursorScheduler = new CursorScheduler(() =>
          this.flushCursor(conflictId),
        );
        pane.enableRecording();
      };

      // Clear any prior dir, open a fresh session, and mount from the CURRENT
      // vault bytes. Used by fresh / discard-fresh and the resume / §3.2.a
      // "Start over" choices.
      const startFreshAndMount = async (): Promise<void> => {
        if (await adapter.exists(dir)) await adapter.rmdir(dir, true);
        const meta = await startSession(
          this.deps.vault,
          conflictId,
          entry.basePath,
          entry.siblingPath,
        );
        this.activeSession = { conflictId, meta };
        const pane = new DiffPane(body, ours, theirs, opts);
        this.activeDiffPane = pane;
        attachWriter(pane, 0); // fresh history.jsonl
      };

      // Non-lossy mount: rebuild from the session-start SNAPSHOTS, replay the
      // recorded history, restore the cursor. KEEPS the dir and REUSES the
      // session — never calls startSession (which would overwrite the snapshots
      // / history being replayed). Shared by resume "Continue" (§3.2) and the
      // §3.2.a restore. Recording resumes the existing seq (KEEP dir).
      const mountReplayed = async (
        sess: ResumeSession,
        meta: AutosaveMeta,
      ): Promise<DiffPane> => {
        const pane = new DiffPane(body, sess.base, sess.sibling, opts);
        pane.replayFrom(sess.jsonl);
        const cursor = await readCursor(this.deps.vault, conflictId);
        if (cursor) {
          pane.setCursor(cursor.anchor, cursor.head, cursor.scrollTop);
        }
        this.activeSession = { conflictId, meta };
        this.activeDiffPane = pane;
        attachWriter(pane, scanHistory(sess.jsonl).blocks.length);
        return pane;
      };

      try {
        switch (action.kind) {
          case "fresh":
          case "discard-fresh":
            await startFreshAndMount();
            break;
          case "restore": {
            // §3.2.a — EXACTLY ONE vault side changed under the session. Reuse
            // the §3.2 ResumeRecoveryModal (a "*" marks the changed file — no
            // scary "files changed" dialog; it is just crash recovery).
            const sess = await readResumeSession(this.deps.vault, conflictId);
            // §3.5 (TODO §2): zero trustworthy edits → nothing to restore even
            // though one side changed in the vault. Skip the modal and start
            // fresh from the CURRENT vault (which reflects that one-side change);
            // there is no user work to carry onto the unchanged side.
            if (assessHistory(sess.jsonl).empty) {
              await startFreshAndMount();
              break;
            }
            const choice = await new ResumeRecoveryModal(this.app, {
              basePath: entry.basePath,
              siblingPath: entry.siblingPath,
              startedAtIso: action.meta.createdAt,
              editCount: scanHistory(sess.jsonl).blocks.length,
              baseChanged: action.changedSide === "base",
              siblingChanged: action.changedSide === "sibling",
              nowMs: Date.now(),
            }).prompt();

            // ❗Re-assert the stale-state guard after the (minutes-long) modal.
            if (
              this.viewState.mode !== "detail" ||
              this.viewState.entry.siblingPath !== entry.siblingPath ||
              !body.isConnected
            ) {
              return;
            }

            if (choice === "cancel") {
              this.viewState = { mode: "list", tab: "conflicts" };
              this.render();
              return;
            }
            if (choice === "start-over") {
              await startFreshAndMount();
              break;
            }
            // "Continue": replay (in a DETACHED pane) to extract the user's
            // resolved content, write the restored content of the UNCHANGED side
            // onto the vault (the changed side keeps its new content), then
            // recreate the session. Symmetric — file1/file2, no privilege.
            const tmp = new DiffPane(
              document.createElement("div"),
              sess.base,
              sess.sibling,
              opts,
            );
            tmp.replayFrom(sess.jsonl);
            const resolved = tmp.getResolved();
            tmp.destroy();
            const writePath =
              action.changedSide === "base"
                ? entry.siblingPath
                : entry.basePath;
            const writeStr =
              action.changedSide === "base" ? resolved.sibling : resolved.base;
            await atomicWriteFile(
              this.deps.vault,
              writePath,
              new TextEncoder().encode(writeStr).buffer as ArrayBuffer,
            );
            if (await adapter.exists(dir)) await adapter.rmdir(dir, true);
            const meta = await startSession(
              this.deps.vault,
              conflictId,
              entry.basePath,
              entry.siblingPath,
            );
            this.activeSession = { conflictId, meta };
            const fresh = await readResumeSession(this.deps.vault, conflictId);
            const recreated = new DiffPane(body, fresh.base, fresh.sibling, opts);
            this.activeDiffPane = recreated;
            attachWriter(recreated, 0);
            break;
          }
          case "resume": {
            // §3.2 — vault unchanged since session start. Offer replay-resume
            // vs fresh. editCount = the trustworthy-prefix block count, i.e.
            // exactly what replayFrom will apply (so the dialog can't promise
            // more than it restores).
            const sess = await readResumeSession(this.deps.vault, conflictId);
            // §3.5 (TODO §2): a valid session whose history.jsonl holds ZERO
            // trustworthy edits is stale — there is nothing to resume, so the
            // "Resume previous edit session? · 0 edits saved" modal is pointless.
            // Skip it and start fresh (wipe + fresh session). `empty` = no blocks
            // AND no corruption; a corrupt-first-block session is a DIFFERENT
            // §3.5 row (it would still surface a modal) so it's intentionally
            // excluded here.
            if (assessHistory(sess.jsonl).empty) {
              await startFreshAndMount();
              break;
            }
            const choice = await new ResumeRecoveryModal(this.app, {
              basePath: entry.basePath,
              siblingPath: entry.siblingPath,
              startedAtIso: action.meta.createdAt,
              editCount: scanHistory(sess.jsonl).blocks.length,
              nowMs: Date.now(),
            }).prompt();

            // ❗The modal can sit open for minutes — re-assert the stale-state
            // guard before touching disk / mounting. The user may have switched
            // to another conflict; a stale Start-over would otherwise rmdir a
            // dir the now-current view is using.
            if (
              this.viewState.mode !== "detail" ||
              this.viewState.entry.siblingPath !== entry.siblingPath ||
              !body.isConnected
            ) {
              return;
            }

            if (choice === "cancel") {
              this.viewState = { mode: "list", tab: "conflicts" };
              this.render();
              return;
            }
            if (choice === "start-over") {
              await startFreshAndMount();
              break;
            }
            // "continue": rebuild from the session-start SNAPSHOTS + replay
            // (KEEP the dir, REUSE the session — see mountReplayed).
            await mountReplayed(sess, action.meta);
            break;
          }
        }
        // TODO §6.1 — focus the freshly-mounted editor so the caret shows and
        // Ctrl/Cmd+Z works without a click. Cancel paths returned early; every
        // mount path set activeDiffPane. Idempotent on the resume-with-cursor
        // path (setCursor already focused).
        this.activeDiffPane?.focus();
      } catch (err) {
        body.createEl("p", {
          cls: "diff2-detail-error",
          text: `Failed to start the edit session: ${String(err)}`,
        });
        return;
      }
    } catch (err) {
      body.createEl("p", {
        cls: "diff2-detail-error",
        text: `Failed to load diff: ${String(err)}`,
      });
    }
  }

  // `[←]` exit — the 7-step pair-atomic commit (DIFF-EDITOR.md §5.0).
  // commit7Step writes done.json (barrier) → stages base+sibling →
  // promotes both → drops backups → §6.5 proactive sibling cleanup
  // (SHA(base)==SHA(sibling)) → rmdir's the autosave dir. Pair-atomic:
  // crash ⇒ both sides or neither, and recoverCommit at onload finishes
  // or rolls back any interrupted commit.
  //
  // Step-0 (§5.0): the `committing` re-entrancy guard below. Step-8 (history
  // clear + → list view): the return-to-list IS the success tail, and the CM6
  // history is cleared by `view.destroy()` when render() disposes the DiffPane
  // (there is no `historyClear` API, and the view is torn down anyway).
  //
  // §5.0.e TOCTOU (W5): when classifyToctou finds the vault changed under the
  // session, the SAME symmetric rule as §3.2.a-reopen applies — see
  // resolveToctouExit. We NEVER overwrite an externally-changed file.
  private async exitDetailView(entry: ConflictEntry): Promise<void> {
    // Step-0 (§5.0) — reject a re-entrant `[←]` while a commit is in flight
    // (the common path is ms-scale; the §5.0.e modal can sit open for minutes,
    // during which `committing` stays true on purpose — the modal blocks the UI,
    // and a Cancel resets the flag via the finally so the user can click again).
    if (this.committing) return;
    this.committing = true;
    // W3 — cancel any pending cursor flush BEFORE the first commit await (the
    // commit rmdir's the dir; a timer firing mid-commit would persistCursor into
    // a dir being staged/removed). This runs only on the non-re-entrant path
    // (the guard above already returned for a second click); we stop() (not
    // null) so a failed commit that stays in the editor keeps autosaving.
    this.cursorScheduler?.stop();

    try {
      const pane = this.activeDiffPane;
      const session = this.activeSession;
      if (!pane || !session) {
        this.viewState = { mode: "list", tab: "conflicts" };
        this.render();
        return;
      }

      try {
        // W2 Step 1 (§5.0) — flush queued history before the commit. commit7Step
        // Step 7 removes the dir on success; drain() awaits the serialized chain.
        await this.activeWriter?.drain();
        // §4.1 zero-edit invariant — currentSeq() is the TOTAL record count
        // (continues a resumed session's seq), so 0 means "this session never
        // recorded an edit" → commitOrDiscardExit wipes the dir without touching
        // the input files (and without the safeRename swap).
        const recordCount = this.activeWriter?.liveBlockCount() ?? 0;
        // getResolved() runs the commit-boundary fail-closed checks (tiling
        // assertion) and applies the empty→"\n" guard to BOTH sides — its bytes
        // are exactly what commit7Step hashes into done.json. Keep it INSIDE the
        // try so a thrown corruption guard means "save failed, stay in editor".
        const resolved = pane.getResolved();
        // §5.0 exit decision (discard-if-empty / commit / TOCTOU). TOCTOU
        // (§5.0 Step 1.5): a sync may have rewritten base/sibling under us.
        const outcome = await commitOrDiscardExit(
          this.deps.vault,
          session.conflictId,
          session.meta,
          resolved,
          recordCount,
        );
        if (outcome.kind === "toctou") {
          // §5.0.e symmetric resolution. Returns false when the user cancels (or
          // the view moved on during the modal) → stay in the editor.
          const proceed = await this.resolveToctouExit(
            entry,
            session,
            resolved,
            outcome.toctou,
          );
          if (!proceed) return;
        } else if (outcome.kind === "committed") {
          const suffix = outcome.result.siblingRemoved
            ? " (redundant sibling cleaned)"
            : "";
          new Notice(`Saved ${outcome.result.basePath}${suffix}`);
        }
        // outcome.kind === "discarded": §4.1 silent wipe — no Notice, no write.
      } catch (err) {
        new Notice(`Failed to save ${entry.basePath}: ${String(err)}`);
        // Commit failed — stay in detail view so the user doesn't lose work.
        // commit7Step is pair-atomic; recoverCommit at onload reconciles any
        // partially-applied commit on the next launch.
        return;
      }

      // Success — Step-8: return to list (render disposes the DiffPane, whose
      // view.destroy() clears its CM6 history).
      this.activeSession = null;
      this.activeWriter = null;
      this.viewState = { mode: "list", tab: "conflicts" };
      this.render();
    } finally {
      this.committing = false;
    }
  }

  // §5.0.e — the vault changed under the session (classifyToctou → mismatch).
  // Symmetric, the SAME rule as §3.2.a-reopen: the resolved content lands ONLY
  // on the side whose vault file did NOT change; we never overwrite a file that
  // was modified externally. Returns true if the exit should proceed (session
  // torn down by the helper), false to stay in the editor (cancel / view moved
  // on). Runs inside exitDetailView's try — a thrown write/guard surfaces as
  // "Failed to save" and keeps the user in the editor.
  private async resolveToctouExit(
    entry: ConflictEntry,
    session: { conflictId: string; meta: AutosaveMeta },
    resolved: ResolvedSides,
    toctou: Extract<ToctouStatus, { kind: "mismatch" }>,
  ): Promise<boolean> {
    // Exactly one side changed (XOR) → SILENT single-side write to the unchanged
    // side; log, no Notice (DIFF-EDITOR.md §5.0.e). The conflict simply
    // continues with the changed side's new bytes.
    if (toctou.baseChanged !== toctou.siblingChanged) {
      const changedSide = toctou.baseChanged ? "base" : "sibling";
      const { writtenPath } = await commitUnchangedSide(
        this.deps.vault,
        session.conflictId,
        session.meta,
        resolved,
        changedSide,
      );
      this.deps.logger?.info(
        "diff2 [←] exit: one input changed externally; wrote resolved " +
          "unchanged side, conflict continues",
        { changedSide, writtenPath },
      );
      return true;
    }

    // BOTH sides changed → the only place the exit asks anything. Save the
    // resolution under a fresh name, or discard. The modal fail-closes on a
    // colliding name (the prefill IS the changed original).
    const choice = await new SaveToAltModal(this.app, {
      defaultName: session.meta.basePath,
      exists: (name) => this.deps.vault.adapter.exists(name),
    }).prompt();

    // The modal can sit open for minutes — bail if the view moved on (onClose
    // nulls activeSession) before we touch disk.
    if (this.activeSession !== session) return false;

    if (choice.choice === "cancel") return false; // stay in the editor
    if (choice.choice === "save") {
      const res = await commitToAlt(
        this.deps.vault,
        session.conflictId,
        choice.name,
        resolved,
        entry.deviceLabel,
        Date.now(),
      );
      const suffix = res.siblingPath ? ` (+ ${res.siblingPath})` : "";
      new Notice(`Saved your resolution as ${res.basePath}${suffix}`);
      return true;
    }
    // discard
    await this.deps.vault.adapter.rmdir(autosaveDir(session.conflictId), true);
    this.deps.logger?.info(
      "diff2 [←] exit: both inputs changed externally; user discarded resolution",
      { base: session.meta.basePath, sibling: session.meta.siblingPath },
    );
    return true;
  }

  // W3 — the cursor scheduler's flush thunk (§2.9). Re-reads the LIVE selection
  // from the active pane and ping-pong-persists it. Fire-and-forget: errors are
  // logged, never propagated (cursor is a best-effort UX signal). `cursorFlushing`
  // drops an overlapping flush rather than queueing it.
  private flushCursor(conflictId: string): void {
    if (this.cursorFlushing) return;
    const pane = this.activeDiffPane;
    if (!pane) return;
    const view = pane.getView();
    const sel = view.state.selection.main;
    this.cursorFlushing = true;
    void persistCursor(this.deps.vault, conflictId, {
      anchor: sel.anchor,
      head: sel.head,
      scrollTop: view.scrollDOM.scrollTop,
    })
      .catch((e) =>
        this.deps.logger?.warn("diff2 cursor flush failed", { err: String(e) }),
      )
      .finally(() => {
        this.cursorFlushing = false;
      });
  }
}
