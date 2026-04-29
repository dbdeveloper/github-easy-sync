// Perf-only helpers. Re-exports nothing from the integration helpers
// — those live one directory up and the perf tests import them
// directly. This module's job is to print baseline records in a
// shape that's grep'able from the terminal AND parseable by a future
// "compare two runs" script.
//
// The convention is one line per record:
//
//   PERF_BASELINE {"name":"P1-100","ms":12345,"files":100,...}
//
// `PERF_BASELINE` is a sentinel prefix so a later regression script
// can grep `^PERF_BASELINE ` out of CI logs without picking up
// vitest's own status lines.

export interface PerfBaseline {
  /** Test name, e.g. "P1-100", "P2-10MB", "P3-50bin", "P4-A3-245". */
  name: string;
  /** Wall-clock duration of the timed block, in milliseconds. */
  ms: number;
  /** Free-form per-test extras: file counts, bytes uploaded, etc. */
  [extra: string]: string | number | boolean;
}

/**
 * Time an async function and emit a baseline record. Returns the
 * function's return value so callers can keep using the result.
 */
export async function timed<T>(
  name: string,
  extras: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const result = await fn();
  const ms = Date.now() - start;
  emit({ name, ms, ...extras });
  return result;
}

/** Emit a baseline record on stdout, prefixed for log scraping. */
export function emit(record: PerfBaseline): void {
  // eslint-disable-next-line no-console
  console.log(`PERF_BASELINE ${JSON.stringify(record)}`);
}

/**
 * Pseudo-random byte source seeded with a string. Deterministic
 * across runs so two consecutive perf invocations push identical
 * payloads — that keeps blob SHAs the same and lets resumes /
 * cache hits behave consistently.
 *
 * Not crypto: just a fast xorshift seeded by FNV-1a of the seed
 * string. Plenty for "non-compressible bytes for upload timing".
 */
export function deterministicBytes(seed: string, length: number): Buffer {
  // FNV-1a 32-bit hash → seed
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // xorshift32 stream
  let x = h | 1;
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += 4) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    const v = x >>> 0;
    out[i] = v & 0xff;
    if (i + 1 < length) out[i + 1] = (v >>> 8) & 0xff;
    if (i + 2 < length) out[i + 2] = (v >>> 16) & 0xff;
    if (i + 3 < length) out[i + 3] = (v >>> 24) & 0xff;
  }
  return out;
}
