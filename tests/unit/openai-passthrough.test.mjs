/**
 * glass G3 / WP2 — the OpenAI-wire measuring passthrough (openai-passthrough.mjs)
 * and its usage tap: forwards verbatim to the agent's own upstream, streams back,
 * writes one token_usage row + context capture per call with usage.
 *
 * Upstream is a plain-HTTP stub (upstreamBase is injected), so no TLS is needed.
 * Needs `npm run build` (measurement.mjs imports ../dist).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-passthrough-'));
process.env.LLM_PROXY_DATA_DIR = dataDir;

const { initTokenDb } = await import('../../dist/token-usage.js');
const { createMeasurement, createOpenAIUsageTap } = await import('../../proxy-bridge/measurement.mjs');
const { handleOpenAIPassthrough, withUsageRequested, openAIWireOf } = await import('../../proxy-bridge/openai-passthrough.mjs');

const sse = (events) => events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
const CHAT_USAGE = { prompt_tokens: 120, completion_tokens: 5, total_tokens: 125, prompt_tokens_details: { cached_tokens: 100 } };

let tokenDb; let measurement; let upstream; let front; let upstreamBase; let frontUrl;
const seen = [];
let jsonSeq = 0;

function respond(req, body, res) {
  const json = body ? JSON.parse(body) : {};
  if (json.metadata?.fail) {
    res.writeHead(400, { 'content-type': 'application/json', 'x-request-id': 'req-err' });
    return res.end(JSON.stringify({ error: { message: 'nope' } }));
  }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'gpt-x' }] }));
  }
  if (req.url.endsWith('/responses')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req-resp' });
    return res.end(sse([
      { type: 'response.created', response: { model: 'gpt-5.1' } },
      { type: 'response.output_text.delta', delta: 'pong' },
      { type: 'response.completed', response: { model: 'gpt-5.1', usage: { input_tokens: 50, output_tokens: 4, input_tokens_details: { cached_tokens: 30 } } } },
    ]));
  }
  if (json.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req-sse' });
    const events = [
      { id: 'c1', model: 'claude-haiku-4.5', choices: [{ index: 0, delta: { content: 'po' } }] },
      { id: 'c1', model: 'claude-haiku-4.5', choices: [{ index: 0, delta: { content: 'ng' }, finish_reason: 'stop' }] },
    ];
    if (json.stream_options?.include_usage) events.push({ id: 'c1', model: 'claude-haiku-4.5', choices: [], usage: CHAT_USAGE });
    // CRLF framing, as some gateways send it.
    return res.end(sse([...events, '[DONE]']).replace(/\n/g, '\r\n'));
  }
  // A fresh request id per call: the token DB dedups rows on (user_hash, request id).
  jsonSeq += 1;
  res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': jsonSeq === 1 ? 'req-json' : `req-json-${jsonSeq}` });
  res.end(JSON.stringify({ id: 'c2', model: 'gpt-4o-mini-2024-07-18', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' } }], usage: CHAT_USAGE }));
}

before(async () => {
  tokenDb = initTokenDb(dataDir);
  measurement = createMeasurement({
    dataDir, tokenDb: () => tokenDb, redactRawBody: (s) => s, canonicalModel: (m) => m, log: () => {}, logErr: () => {},
  });
  upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    respond(req, body, res);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  front = http.createServer((req, res) => {
    handleOpenAIPassthrough(req, res, {
      measurement, fetch: globalThis.fetch, upstreamBase, provider: 'github-copilot',
      agent: req.headers['x-test-agent'] || 'opencode', taskId: req.headers['x-test-task'] || '', project: 'glass', attempts: 1,
    });
  });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  frontUrl = `http://127.0.0.1:${front.address().port}`;
});

after(async () => {
  await new Promise((r) => front.close(r));
  await new Promise((r) => upstream.close(r));
  tokenDb.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const rows = () => tokenDb.db.prepare('SELECT * FROM token_usage ORDER BY rowid').all();
const post = (p, body, headers = {}) => fetch(`${frontUrl}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer agent-own-token', ...headers }, body: JSON.stringify(body),
});
const settle = () => new Promise((r) => setTimeout(r, 100));
const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'ping' }];

test('wire detection and the include_usage rule', () => {
  assert.equal(openAIWireOf('/v1/chat/completions?x=1'), 'chat');
  assert.equal(openAIWireOf('/responses'), 'responses');
  assert.equal(openAIWireOf('/v1/models'), null);
  const raw = Buffer.from('{"stream":true}');
  assert.deepEqual(JSON.parse(withUsageRequested('chat', raw, { stream: true })), { stream: true, stream_options: { include_usage: true } });
  assert.equal(withUsageRequested('chat', raw, { stream: false }), raw);
  assert.equal(withUsageRequested('responses', raw, { stream: true }), raw);
  const asked = { stream: true, stream_options: { include_usage: true } };
  assert.equal(withUsageRequested('chat', raw, asked), raw);
});

test('chat JSON: forwarded verbatim with the agent\'s own auth; fresh input row + context turn', async () => {
  const before = rows().length;
  const res = await post('/v1/chat/completions', { model: 'gpt-4o-mini', messages: msgs }, { 'x-test-task': 'glass-t1' });
  const body = await res.json();
  assert.equal(body.choices[0].message.content, 'pong');
  await settle();
  const up = seen.at(-1);
  assert.equal(up.headers.authorization, 'Bearer agent-own-token');
  assert.deepEqual(JSON.parse(up.body), { model: 'gpt-4o-mini', messages: msgs });
  const [row] = rows().slice(before);
  assert.equal(row.input_tokens, 20, 'prompt 120 − cached 100');
  assert.equal(row.cache_read_tokens, 100);
  assert.equal(row.output_tokens, 5);
  assert.equal(row.total_tokens, 25);
  assert.equal(row.task_id, 'glass-t1');
  assert.equal(row.agent, 'opencode');
  assert.equal(row.user_hash, 'opcadt');
  assert.equal(row.provider, 'github-copilot');
  assert.equal(row.tool_call_id, 'req-json');
  assert.equal(row.project, 'glass');
  const turns = measurement.readContextTurns('glass-t1');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].usage.input, 20);
  assert.ok(JSON.parse(measurement.readBreakdown('glass-t1')).categories, 'per-run breakdown written');
});

test('chat SSE without include_usage: usage requested upstream, stream passed through, row written', async () => {
  const before = rows().length;
  const res = await post('/v1/chat/completions', { model: 'claude-haiku-4.5', stream: true, messages: msgs }, { 'x-test-task': 'glass-t2', 'x-test-agent': 'pi' });
  const text = await res.text();
  assert.match(text, /"content":"po"/);
  assert.match(text, /\[DONE\]/);
  await settle();
  assert.deepEqual(JSON.parse(seen.at(-1).body).stream_options, { include_usage: true });
  const [row] = rows().slice(before);
  assert.equal(row.agent, 'pi');
  assert.equal(row.user_hash, 'piadpt');
  assert.equal(row.model, 'claude-haiku-4.5');
  assert.equal(row.input_tokens, 20);
  assert.equal(row.tool_call_id, 'req-sse');
});

test('responses SSE: usage off response.completed', async () => {
  const before = rows().length;
  const res = await post('/responses', { model: 'gpt-5.1', instructions: 'sys', input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }] }, { 'x-test-task': 'glass-t3' });
  await res.text();
  await settle();
  const [row] = rows().slice(before);
  assert.equal(row.input_tokens, 20, 'input 50 − cached 30');
  assert.equal(row.cache_read_tokens, 30);
  assert.equal(row.output_tokens, 4);
  assert.equal(row.model, 'gpt-5.1');
  assert.equal(measurement.readContextTurns('glass-t3').length, 1);
});

test('upstream error: passed through, no row; unbound call: row but no capture', async () => {
  const before = rows().length;
  const res = await post('/v1/chat/completions', { model: 'gpt-4o-mini', messages: msgs, metadata: { fail: true } }, { 'x-test-task': 'glass-t4' });
  assert.equal(res.status, 400);
  await res.text();
  await settle();
  assert.equal(rows().length, before);
  await (await post('/v1/chat/completions', { model: 'gpt-4o-mini', messages: msgs })).text();
  await settle();
  const [row] = rows().slice(before);
  assert.equal(row.task_id, '');
});

test('other paths are forwarded unchanged and never tapped', async () => {
  const before = rows().length;
  const res = await fetch(`${frontUrl}/v1/models`, { headers: { authorization: 'Bearer agent-own-token' } });
  assert.deepEqual(await res.json(), { data: [{ id: 'gpt-x' }] });
  assert.equal(seen.at(-1).method, 'GET');
  await settle();
  assert.equal(rows().length, before);
});

test('usage tap: chat SSE keeps the last usage; JSON body; no usage → sawUsage false', () => {
  const t = createOpenAIUsageTap({ wire: 'chat' });
  t.sseChunk(Buffer.from(sse([{ model: 'm', choices: [] }])));
  assert.equal(t.usage.sawUsage, false);
  t.sseChunk(Buffer.from(sse([{ model: 'm', choices: [], usage: CHAT_USAGE }, '[DONE]'])));
  assert.equal(t.usage.sawUsage, true);
  assert.equal(t.usage.input, 20);
  const j = createOpenAIUsageTap({ wire: 'responses' });
  j.jsonBody(Buffer.from(JSON.stringify({ model: 'gpt-5.1', usage: { input_tokens: 9, output_tokens: 2 } })));
  assert.deepEqual([j.usage.input, j.usage.output, j.usage.model], [9, 2, 'gpt-5.1']);
});
