/**
 * Optional providers (proxy-bridge/providers/*.mjs): a deployment-only provider
 * such as a corporate gateway lives in a module of its own, which the daemon
 * loads at startup. With the module the provider is available and routable;
 * without it the daemon boots and serves as before, and llm-routing.local.yaml
 * adds the provider's config next to llm-routing.yaml.
 *
 * Needs `npm run build` (server.mjs imports ../dist) and the openssl CLI.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeUpstream } from './harness/fake-upstream.mjs';
import { startDaemon, SANDBOX_FALLBACK } from './harness/daemon.mjs';

const ECHO = `export default ({ log }) => ({
  impl: 'echo', method: 'http',
  init() { log('echo: initialized'); return true; },
  async complete(body) {
    const last = body.messages.at(-1).content;
    return { content: 'echo:' + last, model: body.model, tokens: { input: 3, output: 2, total: 5 } };
  },
});
`;
const BASE = `version: 1
providers:
  openai:
    account: openai-api
    impl: openai
    capabilities: { tools: true, streaming: true }
    available_models: [gpt-4o-mini]
    models: { small: gpt-4o-mini, medium: gpt-4o-mini, high: gpt-4o-mini }
defaults:
  fg-chat: { provider: openai, complexity: medium }
  background: { provider: echo-gw, complexity: small }
`;
const LOCAL = `version: 1
providers:
  echo-gw:
    account: echo-account
    impl: echo
    capabilities: { tools: false, streaming: false }
    available_models: [echo-1]
    models: { small: echo-1, medium: echo-1, high: echo-1 }
`;

let sandbox; let upstream;
before(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-modules-'));
  upstream = await startFakeUpstream({
    dir: path.join(sandbox, 'upstream'),
    respond: (r) => (r.host === 'api.openai.com' && r.path === '/v1/chat/completions' ? { body: {
      id: 'c1', model: 'gpt-4o-mini', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    } } : null),
  });
});
after(async () => {
  await upstream?.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function configIn(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'llm-routing.yaml'), BASE);
  fs.writeFileSync(path.join(dir, 'llm-routing.local.yaml'), LOCAL);
  fs.writeFileSync(path.join(dir, 'llm-fallback.yaml'), SANDBOX_FALLBACK);
  return { LLM_PROXY_ROUTING_PATH: path.join(dir, 'llm-routing.yaml'), LLM_PROXY_FALLBACK_PATH: path.join(dir, 'llm-fallback.yaml') };
}

test('a provider module is loaded, reported by /health and routed to from llm-routing.local.yaml', async () => {
  const providersDir = path.join(sandbox, 'with', 'providers');
  fs.mkdirSync(providersDir, { recursive: true });
  fs.writeFileSync(path.join(providersDir, 'echo.mjs'), ECHO);
  const d = await startDaemon({
    sandbox: path.join(sandbox, 'with'), upstream,
    env: { ...configIn(path.join(sandbox, 'with', 'cfg')), LLM_PROXY_PROVIDERS_DIR: providersDir },
  });
  try {
    const health = await (await fetch(`${d.url}/health`)).json();
    assert.deepEqual(health.providers.echo, { available: true, method: 'http' });
    const r = await fetch(`${d.url}/api/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ process: 'observation-writer', messages: [{ role: 'user', content: 'ping' }] }),
    });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.content, 'echo:ping');
    assert.equal(body.provider, 'echo-gw');
  } finally {
    await d.stop();
  }
});

test('without the module the daemon boots and serves; the provider is just unavailable', async () => {
  const d = await startDaemon({
    sandbox: path.join(sandbox, 'without'), upstream,
    env: { ...configIn(path.join(sandbox, 'without', 'cfg')), LLM_PROXY_PROVIDERS_DIR: path.join(sandbox, 'without', 'no-providers') },
  });
  try {
    const health = await (await fetch(`${d.url}/health`)).json();
    assert.equal(health.providers.echo, undefined);
    assert.equal(health.providers.openai.available, true);
    // The OpenAI-compatible shim names the account that answered, so a forwarder
    // in front of this proxy (glass's relay) records it instead of "the proxy".
    const r = await fetch(`${d.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }] }),
    });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(r.headers.get('x-llm-provider'), 'openai');
  } finally {
    await d.stop();
  }
});
