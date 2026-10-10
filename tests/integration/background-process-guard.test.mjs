/**
 * Regression suite for the Phase 82-06 span-leakage guard II (WIRE-03).
 *
 * Proves, against the SHIPPED compiled helper (../../dist — run AFTER
 * `npm run build`), the exact write-path rule server.mjs applies at the
 * `/api/complete` task_id stamping site:
 *
 *   task_id = body.task_id                         (explicit → always wins)
 *           | ''                                    (background daemon, no explicit id)
 *           | resolveLiveTaskId()                   (any other process → ambient span)
 *
 * The failure this locks down: a coding-side background DAEMON
 * (health-coordinator, consolidator-*, observation-writer, token-adapter-*,
 * wave-analysis-*) firing on its own cadence during an OPEN experiment cell span
 * must NOT get its /api/complete tokens stamped with the cell's task_id. A cell's
 * own agent calls always arrive with an EXPLICIT body.task_id, so the guard only
 * ever gates the ambient fallback — it can never unbind a real cell row.
 *
 * The row-build resolution is exercised end-to-end against dist/token-usage.js +
 * dist/measurement-span.js with a real open span, mirroring server.mjs, so a
 * daemon process reads back '' while a cell/other process reads back the span id.
 *
 * Built-in node:test + node:assert/strict only; no external test deps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { isBackgroundProcess } from '../../dist/background-process.js';
import { initTokenDb, logCall } from '../../dist/token-usage.js';
import { startMeasurement, stopMeasurement, resolveLiveTaskId } from '../../dist/measurement-span.js';

/** Fresh isolated temp data dir shared by the span + the token DB. */
function freshDataDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bg-guard-${label}-`));
}

function cleanup(dataDir) {
  delete process.env.LLM_PROXY_DATA_DIR;
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Resolve task_id EXACTLY as server.mjs does at the /api/complete stamping site:
 *   explicit body.task_id wins → else background daemon gets '' → else ambient span.
 */
function resolveStampedTaskId(dataDir, { process: procName, task_id } = {}) {
  if (typeof task_id === 'string' && task_id) return task_id;
  return isBackgroundProcess(procName) ? '' : resolveLiveTaskId(dataDir);
}

test('isBackgroundProcess — denylist membership (exact + prefix families)', () => {
  // Exact daemons observed leaking in the gate run.
  assert.equal(isBackgroundProcess('health-coordinator'), true);
  assert.equal(isBackgroundProcess('observation-writer'), true);
  // Prefix families.
  assert.equal(isBackgroundProcess('consolidator-insight'), true);
  assert.equal(isBackgroundProcess('consolidator-digest'), true);
  assert.equal(isBackgroundProcess('consolidator-mentions'), true);
  assert.equal(isBackgroundProcess('token-adapter-claude'), true);
  assert.equal(isBackgroundProcess('token-adapter-opencode'), true);
  assert.equal(isBackgroundProcess('wave-analysis-batch'), true);
  // Cell agents / unknown processes are NOT background — they keep the fallback.
  assert.equal(isBackgroundProcess('opencode'), false);
  assert.equal(isBackgroundProcess('claude'), false);
  assert.equal(isBackgroundProcess('some-future-process'), false);
  // Untrusted / empty inputs coalesce to false (never throw).
  assert.equal(isBackgroundProcess(''), false);
  assert.equal(isBackgroundProcess('   '), false);
  assert.equal(isBackgroundProcess(undefined), false);
  assert.equal(isBackgroundProcess(null), false);
  assert.equal(isBackgroundProcess(42), false);
});

test('open cell span → daemon /api/complete row is NOT stamped; cell/other IS', () => {
  const dataDir = freshDataDir('leak');
  process.env.LLM_PROXY_DATA_DIR = dataDir;
  try {
    const cellTaskId = 'wire-verify-82-06-v2--claude-sonnet-straight-default--r0';
    startMeasurement({ task_id: cellTaskId }, dataDir);
    // The span IS the cell — the resolver returns the cell id for the fallback.
    assert.equal(resolveLiveTaskId(dataDir), cellTaskId);

    // (a) health-coordinator daemon, no explicit task_id → must be UNBOUND.
    assert.equal(
      resolveStampedTaskId(dataDir, { process: 'health-coordinator' }), '',
      'daemon must not inherit the ambient cell span',
    );
    // (b) consolidator-insight daemon, no explicit task_id → must be UNBOUND.
    assert.equal(
      resolveStampedTaskId(dataDir, { process: 'consolidator-insight' }), '',
    );
    // (c) an interactive / unknown process without an id → keeps ambient fallback.
    assert.equal(
      resolveStampedTaskId(dataDir, { process: 'claude' }), cellTaskId,
    );
    // (d) the cell's OWN call carries an EXPLICIT task_id → always binds, even if
    //     (hypothetically) its process name were on the denylist.
    assert.equal(
      resolveStampedTaskId(dataDir, { process: 'opencode', task_id: cellTaskId }), cellTaskId,
      'explicit body.task_id always wins over the daemon guard',
    );

    // End-to-end: persist the daemon row and read back '' (matches no-span DEFAULT).
    const handle = initTokenDb();
    logCall(handle, {
      timestamp: new Date().toISOString(),
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      process: 'health-coordinator',
      subscription: 'api-key',
      input_tokens: 9, output_tokens: 4, total_tokens: 13,
      latency_ms: 50,
      prompt_preview: 'bg-guard daemon row',
      tokens_estimated: 0,
      task_id: resolveStampedTaskId(dataDir, { process: 'health-coordinator' }),
    });
    const r = handle.db.prepare('SELECT * FROM token_usage ORDER BY id DESC LIMIT 1').get();
    assert.equal(r.task_id, '', 'persisted daemon row must be unattributed during an open cell span');
    handle.db.close();

    stopMeasurement(dataDir);
  } finally {
    cleanup(dataDir);
  }
});
