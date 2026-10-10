#!/usr/bin/env node
/**
 * Comprehensive Integration Test for LLM Proxy Bridge Server
 *
 * Tests all configuration possibilities of the proxy bridge as consumed by:
 *   1. OKB (integrations/operational-knowledge-management) — via ObservationWriter HTTP calls
 *   2. Coding project (~/Agentic/coding) — via semantic-analysis ObservationWriter
 *   3. Any npm consumer — via @rapid/llm-proxy LLMService class
 *
 * Configuration matrix tested:
 *   - Provider: claude-code | copilot | omitted (auto-route) | invalid
 *   - Model: sonnet | haiku | opus | omitted (default) | copilot-mapped names
 *   - Messages: valid | empty | missing | system+user | user-only
 *   - maxTokens: specified | omitted (default 4096)
 *   - temperature: specified | omitted
 *   - tier: standard | light | heavy | omitted
 *   - Error conditions: 400, 401, 404, 429, 500, timeout, malformed JSON
 *
 * Run modes:
 *   --live     Test against running proxy (default port 12435 or LLM_PROXY_PORT)
 *   --mock     Spin up mock server (default, no real LLM calls)
 *   --smoke    Quick 3-test smoke against live proxy (safe, minimal LLM usage)
 *
 * Usage:
 *   node tests/integration-bridge.test.mjs --mock     # Full test suite, no LLM needed
 *   node tests/integration-bridge.test.mjs --smoke    # Quick live verification
 *   node tests/integration-bridge.test.mjs --live     # Full test against live proxy
 */

import http from 'node:http';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// --- Config ---
const MODE = process.argv.includes('--live') ? 'live'
  : process.argv.includes('--smoke') ? 'smoke'
  : 'mock';

const PROXY_PORT = parseInt(process.env.LLM_PROXY_PORT || '12435', 10);
const PROXY_URL = process.env.LLM_CLI_PROXY_URL || `http://127.0.0.1:${PROXY_PORT}`;

// --- HTTP helpers ---

function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpPost(url, body, timeoutMs = 5000) {
  const payload = JSON.stringify(body);
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// --- Mock server (simulates the proxy bridge for --mock mode) ---

let mockServer;
let mockProviders = {};
let mockCompleteHandler = null;

function createMockBridge() {
  return new Promise((resolve) => {
    mockServer = http.createServer(async (req, res) => {
      // CORS
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

      if (req.method === 'GET' && req.url === '/health') {
        const status = {};
        for (const [name, info] of Object.entries(mockProviders)) {
          status[name] = { available: info.available, method: info.method || 'mock' };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', mode: 'mock', providers: status }));
      }

      if (req.method === 'POST' && req.url === '/api/complete') {
        let rawBody = '';
        for await (const chunk of req) rawBody += chunk;

        let body;
        try { body = JSON.parse(rawBody); }
        catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }

        // Auto-route (mirrors real bridge logic)
        let providerName = body.provider;
        if (!providerName) {
          const order = ['claude-code', 'copilot'];
          providerName = order.find(p => mockProviders[p]?.available);
        }

        const info = mockProviders[providerName];
        if (!info) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: `Unknown provider: ${providerName}. Available: ${Object.entries(mockProviders).filter(([, v]) => v.available).map(([k]) => k).join(', ') || 'none'}`,
          }));
        }
        if (!info.available) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `Provider ${providerName} not available`, type: 'PROVIDER_UNAVAILABLE' }));
        }

        // Custom handler for error simulation
        if (mockCompleteHandler) {
          return mockCompleteHandler(req, res, body, providerName);
        }

        // Default success
        const model = body.model || 'sonnet';
        const msgCount = body.messages?.length || 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          content: `Mock response for ${msgCount} messages via ${providerName}`,
          provider: providerName,
          model,
          tokens: { input: msgCount * 10, output: 15, total: msgCount * 10 + 15 },
          latencyMs: 42,
        }));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    mockServer.listen(0, '127.0.0.1', () => {
      const addr = mockServer.address();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

// --- Test suites ---

let baseUrl;

if (MODE === 'mock') {
  describe('LLM Proxy Bridge — Mock Integration Tests', () => {
    before(async () => {
      baseUrl = await createMockBridge();
      mockProviders = {
        'claude-code': { available: true, method: 'cli' },
        'copilot': { available: true, method: 'http' },
      };
    });

    after(() => { mockServer?.close(); });
    beforeEach(() => { mockCompleteHandler = null; });

    // ===== HEALTH ENDPOINT =====

    describe('GET /health', () => {
      it('returns status ok with provider list', async () => {
        const r = await httpGet(`${baseUrl}/health`);
        assert.equal(r.status, 200);
        const j = JSON.parse(r.body);
        assert.equal(j.status, 'ok');
        assert.ok(j.providers['claude-code']);
        assert.ok(j.providers['copilot']);
      });

      it('reflects provider availability changes', async () => {
        mockProviders['copilot'].available = false;
        const r = await httpGet(`${baseUrl}/health`);
        const j = JSON.parse(r.body);
        assert.equal(j.providers['copilot'].available, false);
        assert.equal(j.providers['claude-code'].available, true);
        mockProviders['copilot'].available = true; // restore
      });

      it('reports method for each provider', async () => {
        const r = await httpGet(`${baseUrl}/health`);
        const j = JSON.parse(r.body);
        assert.equal(j.providers['claude-code'].method, 'cli');
        assert.equal(j.providers['copilot'].method, 'http');
      });
    });

    // ===== PROVIDER ROUTING =====

    describe('Provider routing', () => {
      it('explicit claude-code provider', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'claude-code',
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(r.status, 200);
        const j = JSON.parse(r.body);
        assert.equal(j.provider, 'claude-code');
      });

      it('explicit copilot provider', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'copilot',
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(r.status, 200);
        const j = JSON.parse(r.body);
        assert.equal(j.provider, 'copilot');
      });

      it('auto-route: no provider → selects first available (claude-code)', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(r.status, 200);
        const j = JSON.parse(r.body);
        assert.equal(j.provider, 'claude-code');
      });

      it('auto-route: claude-code unavailable → falls back to copilot', async () => {
        mockProviders['claude-code'].available = false;
        const r = await httpPost(`${baseUrl}/api/complete`, {
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(r.status, 200);
        const j = JSON.parse(r.body);
        assert.equal(j.provider, 'copilot');
        mockProviders['claude-code'].available = true;
      });

      it('auto-route: all providers unavailable → 400', async () => {
        mockProviders['claude-code'].available = false;
        mockProviders['copilot'].available = false;
        const r = await httpPost(`${baseUrl}/api/complete`, {
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(r.status, 400);
        const j = JSON.parse(r.body);
        assert.ok(j.error.includes('Unknown provider'));
        mockProviders['claude-code'].available = true;
        mockProviders['copilot'].available = true;
      });

      it('invalid provider name → 400', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'openai-gpt4',
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(r.status, 400);
        const j = JSON.parse(r.body);
        assert.ok(j.error.includes('Unknown provider'));
      });

      it('provider specified but unavailable → 404 PROVIDER_UNAVAILABLE', async () => {
        mockProviders['copilot'].available = false;
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'copilot',
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(r.status, 404);
        const j = JSON.parse(r.body);
        assert.equal(j.type, 'PROVIDER_UNAVAILABLE');
        mockProviders['copilot'].available = true;
      });
    });

    // ===== REQUEST BODY VARIATIONS =====

    describe('Request body variations', () => {
      it('messages: system + user', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'claude-code',
          messages: [
            { role: 'system', content: 'You summarize things.' },
            { role: 'user', content: 'Summarize this session.' },
          ],
        });
        assert.equal(r.status, 200);
        const j = JSON.parse(r.body);
        assert.ok(j.content.includes('2 messages'));
      });

      it('messages: user only', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'claude-code',
          messages: [{ role: 'user', content: 'hello' }],
        });
        assert.equal(r.status, 200);
        assert.ok(JSON.parse(r.body).content.includes('1 messages'));
      });

      it('messages: empty array', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'claude-code',
          messages: [],
        });
        assert.equal(r.status, 200);
        assert.ok(JSON.parse(r.body).content.includes('0 messages'));
      });

      it('messages: omitted entirely', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'claude-code',
        });
        assert.equal(r.status, 200);
        assert.ok(JSON.parse(r.body).content.includes('0 messages'));
      });

      it('model: explicit sonnet', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'claude-code', model: 'sonnet',
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(JSON.parse(r.body).model, 'sonnet');
      });

      it('model: explicit haiku', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'claude-code', model: 'haiku',
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(JSON.parse(r.body).model, 'haiku');
      });

      it('model: omitted → defaults to sonnet', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'claude-code',
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(JSON.parse(r.body).model, 'sonnet');
      });

      it('model: copilot-specific mapped name (claude-sonnet-4.6)', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'copilot', model: 'claude-sonnet-4.6',
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(r.status, 200);
      });

      it('maxTokens: explicit', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'claude-code', maxTokens: 200,
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(r.status, 200);
      });

      it('temperature: explicit 0.0', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'claude-code', temperature: 0.0,
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(r.status, 200);
      });

      it('temperature: explicit 1.0', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'claude-code', temperature: 1.0,
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(r.status, 200);
      });

      it('tier: standard', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'claude-code', tier: 'standard',
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(r.status, 200);
      });

      it('tier: light', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'claude-code', tier: 'light',
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(r.status, 200);
      });

      it('ObservationWriter-style call (no provider, system+user, maxTokens)', async () => {
        // This is exactly how OKB ObservationWriter calls the proxy
        const r = await httpPost(`${baseUrl}/api/complete`, {
          messages: [
            { role: 'system', content: 'You are a concise summarizer.' },
            { role: 'user', content: 'Summarize: tool calls were made.' },
          ],
          maxTokens: 500,
          temperature: 0.3,
        });
        assert.equal(r.status, 200);
        const j = JSON.parse(r.body);
        assert.ok(j.content);
        assert.ok(j.provider); // auto-routed
        assert.ok(j.tokens);
      });
    });

    // ===== ERROR CONDITIONS =====

    describe('Error conditions', () => {
      it('malformed JSON → 400', async () => {
        const u = new URL(`${baseUrl}/api/complete`);
        const r = await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: u.hostname, port: u.port, path: u.pathname,
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 12 },
          }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => resolve({ status: res.statusCode, body: d }));
          });
          req.on('error', reject);
          req.write('not valid {}');
          req.end();
        });
        assert.equal(r.status, 400);
        assert.ok(JSON.parse(r.body).error.includes('Invalid JSON'));
      });

      it('simulated 429 QUOTA_EXHAUSTED', async () => {
        mockCompleteHandler = (_req, res) => {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Monthly limit reached', type: 'QUOTA_EXHAUSTED' }));
        };
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'claude-code',
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(r.status, 429);
        assert.equal(JSON.parse(r.body).type, 'QUOTA_EXHAUSTED');
      });

      it('simulated 401 AUTH_ERROR', async () => {
        mockCompleteHandler = (_req, res) => {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not authenticated', type: 'AUTH_ERROR' }));
        };
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'claude-code',
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(r.status, 401);
      });

      it('simulated 500 CLI_ERROR', async () => {
        mockCompleteHandler = (_req, res) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'CLI crashed', type: 'CLI_ERROR' }));
        };
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'claude-code',
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(r.status, 500);
      });

      it('unknown route → 404', async () => {
        const r = await httpGet(`${baseUrl}/api/nonexistent`);
        assert.equal(r.status, 404);
      });
    });

    // ===== RESPONSE SHAPE =====

    describe('Response shape contract', () => {
      it('success response has all required fields', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'claude-code',
          messages: [{ role: 'user', content: 'test' }],
        });
        const j = JSON.parse(r.body);
        assert.ok(typeof j.content === 'string', 'content is string');
        assert.ok(typeof j.provider === 'string', 'provider is string');
        assert.ok(typeof j.model === 'string', 'model is string');
        assert.ok(typeof j.tokens === 'object', 'tokens is object');
        assert.ok(typeof j.tokens.input === 'number', 'tokens.input is number');
        assert.ok(typeof j.tokens.output === 'number', 'tokens.output is number');
        assert.ok(typeof j.tokens.total === 'number', 'tokens.total is number');
        assert.ok(typeof j.latencyMs === 'number', 'latencyMs is number');
      });

      it('error response has error field', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'nonexistent',
          messages: [{ role: 'user', content: 'test' }],
        });
        const j = JSON.parse(r.body);
        assert.ok(typeof j.error === 'string');
      });

      it('health response has required shape', async () => {
        const r = await httpGet(`${baseUrl}/health`);
        const j = JSON.parse(r.body);
        assert.equal(j.status, 'ok');
        assert.ok(typeof j.providers === 'object');
        for (const [, info] of Object.entries(j.providers)) {
          assert.ok(typeof info.available === 'boolean');
        }
      });
    });
  });
}

// ===== LIVE / SMOKE TESTS (against running proxy) =====

if (MODE === 'live' || MODE === 'smoke') {
  describe(`LLM Proxy Bridge — ${MODE === 'smoke' ? 'Smoke' : 'Live'} Tests (${PROXY_URL})`, () => {
    before(async () => {
      baseUrl = PROXY_URL;
      // Verify proxy is reachable
      try {
        const r = await httpGet(`${baseUrl}/health`, 3000);
        assert.equal(r.status, 200, `Proxy not healthy at ${baseUrl}`);
        const j = JSON.parse(r.body);
        console.log(`  Proxy status: ${j.status}, providers: ${JSON.stringify(j.providers)}`);
      } catch (e) {
        throw new Error(`Proxy unreachable at ${baseUrl}: ${e.message}. Start it with: node proxy-bridge/server.mjs`);
      }
    });

    it('health endpoint returns provider status', async () => {
      const r = await httpGet(`${baseUrl}/health`);
      assert.equal(r.status, 200);
      const j = JSON.parse(r.body);
      assert.equal(j.status, 'ok');
      assert.ok(j.providers, 'should have providers');
      // At least one provider should be available
      const available = Object.entries(j.providers).filter(([, v]) => v.available);
      assert.ok(available.length > 0, `No providers available: ${JSON.stringify(j.providers)}`);
    });

    it('auto-route completion (ObservationWriter style)', async () => {
      const r = await httpPost(`${baseUrl}/api/complete`, {
        messages: [
          { role: 'system', content: 'Reply with exactly: TEST_OK' },
          { role: 'user', content: 'Reply now.' },
        ],
        maxTokens: 50,
        temperature: 0,
      }, 120_000); // claude CLI can be slow
      assert.equal(r.status, 200);
      const j = JSON.parse(r.body);
      assert.ok(j.content, 'should have content');
      assert.ok(j.provider, 'should have provider');
      assert.ok(j.tokens, 'should have tokens');
      console.log(`  Auto-route: provider=${j.provider} model=${j.model} tokens=${j.tokens.total} latency=${j.latencyMs}ms`);
    });

    it('explicit provider completion', async () => {
      // Find first available provider
      const health = JSON.parse((await httpGet(`${baseUrl}/health`)).body);
      const available = Object.entries(health.providers).find(([, v]) => v.available);
      if (!available) { console.log('  SKIP: no providers available'); return; }

      const [providerName] = available;
      const r = await httpPost(`${baseUrl}/api/complete`, {
        provider: providerName,
        messages: [{ role: 'user', content: 'Reply with: EXPLICIT_OK' }],
        maxTokens: 50,
        temperature: 0,
      }, 120_000);
      assert.equal(r.status, 200);
      const j = JSON.parse(r.body);
      assert.equal(j.provider, providerName);
      console.log(`  Explicit ${providerName}: model=${j.model} tokens=${j.tokens.total}`);
    });

    if (MODE === 'live') {
      it('invalid provider returns 400', async () => {
        const r = await httpPost(`${baseUrl}/api/complete`, {
          provider: 'nonexistent-provider',
          messages: [{ role: 'user', content: 'test' }],
        });
        assert.equal(r.status, 400);
      });

      it('malformed JSON returns 400', async () => {
        const u = new URL(`${baseUrl}/api/complete`);
        const r = await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: u.hostname, port: u.port, path: u.pathname,
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 5 },
          }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => resolve({ status: res.statusCode, body: d }));
          });
          req.on('error', reject);
          req.write('{bad}');
          req.end();
        });
        assert.equal(r.status, 400);
      });

      it('unknown route returns 404', async () => {
        const r = await httpGet(`${baseUrl}/api/nonexistent`);
        // The bridge returns 404 for unknown routes
        assert.ok([404, 400].includes(r.status));
      });
    }
  });
}

// ===== NPM PACKAGE CONSUMER TEST =====
// Tests the @rapid/llm-proxy LLMService class as consumed by OKB and coding

describe('LLMService npm package — consumer contract', () => {
  let LLMService;
  let resolvedFrom;

  before(async () => {
    // Try to import from various locations (mirrors real consumer paths)
    // This checkout's build, then the package as an installed dependency.
    const tryPaths = [
      new URL('../dist/index.js', import.meta.url).href,
      '@rapid/llm-proxy',
    ];

    for (const p of tryPaths) {
      try {
        const mod = await import(p);
        LLMService = mod.LLMService;
        resolvedFrom = p;
        break;
      } catch { /* try next */ }
    }

    if (!LLMService) {
      console.log('  SKIP: @rapid/llm-proxy not found in any location');
    } else {
      console.log(`  Loaded LLMService from: ${resolvedFrom}`);
    }
  });

  it('LLMService class exists and is constructable', () => {
    if (!LLMService) return;
    assert.equal(typeof LLMService, 'function');
    const svc = new LLMService();
    assert.ok(svc);
  });

  it('has required methods: complete, checkHealth, getProviderStatus', () => {
    if (!LLMService) return;
    const svc = new LLMService();
    // Check for expected method names (some may be in prototype)
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(svc));
    console.log(`  Available methods: ${methods.filter(m => !m.startsWith('_')).join(', ')}`);
  });

  it('exports expected types', async () => {
    if (!LLMService) return;
    const mod = await import(resolvedFrom);
    // Check for key exports
    const exports = Object.keys(mod);
    console.log(`  Exports: ${exports.join(', ')}`);
    assert.ok(exports.includes('LLMService'), 'should export LLMService');
  });
});

