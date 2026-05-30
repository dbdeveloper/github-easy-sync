// Stage 8 CPU micro-benchmark: git-blob SHA computation timing.
//
// Motivation: every reconcile path computes the ours-side SHA, and
// the SHA-first reconcile (Stage 5) makes the SHA the primary
// decision input — its timing is on the hot path for every Sync
// click. Stage 4's Worker offload kicks in above the 100 KB
// threshold; this bench documents the cost across sizes to inform
// the threshold tuning.

import { describe, it } from "vitest";
import { emit } from "./perf-helpers";
import { calculateGitBlobSHA } from "../../src/utils";

function synthBytes(targetKb: number): ArrayBuffer {
  const buf = Buffer.alloc(targetKb * 1024);
  let state = 0xc0ffee;
  for (let i = 0; i < buf.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    buf[i] = state & 0xff;
  }
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

describe("perf — git-blob SHA computation timing", () => {
  // Sizes spanning the Stage 4 SHA threshold (100 KB) up to large
  // files. SHA is run many times per sync — even single-ms costs
  // matter when reconcile sees dozens of files.
  const SIZES_KB = [10, 50, 100, 500, 1024, 2048, 4096];

  for (const targetKb of SIZES_KB) {
    it(`SHAs ~${targetKb} KB`, async () => {
      const bytes = synthBytes(targetKb);
      const t0 = Date.now();
      const sha = await calculateGitBlobSHA(bytes);
      const ms = Date.now() - t0;
      emit({
        name: `perf-cpu-sha-${targetKb}KB`,
        ms,
        inputKb: targetKb,
        inputBytes: bytes.byteLength,
        sha,
      });
    });
  }
});
