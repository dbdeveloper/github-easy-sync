// Stage 8 CPU micro-benchmark: 3-way merge timing matrix.
//
// Background: the original "size guard" at RECONCILE_AUTO_MERGE_LIMIT
// = 1 MB was set after observing the diff3 algorithm hit a hard
// scaling cliff on multi-MB inputs (~85 s at 4.6 MB on a Pixel 6 Pro).
// With Stage 4's Worker offload, the same compute now runs off the
// main thread so it no longer freezes the UI — but the wall-clock
// is still the wall-clock. This bench measures node-diff3's pure
// timing characteristic across the size matrix so the size guard
// can be tuned empirically rather than guessed.
//
// What this DOES NOT measure: phone-specific behaviour. Node on a
// dev machine is faster than Capacitor's WebView; this bench gives
// relative timing across sizes, not absolute thresholds. The
// absolute size-guard value still needs phone validation.

import { describe, it } from "vitest";
import { merge as diff3Merge } from "node-diff3";
import { emit } from "./perf-helpers";

// Build a synthetic text of approximately `targetKb` kilobytes,
// composed of distinct numbered lines so node-diff3 has plenty of
// hunk boundaries to consider.
function synthLines(targetKb: number, seedLine: string): string {
  const approxBytesPerLine = seedLine.length + 1;
  const totalLines = Math.ceil((targetKb * 1024) / approxBytesPerLine);
  const out: string[] = [];
  for (let i = 0; i < totalLines; i++) {
    out.push(`L${i}: ${seedLine}`);
  }
  return out.join("\n");
}

// Tweak ONE line near the start and one near the end to simulate a
// real-world divergence: ours and theirs each touch a different
// region, no overlap, clean merge expected.
function mutateOursTheirs(
  base: string,
): { ours: string; theirs: string } {
  const lines = base.split("\n");
  const oursLines = [...lines];
  const theirsLines = [...lines];
  if (oursLines.length > 10) {
    oursLines[5] = oursLines[5].replace("L5:", "L5-OURS-EDIT:");
  }
  if (theirsLines.length > 10) {
    theirsLines[theirsLines.length - 5] = theirsLines[
      theirsLines.length - 5
    ].replace(/L\d+:/, (m) => `${m}-THEIRS-EDIT:`);
  }
  return { ours: oursLines.join("\n"), theirs: theirsLines.join("\n") };
}

describe("perf — node-diff3 timing matrix", () => {
  // Size matrix: from the existing size guard floor (~1 MB worth of
  // text) up past the known cliff (~4 MB). 5 MB is the top end the
  // engine targets per the Stage 7 plan.
  const SIZES_KB = [100, 500, 1024, 2048, 3072, 4096, 5120];

  for (const targetKb of SIZES_KB) {
    it(`merges ~${targetKb} KB of text`, () => {
      const base = synthLines(
        targetKb,
        "the quick brown fox jumps over the lazy dog and runs around the block",
      );
      const { ours, theirs } = mutateOursTheirs(base);

      const t0 = Date.now();
      const result = diff3Merge(ours, base, theirs, {
        excludeFalseConflicts: true,
        stringSeparator: /\r?\n/,
      });
      const ms = Date.now() - t0;
      // Merge size — just the joined output length so the baseline
      // record carries enough context to compare runs.
      const outBytes = result.result.join("\n").length;
      emit({
        name: `perf-cpu-diff3-${targetKb}KB`,
        ms,
        inputKb: targetKb,
        inputBytes: base.length,
        outBytes,
        conflict: result.conflict,
      });
    });
  }
});
