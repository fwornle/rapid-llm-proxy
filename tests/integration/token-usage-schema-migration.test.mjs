/**
 * Integration suite for the Phase 68-01 token-usage attribution schema
 * migration (TELEM-01).
 *
 * Proves, against the SHIPPED compiled code (../../dist/token-usage.js — run
 * AFTER `npm run build`), that:
 *   (a) initTokenDb adds the six additive columns with the correct DEFAULTs
 *       — '' for the 5 TEXT columns, 0 for reasoning_tokens (read from
 *       PRAGMA table_info dflt_value, not merely column existence).
 *   (b) logCall with no new fields inserts a row that reads back '' / 0.
 *   (c) logCall with the new fields populated reads back the supplied values.
 *   (d) a second initTokenDb() on the SAME DB path is a schema-identical no-op
 *       and emits no `migration failed` stderr (idempotent).
 *
 * Each test isolates its DB via LLM_PROXY_TOKEN_DB_PATH pointed at a fresh
 * tmpdir file (resolveTokenDbPath honours that env override first). Built-in
 * node:test + node:assert/strict only; no external test deps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { initTokenDb, logCall } from '../../dist/token-usage.js';

const NEW_TEXT_COLS = ['agent', 'task_id', 'tool_call_id', 'parent_call_id', 'granularity_tier'];
const NEW_INT_COL = 'reasoning_tokens';
const ALL_NEW_COLS = [...NEW_TEXT_COLS, NEW_INT_COL];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_TOKEN_USAGE = path.resolve(__dirname, '../../dist/token-usage.js');

/** Fresh isolated temp DB path; caller sets LLM_PROXY_TOKEN_DB_PATH to it. */
function freshDbPath(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tu-mig-${label}-`));
  return path.join(dir, 'token-usage.db');
}

/** Drop the env override + clean up the temp dir after a test. */
function cleanup(dbPath) {
  delete process.env.LLM_PROXY_TOKEN_DB_PATH;
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* best-effort */ }
}

test('(a) initTokenDb adds the six columns with correct dflt_value defaults', () => {
  const dbPath = freshDbPath('a');
  process.env.LLM_PROXY_TOKEN_DB_PATH = dbPath;
  try {
    const handle = initTokenDb();
    const cols = handle.db.prepare('PRAGMA table_info(token_usage)').all();
    const byName = new Map(cols.map(c => [c.name, c]));

    for (const name of ALL_NEW_COLS) {
      assert.ok(byName.has(name), `column ${name} should exist after initTokenDb`);
    }
    // dflt_value is the literal SQL default: '' renders as "''" for TEXT,
    // and "0" for the integer column.
    for (const name of NEW_TEXT_COLS) {
      assert.equal(byName.get(name).dflt_value, "''", `${name} should default to empty string`);
    }
    assert.equal(byName.get(NEW_INT_COL).dflt_value, '0', 'reasoning_tokens should default to 0');

    handle.db.close();
  } finally {
    cleanup(dbPath);
  }
});

test('(b) logCall without new fields reads back the empty-string / zero defaults', () => {
  const dbPath = freshDbPath('b');
  process.env.LLM_PROXY_TOKEN_DB_PATH = dbPath;
  try {
    const handle = initTokenDb();
    logCall(handle, {
      timestamp: new Date().toISOString(),
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      process: 'unit-test',
      subscription: 'api-key',
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
      latency_ms: 100,
      prompt_preview: 'legacy caller, no attribution fields',
      tokens_estimated: 0,
    });
    const r = handle.db.prepare('SELECT * FROM token_usage ORDER BY id DESC LIMIT 1').get();
    for (const name of NEW_TEXT_COLS) {
      assert.equal(r[name], '', `${name} should read back '' for a legacy insert`);
    }
    assert.equal(r[NEW_INT_COL], 0, 'reasoning_tokens should read back 0 for a legacy insert');
    handle.db.close();
  } finally {
    cleanup(dbPath);
  }
});

test('(c) logCall with new fields populated reads back the supplied values', () => {
  const dbPath = freshDbPath('c');
  process.env.LLM_PROXY_TOKEN_DB_PATH = dbPath;
  try {
    const handle = initTokenDb();
    logCall(handle, {
      timestamp: new Date().toISOString(),
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      process: 'unit-test',
      subscription: 'api-key',
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
      latency_ms: 100,
      prompt_preview: 'adapter caller with attribution fields',
      tokens_estimated: 0,
      agent: 'claude',
      task_id: 'exp-run-42',
      tool_call_id: 'call-7',
      parent_call_id: 'turn-3',
      granularity_tier: 'reasoning-step',
      reasoning_tokens: 512,
    });
    const r = handle.db.prepare('SELECT * FROM token_usage ORDER BY id DESC LIMIT 1').get();
    assert.equal(r.agent, 'claude');
    assert.equal(r.task_id, 'exp-run-42');
    assert.equal(r.tool_call_id, 'call-7');
    assert.equal(r.parent_call_id, 'turn-3');
    assert.equal(r.granularity_tier, 'reasoning-step');
    assert.equal(r.reasoning_tokens, 512);
    handle.db.close();
  } finally {
    cleanup(dbPath);
  }
});

test('(d) a second initTokenDb() on the same DB is a schema-identical no-op with no migration-failed stderr', () => {
  const dbPath = freshDbPath('d');
  try {
    // Drive two initTokenDb() runs against the SAME db path in a child process
    // so we can capture stderr verbatim. The child prints the column set after
    // each run as a JSON line; we assert both runs see the identical set and
    // that no `migration failed` line was emitted.
    const childSrc = `
      import { initTokenDb } from ${JSON.stringify(DIST_TOKEN_USAGE)};
      const colset = (h) => h.db.prepare('PRAGMA table_info(token_usage)').all().map(c => c.name).sort();
      const h1 = initTokenDb();
      const c1 = colset(h1);
      h1.db.close();
      const h2 = initTokenDb();
      const c2 = colset(h2);
      h2.db.close();
      process.stdout.write('COLS1=' + JSON.stringify(c1) + '\\n');
      process.stdout.write('COLS2=' + JSON.stringify(c2) + '\\n');
    `;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', childSrc], {
      encoding: 'utf8',
      env: { ...process.env, LLM_PROXY_TOKEN_DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(res.status, 0, `child should exit 0 (stderr: ${res.stderr})`);
    const stdout = res.stdout || '';
    const stderr = res.stderr || '';
    const cols1Match = stdout.match(/COLS1=(.+)/);
    const cols2Match = stdout.match(/COLS2=(.+)/);
    assert.ok(cols1Match && cols2Match, 'child should print both column sets');
    const cols1 = JSON.parse(cols1Match[1]);
    const cols2 = JSON.parse(cols2Match[1]);
    assert.deepEqual(cols1, cols2, 'column set must be identical across two startups');
    for (const name of ALL_NEW_COLS) {
      assert.ok(cols1.includes(name), `idempotent run should retain column ${name}`);
    }
    // The second initTokenDb() ran against an already-migrated DB; assert the
    // attribution migration emitted no failure line (PRAGMA guard short-circuit).
    assert.ok(!/migration failed/.test(stderr), `no migration-failed stderr on idempotent re-run (stderr: ${stderr})`);
  } finally {
    cleanup(dbPath);
  }
});
