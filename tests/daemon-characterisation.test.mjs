/**
 * Characterisation of the daemon's measurement output — the real server.mjs,
 * booted by tests/harness/daemon.mjs against tests/harness/fake-upstream.mjs.
 *
 * Every scenario records what the measurement side of the daemon produced for
 * one request: the response the client saw, what was forwarded upstream, the
 * token_usage rows written, and the files written under the data dir
 * (per-run context breakdown, context-turns.jsonl, raw-bodies.jsonl). The
 * result must equal tests/fixtures/daemon-characterisation.json, which was
 * recorded before the measurement code was moved out of server.mjs — so any
 * behaviour change in that move fails here.
 *
 * Re-record (only for an INTENDED behaviour change):
 *   UPDATE_CHARACTERISATION=1 node --test tests/daemon-characterisation.test.mjs
 *
 * Needs `npm run build` (server.mjs imports ../dist) and the openssl CLI.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { startFakeUpstream } from './harness/fake-upstream.mjs';
import { startDaemon } from './harness/daemon.mjs';

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'daemon-characterisation.json');
const UPDATE = process.env.UPDATE_CHARACTERISATION === '1';

// ── Fake upstream answers ────────────────────────────────────────────────────
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
const ANTHROPIC_SSE = sse([
  { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-5', usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 } } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong sk-test-leaked' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
  { type: 'message_stop' },
]);
const ANTHROPIC_JSON = {
  id: 'msg_2', type: 'message', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'pong' }],
  usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 11, ephemeral_1h_input_tokens: 2 } },
};
const OPENAI_JSON = {
  id: 'chatcmpl-up', object: 'chat.completion', model: 'gpt-4o-mini-2024-07-18',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
  usage: { prompt_tokens: 120, completion_tokens: 5, total_tokens: 125, prompt_tokens_details: { cached_tokens: 100 } },
};

let reqSeq = 0;
function respond(r) {
  if (r.host === 'api.anthropic.com') {
    const body = JSON.parse(r.body || '{}');
    if (r.path.startsWith('/v1/messages/count_tokens')) return { body: { input_tokens: 21 } };
    if (body.metadata?.fail) return { status: 400, headers: { 'request-id': 'req_err' }, body: { type: 'error', error: { type: 'invalid_request_error', message: 'nope' } } };
    reqSeq += 1;
    if (body.stream) return { headers: { 'request-id': `req_${reqSeq}` }, chunks: ANTHROPIC_SSE };
    return { headers: { 'request-id': `req_${reqSeq}` }, body: ANTHROPIC_JSON };
  }
  if (r.host === 'api.openai.com' && r.path === '/v1/chat/completions') return { body: OPENAI_JSON };
  return null;
}

// ── Normalisation: strip what legitimately differs run to run ────────────────
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const VOLATILE_KEYS = new Set(['latency_ms', 'latencyMs', 'avg_latency', 'avg_latency_ms', 'p50_latency_ms', 'p50_overhead_ms', 'overhead_ms', 'overheadMs', 'created', 'timestamp']);
const CLIENT_HEADERS = new Set(['host', 'content-length', 'connection', 'user-agent', 'accept', 'accept-language', 'sec-fetch-mode']);

function norm(v, sandbox) {
  if (typeof v === 'string') {
    return v.split(sandbox).join('<sandbox>').replace(ISO, '<ts>').replace(UUID, '<uuid>');
  }
  if (Array.isArray(v)) return v.map((x) => norm(x, sandbox));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) {
      o[k] = VOLATILE_KEYS.has(k) && v[k] !== null && v[k] !== 0 ? '<volatile>' : norm(v[k], sandbox);
    }
    return o;
  }
  return v;
}
const parseMaybe = (s) => { try { return JSON.parse(s); } catch { return s; } };
const projectBody = (s, body) => (s.project && body && typeof body === 'object' ? s.project(body) : body);

// ── Observation of the data dir + token DB ───────────────────────────────────
function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}
// llm-proxy-export/ is the token-usage export, named after the wall-clock hour.
const IGNORED_FILES = /^(llm-proxy\/(token-usage\.db.*|last-corporate-proxy)|llm-proxy-export\/.*)$/;
// The live-latest breakdown is throttled to one write per 8 s, so after the first
// scenario whether it is rewritten depends on wall-clock time; only scenario 1 records it.
const GLOBAL_BREAKDOWN = 'llm-proxy/context-breakdown.json';

function readFiles(dataDir) {
  const out = {};
  for (const f of walk(dataDir)) if (!IGNORED_FILES.test(f)) out[f] = fs.readFileSync(path.join(dataDir, f), 'utf8');
  return out;
}
function dbRows(dataDir, afterId) {
  const file = path.join(dataDir, 'llm-proxy', 'token-usage.db');
  if (!fs.existsSync(file)) return [];
  const db = new Database(file, { readonly: true });
  // `id` is not unique in this table; rowid is the insertion order.
  try { return db.prepare('SELECT rowid AS _rowid, * FROM token_usage WHERE rowid > ? ORDER BY rowid').all(afterId); } finally { db.close(); }
}
function maxId(dataDir) {
  const rows = dbRows(dataDir, 0);
  return rows.length ? rows[rows.length - 1]._rowid : 0;
}

// Writes after the response (tap row, context turn, breakdown) are asynchronous:
// wait until the data dir and DB stop changing.
async function settle(dataDir) {
  const sig = () => JSON.stringify([maxId(dataDir), Object.entries(readFiles(dataDir)).map(([k, v]) => [k, v.length])]);
  let last = sig();
  await new Promise((r) => setTimeout(r, 200));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const now = sig();
    if (now === last) return;
    last = now;
  }
}

function fileChanges(before, after, includeGlobal) {
  const out = {};
  for (const [f, content] of Object.entries(after)) {
    if (f === GLOBAL_BREAKDOWN && !includeGlobal) continue;
    const prev = before[f];
    if (prev === content) continue;
    if (f.endsWith('.jsonl')) {
      const added = content.slice(prev && content.startsWith(prev) ? prev.length : 0);
      out[f] = added.split('\n').filter(Boolean).map(parseMaybe);
    } else {
      out[f] = parseMaybe(content);
    }
  }
  return out;
}

// ── Scenarios ────────────────────────────────────────────────────────────────
const MAIN_TOOLS = [{ name: 'Agent', input_schema: {} }, { name: 'Read', input_schema: {} }];
const SUB_TOOLS = [{ name: 'Read', input_schema: {} }];
const messages = (text) => [{ role: 'user', content: [{ type: 'text', text }] }];
const anthropicBody = (extra = {}) => ({
  model: 'claude-sonnet-5', max_tokens: 64,
  system: [{ type: 'text', text: 'You are a test. sk-test-system' }],
  tools: MAIN_TOOLS, messages: messages('ping'), ...extra,
});
const span = (task_id, meta = {}) => ({ task_id, started_at: new Date().toISOString(), meta });

const SCENARIOS = [
  { name: 'messages sse, x-task-id header, main session, project',
    path: '/v1/messages', headers: { 'x-task-id': 'task-hdr', 'x-project': 'glass' }, body: anthropicBody({ stream: true }) },
  // Straight after the first main-session call: the live-latest file is throttled to 8 s.
  { name: 'read: live-latest context breakdown', method: 'GET', path: '/api/context-breakdown' },
  { name: 'messages json, x-agent pi, subagent toolset',
    path: '/v1/messages', headers: { 'x-task-id': 'task-pi', 'x-agent': 'pi' }, body: anthropicBody({ tools: SUB_TOOLS }) },
  { name: 'messages sse, no header, per-agent span with raw-body capture',
    spans: { 'active-measurement.claude.json': span('span-claude', { capture_raw_bodies: true }) },
    path: '/v1/messages', body: anthropicBody({ stream: true }) },
  { name: 'messages sse, no header, global span only → neutral row',
    spans: { 'active-measurement.json': span('span-global') },
    path: '/v1/messages', body: anthropicBody({ stream: true }) },
  { name: 'messages sse, malformed x-task-id → ambient global span',
    spans: { 'active-measurement.json': span('span-global') },
    path: '/v1/messages', headers: { 'x-task-id': 'bad id!' }, body: anthropicBody({ stream: true }) },
  { name: 'messages count_tokens is forwarded, never tapped',
    path: '/v1/messages/count_tokens', headers: { 'x-task-id': 'task-hdr' }, body: anthropicBody() },
  { name: 'messages upstream error has no usage → no row',
    path: '/v1/messages', headers: { 'x-task-id': 'task-hdr' }, body: anthropicBody({ metadata: { fail: true } }) },
  { name: 'opencode shim, x-task-id header',
    path: '/v1/chat/completions', headers: { 'x-task-id': 'task-oc' },
    body: { model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'ping' }] } },
  { name: 'copilot shim, project + task in path',
    path: '/v1/copilot/p/glass/t/task-cp/chat/completions',
    body: { model: 'gpt-4o-mini', messages: [{ role: 'developer', content: 'sys' }, { role: 'user', content: [{ type: 'text', text: 'ping' }] }] } },
  { name: 'opencode responses shim, task in path',
    path: '/v1/opencode/t/task-resp/responses',
    body: { model: 'gpt-4o-mini', instructions: 'sys', input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }] } },
  { name: 'api/complete, background process ignores the global span',
    spans: { 'active-measurement.json': span('span-global') },
    path: '/api/complete', body: { process: 'observation-writer', messages: [{ role: 'user', content: 'ping' }] } },
  { name: 'api/complete, agent with global span + raw-body capture',
    spans: { 'active-measurement.json': span('span-global', { capture_raw_bodies: true }) },
    path: '/api/complete', body: { agent: 'mastra', process: 'mastra-chat', messages: [{ role: 'user', content: 'ping sk-test-user' }] } },
  { name: 'read: per-run context breakdown', method: 'GET', path: '/api/context-breakdown?task_id=task-oc' },
  { name: 'read: unknown run breakdown → 404', method: 'GET', path: '/api/context-breakdown?task_id=nope' },
  { name: 'read: context turns of a run', method: 'GET', path: '/api/context-turns?task_id=task-hdr' },
  { name: 'read: context turns, traversal id → empty', method: 'GET', path: '/api/context-turns?task_id=..' },
  // glass G3 / WP1 — recorded before /v1/messages and the reads move out of server.mjs.
  { name: 'messages json, query string kept upstream',
    path: '/v1/messages?beta=true', headers: { 'x-task-id': 'task-beta' }, body: anthropicBody() },
  { name: 'messages, agent whose route has no fg transport → 501',
    path: '/v1/messages', headers: { 'x-task-id': 'task-hdr', 'x-agent': 'codex' }, body: anthropicBody() },
  // The aggregates below depend on the wall clock (hour buckets, month boundaries):
  // only the clock-free parts are recorded.
  { name: 'read: token-usage summary totals', method: 'GET', path: '/api/token-usage/summary?hours=24&scope=both',
    project: (b) => ({ scope: b.scope, hours: b.hours, total_calls: b.total_calls, total_input: b.total_input,
      total_output: b.total_output, total_tokens: b.total_tokens, total_cache_read: b.total_cache_read,
      total_cache_write: b.total_cache_write, by_process: b.by_process, by_model: b.by_model, by_provider: b.by_provider }) },
  { name: 'read: token-usage recent', method: 'GET', path: '/api/token-usage/recent?limit=3&scope=both' },
  { name: 'read: token-usage cost', method: 'GET', path: '/api/token-usage/cost?months=1',
    project: (b) => ({ months: b.months, rows: (b.rows || []).map(({ month, ...r }) => r) }) },
];

let sandbox; let upstream; let daemon;
const observed = [];

before(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-char-'));
  upstream = await startFakeUpstream({ dir: path.join(sandbox, 'upstream'), respond });
  daemon = await startDaemon({ sandbox, upstream });
});

after(async () => {
  await daemon?.stop();
  await upstream?.close();
  if (sandbox && process.env.KEEP_SANDBOX !== "1") fs.rmSync(sandbox, { recursive: true, force: true });
  else if (sandbox) console.log(`sandbox kept: ${sandbox}`);
});

test('daemon measurement output matches the recorded characterisation', async () => {
  for (const [i, s] of SCENARIOS.entries()) {
    for (const f of walk(daemon.dataDir).filter((f) => /^active-measurement.*\.json$/.test(f))) fs.rmSync(path.join(daemon.dataDir, f));
    for (const [f, rec] of Object.entries(s.spans || {})) fs.writeFileSync(path.join(daemon.dataDir, f), JSON.stringify(rec));

    const filesBefore = readFiles(daemon.dataDir);
    const idBefore = maxId(daemon.dataDir);
    const upBefore = upstream.requests.length;

    const res = await fetch(`${daemon.url}${s.path}`, s.method === 'GET' ? {} : {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test-client', ...(s.headers || {}) },
      body: JSON.stringify(s.body),
    });
    const text = await res.text();
    await settle(daemon.dataDir);

    observed.push(norm({
      scenario: s.name,
      response: { status: res.status, body: projectBody(s, res.headers.get('content-type')?.includes('json') ? parseMaybe(text) : text) },
      upstream: upstream.requests.slice(upBefore).map((r) => ({
        host: r.host, method: r.method, path: r.path,
        headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => !CLIENT_HEADERS.has(k)).sort()),
        body: parseMaybe(r.body),
      })),
      rows: dbRows(daemon.dataDir, idBefore),
      files: fileChanges(filesBefore, readFiles(daemon.dataDir), i === 0),
    }, sandbox));
  }

  if (UPDATE) {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, `${JSON.stringify(observed, null, 2)}\n`);
    return;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  for (const [i, o] of observed.entries()) assert.deepEqual(o, golden[i], `scenario ${i + 1}: ${o.scenario}`);
  assert.equal(observed.length, golden.length);
});
