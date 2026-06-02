// Autosave-directory foundation for the diff-editor (DIFF-EDITOR.md §2.4–§2.5;
// Stage 2.0). This is the shared scaffolding the 7-step `[← back]` commit
// (Stage 2.1, §5.0 — done.json lives in this dir, TOCTOU reads meta, recovery
// scans it) AND persistent autosave (Stage 3, §2.6–§4) both build on.
//
// What lives here, per `<vault>/.diff2-autosave/<conflictId>/`:
//   meta.json        — written LAST at session start (§2.5.a commit point)
//   base.snapshot    — byte-exact copy of basePath at session start
//   sibling.snapshot — byte-exact copy of siblingPath
//   cursor.json      — init (0,0,0); timer-rewritten in Stage 3
//   history.jsonl    — empty at start; append-only REDO-log in Stage 3
//   done.json        — added by the Stage 2.1 commit only
//
// This module: deterministic conflict-id derivation (§2.4.1), the session-start
// protocol (§2.5.a), and reopen DETECTION (§2.5.b — returns a status; the
// recovery dialog / cleanup are Stage 3 / §4). Greenfield, not yet wired into
// the view (like the trash subsystem 9a).
//
// Canonical spec: docs/tasks/DIFF-EDITOR.md §2.4, §2.4.1, §2.5, §2.5.a, §2.5.b.
//
// Mobile: every byte write delegates to atomicWriteFile, whose Capacitor
// remove-then-rename is separately tested — this module adds no new
// write-then-rename path, so it owes no MOCK_PLATFORM=mobile test of its own.

import { normalizePath, type Vault } from "obsidian";
import { calculateGitBlobSHA } from "../utils";
import { atomicWriteFile } from "../sync2/atomic-write";

export const AUTOSAVE_ROOT = ".diff2-autosave";

// The ACTUAL bundled `diff` version. Round-trip (build∘split) is
// version-independent, so this is recorded ONLY for Stage-3 history-replay
// offset-stability validation (§1.5 / §2.5) — a future `diff` bump is a
// one-line change here, not a correctness risk.
export const JOIN_ALGO_VERSION = "diff@9.0.0";
// We call diffLines with NO options (the DEFAULT); see joined-doc.ts header
// for why {newlineIsToken:true} (the doc's stale value) breaks the §1.2 model.
export const JOIN_ALGO_OPTIONS: Record<string, unknown> = {};

// ── conflict-id derivation (§2.4 / §2.4.1) ───────────────────────────

// FNV-1a 64-bit over the UTF-8 bytes of `input`, as 16 lowercase hex chars.
//
// A naive single `hash * prime` overflows 2^53 and silently produces a wrong,
// collision-prone value. BigInt would be the clean fix, but this project's
// tsconfig targets ES6 (no BigInt literals), so we instead carry the 64-bit
// state as four little-endian 16-bit limbs and do the multiply limb-wise. Each
// partial product is < 2^32 and the per-limb sums are < 2^34 — comfortably
// within JS double precision, so the arithmetic is exact. Correctness is
// pinned against PUBLISHED FNV-1a-64 vectors in autosave-id.test.ts (a wrong
// multiply fails them instantly). Hashing UTF-8 bytes (not UTF-16 code units)
// keeps non-ASCII paths stable.
//
// offset basis 0xcbf29ce484222325 → LE 16-bit limbs [0x2325,0x8422,0x9ce4,0xcbf2]
// FNV prime  0x100000001b3        → LE 16-bit limbs [0x01b3,0x0000,0x0100,0x0000]
const P0 = 0x01b3;
const P2 = 0x0100; // P1 and P3 are zero
export function fnv1a64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let h0 = 0x2325,
    h1 = 0x8422,
    h2 = 0x9ce4,
    h3 = 0xcbf2;
  for (let i = 0; i < bytes.length; i++) {
    h0 ^= bytes[i]; // XOR the byte into the low limb (only low 8 bits matter)
    // (h * prime) mod 2^64, limb k = Σ_{i+j=k} h_i·p_j + carries; p1=p3=0.
    const t0 = h0 * P0;
    const t1 = h1 * P0;
    const t2 = h0 * P2 + h2 * P0;
    const t3 = h1 * P2 + h3 * P0;
    let carry = 0;
    let r = t0 + carry; carry = Math.floor(r / 0x10000); h0 = r & 0xffff;
    r = t1 + carry; carry = Math.floor(r / 0x10000); h1 = r & 0xffff;
    r = t2 + carry; carry = Math.floor(r / 0x10000); h2 = r & 0xffff;
    r = t3 + carry; h3 = r & 0xffff; // bits ≥64 fall off → mod 2^64
  }
  const hex = (n: number) => n.toString(16).padStart(4, "0");
  return hex(h3) + hex(h2) + hex(h1) + hex(h0);
}

// §2.4.1 — deterministic, ORDER-INDEPENDENT id for non-tracked sessions.
// Sort canonicalises (a,b)==(b,a); the `\0` delimiter prevents path-boundary
// collisions ("foo"+"bar" vs "foob"+"ar"). Pure: no Date.now / mtime / random.
export function deriveAutosaveId(
  kind: "synthetic" | "compare",
  path1: string,
  path2: string,
): string {
  const [first, second] = [path1, path2].sort();
  return `${kind}-${fnv1a64(`${first}\0${second}`)}`;
}

// §2.4 — a tracked conflict reuses the ConflictStore record's opaque UUID.
export function trackedAutosaveId(recordId: string): string {
  return `tracked-${recordId}`;
}

// ── paths ────────────────────────────────────────────────────────────

export function autosaveDir(conflictId: string): string {
  return normalizePath(`${AUTOSAVE_ROOT}/${conflictId}`);
}
const metaPath = (id: string) => `${autosaveDir(id)}/meta.json`;
const baseSnapshotPath = (id: string) => `${autosaveDir(id)}/base.snapshot`;
const siblingSnapshotPath = (id: string) => `${autosaveDir(id)}/sibling.snapshot`;
const cursorPath = (id: string) => `${autosaveDir(id)}/cursor.json`;
const historyPath = (id: string) => `${autosaveDir(id)}/history.jsonl`;

// ── meta.json (§2.5) ─────────────────────────────────────────────────

export interface AutosaveMeta {
  v: 1;
  createdAt: string;
  conflictId: string;
  basePath: string;
  siblingPath: string;
  baseShaAtStart: string;
  siblingShaAtStart: string;
  joinAlgoVersion: string;
  joinAlgoOptions: Record<string, unknown>;
}

const utf8 = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;

// ── session-start protocol (§2.5.a) ──────────────────────────────────

// Initialise a fresh autosave session in strict order, writing meta.json
// LAST. The strong invariant this buys: **meta.json exists ⇒ all five files
// exist and meta's SHAs match the snapshot bytes** — so later recovery can
// trust meta without re-hashing snapshots (defence-in-depth still re-checks).
// Each write is itself crash-safe via atomicWriteFile (temp + rename). `nowIso`
// is injectable for deterministic tests.
export async function startSession(
  vault: Vault,
  conflictId: string,
  basePath: string,
  siblingPath: string,
  nowIso: string = new Date().toISOString(),
): Promise<AutosaveMeta> {
  await ensureDir(vault, autosaveDir(conflictId)); // step 1 (idempotent)

  const baseBytes = await vault.adapter.readBinary(basePath); // step 2
  const siblingBytes = await vault.adapter.readBinary(siblingPath); // step 3
  const baseShaAtStart = await calculateGitBlobSHA(baseBytes); // step 4
  const siblingShaAtStart = await calculateGitBlobSHA(siblingBytes); // step 5

  await atomicWriteFile(vault, baseSnapshotPath(conflictId), baseBytes); // 6
  await atomicWriteFile(vault, siblingSnapshotPath(conflictId), siblingBytes); // 7
  await atomicWriteFile(
    vault,
    cursorPath(conflictId),
    utf8(JSON.stringify({ v: 1, anchor: 0, head: 0, scrollTop: 0, savedAt: nowIso })),
  ); // step 8
  await atomicWriteFile(vault, historyPath(conflictId), new ArrayBuffer(0)); // 9 (empty)

  const meta: AutosaveMeta = {
    v: 1,
    createdAt: nowIso,
    conflictId,
    basePath,
    siblingPath,
    baseShaAtStart,
    siblingShaAtStart,
    joinAlgoVersion: JOIN_ALGO_VERSION,
    joinAlgoOptions: JOIN_ALGO_OPTIONS,
  };
  await atomicWriteFile(vault, metaPath(conflictId), utf8(JSON.stringify(meta))); // step 10 — COMMIT POINT
  return meta;
}

export async function readMeta(
  vault: Vault,
  conflictId: string,
): Promise<AutosaveMeta | null> {
  const p = metaPath(conflictId);
  if (!(await vault.adapter.exists(p))) return null;
  try {
    return JSON.parse(await vault.adapter.read(p)) as AutosaveMeta;
  } catch {
    return null; // corrupt meta → treat as no session (§4.2 cleanup handles the dir)
  }
}

// ── reopen detection (§2.5.b) — DETECTION ONLY ───────────────────────

// On `openDiffPane(conflictId)` decide how to open. This returns a status; it
// does NOT render the recovery dialog or run cleanup — those are Stage 3
// (§3.2 / §3.2.a) / §4. Snapshots are preserved untouched so the caller has
// the ground-truth bytes to act on.
//
// NOTE for the Stage 2.1 open-flow caller: unlike readMeta (which degrades to
// null on a missing/corrupt meta), this THROWS if basePath/siblingPath no
// longer exist — readBinary rejects. If an interleaved sync can remove a
// tracked conflict's base between sessions, the caller must catch and fall
// back to "fresh" (or this gains a fourth status). Decide when wiring 2.1.
// The `reuse` verdict only compares vault SHAs to meta — it does NOT confirm
// the snapshot files still exist/are intact (snapshot integrity is §4.2); the
// 2.1 reuse path must re-check snapshot presence before trusting them.
export type AutosaveOpenStatus =
  | { kind: "fresh" } // no usable session → caller runs startSession
  | { kind: "reuse"; meta: AutosaveMeta } // vault unchanged since session start
  | {
      kind: "mismatch"; // vault changed during/since the session (§3.2.a territory)
      meta: AutosaveMeta;
      currentBaseSha: string;
      currentSiblingSha: string;
    };

export async function classifyOpen(
  vault: Vault,
  conflictId: string,
  basePath: string,
  siblingPath: string,
): Promise<AutosaveOpenStatus> {
  const meta = await readMeta(vault, conflictId);
  if (!meta) return { kind: "fresh" };

  const currentBaseSha = await calculateGitBlobSHA(
    await vault.adapter.readBinary(basePath),
  );
  const currentSiblingSha = await calculateGitBlobSHA(
    await vault.adapter.readBinary(siblingPath),
  );
  if (
    currentBaseSha === meta.baseShaAtStart &&
    currentSiblingSha === meta.siblingShaAtStart
  ) {
    return { kind: "reuse", meta }; // §2.5.b: reuse existing snapshots
  }
  return { kind: "mismatch", meta, currentBaseSha, currentSiblingSha };
}

// ── internals ────────────────────────────────────────────────────────

async function ensureDir(vault: Vault, dir: string): Promise<void> {
  const root = normalizePath(AUTOSAVE_ROOT);
  if (!(await vault.adapter.exists(root))) await vault.adapter.mkdir(root);
  if (!(await vault.adapter.exists(dir))) await vault.adapter.mkdir(dir);
}
