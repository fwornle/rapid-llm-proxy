/**
 * Integration suite for the Phase 82-01 prompt-cache token schema wiring
 * (WIRE-01).
 *
 * Proves, against the SHIPPED compiled code (../../dist/token-usage.js — run
 * AFTER `npm run build`), that:
 *   (a) initTokenDb adds cache_read_tokens / cache_write_tokens as INTEGER
 *       NOT NULL DEFAULT 0, and a second init on the SAME DB is a
 *       schema-identical no-op with no `cache column migration failed` stderr
 *       (idempotent — the two independent proxy/coding migrations are mutually
 *       idempotent because the names+types are byte-identical).
 *   (b) logCall persists nonzero cache values (read=12, write=34) verbatim via
 *       getRecent; total_tokens is UNCHANGED by the cache counters (they are a
 *       SEPARATE counter, never folded into the input+output total). A row that
 *       omits the fields persists 0/0. getSummary surfaces total_cache_read /
 *       total_cache_write aggregates.
 *   (c) round-trip: logCall a row with cache_read=7/cache_write=9 →
 *       exportToHourFile → fresh DB → hydrate → getRecent surfaces 7/9.
 *   (d) a hydrate source object LACKING the cache columns coalesces to 0
 *       (no crash on a mixed-vintage export dir).
 *
 * Each test isolates its DB + export dir under a fresh tmpdir via the
 * LLM_PROXY_DATA_DIR / LLM_PROXY_TOKEN_DB_PATH env seams. Built-in node:test +
 * node:assert/strict only; no external test deps. No live-network assertions
 * here (pure local SQLite), so nothing is gated on LLM_PROXY_LIVE.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import {
  initTokenDb,
  logCall,
  getRecent,
  getSummary,
  exportToHourFile,
  hydrateFromExports,
} from '../../dist/token-usage.js';

const CACHE_COLS = ['cache_read_tokens', 'cache_write_tokens'];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_TOKEN_USAGE = path.resolve(__dirname, '../../dist/token-usage.js');

/** Fresh isolated tmp base dir (used for both DB path and export dir). */
function freshBase(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tu-cache-${label}-`));
}

/** Reset every env seam this suite touches so tests never leak into each other. */
function resetEnv() {
  delete process.env.LLM_PROXY_TOKEN_DB_PATH;
  delete process.env.LLM_PROXY_DATA_DIR;
  delete process.env.LLM_PROXY_TOKEN_EXPORT_DIR;
  delete process.env.LLM_PROXY_TOKEN_EXPORT_PATH;
}

function cleanup(base) {
  resetEnv();
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** A minimal valid TokenUsageRow; caller overrides cache fields as needed. */
function baseRow(extra = {}) {
  return {
    timestamp: new Date().toISOString(),
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    process: 'unit-test',
    subscription: 'api-key',
    input_tokens: 10,
    output_tokens: 20,
    total_tokens: 30,
    latency_ms: 100,
    prompt_preview: 'cache-column suite',
    tokens_estimated: 0,
    ...extra,
  };
}

test('(a) initTokenDb adds both cache columns as INTEGER NOT NULL DEFAULT 0, idempotently', () => {
  const base = freshBase('a');
  resetEnv();
  process.env.LLM_PROXY_TOKEN_DB_PATH = path.join(base, 'token-usage.db');
  try {
    const handle = initTokenDb();
    const cols = handle.db.prepare('PRAGMA table_info(token_usage)').all();
    const byName = new Map(cols.map(c => [c.name, c]));
    for (const name of CACHE_COLS) {
      assert.ok(byName.has(name), `column ${name} should exist after initTokenDb`);
      assert.equal(byName.get(name).dflt_value, '0', `${name} should default to 0`);
      assert.equal(byName.get(name).notnull, 1, `${name} should be NOT NULL`);
      assert.equal(String(byName.get(name).type).toUpperCase(), 'INTEGER', `${name} should be INTEGER`);
    }
    handle.db.close();

    // Idempotency + no `cache column migration failed` stderr on re-open. Run
    // in a child so we can capture stderr verbatim (mirrors the schema-migration
    // suite's approach). Two inits against the SAME DB must yield an identical
    // column set and no failure line.
    const dbPath = path.join(base, 'token-usage.db');
    const childSrc = `
      import { initTokenDb } from ${JSON.stringify(DIST_TOKEN_USAGE)};
      const colset = (h) => h.db.prepare('PRAGMA table_info(token_usage)').all().map(c => c.name).sort();
      const h1 = initTokenDb(); const c1 = colset(h1); h1.db.close();
      const h2 = initTokenDb(); const c2 = colset(h2); h2.db.close();
      process.stdout.write('COLS1=' + JSON.stringify(c1) + '\\n');
      process.stdout.write('COLS2=' + JSON.stringify(c2) + '\\n');
    `;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', childSrc], {
      encoding: 'utf8',
      env: { ...process.env, LLM_PROXY_TOKEN_DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(res.status, 0, `child should exit 0 (stderr: ${res.stderr})`);
    const cols1 = JSON.parse((res.stdout.match(/COLS1=(.+)/) || [])[1]);
    const cols2 = JSON.parse((res.stdout.match(/COLS2=(.+)/) || [])[1]);
    assert.deepEqual(cols1, cols2, 'column set must be identical across two startups');
    for (const name of CACHE_COLS) {
      assert.ok(cols1.includes(name), `idempotent run should retain column ${name}`);
    }
    assert.ok(!/cache column migration failed/.test(res.stderr), `no cache-migration-failed stderr on re-run (stderr: ${res.stderr})`);
  } finally {
    cleanup(base);
  }
});

test('(b) logCall persists nonzero cache values; total_tokens is untouched; getSummary aggregates them', () => {
  const base = freshBase('b');
  resetEnv();
  process.env.LLM_PROXY_TOKEN_DB_PATH = path.join(base, 'token-usage.db');
  try {
    const handle = initTokenDb();

    // Row carrying explicit cache counters.
    logCall(handle, baseRow({ cache_read_tokens: 12, cache_write_tokens: 34, prompt_preview: 'with-cache' }));
    // Row omitting them → must persist the 0/0 DEFAULTs.
    logCall(handle, baseRow({ prompt_preview: 'no-cache' }));

    const rows = getRecent(handle, { limit: 10 }).data;
    const withCache = rows.find(r => r.prompt_preview === 'with-cache');
    const noCache = rows.find(r => r.prompt_preview === 'no-cache');
    assert.ok(withCache && noCache, 'both rows should read back via getRecent');

    assert.equal(withCache.cache_read_tokens, 12, 'cache_read_tokens persisted verbatim');
    assert.equal(withCache.cache_write_tokens, 34, 'cache_write_tokens persisted verbatim');
    // total_tokens must NOT absorb the cache counters (separate counter).
    assert.equal(withCache.total_tokens, 30, 'total_tokens unchanged by cache values');

    assert.equal(noCache.cache_read_tokens, 0, 'omitted cache_read_tokens defaults to 0');
    assert.equal(noCache.cache_write_tokens, 0, 'omitted cache_write_tokens defaults to 0');

    const summary = getSummary(handle, { hours: 24 });
    assert.equal(summary.total_cache_read, 12, 'getSummary total_cache_read aggregates the cache reads');
    assert.equal(summary.total_cache_write, 34, 'getSummary total_cache_write aggregates the cache writes');
    // total_tokens aggregate stays input+output only (2 rows × 30).
    assert.equal(summary.total_tokens, 60, 'getSummary total_tokens excludes cache counters');

    handle.db.close();
  } finally {
    cleanup(base);
  }
});

test('(b2) getSummary cells keep the four token kinds apart per process × provider × model, and only on request', () => {
  const base = freshBase('b2');
  resetEnv();
  process.env.LLM_PROXY_TOKEN_DB_PATH = path.join(base, 'token-usage.db');
  try {
    const handle = initTokenDb();
    logCall(handle, baseRow({ provider: 'gh-copilot', model: 'claude-sonnet-5', cache_read_tokens: 100, cache_write_tokens: 5 }));
    logCall(handle, baseRow({ provider: 'gh-copilot', model: 'claude-sonnet-5', cache_read_tokens: 50 }));
    logCall(handle, baseRow({ provider: 'claude-code-max', model: 'claude-sonnet-5' }));

    // Default payload unchanged: no cells key at all.
    assert.equal('cells' in getSummary(handle, { hours: 24 }), false, 'cells are opt-in');

    const { cells } = getSummary(handle, { hours: 24, cells: true });
    const copilot = cells.filter(c => c.provider === 'gh-copilot');
    const max = cells.filter(c => c.provider === 'claude-code-max');
    // Same model on two accounts is two cells — they are different money.
    assert.equal(copilot.length, 1, 'both copilot rows land in one cell (same bucket)');
    assert.equal(max.length, 1, 'the max row is its own cell');
    assert.deepEqual(
      { calls: copilot[0].calls, in: copilot[0].input_tokens, out: copilot[0].output_tokens, cr: copilot[0].cache_read_tokens, cw: copilot[0].cache_write_tokens },
      { calls: 2, in: 20, out: 40, cr: 150, cw: 5 },
    );
    assert.match(copilot[0].hour, /Z$/, 'bucket is a UTC ISO timestamp like the pivots');
    assert.deepEqual(getSummary(handle, { hours: 24, cells: true }).local_providers, [], 'nothing offloaded yet');
    logCall(handle, baseRow({ provider: 'gh-copilot', model: 'claude-haiku-5.5', offloaded_from: 'gh-copilot' }));
    logCall(handle, baseRow({ provider: 'team-qwen', model: 'qwen3.8-27b', offloaded_from: 'gh-copilot' }));
    assert.deepEqual(getSummary(handle, { hours: 24, cells: true }).local_providers, ['team-qwen'], 'an offload target is own hardware, whatever it is called');
    handle.db.close();
  } finally {
    cleanup(base);
  }
});

test('(c) export → fresh DB → hydrate round-trip preserves cache_read=7 / cache_write=9', () => {
  const base = freshBase('c');
  resetEnv();
  process.env.LLM_PROXY_DATA_DIR = base; // drives both DB path and export dir
  try {
    const now = new Date();
    // Phase 1: seed + export.
    process.env.LLM_PROXY_TOKEN_DB_PATH = path.join(base, 'db1.db');
    const h1 = initTokenDb();
    logCall(h1, baseRow({ timestamp: now.toISOString(), cache_read_tokens: 7, cache_write_tokens: 9, prompt_preview: 'roundtrip' }));
    exportToHourFile(h1, now);
    h1.db.close();

    // Phase 2: fresh DB, SAME export dir (via LLM_PROXY_DATA_DIR) → hydrate.
    process.env.LLM_PROXY_TOKEN_DB_PATH = path.join(base, 'db2.db');
    const h2 = initTokenDb();            // initTokenDb auto-hydrates from the export dir
    hydrateFromExports(h2);              // explicit re-hydrate is idempotent (INSERT OR IGNORE)

    const rows = getRecent(h2, { limit: 10 }).data;
    const row = rows.find(r => r.prompt_preview === 'roundtrip');
    assert.ok(row, 'the exported row should hydrate into the fresh DB');
    assert.equal(row.cache_read_tokens, 7, 'round-trip preserves cache_read_tokens=7');
    assert.equal(row.cache_write_tokens, 9, 'round-trip preserves cache_write_tokens=9');
    h2.db.close();
  } finally {
    cleanup(base);
  }
});

test('(d) hydrate coalesces a legacy export row LACKING the cache columns to 0/0', () => {
  const base = freshBase('d');
  resetEnv();
  process.env.LLM_PROXY_DATA_DIR = base;
  try {
    // Hand-write a legacy per-window export file with NO cache columns.
    const exportDir = path.join(base, 'llm-proxy-export', '2020', '01');
    fs.mkdirSync(exportDir, { recursive: true });
    const legacyRow = {
      id: 1,
      timestamp: '2020-01-01T00:30:00.000Z',
      provider: 'anthropic',
      model: 'claude-legacy',
      process: 'legacy',
      subscription: 'api-key',
      input_tokens: 5,
      output_tokens: 6,
      total_tokens: 11,
      latency_ms: 42,
      prompt_preview: 'legacy-no-cache',
      tokens_estimated: 0,
      user_hash: 'abcdef',
      // NOTE: intentionally NO cache_read_tokens / cache_write_tokens.
    };
    fs.writeFileSync(
      path.join(exportDir, '2020-01-01_0000-0100_abcdef.json'),
      JSON.stringify([legacyRow], null, 2) + '\n',
      'utf-8',
    );

    process.env.LLM_PROXY_TOKEN_DB_PATH = path.join(base, 'db.db');
    const handle = initTokenDb(); // auto-hydrates the legacy file
    const rows = getRecent(handle, { limit: 10 }).data;
    const row = rows.find(r => r.prompt_preview === 'legacy-no-cache');
    assert.ok(row, 'legacy row should hydrate without crashing');
    assert.equal(row.cache_read_tokens, 0, 'missing cache_read_tokens coalesces to 0');
    assert.equal(row.cache_write_tokens, 0, 'missing cache_write_tokens coalesces to 0');
    handle.db.close();
  } finally {
    cleanup(base);
  }
});
