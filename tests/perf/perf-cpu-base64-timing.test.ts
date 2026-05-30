// Stage 8 CPU micro-benchmark: base64 decode timing matrix.
//
// Motivation: GitHub's Blobs API returns binary content as base64.
// Decoding multi-MB strings was one of the original mobile-hang
// suspects during the May 2026 field investigation. Stage 4's
// Worker offload moved the decode off the main thread for inputs
// above the threshold (2 MB), but the wall-clock matters either
// way. This bench measures the decode path the engine actually
// uses — `atob` + per-byte copy into a Uint8Array — across size
// classes.

import { describe, it } from "vitest";
import { emit } from "./perf-helpers";

// Base64 of `n` raw bytes is ~(n * 4 / 3) chars. Generate a
// deterministic base64 string of approximately `targetKb` decoded
// kilobytes. Deterministic so two runs produce comparable timing.
function synthBase64(targetKb: number): string {
  const rawBytes = targetKb * 1024;
  const buf = Buffer.alloc(rawBytes);
  // Simple xorshift fill — non-trivial bytes for atob to chew on.
  let state = 0x9e3779b9;
  for (let i = 0; i < rawBytes; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    buf[i] = state & 0xff;
  }
  return buf.toString("base64");
}

// Mirrors the engine's `fallbackDecodeBase64` (src/worker/worker-client.ts).
function decodeBase64(b64: string): ArrayBuffer {
  const clean = b64.replace(/\s/g, "");
  const binStr = atob(clean);
  const out = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    out[i] = binStr.charCodeAt(i);
  }
  return out.buffer;
}

describe("perf — base64 decode timing matrix", () => {
  // Sizes from "inline-content threshold" (1 MB) up past where the
  // engine's Stage 4 Worker threshold kicks in (2 MB) to the top
  // sizes the engine targets.
  const SIZES_KB = [100, 500, 1024, 2048, 4096, 6144, 10240];

  for (const targetKb of SIZES_KB) {
    it(`decodes ~${targetKb} KB of binary`, () => {
      const b64 = synthBase64(targetKb);
      const t0 = Date.now();
      const buf = decodeBase64(b64);
      const ms = Date.now() - t0;
      emit({
        name: `perf-cpu-base64-${targetKb}KB`,
        ms,
        inputKb: targetKb,
        b64Chars: b64.length,
        outBytes: buf.byteLength,
      });
    });
  }
});
