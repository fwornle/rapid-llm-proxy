# Integration Guide

Step-by-step setup for `@rapid/llm-proxy` in both host and Docker environments.

## npm Package (Host-Side)

### Install

```bash
# From npm registry (once published)
npm install @rapid/llm-proxy

# From local tarball
npm install ./vendor/rapid-llm-proxy-1.0.0.tgz
```

### Basic Usage

```typescript
import { LLMService, loadConfig } from '@rapid/llm-proxy';

// Load config from config/llm-providers.yaml
const config = await loadConfig();
const llm = new LLMService(config);
await llm.initialize();

// Simple completion
const result = await llm.complete({
  messages: [{ role: 'user', content: 'Summarize this document' }],
});
console.log(result.content);
console.log(`Provider: ${result.provider}, Model: ${result.model}, Tokens: ${result.tokens.total}`);
```

### Task-Based Routing

```typescript
// Route to the correct tier automatically based on task type
const result = await llm.completeForTask(
  'Extract the file paths from this git diff',
  'git_file_extraction',  // maps to 'fast' tier
);

// Or with explicit tier
const result = await llm.complete({
  messages: [{ role: 'user', content: 'Analyze this code deeply' }],
  tier: 'premium',
});
```

### Structured Output (Zod Validation)

```typescript
import { z } from 'zod';

const schema = z.object({
  summary: z.string(),
  topics: z.array(z.string()),
});

const result = await llm.complete({
  messages: [{ role: 'user', content: 'Summarize and extract topics from: ...' }],
  responseFormat: { type: 'json_object' },
  responseSchema: schema,
});

const parsed = schema.parse(JSON.parse(result.content));
```

### Dependency Injection

```typescript
// Budget control
llm.setBudgetTracker({
  canAfford: async (prompt, ctx) => true,
  recordCost: async (tokens, provider, meta) => { /* track spending */ },
});

// Sensitivity routing (routes sensitive content to local providers)
llm.setSensitivityClassifier({
  classify: async (content, ctx) => ({ isSensitive: content.includes('secret') }),
});

// Subscription quota tracking
import { SubscriptionQuotaTracker } from '@rapid/llm-proxy';
llm.setQuotaTracker(new SubscriptionQuotaTracker());
```

### Metrics

```typescript
const metrics = llm.getMetrics();
console.log(`Total calls: ${metrics.totalCalls}`);
console.log(`Cache hit rate: ${metrics.cache.hitRate}`);
console.log(`By provider:`, metrics.byProvider);
```

## HTTP Proxy Bridge (Docker)

The proxy bridge runs on the **host** and provides LLM completions to Docker containers over HTTP.

### Start the Server

```bash
# Via npx (if installed globally or in project)
npx llm-proxy

# Direct invocation
node node_modules/@rapid/llm-proxy/proxy-bridge/server.mjs

# Custom port
LLM_PROXY_PORT=12435 node node_modules/@rapid/llm-proxy/proxy-bridge/server.mjs

# Via launchd wrapper (recommended for macOS — auto-injects HTTPS_PROXY on VPN)
./bin/start-llm-proxy.sh
```

Default port: `8089`. The consumer project's launchd plist conventionally uses `12435`. The wrapper at `bin/start-llm-proxy.sh` is the right entry point under launchd because it probes the health coordinator (with PAC-host fallback) and injects `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` only when the host is currently on a corporate/VPN network — see [network-detection.md](network-detection.md).

### curl Examples

```bash
# Health check
curl http://localhost:8089/health

# Completion (auto-routes to best available provider)
curl -X POST http://localhost:8089/api/complete \
  -H 'Content-Type: application/json' \
  -d '{
    "messages": [{"role": "user", "content": "Hello, world"}],
    "maxTokens": 256
  }'

# Completion with explicit provider
curl -X POST http://localhost:8089/api/complete \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "copilot",
    "model": "claude-sonnet-4.6",
    "messages": [{"role": "user", "content": "Explain quicksort"}],
    "maxTokens": 1024
  }'
```

### Docker Compose

```yaml
services:
  app:
    build: .
    environment:
      - LLM_CLI_PROXY_URL=http://host.docker.internal:8089
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

The `LLM_CLI_PROXY_URL` environment variable tells the npm package to route requests through the bridge instead of calling providers directly. The `host.docker.internal` hostname resolves to the Docker host on both macOS and Linux.

### Docker-Side Usage (npm package in container)

When `LLM_CLI_PROXY_URL` is set, providers like `CopilotProvider` and `ClaudeCodeProvider` automatically detect they are in Docker and route through the proxy bridge:

```typescript
// Same code works in Docker — routing is automatic
import { LLMService, loadConfig } from '@rapid/llm-proxy';

const llm = new LLMService(await loadConfig());
await llm.initialize();

// This routes through http://host.docker.internal:8089/api/complete
const result = await llm.complete({
  messages: [{ role: 'user', content: 'Hello from Docker' }],
});
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROXY_PORT` | `8089` | Port for the proxy bridge HTTP server (launchd plist usually overrides to `12435`) |
| `LLM_PROXY_URL` | — | Proxy bridge URL (set in Docker containers, e.g. `http://host.docker.internal:12435`) |
| `LLM_NETWORK_MODE` | auto-detect | Force `corporate` (alias `vpn`) or `public` network mode |
| `LLM_PROXY_DATA_DIR` | `<cwd>/.data` | Base dir for the token-usage SQLite DB and JSON export |
| `LLM_PROXY_TOKEN_DB_PATH` | — | Absolute path override for the token-usage SQLite DB |
| `HEALTH_COORDINATOR_URL` | `http://127.0.0.1:3034` | Wrapper-only — single source of truth for network location |
| `LLM_VPN_PROBE_HOST` | — | Hostname for DNS-based VPN detection |
| `CLAUDE_CLI_PATH` | `/opt/homebrew/bin/claude` | Path to the `claude` CLI binary |
| `HTTPS_PROXY` | — | Corporate proxy URL for outbound HTTPS |
| `GROQ_API_KEY` | — | Groq API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `GOOGLE_API_KEY` | — | Google Gemini API key |
| `GITHUB_TOKEN` | — | GitHub token (for GitHub Models provider) |
| `SEMANTIC_ANALYSIS_TIER` | — | Force all requests to a specific tier |
| `SEMANTIC_ANALYSIS_PROVIDER` | — | Force a specific provider |
| `SEMANTIC_ANALYSIS_COST_MODE` | — | `budget` = use fast tier everywhere |

## Configuration File

Place `config/llm-providers.yaml` in your project root. The loader searches these paths in order:

1. `<cwd>/config/llm-providers.yaml`
2. `<cwd>/lib/llm/config/llm-providers.yaml`
3. Bundled config inside the npm package
4. Monorepo fallback paths

See [configuration.md](configuration.md) for the full YAML reference.
