/**
 * token_usage.project — the repo a call was made for.
 *
 * coding's launcher sends the project id (x-project header, or /p/<id> for
 * copilot); background callers send body.project. The column must exist on a
 * fresh DB AND appear on an existing one, and only a single path-safe id may
 * land in it: a path or a header with junk in it records '' rather than
 * failing the call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { initTokenDb, logCall, sanitizeProject } from '../../dist/token-usage.js';

function withDataDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-project-'));
  const prev = process.env.LLM_PROXY_DATA_DIR;
  process.env.LLM_PROXY_DATA_DIR = dir;
  try { return fn(dir); } finally {
    if (prev === undefined) delete process.env.LLM_PROXY_DATA_DIR; else process.env.LLM_PROXY_DATA_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const row = (extra) => ({
  timestamp: new Date().toISOString(), provider: 'anthropic', model: 'claude-test',
  process: 'token-adapter-claude', subscription: 'x', input_tokens: 1, output_tokens: 1,
  total_tokens: 2, latency_ms: 1, prompt_preview: '', tokens_estimated: 0, ...extra,
});

test('a recorded project lands; an absent one reads back as ""', () => {
  withDataDir(() => {
    const h = initTokenDb();
    logCall(h, row({ project: 'a2a-xpr', tool_call_id: 'r1' }));
    logCall(h, row({ tool_call_id: 'r2' }));
    const got = h.db.prepare('SELECT tool_call_id, project FROM token_usage ORDER BY tool_call_id').all();
    assert.deepEqual(got.map((r) => r.project), ['a2a-xpr', '']);
    h.db.close();
  });
});

test('an existing DB without the column gains it, old rows read ""', () => {
  withDataDir((dir) => {
    const h = initTokenDb();
    logCall(h, row({ tool_call_id: 'old' }));
    h.db.exec('DROP INDEX idx_token_usage_project');
    h.db.exec('ALTER TABLE token_usage DROP COLUMN project');
    h.db.close();

    const h2 = initTokenDb();
    const cols = h2.db.prepare('PRAGMA table_info(token_usage)').all().map((c) => c.name);
    assert.ok(cols.includes('project'));
    assert.equal(h2.db.prepare("SELECT project FROM token_usage WHERE tool_call_id='old'").get().project, '');
    const idx = h2.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_token_usage_project'").get();
    assert.ok(idx, 'per-project index exists');
    h2.db.close();
    assert.ok(fs.existsSync(dir));
  });
});

test('sanitizeProject keeps one path-safe id and nothing else', () => {
  assert.equal(sanitizeProject('coding'), 'coding');
  assert.equal(sanitizeProject(' rapid-llm-proxy '), 'rapid-llm-proxy');
  assert.equal(sanitizeProject('_work.x~1'), '_work.x~1');
  for (const bad of ['', '.', '..', '/Users/me/coding', 'a/b', 'a b', 'x\ny', 'x'.repeat(101), undefined, 42, null]) {
    assert.equal(sanitizeProject(bad), '', JSON.stringify(bad));
  }
});
