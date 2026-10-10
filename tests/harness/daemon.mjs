/**
 * Boot the REAL proxy daemon (proxy-bridge/server.mjs) in a sandbox, against a
 * fake upstream.
 *
 * server.mjs listens on import and reads its world from the environment, so the
 * only way to exercise it whole is a child process with a curated env:
 *   - HOME, data dir and CODING_REPO all inside the sandbox — the daemon never
 *     sees the real ~/.local/share/opencode/auth.json, keychain-backed CLI, or
 *     the live token DB;
 *   - its own routing config (the shipped one routes through providers that
 *     need real credentials);
 *   - HTTPS_PROXY + NODE_EXTRA_CA_CERTS from startFakeUpstream, so every
 *     upstream call lands in the fake;
 *   - the health coordinator, classifier and claude CLI pointed at nothing, so
 *     no probe or warm-up reaches a real service.
 * Nothing from the parent env is inherited except PATH and CODING_SQLITE_BACKEND
 * (so the same run can exercise better-sqlite3 and node:sqlite).
 *
 *   const d = await startDaemon({ sandbox, upstream, env });
 *   await fetch(`${d.url}/v1/messages`, …);
 *   d.dataDir, d.logs(), await d.stop()
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(REPO, 'proxy-bridge', 'server.mjs');
// Unreachable on purpose: discard port, connection refused at once.
const NOWHERE = 'http://127.0.0.1:9';

const MODELS = (m) => ({ small: m, medium: m, high: m });

// Two providers: the Anthropic passthrough that /v1/messages requires, and one
// OpenAI-compatible provider for everything that goes through /api/complete.
export const SANDBOX_ROUTING = `version: 1
providers:
  claude-code-max:
    account: anthropic-subscription
    impl: claude-code
    fg_transport: anthropic-passthrough
    capabilities: { tools: false, streaming: true }
    available_models: [claude-sonnet-5]
    models: ${JSON.stringify(MODELS('claude-sonnet-5'))}
  openai:
    account: openai-api
    impl: openai
    capabilities: { tools: true, streaming: true }
    available_models: [gpt-4o-mini]
    models: ${JSON.stringify(MODELS('gpt-4o-mini'))}
defaults:
  fg-chat: { provider: openai, complexity: medium }
  background: { provider: openai, complexity: small }
routes:
  fg-chat/claude: { provider: claude-code-max, complexity: high }
  fg-chat/pi: { provider: claude-code-max, complexity: high }
`;

export const SANDBOX_FALLBACK = `version: 1
chains: {}
retry_on: [provider_unavailable, network_error, timeout]
`;

// One pattern is enough to show the raw-body path redacts before it writes.
export const SANDBOX_REDACTION = {
  enabled: true,
  patterns: [{ id: 'test_secret', enabled: true, pattern: 'sk-test-[A-Za-z0-9]+', flags: 'g', replacement: '<SECRET_REDACTED>' }],
};

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

export async function startDaemon({ sandbox, upstream, env = {} }) {
  const dirs = {
    home: path.join(sandbox, 'home'),
    data: path.join(sandbox, 'data'),
    coding: path.join(sandbox, 'coding'),
    config: path.join(sandbox, 'config'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const routingPath = path.join(dirs.config, 'llm-routing.yaml');
  const fallbackPath = path.join(dirs.config, 'llm-fallback.yaml');
  const redactionPath = path.join(dirs.config, 'redaction-patterns.json');
  fs.writeFileSync(routingPath, SANDBOX_ROUTING);
  fs.writeFileSync(fallbackPath, SANDBOX_FALLBACK);
  fs.writeFileSync(redactionPath, JSON.stringify(SANDBOX_REDACTION));

  const port = await freePort();
  const childEnv = {
    PATH: process.env.PATH,
    ...(process.env.CODING_SQLITE_BACKEND ? { CODING_SQLITE_BACKEND: process.env.CODING_SQLITE_BACKEND } : {}),
    HOME: dirs.home,
    TZ: 'UTC',
    LSL_TIMEZONE: 'UTC',
    LLM_PROXY_PORT: String(port),
    LLM_PROXY_DATA_DIR: dirs.data,
    CODING_REPO: dirs.coding,
    LLM_PROXY_ROUTING_PATH: routingPath,
    LLM_PROXY_FALLBACK_PATH: fallbackPath,
    LLM_PROXY_REDACTION_CONFIG: redactionPath,
    LLM_PROXY_USER_HASH: 'tester',
    HTTPS_PROXY: upstream.proxyUrl,
    NO_PROXY: '127.0.0.1,localhost',
    NODE_EXTRA_CA_CERTS: upstream.caPath,
    HEALTH_COORDINATOR_URL: NOWHERE,
    CLASSIFIER_BASE_URL: NOWHERE,
    QWEN_LAPTOP_API_BASE_URL: NOWHERE,
    QWEN_LOCAL_API_BASE_URL: NOWHERE,
    LLM_CORPORATE_PROXY_URL: NOWHERE,
    CLAUDE_CLI_PATH: path.join(dirs.home, 'no-claude-cli'),
    LLM_EGRESS_RECHECK_MS: '3600000',
    LLM_PROXY_FORWARD_ATTEMPTS: '1',
    LLM_PROXY_DRAIN_MS: '500',
    OPENAI_API_KEY: 'sk-test-openai',
    ...env,
  };

  const out = [];
  const child = spawn(process.execPath, [SERVER], { cwd: dirs.coding, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (c) => out.push(c.toString()));
  child.stderr.on('data', (c) => out.push(c.toString()));
  const exited = new Promise((resolve) => child.once('exit', resolve));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`daemon exited during boot:\n${out.join('')}`);
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok && out.join('').includes('Providers initialized')) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`daemon not ready after 20s:\n${out.join('')}`); }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    url,
    dataDir: dirs.data,
    logs: () => out.join(''),
    stop: async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await exited; } },
  };
}
