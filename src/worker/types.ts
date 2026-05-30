// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Wire-format types shared between the main-thread `WorkerClient`
// and the two worker entry points (`cpu-worker.ts`, `network-worker.ts`).
//
// Discriminated unions on `op` give us exhaustive type checking on
// both sides; `id` is a per-request UUID that the client uses to
// route the reply back to the right pending Promise. The same envelope
// works for both CPU and network workers — dispatch happens client-side.
//
// Stage 3 ships only `ping` and `echo` ops. Stages 4-6 add the real
// work (decode-base64, merge-text, compute-sha, github-* calls).

export type WorkerRequest =
  | { id: string; op: "ping" }
  | { id: string; op: "echo"; payload: unknown }
  // Stage 4 — CPU-bound ops. All go to the CPU worker pool.
  // Decode a base64 string to its raw bytes. Used by reconcile
  // when GitHub's Blobs API returns the file content as base64.
  | { id: string; op: "decode-base64"; b64: string }
  // Compute the git-blob SHA-1 (SHA-1 of "blob {len}\0{content}")
  // for a binary buffer. Used by reconcile to compare ours/theirs
  // SHAs without touching the network.
  | { id: string; op: "compute-git-blob-sha"; bytes: ArrayBuffer }
  // Run node-diff3 three-way merge on three text strings. Used by
  // reconcile when ours/base/theirs all differ on a text file.
  // Result mirrors `MergeOutcome` from three-way-merge.ts.
  | {
      id: string;
      op: "merge-text";
      ours: string;
      base: string;
      theirs: string;
    };

export type WorkerResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

// Result shape for the merge-text op (mirrors src/sync2/three-way-merge.ts
// MergeOutcome). Duplicated here so worker scope doesn't have to
// import from the engine — keeps the worker bundle independent.
export type MergeTextResult =
  | { kind: "clean"; content: string }
  | { kind: "conflict"; conflictMarkedContent: string };

// Which worker should handle a given op. Stage 4 keeps all CPU
// ops on the pool; Stage 6 routes network ops to the dedicated
// network worker.
export type WorkerKind = "cpu" | "network";

export function workerKindForOp(op: WorkerRequest["op"]): WorkerKind {
  switch (op) {
    case "ping":
    case "echo":
    case "decode-base64":
    case "compute-git-blob-sha":
    case "merge-text":
      return "cpu";
  }
}
