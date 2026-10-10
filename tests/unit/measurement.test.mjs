/**
 * proxy-bridge/measurement.mjs — the parts the daemon characterisation
 * (tests/daemon-characterisation.test.mjs) cannot reach from the outside:
 * SSE frames split across network chunks, and the binding rules on their own.
 * Needs `npm run build` (measurement.mjs imports ../dist).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'measurement-unit-'));
process.env.LLM_PROXY_DATA_DIR = dataDir;
const {
  createAnthropicUsageTap, adapterUserHash, bindTapTaskId, bindShimTaskId, bindCompleteTaskId, safeSanitizeTaskId,
} = await import('../../proxy-bridge/measurement.mjs');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const enc = new TextEncoder();
const frame = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;

test('usage tap reads SSE frames split at arbitrary chunk boundaries', () => {
  const text = frame({ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } })
    + frame({ type: 'message_delta', usage: { output_tokens: 8 } });
  for (const size of [1, 7, 64, text.length]) {
    const tap = createAnthropicUsageTap({ captureRaw: true });
    for (let i = 0; i < text.length; i += size) tap.sseChunk(enc.encode(text.slice(i, i + size)));
    assert.deepEqual(
      { ...tap.usage },
      { input: 5, output: 8, cacheRead: 3, cacheWrite: 2, sawUsage: true, rawResponse: text },
      `chunk size ${size}`,
    );
  }
});

test('usage tap keeps no raw text unless asked, and ignores non-JSON bodies', () => {
  const tap = createAnthropicUsageTap();
  tap.jsonBody(Buffer.from('<html>bad gateway</html>'));
  assert.equal(tap.usage.sawUsage, false);
  assert.equal(tap.usage.rawResponse, '');
});

test('tap binding: header wins; no header and no per-agent span → neutral', () => {
  fs.writeFileSync(path.join(dataDir, 'active-measurement.json'), JSON.stringify({ task_id: 'global', started_at: new Date().toISOString() }));
  try {
    assert.equal(bindTapTaskId({ hdrTaskId: 'run-1', agent: 'claude' }), 'run-1');
    assert.equal(bindTapTaskId({ hdrTaskId: '', agent: 'claude' }), '');
    const errs = [];
    assert.equal(bindTapTaskId({ hdrTaskId: 'bad id!', agent: 'claude', logErr: (m) => errs.push(m) }), 'global');
    assert.equal(errs.length, 1);
  } finally {
    fs.rmSync(path.join(dataDir, 'active-measurement.json'));
  }
});

test('shim binding precedence and /api/complete background guard', () => {
  assert.equal(bindShimTaskId({ hdrTaskId: 'h', bodyTaskId: 'b', pathTaskId: 'p' }), 'h');
  assert.equal(bindShimTaskId({ hdrTaskId: '', bodyTaskId: 'b', pathTaskId: 'p' }), 'b');
  assert.equal(bindShimTaskId({ hdrTaskId: '', bodyTaskId: '', pathTaskId: 'p' }), 'p');
  assert.equal(safeSanitizeTaskId('bad id!'), '');
  fs.writeFileSync(path.join(dataDir, 'active-measurement.json'), JSON.stringify({ task_id: 'global', started_at: new Date().toISOString() }));
  try {
    assert.equal(bindCompleteTaskId({}, 'observation-writer'), '');
    assert.equal(bindCompleteTaskId({}, 'mastra-chat'), 'global');
    assert.equal(bindCompleteTaskId({ task_id: 'explicit' }, 'observation-writer'), 'explicit');
  } finally {
    fs.rmSync(path.join(dataDir, 'active-measurement.json'));
  }
});

test('adapter user_hash: known agents keep their literals, others derive 6 chars', () => {
  assert.equal(adapterUserHash('claude'), 'cladpt');
  assert.equal(adapterUserHash('pi'), 'piadpt');
  assert.match(adapterUserHash('9-codegraph'), /^[a-z][a-z0-9]{5}$/);
});
