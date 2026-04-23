# rapid-llm-proxy

Unified LLM abstraction layer for AI-powered applications. Routes inference requests to the best available provider — GitHub Copilot, Claude Code CLI, Groq, OpenAI, or Anthropic. Detects VPN/corporate networks and adapts routing automatically. Works as an npm package (Node.js) or HTTP bridge server (any language, Docker).

## Architecture

![Architecture Overview](docs/diagrams/architecture-overview.png)

The proxy runs on the **host machine** and provides two integration modes:

- **npm package** — `import { LLMService } from '@rapid/llm-proxy'` for Node.js applications
- **HTTP bridge** — `POST /api/complete` for Docker containers, Python, Shell, or any language

![Deployment Topology](docs/diagrams/deployment.png)

## Provider Chain

Requests are auto-routed through the provider chain based on availability and network mode:

```
On public network:  copilot → claude-code → groq → openai → anthropic
On VPN/corporate:   copilot → claude-code  (API providers excluded)
```

![Network-Adaptive Routing](docs/diagrams/network-routing.png)

## Quick Start

```bash
# Install
npm install @rapid/llm-proxy          # from npm (once published)
npm install ./rapid-llm-proxy-1.0.0.tgz  # from local tarball
```

### npm Package (Node.js)

```javascript
import { LLMService } from '@rapid/llm-proxy';

const llm = new LLMService();
await llm.initialize();

const { text, provider } = await llm.complete({
  messages: [{ role: 'user', content: 'Summarize this document' }]
});

console.log(`${provider}: ${text}`);
```

### HTTP Bridge (Docker / any language)

Start on the host:

```bash
LLM_PROXY_PORT=12435 node node_modules/@rapid/llm-proxy/dist/proxy-bridge/server.mjs
```

Call from a Docker container:

```bash
curl -s http://host.docker.internal:12435/api/complete \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}' | jq .text
```

Docker Compose setup:

```yaml
services:
  my-app:
    environment:
      LLM_PROXY_URL: http://host.docker.internal:12435
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

### Health Check

```bash
curl -s http://localhost:12435/health | jq
# → { "status": "ok", "networkMode": "vpn", "providers": { "copilot": { "available": true } } }
```

## Request Flow

![Request Flow](docs/diagrams/request-flow.png)

1. Consumer sends `POST /api/complete` with `messages` array
2. If `provider` is omitted, auto-route selects best available based on VPN detection
3. Selected provider builds the request (model mapping, auth headers)
4. For corporate networks: CONNECT tunnel through `HTTPS_PROXY`
5. Response returned with provider metadata (model, latency, token usage)

## Configuration

Place `config/llm-providers.yaml` in your project root:

```yaml
providers:
  copilot:
    type: copilot
    auth_file: ~/.local/share/opencode/auth.json
  claude-code:
    type: claude-code
  groq:
    type: groq
    env_key: GROQ_API_KEY
  openai:
    type: openai
    env_key: OPENAI_API_KEY
  anthropic:
    type: anthropic
    env_key: ANTHROPIC_API_KEY

provider_priority: [copilot, claude-code, groq, openai, anthropic]

network_overrides:
  vpn:
    provider_priority: [copilot, claude-code]
    disabled_providers: [groq, openai, anthropic]
  public:
    provider_priority: [copilot, claude-code, groq, openai, anthropic]
```

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `LLM_PROXY_PORT` | `12435` | Bridge server port |
| `LLM_NETWORK_MODE` | auto-detect | Force `vpn` or `public` |
| `LLM_VPN_PROBE_HOST` | — | Hostname for VPN detection probe |
| `HTTPS_PROXY` | — | Corporate proxy for CONNECT tunnel |
| `GROQ_API_KEY` | — | Groq API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |

## Features

- **Multi-provider support** — Copilot, Claude Code CLI, Groq, OpenAI, Anthropic
- **Network-aware auto-routing** — VPN/corporate detection adapts provider chain automatically
- **Zero-dependency CONNECT tunnel** — corporate proxy support using built-in Node.js `http`/`https`
- **No token exchange** — Enterprise Copilot uses OAuth token directly (no intermediate exchange)
- **Provider init timeout + abort** — 10s timeout with AbortController prevents socket leaks
- **Model mapping** — provider-agnostic model names (`sonnet`, `fast`) mapped per provider
- **Streaming support** — Server-Sent Events for real-time responses

## Documentation

- [Architecture](docs/architecture.md) — component diagrams, data flow, design decisions
- [Integration Guide](docs/integration-guide.md) — step-by-step setup for host and Docker
- [Configuration](docs/configuration.md) — YAML config reference
- [Providers](docs/providers.md) — per-provider setup, auth, env vars, models
- [Proxy Bridge](docs/proxy-bridge.md) — Docker/container HTTP bridge
- [Network Detection](docs/network-detection.md) — VPN/corporate detection and adaptive routing

## Tests

```bash
# Unit/integration tests (38 mock tests)
node --test tests/integration-bridge.test.mjs

# Live smoke test (requires running proxy)
node --test tests/integration-bridge.test.mjs -- --smoke
```

## License

MIT
