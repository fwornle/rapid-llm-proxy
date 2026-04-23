#!/usr/bin/env node
/**
 * LLM Proxy Bridge — Direct HTTP + CLI Edition
 *
 * HTTP server running on the HOST that provides LLM completions to Docker containers.
 *
 * Provider routing:
 *   - copilot: Direct HTTP to GitHub Copilot API (OpenAI-compatible endpoint)
 *   - claude-code: Shells out to `claude` CLI with Max OAuth (personal subscription)
 *
 * Previous design used @github/copilot-sdk (JSON-RPC → copilot-cli subprocess) and
 * @anthropic-ai/claude-agent-sdk (subprocess spawn). Both are full agent frameworks
 * that add 30-180s of overhead per request. This version:
 *   - copilot: single HTTP POST (~2-5s)
 *   - claude-code: claude CLI -p mode (~10-15s, but uses personal Max subscription)
 *
 * Auth:
 *   - copilot: OAuth tokens from ~/.local/share/opencode/auth.json (written by OpenCode)
 *   - claude-code: OAuth token from macOS keychain (managed by claude CLI)
 *
 * CRITICAL: ANTHROPIC_API_KEY must NOT be passed to the claude CLI subprocess,
 * otherwise it uses the (depleted) API key instead of the Max OAuth subscription.
 *
 * Usage:
 *   node llm-proxy.mjs                  # default port 8089
 *   LLM_PROXY_PORT=9000 node llm-proxy.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PORT = parseInt(process.env.LLM_PROXY_PORT || '8089', 10);

const log = (...args) => process.stdout.write(`[llm-proxy] ${args.join(' ')}\n`);
const logErr = (...args) => process.stderr.write(`[llm-proxy] ${args.join(' ')}\n`);

// --- Proxy-Aware Fetch ---

/**
 * Node.js native fetch() does not honor HTTPS_PROXY. In corporate environments
 * (like BMW), all external HTTPS traffic must go through the corporate proxy.
 * We use undici's ProxyAgent to create a proxy-aware fetch function.
 */
let proxyFetch = globalThis.fetch;

const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (httpsProxy) {
  try {
    const undici = await import('undici');
    const dispatcher = new undici.ProxyAgent(httpsProxy);
    // Use undici's own fetch — Node's globalThis.fetch may not honour `dispatcher`
    proxyFetch = (url, init = {}) => undici.fetch(url, { ...init, dispatcher });
    log(`Using HTTPS proxy: ${httpsProxy}`);
  } catch (err) {
    logErr(`Failed to load undici ProxyAgent: ${err.message}. External HTTPS calls may fail.`);
  }
} else {
  log('No HTTPS_PROXY set, using direct fetch');
}

// --- VPN / Corporate Network Detection ---

/**
 * Detect if running inside a VPN/corporate network.
 * Checks for common VPN tunnel interfaces (utun*, tun*, ppp*).
 * Result is cached for 5 minutes.
 */
let cachedNetworkMode = null;
let networkModeCheckedAt = 0;

function detectNetworkMode() {
  const now = Date.now();
  if (cachedNetworkMode && (now - networkModeCheckedAt) < 300_000) return cachedNetworkMode;

  const interfaces = os.networkInterfaces();
  const vpnPatterns = /^(utun|tun|tap|ppp|wg|ipsec|gpd|pangp)/i;
  const hasVpn = Object.keys(interfaces).some(name => vpnPatterns.test(name));

  cachedNetworkMode = hasVpn ? 'vpn' : 'public';
  networkModeCheckedAt = now;
  log(`Network mode: ${cachedNetworkMode} (interfaces: ${Object.keys(interfaces).filter(n => vpnPatterns.test(n)).join(', ') || 'none'})`);
  return cachedNetworkMode;
}

// --- Auth Token Management (Copilot) ---

const AUTH_FILE = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');

/**
 * OAuth token state — loaded from OpenCode's auth.json.
 */
let copilotAuth = {
  oauthToken: null,
  enterpriseUrl: null,
  lastLoaded: 0,
};

/**
 * Copilot API base URL — derived from auth.json enterpriseUrl.
 * Enterprise: https://copilot-api.bmw.ghe.com
 * Public:     https://api.githubcopilot.com
 */
let copilotApiBaseUrl = null;

/**
 * Load raw OAuth token from OpenCode's auth.json.
 * Re-reads the file at most every 60 seconds to pick up token refreshes.
 */
function loadCopilotOAuth() {
  const now = Date.now();
  if (copilotAuth.oauthToken && (now - copilotAuth.lastLoaded) < 60_000) {
    return copilotAuth;
  }

  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf8');
    const auth = JSON.parse(raw);

    const enterprise = auth['github-copilot-enterprise'];
    const public_ = auth['github-copilot'];
    const entry = enterprise || public_;

    if (!entry?.refresh) {
      throw new Error('No OAuth token found in auth.json');
    }

    copilotAuth = {
      oauthToken: entry.refresh,
      enterpriseUrl: entry.enterpriseUrl || null,
      lastLoaded: now,
    };

    return copilotAuth;
  } catch (err) {
    logErr(`Failed to load Copilot auth token: ${err.message}`);
    return copilotAuth;
  }
}

/**
 * Get Copilot credentials for direct API calls.
 * Enterprise Copilot: use refresh token directly as Bearer against copilot-api.${enterpriseUrl}
 * Public Copilot:     use refresh token directly as Bearer against api.githubcopilot.com
 *
 * No token exchange needed — the OAuth refresh token works directly as a Bearer token
 * on the Copilot chat completions endpoint.
 */
function getCopilotCredentials() {
  const auth = loadCopilotOAuth();
  if (!auth.oauthToken) {
    throw new Error('AUTH_ERROR: No Copilot OAuth token available. Run `opencode` to authenticate.');
  }

  // Derive API base URL from enterpriseUrl (if present)
  if (auth.enterpriseUrl) {
    copilotApiBaseUrl = `https://copilot-api.${auth.enterpriseUrl}`;
  } else {
    copilotApiBaseUrl = 'https://api.githubcopilot.com';
  }

  return {
    token: auth.oauthToken,
    apiBaseUrl: copilotApiBaseUrl,
  };
}

// --- Claude CLI Configuration ---

const CLAUDE_CLI = process.env.CLAUDE_CLI_PATH || '/opt/homebrew/bin/claude';

/**
 * Build a clean env for the claude CLI subprocess.
 * CRITICAL: removes ANTHROPIC_API_KEY to force OAuth/Max subscription usage.
 */
function buildClaudeEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

// --- Provider State ---

const providers = {
  'anthropic': { available: false, method: 'http' },
  'claude-code': { available: false, method: 'cli' },
  'copilot': { available: false, method: 'http' },
};

// --- Model Mapping ---

/**
 * Map provider-specific model names to API/CLI model names.
 * Copilot uses full model names; Claude CLI uses short aliases.
 * Anthropic uses full model names with date suffixes.
 */
const ANTHROPIC_MODEL_MAP = {
  'sonnet': 'claude-sonnet-4-20250514',
  'haiku': 'claude-haiku-4-20250414',
  'opus': 'claude-opus-4-20250514',
  'claude-sonnet-4.6': 'claude-sonnet-4-20250514',
  'claude-haiku-4.5': 'claude-haiku-4-20250414',
  'claude-opus-4.6': 'claude-opus-4-20250514',
};

function resolveAnthropicModel(model) {
  return ANTHROPIC_MODEL_MAP[model] || model;
}

const COPILOT_MODEL_MAP = {
  'sonnet': 'claude-sonnet-4.6',
  'haiku': 'claude-haiku-4.5',
  'opus': 'claude-opus-4.6',
};

const CLAUDE_MODEL_MAP = {
  'sonnet': 'sonnet',
  'haiku': 'haiku',
  'opus': 'opus',
  // Full names → short aliases for CLI
  'claude-sonnet-4.6': 'sonnet',
  'claude-haiku-4.5': 'haiku',
  'claude-opus-4.6': 'opus',
};

function resolveCopilotModel(model) {
  return COPILOT_MODEL_MAP[model] || model;
}

function resolveClaudeModel(model) {
  return CLAUDE_MODEL_MAP[model] || model;
}

// --- Copilot: Direct HTTP Completion ---

/**
 * Complete via direct HTTP to the Copilot API (OpenAI-compatible endpoint).
 * Single HTTP POST, ~2-5s for typical prompts.
 */
async function completeCopilot(body) {
  const creds = getCopilotCredentials();

  const model = resolveCopilotModel(body.model || 'claude-sonnet-4.6');
  const timeoutMs = body.timeout || 120_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const requestBody = {
    model,
    messages: body.messages || [],
    max_tokens: body.maxTokens || 4096,
    stream: false,
  };

  if (body.temperature !== undefined) {
    requestBody.temperature = body.temperature;
  }
  if (body.responseFormat) {
    requestBody.response_format = body.responseFormat;
  }

  try {
    const response = await proxyFetch(`${creds.apiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'opencode/1.0',
        'Openai-Intent': 'conversation-edits',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      let errMsg;
      try {
        const errJson = JSON.parse(errBody);
        errMsg = errJson.error?.message || errJson.error || errBody;
      } catch {
        errMsg = errBody;
      }

      if (response.status === 401 || response.status === 403) {
        copilotAuth.lastLoaded = 0; // Force re-read of auth.json on next request
        throw new Error(`AUTH_ERROR: Copilot API returned ${response.status}: ${errMsg}`);
      }
      if (response.status === 429) {
        throw new Error(`QUOTA_EXHAUSTED: Copilot API rate limited: ${errMsg}`);
      }
      throw new Error(`Copilot API error (${response.status}): ${errMsg}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || {};

    return {
      content,
      model: data.model || model,
      tokens: {
        input: usage.prompt_tokens || 0,
        output: usage.completion_tokens || 0,
        total: usage.total_tokens || 0,
      },
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Copilot API timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

// --- Anthropic Direct API Completion ---

/**
 * Complete via the Anthropic Messages API directly using ANTHROPIC_API_KEY.
 * No CLI subprocess, no concurrency limits, ~2-5s per request.
 */
async function completeAnthropic(body) {
  const messages = body.messages || [];
  const model = resolveAnthropicModel(body.model || 'haiku');
  const maxTokens = body.maxTokens || body.max_tokens || 4096;
  const temperature = body.temperature ?? 0.3;

  // Separate system prompt from messages
  let system = body.systemPrompt || body.system_prompt || '';
  const apiMessages = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      system = system || msg.content;
    } else {
      apiMessages.push({ role: msg.role, content: msg.content });
    }
  }

  // Ensure at least one user message
  if (apiMessages.length === 0) {
    if (body.prompt) {
      apiMessages.push({ role: 'user', content: body.prompt });
    } else {
      throw new Error('No messages or prompt provided');
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const requestBody = {
    model,
    max_tokens: maxTokens,
    messages: apiMessages,
    ...(system ? { system } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  };

  const timeoutMs = body.timeout || 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await proxyFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => 'unknown error');
      const err = new Error(`Anthropic API ${resp.status}: ${errText}`);
      if (resp.status === 401 || resp.status === 403) err.retryable = false;
      if (resp.status === 429 || resp.status === 529) err.retryable = true;
      throw err;
    }

    const data = await resp.json();
    // Extract text from content blocks
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    return {
      text,
      model: data.model,
      usage: data.usage ? {
        input_tokens: data.usage.input_tokens,
        output_tokens: data.usage.output_tokens,
      } : undefined,
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Anthropic API timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

// --- Claude Code: CLI Completion ---

/**
 * Complete via the `claude` CLI in non-interactive mode.
 * Spawns: claude -p <prompt> --output-format json --model <model> --tools "" [--system-prompt <sp>]
 *
 * Uses the user's Claude Max OAuth subscription (personal, unlimited usage).
 * ~10-15s per call (CLI startup overhead), but the API call itself is ~2-5s.
 */
async function completeClaudeCode(body) {
  const messages = body.messages || [];
  const model = resolveClaudeModel(body.model || 'sonnet');
  const timeoutMs = body.timeout || 120_000;

  // Extract system prompt and user prompt from messages
  const systemParts = [];
  const userParts = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
    } else if (m.role === 'assistant') {
      userParts.push(`Assistant: ${m.content}`);
    } else {
      userParts.push(m.content);
    }
  }

  const userPrompt = userParts.join('\n\n');
  const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : null;

  if (!userPrompt) {
    throw new Error('No user message provided');
  }

  const args = [
    '-p', userPrompt,
    '--output-format', 'json',
    '--model', model,
    '--tools', '',               // Disable tools — just a completion
    '--no-session-persistence',  // Don't save ingestion sessions
  ];

  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }

  try {
    const { stdout, stderr } = await execFileAsync(CLAUDE_CLI, args, {
      timeout: timeoutMs,
      env: buildClaudeEnv(),
      maxBuffer: 10 * 1024 * 1024, // 10MB for large responses
    });

    if (stderr) {
      log(`claude-code: stderr: ${stderr.trim().slice(0, 200)}`);
    }

    const output = JSON.parse(stdout);

    if (output.is_error) {
      const errMsg = output.result || 'Unknown CLI error';
      if (errMsg.toLowerCase().includes('credit balance') || errMsg.toLowerCase().includes('rate limit')) {
        throw new Error(`QUOTA_EXHAUSTED: ${errMsg}`);
      }
      if (errMsg.toLowerCase().includes('not logged in') || errMsg.toLowerCase().includes('login')) {
        throw new Error(`AUTH_ERROR: ${errMsg}`);
      }
      throw new Error(`Claude CLI error: ${errMsg}`);
    }

    // Extract token usage from modelUsage (more accurate) or top-level usage
    let inputTokens = output.usage?.input_tokens || 0;
    let outputTokens = output.usage?.output_tokens || 0;

    if (output.modelUsage) {
      const modelEntry = Object.values(output.modelUsage)[0];
      if (modelEntry) {
        inputTokens = modelEntry.inputTokens + (modelEntry.cacheReadInputTokens || 0) + (modelEntry.cacheCreationInputTokens || 0);
        outputTokens = modelEntry.outputTokens;
      }
    }

    return {
      content: output.result,
      model: Object.keys(output.modelUsage || {})[0] || model,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        total: inputTokens + outputTokens,
      },
    };
  } catch (err) {
    const msg = err.message || String(err);

    // execFile timeout
    if (msg.includes('ETIMEDOUT') || msg.includes('killed') || msg.includes('SIGTERM')) {
      throw new Error(`Claude CLI timed out after ${timeoutMs}ms`);
    }

    // Re-throw typed errors as-is
    if (msg.includes('QUOTA_EXHAUSTED') || msg.includes('AUTH_ERROR') || msg.includes('Claude CLI error')) {
      throw err;
    }

    throw new Error(`Claude CLI failed: ${msg}`);
  }
}

// --- Initialize ---

async function initProviders() {
  // Initialize Copilot (direct HTTP with OAuth token — no token exchange)
  try {
    const creds = getCopilotCredentials();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await proxyFetch(`${creds.apiBaseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'User-Agent': 'opencode/1.0',
        'Openai-Intent': 'conversation-edits',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (response.ok) {
      providers.copilot.available = true;
      log(`copilot: initialized (direct HTTP → ${creds.apiBaseUrl})`);
    } else {
      logErr(`copilot: model list failed: HTTP ${response.status}`);
    }
  } catch (err) {
    logErr(`copilot: initialization failed: ${err.message}`);
  }

  // Initialize Anthropic (direct HTTP API)
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const response = await proxyFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-20250414',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.ok || response.status === 200) {
        providers.anthropic.available = true;
        log(`anthropic: initialized (direct HTTP API, key: ${process.env.ANTHROPIC_API_KEY.slice(0, 10)}...)`);
      } else {
        const errText = await response.text().catch(() => '');
        logErr(`anthropic: API check returned HTTP ${response.status}: ${errText.slice(0, 200)}`);
        // Still mark as available if we got a structured error (means API key is valid, just request issue)
        if (response.status === 400 || response.status === 429) {
          providers.anthropic.available = true;
          log(`anthropic: marked available despite ${response.status} (API key works)`);
        }
      }
    } catch (err) {
      logErr(`anthropic: initialization failed: ${err.message}`);
    }
  } else {
    log(`anthropic: ANTHROPIC_API_KEY not set, skipping`);
  }

  // Initialize Claude Code (CLI)
  try {
    const { stdout } = await execFileAsync(CLAUDE_CLI, ['auth', 'status'], {
      timeout: 10_000,
      env: buildClaudeEnv(),
    });

    const authStatus = JSON.parse(stdout);
    if (authStatus.loggedIn) {
      providers['claude-code'].available = true;
      log(`claude-code: initialized (CLI → ${authStatus.authMethod || 'unknown'} auth, subscription: ${authStatus.subscriptionType || 'unknown'})`);
    } else {
      log(`claude-code: CLI not authenticated`);
    }
  } catch (err) {
    logErr(`claude-code: CLI check failed: ${err.message}`);
    log(`claude-code: expected CLI at: ${CLAUDE_CLI}`);
  }
}

// --- HTTP Server ---

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    // Re-check copilot auth on health check
    const auth = loadCopilotOAuth();
    providers.copilot.available = !!auth.oauthToken;

    // Don't re-check claude CLI on every health check (expensive subprocess)
    // It was checked at init time

    const status = {};
    for (const [name, info] of Object.entries(providers)) {
      status[name] = { available: info.available, method: info.method };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      mode: 'direct-http+cli',
      networkMode: detectNetworkMode(),
      providers: status,
    }));
  }

  if (req.method === 'POST' && req.url === '/api/complete') {
    let rawBody = '';
    for await (const chunk of req) rawBody += chunk;

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }

    // Auto-route: if no provider specified, pick first available
    // VPN/corporate: copilot > anthropic/groq/openai (claude-code CLI unavailable on VPN)
    // Public:        copilot > claude-code > anthropic/groq/openai
    let providerName = body.provider;
    if (!providerName) {
      const networkMode = detectNetworkMode();
      const preferenceOrder = networkMode === 'vpn'
        ? ['copilot', 'anthropic', 'openai', 'groq']           // claude-code blocked on VPN
        : ['copilot', 'claude-code', 'anthropic', 'openai', 'groq'];
      providerName = preferenceOrder.find(p => providers[p]?.available);
      if (providerName) {
        log(`auto-route [${networkMode}]: selected ${providerName}`);
      }
    }
    const providerInfo = providers[providerName];

    if (!providerInfo) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `Unknown provider: ${providerName}. Available: ${Object.entries(providers).filter(([,v]) => v.available).map(([k]) => k).join(', ') || 'none'}` }));
    }

    if (!providerInfo.available) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `Provider ${providerName} not available. Available: ${Object.entries(providers).filter(([,v]) => v.available).map(([k]) => k).join(', ') || 'none'}`, type: 'PROVIDER_UNAVAILABLE' }));
    }

    const startTime = Date.now();

    try {
      log(`${providerName}: model=${body.model || 'default'} messages=${body.messages?.length || 0} method=${providerInfo.method}`);

      let result;
      if (providerName === 'claude-code') {
        result = await completeClaudeCode(body);
      } else if (providerName === 'anthropic') {
        result = await completeAnthropic(body);
      } else {
        result = await completeCopilot(body);
      }

      const latencyMs = Date.now() - startTime;
      log(`${providerName}: completed in ${latencyMs}ms model=${result.model} tokens=${result.tokens.total}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        content: result.content,
        provider: providerName,
        model: result.model,
        tokens: result.tokens,
        latencyMs,
      }));
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const msg = err.message || String(err);
      logErr(`${providerName}: error after ${latencyMs}ms: ${msg}`);

      // Map errors to appropriate HTTP status codes
      if (msg.includes('QUOTA_EXHAUSTED') || msg.toLowerCase().includes('rate limit')) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: msg, type: 'QUOTA_EXHAUSTED' }));
      }
      if (msg.includes('AUTH_ERROR') || msg.toLowerCase().includes('unauthorized')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: msg, type: 'AUTH_ERROR' }));
      }

      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: msg, type: 'API_ERROR' }));
    }
  }

  // --- RaaS Job Proxy ---
  // Proxies RaaS job lookups through the host-side `raas-api` CLI,
  // which handles AWS SSO + SigV4 auth automatically.
  // Docker container (OKB backend) forwards here via host.docker.internal.
  const raasMatch = req.url?.match(/^\/raas-job\/([0-9a-f-]{36})$/i);
  if (req.method === 'GET' && raasMatch) {
    const uuid = raasMatch[1];
    log(`raas-job: fetching job ${uuid}`);

    try {
      // Resolve RAPID_HOME: env var > sibling in workspace > legacy path
      const rapidHome = process.env.RAPID_HOME
        || (() => {
          // Try to find rapid-toolkit relative to this script's location
          const scriptDir = path.dirname(new URL(import.meta.url).pathname);
          const candidate = path.resolve(scriptDir, '..', '..', 'rapid-toolkit');
          if (fs.existsSync(path.join(candidate, 'bin', 'raas-api'))) return candidate;
          return path.join(os.homedir(), 'code', 'po-automations', 'integrations', 'rapid-toolkit');
        })();
      const raasApiBin = path.join(rapidHome, 'bin', 'raas-api');

      const { stdout, stderr } = await execFileAsync(raasApiBin, ['job', uuid], {
        timeout: 30_000,
        env: { ...process.env, RAPID_HOME: rapidHome, PATH: `${rapidHome}/bin:${process.env.PATH}` },
      });

      if (stderr) {
        log(`raas-job: stderr: ${stderr.trim()}`);
      }

      // raas-api outputs JSON
      let data;
      try {
        data = JSON.parse(stdout);
      } catch {
        // May output non-JSON (e.g. auth prompt) — return as text
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(stdout);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    } catch (err) {
      const rawMsg = err.message || String(err);
      // stderr from the CLI often contains the useful info
      const stderr = err.stderr || '';

      // Try to extract clean error from Python traceback or CLI output
      let cleanError = rawMsg;
      // Look for RuntimeError or HTTP error at end of traceback
      const rtMatch = rawMsg.match(/RuntimeError:\s*(.+?)(?:\n|$)/);
      const httpMatch = rawMsg.match(/HTTP\s+(\d+):\s*(\{.+\})/);
      if (httpMatch) {
        try {
          const apiErr = JSON.parse(httpMatch[2]);
          cleanError = apiErr.error || apiErr.message || httpMatch[2];
        } catch {
          cleanError = rtMatch?.[1] || rawMsg.slice(-500);
        }
      } else if (rtMatch) {
        cleanError = rtMatch[1];
      }

      logErr(`raas-job: error for ${uuid}: ${cleanError}`);

      if (rawMsg.includes('ENOENT')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'raas-api CLI not found. Ensure RAPID_HOME is set.' }));
      }

      // Propagate upstream HTTP status codes
      if (rawMsg.includes('HTTP 404') || cleanError.includes('does not exist')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: cleanError }));
      }
      if (rawMsg.includes('HTTP 401') || rawMsg.includes('HTTP 403')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: cleanError, hint: 'Run: raas-api auth' }));
      }

      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: cleanError }));
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// --- Startup ---

async function main() {
  log('Initializing providers...');
  await initProviders();

  // Watch auth file for changes (token refresh by OpenCode)
  try {
    fs.watch(path.dirname(AUTH_FILE), (eventType, filename) => {
      if (filename === 'auth.json') {
        copilotAuth.lastLoaded = 0; // Force re-read on next request
        copilotSession = { token: null, apiBaseUrl: null, expiresAt: 0 }; // Invalidate session
        log('auth.json changed, will re-read on next request');
      }
    });
  } catch {
    // fs.watch may not work on all platforms — non-fatal
  }

  server.listen(PORT, '0.0.0.0', () => {
    log(`Listening on http://0.0.0.0:${PORT}`);
    log(`Docker: LLM_CLI_PROXY_URL=http://host.docker.internal:${PORT}`);
  });
}

// Graceful shutdown
process.on('SIGINT', () => {
  log('Shutting down...');
  server.close();
  process.exit(0);
});

main().catch(err => {
  logErr(`Fatal: ${err.message}`);
  process.exit(1);
});
