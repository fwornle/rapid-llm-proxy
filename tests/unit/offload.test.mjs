/**
 * offload.mjs — the opt-in offload of a measuring passthrough: config shape, the
 * caller's band, every gate of decide(), and the passthrough end to end against a
 * stub target and a stub upstream (offloaded / fallen back / off).
 *
 * Needs `npm run build` (measurement.mjs imports ../dist).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offload-'));
process.env.LLM_PROXY_DATA_DIR = dataDir;

const { initTokenDb } = await import('../../dist/token-usage.js');
const { createMeasurement } = await import('../../proxy-bridge/measurement.mjs');
const { handleOpenAIPassthrough } = await import('../../proxy-bridge/openai-passthrough.mjs');
const {
  normalizeOffloadConfig, callerBand, createOffloader, createTargetHealth, targetProviderId,
} = await import('../../proxy-bridge/offload.mjs');

const sse = (events) => events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
const USAGE = { prompt_tokens: 40, completion_tokens: 3, total_tokens: 43 };
const AGENT_AUTH = 'Bearer agent-login';
const TARGET_KEY = 'target-key';

let tokenDb; let measurement; let upstream; let target; let front;
let upstreamBase; let targetUrl; let frontUrl;
const upstreamSeen = [];
let upstreamSeq = 0; // the token DB dedups rows on the request id
const targetSeen = [];
const targetMode = { status: 200, delayMs: 0, verdict: 'small' };
let cfg;
let offloader; let health;

function chatAnswer(res, model, text, stream) {
  if (stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    return res.end(sse([
      { id: 'x', model, choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] },
      { id: 'x', model, choices: [], usage: USAGE },
      '[DONE]',
    ]));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'x', model, choices: [{ index: 0, message: { role: 'assistant', content: text } }], usage: USAGE }));
}

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));

before(async () => {
  tokenDb = initTokenDb(dataDir);
  measurement = createMeasurement({
    dataDir, tokenDb: () => tokenDb, redactRawBody: (s) => s, canonicalModel: (m) => m, log: () => {}, logErr: () => {},
  });
  upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    upstreamSeen.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
    const j = JSON.parse(body || '{}');
    upstreamSeq += 1;
    res.setHeader('x-request-id', `up-${upstreamSeq}`);
    chatAnswer(res, j.model, 'from upstream', j.stream === true);
  });
  target = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'm-small' }, { id: 'm-medium' }] }));
    }
    const j = JSON.parse(body || '{}');
    // The classifier's question: three tokens, the rubric as system prompt.
    if (j.max_tokens === 3) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: targetMode.verdict } }] }));
    }
    targetSeen.push({ url: req.url, headers: req.headers, body: j });
    if (targetMode.delayMs) await new Promise((r) => setTimeout(r, targetMode.delayMs));
    if (targetMode.status !== 200) {
      res.writeHead(targetMode.status, { 'content-type': 'application/json' });
      return res.end('{"error":"busy"}');
    }
    chatAnswer(res, j.model, 'from target', j.stream === true);
  });
  upstreamBase = await listen(upstream);
  targetUrl = `${await listen(target)}/v1`;

  cfg = normalizeOffloadConfig({
    enabled: true, agents: { opencode: true, copilot: true },
    target: { name: 'Team Box', url: targetUrl, models: { small: 'm-small', medium: 'm-medium' } },
    bands: ['small'], timeoutMs: 1500,
  });
  health = createTargetHealth({ fetch, getConfig: () => cfg, getKey: () => TARGET_KEY });
  await health.probe();
  offloader = createOffloader({ fetch, getConfig: () => cfg, getKey: () => TARGET_KEY, health });

  front = http.createServer((req, res) => {
    handleOpenAIPassthrough(req, res, {
      measurement, fetch, upstreamBase, provider: 'github-copilot', agent: req.headers['x-test-agent'] || 'copilot',
      taskId: '', project: 'p', attempts: 1, backoffMs: [0],
      offload: { offloader, getConfig: () => cfg },
    }).catch((e) => { res.writeHead(500); res.end(String(e)); });
  });
  frontUrl = await listen(front);
});

after(() => {
  for (const s of [upstream, target, front]) s.close();
  tokenDb.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const lastRow = () => tokenDb.db.prepare('SELECT * FROM token_usage ORDER BY rowid DESC LIMIT 1').get();
const post = (body, { agent = 'copilot' } = {}) => fetch(`${frontUrl}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: AGENT_AUTH, 'x-test-agent': agent, 'copilot-integration-id': 'cli' },
  body: JSON.stringify(body),
});
const easy = (extra = {}) => ({ model: 'claude-haiku-4.5', messages: [{ role: 'user', content: 'capital of Portugal?' }], ...extra });

test('config: unknown keys dropped, bounds applied, bad URL refused, off by default', () => {
  const c = normalizeOffloadConfig({ enabled: 'yes', agents: { claude: true, pi: true }, target: { url: 'ftp://x' }, maxInputTokens: 1e9, sneaky: 1 });
  assert.equal(c.enabled, false);
  assert.deepEqual(c.agents, { opencode: false, pi: true, copilot: false });
  assert.equal(c.target.url, '');
  assert.equal(c.maxInputTokens, 200_000);
  assert.equal('sneaky' in c, false);
  assert.deepEqual(normalizeOffloadConfig({}).bands, ['small']);
  assert.equal(targetProviderId('Team Box!'), 'team-box');
});

test('caller band: reasoning effort first, else the tier of the model the agent picked', () => {
  assert.deepEqual(callerBand('chat', { model: 'claude-opus-5', reasoning_effort: 'low' }), { band: 'small', source: 'caller' });
  assert.deepEqual(callerBand('responses', { model: 'x', reasoning: { effort: 'high' } }), { band: 'high', source: 'caller' });
  assert.equal(callerBand('chat', { model: 'gpt-5-mini' }).band, 'small');
  assert.equal(callerBand('chat', { model: 'claude-haiku-4.5' }).band, 'small');
  assert.equal(callerBand('chat', { model: 'claude-sonnet-5' }).band, 'medium');
  assert.equal(callerBand('chat', { model: 'claude-opus-5' }).band, 'high');
});

test('decide: every gate keeps the call and says why', async () => {
  const at = (patch, input = {}) => {
    const c = normalizeOffloadConfig({ ...cfg, ...patch });
    const o = createOffloader({ fetch, getConfig: () => c, health });
    return o.decide({ agent: 'copilot', wire: 'chat', body: easy(), ...input });
  };
  assert.equal((await at({ enabled: false })).reason, 'offload off');
  assert.equal((await at({}, { agent: 'claude' })).reason, 'claude is not offloadable');
  assert.equal((await at({}, { agent: 'pi' })).reason, 'offload off for pi');
  assert.match((await at({}, { wire: 'responses' })).reason, /Responses API/);
  assert.equal((await at({ target: { ...cfg.target, url: 'http://elsewhere:1/v1' } })).reason, 'Team Box not reachable');
  const looped = easy({ messages: [{ role: 'user', content: 'x' }, { role: 'tool', tool_call_id: 't', content: 'r' }] });
  assert.equal((await at({}, { body: looped })).reason, 'turn carries tool results — its first call was not seen');
  assert.equal((await at({}, { body: easy({ model: 'claude-sonnet-5' }) })).reason, 'band medium not offloaded');
  const big = easy({ messages: [{ role: 'user', content: 'x'.repeat(20_000) }] });
  assert.match((await at({}, { body: big })).reason, /input tokens > 3000/);
  const ok = await at({});
  assert.equal(ok.offload, true);
  assert.equal(ok.model, 'm-small');
});

const callRead = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] };
const readResult = { role: 'tool', tool_call_id: 'c1', content: 'file contents' };
/** The same turn, one tool hop later: what the agent sends after running the tool. */
const loopOf = (first) => ({ ...first, messages: [...first.messages, callRead, readResult] });

test('turn band: a loop call follows its offloaded first call to the target, as band source "turn"', async () => {
  const o = createOffloader({ fetch, getConfig: () => cfg, health });
  const first = easy({ messages: [{ role: 'user', content: 'capital of Portugal? (turn band offloaded)' }] });
  const d1 = await o.decide({ agent: 'copilot', wire: 'chat', body: first });
  assert.equal(d1.offload, true);
  assert.equal(d1.bandSource, 'model');
  // The loop call declares a medium-tier model: without the turn's record it
  // would be judged medium and kept. It inherits instead.
  const d2 = await o.decide({ agent: 'copilot', wire: 'chat', body: { ...loopOf(first), model: 'claude-sonnet-5' } });
  assert.equal(d2.offload, true);
  assert.equal(d2.band, 'small');
  assert.equal(d2.bandSource, 'turn');
  assert.equal(d2.model, 'm-small');
  assert.equal(o.counters.inherited, 1);
});

test('turn band: a loop call stays on the provider when its first call did', async () => {
  const o = createOffloader({ fetch, getConfig: () => cfg, health });
  const first = easy({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'capital of Portugal? (turn band kept)' }] });
  assert.equal((await o.decide({ agent: 'copilot', wire: 'chat', body: first })).reason, 'band medium not offloaded');
  // A small-tier model on the loop call must not pull the turn onto the target mid-way.
  const d2 = await o.decide({ agent: 'copilot', wire: 'chat', body: { ...loopOf(first), model: 'claude-haiku-4.5' } });
  assert.equal(d2.offload, false);
  assert.equal(d2.reason, 'turn carries tool results — its first call stayed on the provider (band medium not offloaded)');
});

test('turn band: the remaining gates still apply to a loop call', async () => {
  const o = createOffloader({ fetch, getConfig: () => cfg, health });
  const first = easy({ messages: [{ role: 'user', content: 'capital of Portugal? (turn band size)' }] });
  assert.equal((await o.decide({ agent: 'copilot', wire: 'chat', body: first })).offload, true);
  const bigLoop = loopOf(first);
  bigLoop.messages = [...bigLoop.messages.slice(0, -1), { ...readResult, content: 'x'.repeat(20_000) }];
  assert.match((await o.decide({ agent: 'copilot', wire: 'chat', body: bigLoop })).reason, /input tokens > 3000/);
});

test('turn band: a fresh prompt after an earlier tool turn is a new turn, judged on its own', async () => {
  const o = createOffloader({ fetch, getConfig: () => cfg, health });
  const later = easy({
    messages: [
      { role: 'user', content: 'read the README (turn band later)' }, callRead, readResult,
      { role: 'assistant', content: 'It is a proxy.' }, { role: 'user', content: 'capital of Portugal?' },
    ],
  });
  const d = await o.decide({ agent: 'copilot', wire: 'chat', body: later });
  assert.equal(d.offload, true);
  assert.equal(d.bandSource, 'model');
});

test('turn band: a target failure moves the rest of the turn to the provider', async () => {
  const first = easy({ messages: [{ role: 'user', content: 'capital of Portugal? (turn band fallback)' }] });
  targetMode.status = 503;
  try {
    assert.equal((await (await post(first)).json()).choices[0].message.content, 'from upstream');
  } finally { targetMode.status = 200; }
  upstreamSeen.length = 0;
  await (await post(loopOf(first))).text();
  assert.equal(upstreamSeen.length, 1, 'the loop call went to the provider, not back to the failing target');
  assert.match(JSON.parse(lastRow().attempt_trail).offloadSkipped, /first call stayed on the provider \(Team Box failed: HTTP 503/);
});

test('session: an offloaded session promoted by a medium turn stays on the provider for later small turns', async () => {
  const o = createOffloader({ fetch, getConfig: () => cfg, health });
  const t1 = [{ role: 'user', content: 'capital of Portugal? (session promotion)' }];
  assert.equal((await o.decide({ agent: 'copilot', wire: 'chat', body: easy({ messages: t1 }) })).offload, true);
  const t2 = [...t1, { role: 'assistant', content: 'Lisbon.' }, { role: 'user', content: 'now refactor the router' }];
  assert.equal((await o.decide({ agent: 'copilot', wire: 'chat', body: easy({ model: 'claude-sonnet-5', messages: t2 }) })).reason,
    'band medium not offloaded');
  assert.equal(o.counters.promoted, 1);
  const t3 = [...t2, { role: 'assistant', content: 'Done.' }, { role: 'user', content: 'and of Spain?' }];
  const d3 = await o.decide({ agent: 'copilot', wire: 'chat', body: easy({ messages: t3 }) });
  assert.equal(d3.offload, false);
  assert.equal(d3.bandSource, 'session');
  assert.equal(d3.reason, 'session promoted to the provider at turn 2 (band medium)');
  // ...and its tool loop follows the turn's first call onto the provider.
  const d3loop = await o.decide({ agent: 'copilot', wire: 'chat', body: loopOf(easy({ messages: t3 })) });
  assert.match(d3loop.reason, /first call stayed on the provider \(session promoted/);
});

test('session: a session that started on the provider is still offloaded when a later turn is small', async () => {
  const o = createOffloader({ fetch, getConfig: () => cfg, health });
  const t1 = [{ role: 'user', content: 'refactor the router (session never offloaded)' }];
  assert.equal((await o.decide({ agent: 'copilot', wire: 'chat', body: easy({ model: 'claude-sonnet-5', messages: t1 }) })).offload, false);
  const t2 = [...t1, { role: 'assistant', content: 'Done.' }, { role: 'user', content: 'capital of Portugal?' }];
  assert.equal((await o.decide({ agent: 'copilot', wire: 'chat', body: easy({ messages: t2 }) })).offload, true);
});

test('offloaded: the target answers with its own key; the agent login never reaches it', async () => {
  upstreamSeen.length = 0; targetSeen.length = 0;
  const r = await post(easy({ stream: true }));
  const text = await r.text();
  assert.match(text, /from target/);
  assert.equal(upstreamSeen.length, 0, 'the agent provider was not called');
  const t = targetSeen.at(-1);
  assert.equal(t.headers.authorization, `Bearer ${TARGET_KEY}`);
  assert.equal(t.headers['copilot-integration-id'], undefined);
  assert.equal(t.body.model, 'm-small');
  const row = lastRow();
  assert.equal(row.provider, 'team-box');
  assert.equal(row.offloaded_from, 'github-copilot');
  assert.equal(row.route_band, 'small');
  assert.equal(row.route_key, 'fg-chat/copilot');
});

test('target error before the first byte: the held original goes to the agent provider unchanged', async () => {
  upstreamSeen.length = 0;
  targetMode.status = 503;
  try {
    const r = await post(easy());
    assert.equal((await r.json()).choices[0].message.content, 'from upstream');
  } finally { targetMode.status = 200; }
  assert.equal(upstreamSeen.length, 1);
  assert.equal(upstreamSeen[0].headers.authorization, AGENT_AUTH);
  assert.equal(upstreamSeen[0].body.model, 'claude-haiku-4.5');
  const row = lastRow();
  assert.equal(row.provider, 'github-copilot');
  assert.equal(row.offloaded_from, '');
  assert.match(JSON.parse(row.attempt_trail).attempts[0].error, /HTTP 503/);
});

test('target too slow: the budget runs out and the call falls back', async () => {
  upstreamSeen.length = 0;
  targetMode.delayMs = 2500;
  try {
    const r = await post(easy());
    assert.equal((await r.json()).choices[0].message.content, 'from upstream');
  } finally { targetMode.delayMs = 0; }
  assert.match(JSON.parse(lastRow().attempt_trail).attempts[0].error, /no answer within 1500 ms/);
});

test('classifier: a medium-tier first turn judged small is offloaded and counted', async () => {
  const saved = cfg;
  cfg = normalizeOffloadConfig({ ...cfg, classifier: true });
  try {
    await (await post(easy({ model: 'claude-sonnet-5' }))).text();
  } finally { cfg = saved; }
  const row = lastRow();
  assert.equal(row.provider, 'team-box');
  assert.equal(row.band_source, 'classifier');
  assert.equal(offloader.counters.downgraded, 1);
});

test('kept on its provider: the reason is on the row; an agent left off gets no route columns', async () => {
  await (await post(easy({ model: 'claude-opus-5' }))).text();
  assert.equal(JSON.parse(lastRow().attempt_trail).offloadSkipped, 'band high not offloaded');
  await (await post(easy(), { agent: 'pi' })).text();
  const row = lastRow();
  assert.equal(row.route_key, '');
  assert.equal(row.attempt_trail, '');
});
