# Providers

Per-provider documentation for `@rapid/llm-proxy`.

![Provider Routing](diagrams/provider-routing.png)

## Overview

Providers fall into three categories:

| Category | Providers | Auth | Cost |
|----------|-----------|------|------|
| **Subscription** | copilot, claude-code | OAuth tokens | Zero (included in subscription) |
| **API key** | groq, openai, anthropic, gemini, github-models | Environment variable | Per-token |
| **Local** | dmr, ollama | None | Zero (runs on your hardware) |
| **Utility** | proxy, mock | N/A | N/A |

### What the bridge actually serves

`POST /api/complete` on the proxy bridge currently routes to **five providers**: `copilot`, `claude-code`, `openai`, `groq`, `anthropic`. The remaining providers in this document (`gemini`, `github-models`, `dmr`, `ollama`, `proxy`, `mock`) are only reachable through the npm-package API. On a corporate/VPN network, only `copilot` and `claude-code` are initialized — `openai`/`groq`/`anthropic` are skipped because the corporate firewall blocks their endpoints (calls would hang in TCP `SYN_SENT` forever).

---

## Copilot (GitHub Copilot)

**Method:** Direct HTTP (OpenAI-compatible chat completions endpoint)
**Source:** `src/providers/copilot-provider.ts`

### Auth

Reads OAuth tokens from `~/.local/share/opencode/auth.json`, written by OpenCode. The file contains entries for enterprise and/or public GitHub Copilot:

```json
{
  "github-copilot-enterprise": {
    "refresh": "gho_xxxx...",
    "enterpriseUrl": "enterprise.example.com"
  },
  "github-copilot": {
    "refresh": "gho_xxxx..."
  }
}
```

Enterprise entry is preferred over public. The refresh token is used directly as a Bearer token — no token exchange is required.

### API Endpoints

- **Enterprise:** `https://copilot-api.<enterpriseUrl>/chat/completions`
- **Public (individual):** `https://api.individual.githubcopilot.com/chat/completions`

### Corporate Proxy (CONNECT Tunnel)

When `HTTPS_PROXY` is set, the provider establishes an HTTP CONNECT tunnel through the corporate proxy using only Node.js built-in `http`/`tls` modules (zero external dependencies). This is necessary in corporate environments where direct outbound HTTPS is blocked.

### Model Aliases

| Tier | Model |
|------|-------|
| fast | `claude-haiku-4.5` |
| standard | `claude-sonnet-4.6` |
| premium | `claude-opus-5` |

Short aliases (`sonnet`, `haiku`, `opus`) are mapped to full names automatically.

### Docker Behavior

In Docker (when `LLM_CLI_PROXY_URL` is set), the provider routes through the proxy bridge on the host, which has access to the auth tokens and corporate proxy.

### Timeout

Default: 120s. Configurable per-request via `request.timeout`.

---

## Claude Code

**Method:** CLI subprocess (`claude -p`)
**Source:** `src/providers/claude-code-provider.ts`

### Auth

Uses the `claude` CLI's own authentication, which stores an OAuth token in the macOS keychain. Managed by running `claude` interactively once to log in with a personal Claude Max subscription.

**Critical:** The `ANTHROPIC_API_KEY` environment variable is explicitly removed from the subprocess environment. If present, the CLI uses the API key (which may have a depleted balance) instead of the subscription.

### CLI Invocation

```
claude -p <prompt> --output-format json --model <model> --tools "" --no-session-persistence [--system-prompt <sp>]
```

Output is JSON with `result`, `usage`, `modelUsage`, `is_error` fields.

### Model Aliases

| Tier | CLI Model |
|------|-----------|
| fast | `haiku` |
| standard | `sonnet` |
| premium | `opus` |

### Limitations

- **Host-only:** The CLI requires access to the macOS keychain for auth. In Docker, requests route through the proxy bridge.
- **Concurrency:** Each call spawns a subprocess. Typical latency is 10-15s (CLI startup overhead), with the API call itself taking 2-5s.
- **CLI path:** Defaults to `/opt/homebrew/bin/claude`. Override with `CLAUDE_CLI_PATH`.

### Docker Behavior

Same as Copilot — when `LLM_CLI_PROXY_URL` is set, routes through the proxy bridge.

---

## Groq

**Method:** SDK (`groq-sdk`, optional dependency)
**Source:** `src/providers/groq-provider.ts`

### Auth

Set `GROQ_API_KEY` in environment.

### Model Aliases

| Tier | Model |
|------|-------|
| fast | `llama-3.1-8b-instant` |
| standard | `llama-3.3-70b-versatile` |
| premium | `openai/gpt-oss-120b` |

### Network

Requires public internet. Unreachable on VPN/corporate networks — automatically skipped during initialization when VPN is detected.

---

## OpenAI

**Method:** SDK (`openai`, optional dependency)
**Source:** `src/providers/openai-provider.ts`

### Auth

Set `OPENAI_API_KEY` in environment.

### Model Aliases

| Tier | Model |
|------|-------|
| fast | `gpt-4.1-mini` |
| standard | `gpt-4.1` |
| premium | `o4-mini` |

### Network

Requires public internet. Skipped on VPN.

---

## Anthropic

**Method:** SDK (`@anthropic-ai/sdk`, optional dependency)
**Source:** `src/providers/anthropic-provider.ts`

### Auth

Set `ANTHROPIC_API_KEY` in environment.

### Model Aliases

| Tier | Model |
|------|-------|
| fast | `claude-haiku-4-5` |
| standard | `claude-sonnet-5` |
| premium | `claude-opus-5` |

### Network

Requires public internet. Skipped on VPN.

---

## Gemini (Google)

**Method:** SDK (`@google/generative-ai`, optional dependency)
**Source:** `src/providers/gemini-provider.ts`

### Auth

Set `GOOGLE_API_KEY` in environment.

### Model Aliases

| Tier | Model |
|------|-------|
| fast | `gemini-2.5-flash` |
| standard | `gemini-2.5-flash` |
| premium | `gemini-2.5-pro` |

### Network

Requires public internet. Skipped on VPN.

---

## GitHub Models

**Method:** OpenAI-compatible HTTP
**Source:** `src/providers/github-models-provider.ts`

### Auth

Set `GITHUB_TOKEN` in environment.

### Base URL

`https://models.github.ai/inference/v1`

### Model Aliases

| Tier | Model |
|------|-------|
| fast | `gpt-4.1-mini` |
| standard | `gpt-4.1` |
| premium | `o4-mini` |

### Network

Requires public internet. Skipped on VPN.

---

## DMR (Docker Model Runner)

**Method:** HTTP (OpenAI-compatible)
**Source:** `src/providers/dmr-provider.ts`
**Local:** Yes

Connects to Docker Model Runner at `http://localhost:12434/engines/v1`. Uses local models like `ai/llama3.2` and `ai/qwen2.5-coder`. No API key required.

---

## Provider modules

A provider that only one deployment has — a corporate LLM gateway, say — is a module
in `proxy-bridge/providers/<name>.mjs` plus its config in
`config/llm-routing.local.yaml`, next to `llm-routing.yaml`.

- The module's default export takes `{ proxyFetch, log, logErr }` and returns
  `{ impl, method, init(), complete(body) }`. `init()` returns whether the provider is
  available (credentials present, for instance); `complete()` returns the same shape
  as every other leg: `{ content, model, tokens: { input, output, total }, toolCalls? }`.
- The proxy loads every module in that directory at startup
  (`LLM_PROXY_PROVIDERS_DIR` overrides the directory). Without the file the provider
  simply does not exist, and a route to it falls through its fallback chain.
- `llm-routing.local.yaml` holds `providers:` blocks only; they are added to those of
  `llm-routing.yaml` (a provider in both is a config error). Saving from the dashboard
  writes `llm-routing.yaml` only.

## Ollama

**Method:** HTTP
**Source:** `src/providers/ollama-provider.ts`
**Local:** Yes

Connects to a local Ollama instance. No API key required.

---

## Proxy

**Method:** HTTP
**Source:** `src/providers/proxy-provider.ts`

Routes requests through the proxy bridge server (default `http://localhost:12435`). The bridge handles network detection, provider failover, and subscription routing. Model is set to `auto` — the bridge selects the best available provider.

Configured via `LLM_CLI_PROXY_PORT` or `LLM_PROXY_URL` environment variables.

---

## Mock

**Method:** In-memory
**Source:** `src/providers/mock-provider.ts`
**Local:** Yes

Returns mock responses for testing. Activated by injecting a mock service via `llm.setMockService(service)`.
