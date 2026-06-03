// Mobile autosave write benchmark (DIFF-EDITOR.md §2.8 / §6; plan §R9.1 row 5).
//
// The live-autosave coalesce values (150 ms idle / 500 ms typing-pause / 10-block
// cap, §2.8) and the cursor-timer intervals (§2.9) are PLACEHOLDERS until we know
// how fast the two hot write ops actually are on a real device:
//   - vault.adapter.append(history.jsonl, line)   — every flush
//   - write(tmp) + remove(dst) + rename(tmp→dst)  — every cursor rewrite
// On Android/iOS (Capacitor) these are slower + more variable than desktop. The
// §2.8 rule of thumb: p95 < 10 ms → coalescing optional; p95 > 50 ms → raise idle
// to ~300 ms. This benchmark measures p50/p95/p99 so the Phase-5 values are pinned
// from data, not guessed.
//
// Mobile-safe: only vault.adapter + performance.now(). Writes under .diff2-bench/,
// cleans up after. Settings → "Run mobile autosave benchmark" runs it.

import type { Vault } from "obsidian";

export interface BenchStats {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface BenchResult {
  iterations: number;
  lineBytes: number;
  singleAppend: BenchStats; // per single adapter.append (one NDJSON block)
  batchedAppendPerLine: BenchStats; // amortized per line in a 10-line batch append
  cursorRewrite: BenchStats; // per write-tmp + remove + rename cycle
  report: string; // human-readable summary
}

const BENCH_DIR = ".diff2-bench";

// Linear-interpolated percentile over an ascending-sorted sample.
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

export function computeStats(samples: number[]): BenchStats {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
  return {
    n: s.length,
    min: s.length ? s[0] : 0,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s.length ? s[s.length - 1] : 0,
    mean,
  };
}

// A representative history.jsonl block line (§2.6 format B): change + a small
// structure array + sum. ~realistic size so the I/O measurement is meaningful.
function sampleBlockLine(): string {
  const structure = Array.from({ length: 12 }, (_, i) => ({
    role: i % 3 === 0 ? "ver1" : i % 3 === 1 ? "ver2" : "normal",
    group: Math.floor(i / 3),
    from: i * 10,
    to: i * 10 + 9,
  }));
  return (
    JSON.stringify({
      seq: 1,
      at: "2026-06-03T12:00:00.000Z",
      change: [120, [8, "abcdefgh"]],
      structure,
      sum: "deadbeef",
    }) + "\n"
  );
}

export interface BenchOptions {
  iterations?: number; // per-op sample count (default 200)
}

export async function runAutosaveBenchmark(
  vault: Vault,
  opts: BenchOptions = {},
): Promise<BenchResult> {
  const iterations = Math.max(1, opts.iterations ?? 200);
  const a = vault.adapter;

  if (await a.exists(BENCH_DIR)) await a.rmdir(BENCH_DIR, true);
  await a.mkdir(BENCH_DIR);

  const line = sampleBlockLine();
  const lineBytes = new TextEncoder().encode(line).length;

  try {
    // 1) single append — the per-flush cost when a flush carries one block.
    const histPath = `${BENCH_DIR}/history.jsonl`;
    const single: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const t = performance.now();
      await a.append(histPath, line);
      single.push(performance.now() - t);
    }

    // 2) batched append (10 lines/call) — amortized per line (coalesce payoff).
    const BATCH = 10;
    const batchPath = `${BENCH_DIR}/batch.jsonl`;
    const payload = line.repeat(BATCH);
    const batchPerLine: number[] = [];
    for (let i = 0; i < Math.ceil(iterations / BATCH); i++) {
      const t = performance.now();
      await a.append(batchPath, payload);
      const per = (performance.now() - t) / BATCH;
      for (let k = 0; k < BATCH; k++) batchPerLine.push(per);
    }

    // 3) cursor atomic rewrite — write tmp + remove existing + rename (§2.9).
    const curTmp = `${BENCH_DIR}/cursor.json.tmp`;
    const curDst = `${BENCH_DIR}/cursor.json`;
    const cursorJson = JSON.stringify({
      v: 1,
      anchor: 1247,
      head: 1247,
      scrollTop: 8420,
      savedAt: "2026-06-03T12:00:00.000Z",
    });
    const cursor: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const t = performance.now();
      await a.write(curTmp, cursorJson);
      if (await a.exists(curDst)) await a.remove(curDst);
      await a.rename(curTmp, curDst);
      cursor.push(performance.now() - t);
    }

    const singleAppend = computeStats(single);
    const batchedAppendPerLine = computeStats(batchPerLine);
    const cursorRewrite = computeStats(cursor);
    const report = formatReport({
      iterations,
      lineBytes,
      singleAppend,
      batchedAppendPerLine,
      cursorRewrite,
    });
    return { iterations, lineBytes, singleAppend, batchedAppendPerLine, cursorRewrite, report };
  } finally {
    try {
      await a.rmdir(BENCH_DIR, true);
    } catch {
      // best-effort cleanup
    }
  }
}

function ms(x: number): string {
  return x.toFixed(2);
}
function line(label: string, s: BenchStats): string {
  return `${label.padEnd(26)} p50=${ms(s.p50)} p95=${ms(s.p95)} p99=${ms(s.p99)} (min=${ms(s.min)} max=${ms(s.max)} mean=${ms(s.mean)} n=${s.n}) ms`;
}

function formatReport(r: Omit<BenchResult, "report">): string {
  const p95 = r.singleAppend.p95;
  const advice =
    p95 < 10
      ? "single-append p95 < 10 ms → coalescing optional; could flush per-transaction."
      : p95 > 50
        ? "single-append p95 > 50 ms → raise idle window to ~300 ms; keep batching (§2.8)."
        : "single-append p95 in 10–50 ms → default 150/500/10 (§2.8) is reasonable.";
  return [
    "# diff2 mobile autosave benchmark",
    `iterations=${r.iterations}, block line=${r.lineBytes} bytes`,
    "",
    line("history append (single)", r.singleAppend),
    line("history append (batch/10, per-line)", r.batchedAppendPerLine),
    line("cursor atomic rewrite", r.cursorRewrite),
    "",
    `recommendation: ${advice}`,
  ].join("\n");
}
