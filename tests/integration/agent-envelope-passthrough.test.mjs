/**
 * Integration suite for the Phase 70-01 Task 1 generic envelope passthrough
 * (ADAPT-03 / D-06 — agent / granularity_tier / task_id precedence on the
 * logTokenCall row build).
 *
 * Task 1 adds, to the proxy's shared logTokenCall row build (server.mjs, inside
 * the `if (_tokenDb)` guard), two generic envelope-passthrough fields stamped the
 * SAME way `process`/`subscription` already are, plus a task_id precedence:
 *
 *   row.agent            = (typeof body.agent === 'string' && body.agent) ? body.agent : ''
 *   row.granularity_tier = (typeof body.granularity_tier === 'string' && body.granularity_tier) ? body.granularity_tier : ''
 *   row.task_id          = (typeof body.task_id === 'string' && body.task_id) ? body.task_id : resolveLiveTaskId()
 *
 * This suite proves the resulting ROW CONTRACT against the SHIPPED compiled
 * persistence layer (../../dist — already complete, zero edits) by building rows
 * exactly the way server.mjs does and reading them back from token-usage.db:
 *
 *   (a) An envelope carrying agent='opencode', granularity_tier='per-llm-call',
 *       and an explicit task_id override lands a row stamped with all three,
 *       and the task_id override WINS over the active span.
 *   (b) An envelope carrying agent='mastra' (the Plan-04 Track-A path) lands a
 *       row stamped agent='mastra' — proving the same generic code serves any
 *       agent with no per-agent branch.
 *   (c) An envelope that OMITS agent/granularity_tier/task_id (an existing
 *       /api/complete caller) lands a backward-compatible row: agent='' and
 *       granularity_tier='' (column defaults) and task_id resolved from the
 *       active span via resolveLiveTaskId() — current behaviour preserved.
 *
 * The persistence layer (token-usage.ts) is NOT edited by this plan — the six
 * Phase-68 attribution columns already exist and logCall already binds
 * agent/task_id/granularity_tier with ''/0 defaults. This suite is the
 * executable proof of the row-shape contract the shim relies on.
 *
 * Built-in node:test + node:assert/strict only; no external test deps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { initTokenDb, logCall } from '../../dist/token-usage.js';
import { startMeasurement, stopMeasurement, resolveLiveTaskId } from '../../dist/measurement-span.js';

function freshDataDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-env-${label}-`));
}

function cleanup(dataDir) {
  delete process.env.LLM_PROXY_DATA_DIR;
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Build the token_usage row the proxy logs, stamping agent / granularity_tier /
 * task_id EXACTLY the way Task 1's server.mjs passthrough does. `body` is the
 * internal envelope the shim (Task 2) hands the shared path; `dataDir` is the
 * test seam standing in for the daemon's LLM_PROXY_DATA_DIR.
 */
function buildRow(body, dataDir) {
  return {
    timestamp: new Date().toISOString(),
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    process: typeof body.process === 'string' && body.process ? body.process : 'unknown',
    subscription: 'api-key',
    input_tokens: 10,
    output_tokens: 20,
    total_tokens: 30,
    latency_ms: 100,
    prompt_preview: 'agent envelope passthrough test',
    tokens_estimated: 0,
    // ── Phase 70 Task 1 passthrough (mirrors process/subscription threading) ──
    agent: typeof body.agent === 'string' && body.agent ? body.agent : '',
    granularity_tier: typeof body.granularity_tier === 'string' && body.granularity_tier ? body.granularity_tier : '',
    // task_id precedence: body.task_id override wins, else the active span.
    task_id: typeof body.task_id === 'string' && body.task_id ? body.task_id : resolveLiveTaskId(dataDir),
    // ── CR-02 (83-09): mirror server.mjs's adapterUserHash(body.agent) stamp ──
    // A known agent → its adapter hash; an omitted agent leaves user_hash unset so
    // logCall keeps defaulting to the machine USER_HASH (backward compatible).
    ...(typeof body.agent === 'string' && body.agent
      ? { user_hash: ADAPTER_USER_HASH[body.agent] ?? adapterUserHashFallback(body.agent) }
      : {}),
  };
}

/**
 * Mirror of server.mjs adapterUserHash: known agents use the established literals;
 * any other agent derives a valid 6-char /^[a-z][a-z0-9]{5}$/ code.
 */
const ADAPTER_USER_HASH = { claude: 'cladpt', copilot: 'copadt', opencode: 'opcadt', mastra: 'mstadt' };
function adapterUserHashFallback(agent) {
  let s = String(agent || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!/^[a-z]/.test(s)) s = `x${s}`;
  return `${s}xxxxxx`.slice(0, 6);
}

test('(a) agent/granularity_tier/task_id-override all land; override wins over the span', () => {
  const dataDir = freshDataDir('a');
  process.env.LLM_PROXY_DATA_DIR = dataDir;
  try {
    startMeasurement({ task_id: 'span-should-lose' }, dataDir);
    assert.equal(resolveLiveTaskId(dataDir), 'span-should-lose');

    const handle = initTokenDb();
    logCall(handle, buildRow({ agent: 'opencode', granularity_tier: 'per-llm-call', task_id: 'override-wins' }, dataDir));
    const r = handle.db.prepare('SELECT * FROM token_usage ORDER BY id DESC LIMIT 1').get();
    assert.equal(r.agent, 'opencode', 'row.agent stamped from body.agent');
    assert.equal(r.granularity_tier, 'per-llm-call', 'row.granularity_tier stamped from body.granularity_tier');
    assert.equal(r.task_id, 'override-wins', 'body.task_id override wins over the active span');
    handle.db.close();

    stopMeasurement(dataDir);
  } finally {
    cleanup(dataDir);
  }
});

test("(b) agent='mastra' lands generically (Plan-04 Track-A, no per-agent branch)", () => {
  const dataDir = freshDataDir('b');
  process.env.LLM_PROXY_DATA_DIR = dataDir;
  try {
    const handle = initTokenDb();
    logCall(handle, buildRow({ agent: 'mastra', granularity_tier: 'per-llm-call' }, dataDir));
    const r = handle.db.prepare('SELECT * FROM token_usage ORDER BY id DESC LIMIT 1').get();
    assert.equal(r.agent, 'mastra', "the same generic passthrough serves agent='mastra'");
    assert.equal(r.granularity_tier, 'per-llm-call');
    handle.db.close();
  } finally {
    cleanup(dataDir);
  }
});

test("(c) omitted envelope is backward-compatible: agent='', tier='', task_id from the span", () => {
  const dataDir = freshDataDir('c');
  process.env.LLM_PROXY_DATA_DIR = dataDir;
  try {
    startMeasurement({ task_id: 'span-wins-when-omitted' }, dataDir);

    const handle = initTokenDb();
    // An existing /api/complete caller: no agent / granularity_tier / task_id.
    logCall(handle, buildRow({ process: 'legacy-caller' }, dataDir));
    const r = handle.db.prepare('SELECT * FROM token_usage ORDER BY id DESC LIMIT 1').get();
    assert.equal(r.agent, '', "omitted agent defaults to '' (backward compatible)");
    assert.equal(r.granularity_tier, '', "omitted granularity_tier defaults to '' (backward compatible)");
    assert.equal(r.task_id, 'span-wins-when-omitted', 'task_id falls back to the active span when not overridden');
    handle.db.close();

    stopMeasurement(dataDir);
  } finally {
    cleanup(dataDir);
  }
});

// CR-02 (83-09): the /api/complete logTokenCall stamps user_hash from body.agent
// (mirroring the /v1/messages tap) so copilot BYOK wire rows carry the copadt
// adapter hash and become discoverable by the coding-side copadt-keyed
// snapshotWireRowIds. A known agent → its adapter hash; an omitted agent keeps
// the machine USER_HASH default (backward compatible for direct /api/complete
// callers). The same generic map serves opencode/mastra.
test("(d) CR-02: agent='copilot'→copadt, 'opencode'→opcadt; omitted agent → machine USER_HASH", () => {
  const dataDir = freshDataDir('d');
  process.env.LLM_PROXY_DATA_DIR = dataDir;
  try {
    const handle = initTokenDb();

    // An omitted-agent row establishes the machine USER_HASH baseline.
    logCall(handle, buildRow({ process: 'legacy-caller' }, dataDir));
    const omitted = handle.db.prepare("SELECT * FROM token_usage WHERE agent = ''").get();
    const machineHash = omitted.user_hash;
    assert.ok(machineHash && machineHash.length > 0, 'omitted agent lands the machine USER_HASH default');

    logCall(handle, buildRow({ agent: 'copilot' }, dataDir));
    const copilot = handle.db.prepare("SELECT * FROM token_usage WHERE agent = 'copilot'").get();
    assert.equal(copilot.user_hash, 'copadt', "agent='copilot' stamps the copilot adapter hash");

    logCall(handle, buildRow({ agent: 'opencode' }, dataDir));
    const opencode = handle.db.prepare("SELECT * FROM token_usage WHERE agent = 'opencode'").get();
    assert.equal(opencode.user_hash, 'opcadt', "agent='opencode' stamps the opencode adapter hash");

    assert.notEqual(copilot.user_hash, machineHash, 'the copilot adapter hash differs from the machine hash');
    handle.db.close();
  } finally {
    cleanup(dataDir);
  }
});
