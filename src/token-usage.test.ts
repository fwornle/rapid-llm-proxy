/**
 * Unit suite for the per-model median (p50) latency surfaced on
 * getSummary()'s by_model rows (Phase 66 — PERF-03).
 *
 * Runner: `node --test src/token-usage.test.ts` (Node 25 native TS type
 * stripping). The repo's package.json `test` script (jest) is stale and
 * uninstalled; the live `--test` suites under tests/ use node:test, and this
 * file follows the same convention so it actually executes.
 *
 * Median convention asserted here: LOWER-MID for even counts — the row at
 * ORDER BY latency_ms LIMIT 1 OFFSET (count-1)/2 (integer division). For the
 * seeded odd set [1000,2000,3000,4000,5000] (count 5, offset 2) the median is
 * the true middle element 3000.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initTokenDb, getSummary, type TokenUsageDb } from './token-usage.ts';

const MODEL = 'claude-code/sonnet';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tokdb-p50-'));
}

/** Insert a raw token_usage row with an explicit timestamp + latency. */
function seedRow(handle: TokenUsageDb, timestampMs: number, latencyMs: number, model = MODEL): void {
  handle.db.prepare(`
    INSERT INTO token_usage
      (id, timestamp, provider, model, process, subscription,
       input_tokens, output_tokens, total_tokens, latency_ms,
       prompt_preview, tokens_estimated, user_hash)
    VALUES (?, ?, ?, ?, 'test', 'test', 1, 1, 2, ?, '', 0, 'test')
  `).run(handle.nextLocalId(), new Date(timestampMs).toISOString(), 'claude-code', model, latencyMs);
}

let dirs: string[] = [];
function freshDb(): TokenUsageDb {
  const dir = tmpDir();
  dirs.push(dir);
  return initTokenDb(dir);
}

before(() => { dirs = []; });
after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('Test 1: by_model row carries p50_latency_ms = true median (3000) over seeded [1000..5000]', () => {
  const handle = freshDb();
  const now = Date.now();
  for (const lat of [1000, 2000, 3000, 4000, 5000]) {
    seedRow(handle, now - 60_000, lat); // all comfortably inside the 24h window
  }
  const summary = getSummary(handle, { hours: 24 });
  const row = summary.by_model.find(r => r.model === MODEL);
  assert.ok(row, 'expected a by_model row for the seeded model');
  assert.equal(row!.p50_latency_ms, 3000, 'median of [1000,2000,3000,4000,5000] is 3000 (lower-mid, offset 2)');
});

test('Test 2: empty token_usage DB returns without throwing and has no by_model rows', () => {
  const handle = freshDb();
  let summary: ReturnType<typeof getSummary>;
  assert.doesNotThrow(() => { summary = getSummary(handle, { hours: 24 }); });
  assert.deepEqual(summary!.by_model, [], 'empty DB yields an empty by_model array (no 500)');
});

test('Test 3: rows outside the 24h window are excluded from the median', () => {
  const handle = freshDb();
  const now = Date.now();
  // One in-window row of 2500.
  seedRow(handle, now - 60_000, 2500);
  // Out-of-window outliers (older than 24h) that would skew an unbounded median.
  seedRow(handle, now - 48 * 3600_000, 99999);
  seedRow(handle, now - 72 * 3600_000, 1);
  const summary = getSummary(handle, { hours: 24 });
  const row = summary.by_model.find(r => r.model === MODEL);
  assert.ok(row, 'expected a by_model row for the in-window model');
  assert.equal(row!.p50_latency_ms, 2500, 'only the single in-window row (2500) counts toward the median');
});

// ---------------------------------------------------------------------------
// Phase 66 Plan 03 — PERF-03 spawn/queue OVERHEAD median (p50_overhead_ms).
// The overhead median mirrors p50_latency_ms BUT is computed only over rows
// that HAVE an overhead value (WHERE overhead_ms IS NOT NULL), and the OFFSET
// uses the COUNT of those non-null rows (NOT row.calls, which counts all rows).
// This closes WR-02 from 66-REVIEW.md: counting NULLs in the offset would skew
// the median row selection.
// ---------------------------------------------------------------------------

const OMODEL = 'claude-code/sonnet-overhead';

/**
 * Insert a row carrying an explicit overhead_ms (or NULL when overheadMs is
 * null). latency_ms is fixed; only the overhead column matters to these tests.
 */
function seedOverheadRow(handle: TokenUsageDb, timestampMs: number, overheadMs: number | null, model = OMODEL): void {
  handle.db.prepare(`
    INSERT INTO token_usage
      (id, timestamp, provider, model, process, subscription,
       input_tokens, output_tokens, total_tokens, latency_ms,
       prompt_preview, tokens_estimated, user_hash, overhead_ms)
    VALUES (?, ?, ?, ?, 'test', 'test', 1, 1, 2, 5000, '', 0, 'test', ?)
  `).run(handle.nextLocalId(), new Date(timestampMs).toISOString(), 'claude-code', model, overheadMs);
}

test('Test 4: p50_overhead_ms is the true median (300) over non-null [100,200,300,400,500]', () => {
  const handle = freshDb();
  const now = Date.now();
  for (const ov of [100, 200, 300, 400, 500]) {
    seedOverheadRow(handle, now - 60_000, ov);
  }
  const summary = getSummary(handle, { hours: 24 });
  const row = summary.by_model.find(r => r.model === OMODEL);
  assert.ok(row, 'expected a by_model row for the overhead-seeded model');
  assert.equal(row!.p50_overhead_ms, 300, 'median of [100,200,300,400,500] is 300 (lower-mid, offset 2)');
});

test('Test 5: NULL-safety — median ignores NULL rows and the offset uses the non-null count (WR-02)', () => {
  const handle = freshDb();
  const now = Date.now();
  // Mix: two legacy NULL-overhead rows + three valued rows [100,200,300].
  // Non-null count = 3, offset = floor((3-1)/2) = 1 -> the value 200.
  // If NULLs were counted (calls=5, offset=2) the ORDER BY (NULLs sort first)
  // would pick the WRONG element. Asserting 200 proves the non-null-count offset.
  seedOverheadRow(handle, now - 60_000, null);
  seedOverheadRow(handle, now - 60_000, null);
  seedOverheadRow(handle, now - 60_000, 100);
  seedOverheadRow(handle, now - 60_000, 200);
  seedOverheadRow(handle, now - 60_000, 300);
  const summary = getSummary(handle, { hours: 24 });
  const row = summary.by_model.find(r => r.model === OMODEL);
  assert.ok(row, 'expected a by_model row for the mixed-overhead model');
  assert.equal(row!.p50_overhead_ms, 200, 'median over non-null [100,200,300] is 200; NULLs excluded from value AND offset');
});

test('Test 6: a model with all-NULL overhead leaves p50_overhead_ms absent (no throw)', () => {
  const handle = freshDb();
  const now = Date.now();
  seedOverheadRow(handle, now - 60_000, null);
  seedOverheadRow(handle, now - 60_000, null);
  let summary: ReturnType<typeof getSummary>;
  assert.doesNotThrow(() => { summary = getSummary(handle, { hours: 24 }); });
  const row = summary!.by_model.find(r => r.model === OMODEL);
  assert.ok(row, 'the model still has a by_model row (it has rows, just no overhead values)');
  assert.equal(row!.p50_overhead_ms, undefined, 'all-NULL overhead -> p50_overhead_ms absent on the row');
});

test('Test 7: migration idempotency — re-opening the same DB does not error or duplicate overhead_ms', () => {
  const dir = tmpDir();
  dirs.push(dir);
  const h1 = initTokenDb(dir);
  seedOverheadRow(h1, Date.now() - 60_000, 123);
  // Re-open the same directory: the PRAGMA-guarded ALTER must be a no-op.
  let h2: TokenUsageDb;
  assert.doesNotThrow(() => { h2 = initTokenDb(dir); });
  const cols = h2!.db.prepare(`PRAGMA table_info(token_usage)`).all() as Array<{ name: string }>;
  const overheadCols = cols.filter(c => c.name === 'overhead_ms');
  assert.equal(overheadCols.length, 1, 'overhead_ms column exists exactly once after a second open');
});

test('Test 8: bucket size follows the span shown — on a DB younger than the window, 48h / 7 days / all draw the same series', () => {
  const handle = freshDb();
  const now = Date.now();
  for (const ago of [33, 20, 5, 1]) seedRow(handle, now - ago * 3600_000, 1000); // ~33h of data
  const series = [48, 168, 87600].map((hours) => {
    const s = getSummary(handle, { hours });
    return { bucket: s.bucket_minutes, rows: s.by_process_hour.length, total: s.total_tokens };
  });
  assert.equal(series[0].bucket, 10, '33h shown → 10-minute buckets');
  assert.deepEqual(series[1], series[0], '7 days covers the same rows as 48h');
  assert.deepEqual(series[2], series[0], 'all covers the same rows as 48h');
  assert.equal(getSummary(handle, { hours: 168, bucketMinutes: 60 }).bucket_minutes, 60, 'an explicit bucketMinutes still wins');
});
