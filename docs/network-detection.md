# Network Detection

`@rapid/llm-proxy` automatically detects whether it is running on a VPN/corporate network or the public internet, and adjusts provider routing accordingly.

![Network Routing](diagrams/network-routing.png)

## How It Works

There are two layers of network detection in this repo:

- **Inside the proxy process** — runs at startup (during `ProviderRegistry.initializeAll()`), results cached for 5 minutes. Decides which providers to initialize and what auto-route order to use.
- **Outside the proxy process** — the `bin/start-llm-proxy.sh` launchd wrapper probes the network *before* the bridge starts and conditionally exports `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` into the bridge's environment. This is the *only* way the bridge ever sees those env vars under launchd, because launchd does not inherit shell environment.

### In-process detection signals (ordered by priority)

1. **Environment variable override** — `LLM_NETWORK_MODE=corporate|public` skips all detection
2. **VPN tunnel interfaces** — checks for network interfaces matching `utun*`, `tun*`, `ppp*`, `wg*` patterns with routes to private IP ranges (RFC 1918 + RFC 6598)
3. **DNS probe** — if `LLM_VPN_PROBE_HOST` is set, resolves the hostname and checks if it returns a private IP

### Wrapper-script detection signals (`bin/start-llm-proxy.sh`)

The wrapper picks a verdict for the *next* bridge invocation in this order:

1. **Health-coordinator state** (authoritative). Reads `${HEALTH_COORDINATOR_URL}/health/state` (default `http://127.0.0.1:3034`) and checks `network.location`. Values `corporate` / `vpn` → inject proxy; `home` / `public` → leave env unset.
2. **Local px-proxy probe** (fallback). If the coordinator is unreachable, checks whether `px` is listening locally and can reach the configured upstream corporate proxy.
3. **PAC-host DNS probe** (last resort). Resolves `PAC_HOST` (no default: unset, the probe is skipped); if it resolves, fetch the PAC, regex-extract the first `PROXY` directive, export it.

This priority exists because the *statusline* and other tools read network location from the coordinator (`/health/state`) — the wrapper must not drift from that single source of truth. Local probes only fire as a fallback for cold-boot ordering before the coordinator's launchd job is up.

### Platform-Specific Detection

**macOS:**
- Checks `ifconfig` output for `utun<N>` interfaces with assigned IPs
- Falls back to `netstat -rn | grep utun` for private-range routes

**Linux:**
- Parses `ip route` output for `tun`, `ppp`, `wg` device routes to private ranges

**Other platforms:**
- Defaults to `public`

### Private IP Ranges

The following are considered private (indicating VPN):
- `10.0.0.0/8`
- `172.16.0.0/12`
- `192.168.0.0/16`
- `100.64.0.0/10` (CGNAT — used by some VPN providers)

## Environment Variables

| Variable | Values | Description |
|----------|--------|-------------|
| `LLM_NETWORK_MODE` | `corporate`, `vpn`, `public` | Force network mode, skip auto-detection (`corporate` and `vpn` are aliases) |
| `LLM_VPN_PROBE_HOST` | hostname | DNS probe target (e.g. `vpn-gateway.corp.example.com`). If unset, only interface-based detection is used. |
| `HEALTH_COORDINATOR_URL` | URL | Wrapper-only. Default `http://127.0.0.1:3034`; the wrapper reads `network.location` from `/health/state` before each bridge start. |
| `PAC_HOST` | hostname | Wrapper-only. No default; used as the last-resort fallback when the coordinator is unreachable. |

## Effect on Provider Routing

When corporate/VPN is detected, three things happen:

### 1. Wrapper injects proxy env

`bin/start-llm-proxy.sh` exports `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` (extracted from the PAC) into the bridge's process environment. The bridge then routes all outbound HTTPS through `undici.ProxyAgent`.

### 2. Provider priority override

The `network_overrides.corporate` (or `network_overrides.vpn`) section from `config/llm-providers.yaml` replaces the default `provider_priority`:

| Mode | Typical priority |
|------|-----------------|
| **public** | claude-code → copilot → groq → openai → anthropic |
| **corporate/vpn** | claude-code → copilot                                |

On corporate, subscription providers that work through the corporate network (like Copilot via enterprise endpoint) are preferred. Claude Code stays available if its CLI can reach `auth.anthropic.com` through the corporate proxy.

### 3. External API providers skipped

On corporate, external API providers (`groq`, `openai`, `anthropic`, plus the npm-package-only `gemini` and `github-models`) are **not initialized** at all. Their `fetch()` calls would hang indefinitely in TCP `SYN_SENT` state because the corporate firewall blocks direct connections to public APIs. Even with timeouts, Node.js keeps TCP sockets alive after `Promise.race` rejects, leading to resource leaks.

The skipped providers are logged at startup:

```
[llm] corporate network detected — skipping unreachable providers: groq, openai, anthropic
```

## Provider Timeout Handling

For providers that are initialized but may be unreachable (e.g., network changed after startup):

- Each provider call has a hard timeout (default 120s, configurable per-request)
- Timeout errors are caught by the circuit breaker
- After `threshold` failures (default 5), the provider is circuit-broken with exponential backoff
- Auth errors (`AUTH_ERROR`) trip the circuit breaker immediately

## Proxy Bridge Network Detection

The proxy bridge (`proxy-bridge/server.mjs`) has its own lightweight network detection that checks `os.networkInterfaces()` for VPN interface patterns (`utun`, `tun`, `tap`, `ppp`, `wg`, `ipsec`, `gpd`, `pangp`). This is used for auto-routing decisions on the `/api/complete` endpoint.

## Caching

Both the npm package and bridge server cache the detected network mode for 5 minutes. To force re-detection:

```typescript
import { clearNetworkCache } from '@rapid/llm-proxy/dist/network-detect.js';
clearNetworkCache();
```

Or restart the process.
