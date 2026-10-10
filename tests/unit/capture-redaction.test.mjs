/**
 * Context captures go through the redaction set before they are written —
 * the live and per-run context-breakdown snapshots and the context-turns lines,
 * on both wires. They carry previews of the system prompt, tool descriptions
 * and every message, so a secret pasted into a prompt would otherwise land on
 * disk verbatim (glass G6). Needs `npm run build` (measurement.mjs imports ../dist).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-redaction-'));
process.env.LLM_PROXY_DATA_DIR = dataDir;
const { initTokenDb } = await import('../../dist/token-usage.js');
const { createMeasurement } = await import('../../proxy-bridge/measurement.mjs');

const SECRET = 'sk-ant-api03-PASTEDINTOTHEPROMPT0123456789';
const redactRawBody = (s) => s.replace(/sk-ant-[\w-]{10,}/g, '<SECRET_REDACTED>');
let tokenDb; let measurement;

before(() => {
  tokenDb = initTokenDb(dataDir);
  measurement = createMeasurement({
    dataDir, tokenDb: () => tokenDb, redactRawBody, canonicalModel: (m) => m, log: () => {}, logErr: () => {},
  });
});

after(() => {
  tokenDb.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const usage = { sawUsage: true, input: 10, output: 2, cacheRead: 0, cacheWrite: 0 };
// The writes are fire-and-forget; give them a moment to land.
const settle = () => new Promise((r) => setTimeout(r, 300));

function assertRedacted(text, what) {
  assert.ok(!text.includes(SECRET), `${what} holds the secret verbatim`);
  assert.ok(text.includes('<SECRET_REDACTED>'), `${what} lost the redaction marker`);
}

test('anthropic wire: breakdowns and context turn are redacted before write', async () => {
  const reqJson = {
    model: 'claude-sonnet-5',
    system: [{ type: 'text', text: `system knows ${SECRET}` }],
    tools: [{ name: 't', description: `tool sees ${SECRET}`, input_schema: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: `my key is ${SECRET}` }],
  };
  measurement.captureAnthropicBreakdown({ reqJson, model: 'claude-sonnet-5', taskId: 'glass-r1', isSubagent: false });
  measurement.recordAnthropicTap({
    route: {}, model: 'claude-sonnet-5', reqJson, proc: 'p', agent: 'claude', project: 'x', requestId: 'r1',
    taskId: 'glass-r1', usage, latencyMs: 1, captureRaw: false,
  });
  await settle();
  assertRedacted(measurement.readBreakdown('glass-r1'), 'per-run breakdown');
  assertRedacted(measurement.readBreakdown(), 'live breakdown');
  assertRedacted(JSON.stringify(measurement.readContextTurns('glass-r1')), 'context turn');
});

test('openai wire: breakdown and context turn are redacted before write', async () => {
  const body = { model: 'gpt-5.1', messages: [{ role: 'system', content: `be careful ${SECRET}` }, { role: 'user', content: `key ${SECRET}` }] };
  measurement.captureOpenAIBreakdown({ oaBody: body, agent: 'opencode', taskId: 'glass-r2' });
  measurement.recordOpenAITap({
    provider: 'openai', wire: 'chat', body, proc: 'p', agent: 'opencode', project: 'x', requestId: 'r2',
    taskId: 'glass-r2', usage: { ...usage, model: 'gpt-5.1' }, latencyMs: 1, captureRaw: false,
  });
  await settle();
  assertRedacted(measurement.readBreakdown('glass-r2'), 'per-run breakdown');
  assertRedacted(JSON.stringify(measurement.readContextTurns('glass-r2')), 'context turn');
});
