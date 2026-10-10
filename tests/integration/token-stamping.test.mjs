/**
 * Integration suite for the Phase 68-03 proxy write-path task_id stamping
 * (TELEM-03 / Success Criterion 5).
 *
 * Proves, against the SHIPPED compiled code (../../dist — run AFTER
 * `npm run build`), the write-path resolution contract that server.mjs applies
 * when it builds the logTokenCall row:
 *
 *   (a) With an ACTIVE span, resolveLiveTaskId returns the span's task_id, and a
 *       row logged with that value reads back the span's task_id.
 *   (b) With NO active span, resolveLiveTaskId returns '' and the logged row
 *       reads back '' (matching the column DEFAULT from Plan 68-01).
 *   (c) With a CORRUPT active-measurement.json, resolveLiveTaskId returns ''
 *       (the read failure is swallowed) AND a row is still inserted — the
 *       best-effort property is preserved (a measurement-read failure must never
 *       break token logging, T-68-03-01).
 *
 * resolveLiveTaskId is imported (not re-implemented) from dist/measurement-span.js
 * — the single place the live rule lives, the same export server.mjs consults.
 * Each test isolates BOTH stores under one shared tmp dataDir:
 *   - the measurement span at <dataDir>/active-measurement.json (override arg)
 *   - the token DB at <dataDir>/llm-proxy/token-usage.db (LLM_PROXY_DATA_DIR)
 *
 * Built-in node:test + node:assert/strict only; no external test deps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { initTokenDb, logCall } from '../../dist/token-usage.js';
import {
  startMeasurement, stopMeasurement, resolveLiveTaskId, resolveMeasurementPaths,
} from '../../dist/measurement-span.js';

/** Fresh isolated temp data dir shared by the span + the token DB. */
function freshDataDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tok-stamp-${label}-`));
}

/** Drop env overrides + clean up the temp dir after a test. */
function cleanup(dataDir) {
  delete process.env.LLM_PROXY_DATA_DIR;
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Build the minimal token_usage row the proxy logs, stamping task_id exactly as
 * server.mjs does — via resolveLiveTaskId(dataDir). The dataDir override is the
 * test seam standing in for the daemon's LLM_PROXY_DATA_DIR.
 */
function buildRow(dataDir, overrides = {}) {
  return {
    timestamp: new Date().toISOString(),
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    process: 'telem-stamping-test',
    subscription: 'api-key',
    input_tokens: 10,
    output_tokens: 20,
    total_tokens: 30,
    latency_ms: 100,
    prompt_preview: 'token-stamping integration test',
    tokens_estimated: 0,
    task_id: resolveLiveTaskId(dataDir),
    ...overrides,
  };
}

test('(a) active span → row.task_id equals the span task_id', () => {
  const dataDir = freshDataDir('a');
  process.env.LLM_PROXY_DATA_DIR = dataDir;
  try {
    startMeasurement({ task_id: 'exp-run-a1' }, dataDir);
    // Sanity: the resolver consults the single reader and returns the span id.
    assert.equal(resolveLiveTaskId(dataDir), 'exp-run-a1');

    const handle = initTokenDb();
    logCall(handle, buildRow(dataDir));
    const r = handle.db.prepare('SELECT * FROM token_usage ORDER BY id DESC LIMIT 1').get();
    assert.equal(r.task_id, 'exp-run-a1', 'logged row should carry the active span task_id');
    handle.db.close();

    stopMeasurement(dataDir);
  } finally {
    cleanup(dataDir);
  }
});

test("(b) no active span → row.task_id is ''", () => {
  const dataDir = freshDataDir('b');
  process.env.LLM_PROXY_DATA_DIR = dataDir;
  try {
    // No startMeasurement → no active span.
    assert.equal(resolveLiveTaskId(dataDir), '', 'resolver returns empty string when no span');

    const handle = initTokenDb();
    logCall(handle, buildRow(dataDir));
    const r = handle.db.prepare('SELECT * FROM token_usage ORDER BY id DESC LIMIT 1').get();
    assert.equal(r.task_id, '', "logged row task_id should be '' with no active span");
    handle.db.close();
  } finally {
    cleanup(dataDir);
  }
});

test("(c) corrupt active-measurement.json → resolver returns '' AND a row is still inserted (best-effort)", () => {
  const dataDir = freshDataDir('c');
  process.env.LLM_PROXY_DATA_DIR = dataDir;
  try {
    // Write a corrupt active-measurement.json so the single reader's JSON.parse
    // fails. getActiveMeasurement swallows it (returns null) and resolveLiveTaskId
    // returns '' — the read failure must not break token logging.
    const { activePath } = resolveMeasurementPaths(dataDir);
    fs.mkdirSync(path.dirname(activePath), { recursive: true });
    fs.writeFileSync(activePath, '{ this is not valid json ');

    assert.equal(resolveLiveTaskId(dataDir), '', 'corrupt span → empty task_id (no throw)');

    const handle = initTokenDb();
    // The whole point: logging proceeds despite the unreadable span.
    assert.doesNotThrow(() => logCall(handle, buildRow(dataDir)));
    const r = handle.db.prepare('SELECT * FROM token_usage ORDER BY id DESC LIMIT 1').get();
    assert.ok(r, 'a row must still be inserted when the span is unreadable');
    assert.equal(r.task_id, '', "row task_id is '' when the span is corrupt");
    handle.db.close();
  } finally {
    cleanup(dataDir);
  }
});
