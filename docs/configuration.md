# Configuration

YAML config reference for `@rapid/llm-proxy`. Place at `config/llm-providers.yaml` in your project root.

## Config File Search Order

The `loadConfig()` function searches these paths:

1. Custom path (if passed to `loadConfig(path)`)
2. `<cwd>/config/llm-providers.yaml`
3. `<cwd>/lib/llm/config/llm-providers.yaml`
4. Bundled config inside the npm package
5. Monorepo fallback paths

All string values support `${VAR}` and `${VAR:-default}` environment variable expansion.

## Full Reference

### `providers`

Define available providers and their models per tier.

```yaml
providers:
  claude-code:
    method: "cli"              # "cli" or "http"
    timeout: 120000            # ms (CLI needs longer)
    models:
      fast: "haiku"
      standard: "sonnet"
      premium: "opus"
    quotaTracking:
      enabled: true
      softLimitPerHour: 100

  copilot:
    method: "http"
    timeout: 120000
    models:
      fast: "claude-haiku-4.5"
      standard: "claude-sonnet-4.6"
      premium: "claude-opus-5"
    quotaTracking:
      enabled: true
      softLimitPerHour: 100

  groq:
    apiKeyEnvVar: GROQ_API_KEY
    fast: "llama-3.1-8b-instant"
    standard: "llama-3.3-70b-versatile"
    premium: "openai/gpt-oss-120b"

  anthropic:
    apiKeyEnvVar: ANTHROPIC_API_KEY
    fast: "claude-haiku-4-5"
    standard: "claude-sonnet-5"
    premium: "claude-opus-5"

  openai:
    apiKeyEnvVar: OPENAI_API_KEY
    fast: "gpt-4.1-mini"
    standard: "gpt-4.1"
    premium: "o4-mini"

  gemini:
    apiKeyEnvVar: GOOGLE_API_KEY
    fast: "gemini-2.5-flash"
    standard: "gemini-2.5-flash"
    premium: "gemini-2.5-pro"

  github-models:
    apiKeyEnvVar: GITHUB_TOKEN
    baseUrl: "https://models.github.ai/inference/v1"
    fast: "gpt-4.1-mini"
    standard: "gpt-4.1"
    premium: "o4-mini"

  proxy:
    baseUrl: "http://localhost:12435"
    timeout: 30000
    models:
      fast: "auto"
      standard: "auto"
      premium: "auto"
```

**Provider fields:**

| Field | Type | Description |
|-------|------|-------------|
| `method` | `"cli"` or `"http"` | How the provider is invoked (subscription providers only) |
| `apiKeyEnvVar` | `string` | Environment variable name for API key |
| `baseUrl` | `string` | Custom API base URL |
| `timeout` | `number` | Default timeout in ms |
| `models` | `{fast, standard, premium}` | Model name per tier |
| `fast`, `standard`, `premium` | `string` | Shorthand for models (alternative to nested `models` block) |
| `quotaTracking.enabled` | `boolean` | Enable subscription quota tracking |
| `quotaTracking.softLimitPerHour` | `number` | Soft limit for hourly completions |

### `provider_priority`

Default provider fallback order per tier. Providers are tried left-to-right until one succeeds.

```yaml
provider_priority:
  fast: ["proxy", "claude-code", "copilot", "groq", "anthropic", "openai", "gemini", "github-models"]
  standard: ["proxy", "claude-code", "copilot", "groq", "anthropic", "openai", "gemini", "github-models"]
  premium: ["proxy", "claude-code", "copilot", "groq", "anthropic", "openai", "gemini", "github-models"]
```

### `task_provider_priority`

Override provider order for specific task types. Takes precedence over `provider_priority`.

```yaml
task_provider_priority:
  semantic_code_analysis: ["proxy", "claude-code", "copilot", "groq", "anthropic", "openai"]
  observation_generation: ["proxy", "claude-code", "copilot", "groq", "gemini", "openai", "anthropic"]
  proxy_copilot: ["copilot", "claude-code", "groq", "anthropic", "openai"]
```

### `task_tiers`

Map task types to tiers. Used when `request.taskType` is set but no explicit `request.tier`.

```yaml
task_tiers:
  fast:
    - git_file_extraction
    - commit_message_parsing
    - file_pattern_matching
    - basic_classification
  standard:
    - semantic_code_analysis
    - ontology_classification
    - content_validation
    - observation_generation
  premium:
    - insight_generation
    - pattern_recognition
    - deep_code_analysis
```

### `agent_overrides`

Map agent IDs to tiers. Used when `request.agentId` is set.

```yaml
agent_overrides:
  insight_generation: premium
  semantic_analysis: standard
  batch_scheduler: fast
```

### `operator_tiers`

Tier assignments for Tree-KG operators.

```yaml
operator_tiers:
  conv: premium
  aggr: standard
  embed: fast
  dedup: standard
```

### `batch_task_tiers`

Tier assignments for batch workflow tasks.

```yaml
batch_task_tiers:
  plan_batches: fast
  batch_semantic_analysis: premium
  final_validation: standard
```

### `network_overrides`

Provider priority overrides applied based on detected network mode. See [network-detection.md](network-detection.md).

```yaml
network_overrides:
  vpn:
    default_provider: "copilot"
    provider_priority:
      fast: ["copilot", "groq", "gemini", "anthropic", "openai", "github-models"]
      standard: ["copilot", "groq", "gemini", "openai", "anthropic", "github-models"]
      premium: ["copilot", "claude-code", "groq", "gemini", "openai", "anthropic", "github-models"]
    task_provider_priority:
      observation_generation: ["copilot", "groq", "gemini", "openai", "anthropic"]
  public:
    default_provider: "claude-code"
    provider_priority:
      fast: ["claude-code", "copilot", "groq", "gemini", "openai", "anthropic", "github-models"]
      standard: ["claude-code", "copilot", "groq", "gemini", "openai", "anthropic", "github-models"]
      premium: ["claude-code", "copilot", "groq", "gemini", "openai", "anthropic", "github-models"]
```

### `dmr`

Docker Model Runner configuration for local model inference.

```yaml
dmr:
  port: ${DMR_PORT:-12434}
  host: ${DMR_HOST:-localhost}
  baseUrl: http://${DMR_HOST:-localhost}:${DMR_PORT:-12434}/engines/v1
  defaultModel: ai/llama3.2
  modelOverrides:
    semantic_analysis: ai/qwen2.5-coder:7B-Q4_K_M
    insight_generation: ai/llama3.2
  timeout: 120000
  maxTokens: 4096
  temperature: 0.7
  connection:
    maxRetries: 3
    retryDelay: 1000
    healthCheckInterval: 30000
```

### `cost_limits`

Per-workflow-run cost thresholds.

```yaml
cost_limits:
  budget_mode: 0.05    # $0.05 max
  standard_mode: 0.50  # $0.50 max
  quality_mode: 2.00   # $2.00 max
```

### `batch_cost_limits`

Cost limits for batch processing workflows.

```yaml
batch_cost_limits:
  max_tokens_per_batch: 500000
  max_cost_per_batch_usd: 1.00
  fallback_on_quota: true
  total_budget_usd: 50.00
```

### `cache`

Response cache settings.

```yaml
cache:
  maxSize: 1000       # Max cached entries (FIFO eviction)
  ttlMs: 3600000      # 1 hour TTL
```

### `circuit_breaker`

Per-provider circuit breaker.

```yaml
circuit_breaker:
  threshold: 5          # Failures before circuit opens
  resetTimeoutMs: 60000 # Base reset timeout (exponential backoff applied)
```

### `token_usage`

Local SQLite-backed completion log + git-trackable JSON export.

```yaml
token_usage:
  db_path: ${LLM_PROXY_DATA_DIR:-.data}/llm-proxy/token-usage.db
  export_path: ${LLM_PROXY_DATA_DIR:-.data}/llm-proxy-export/token-usage.json
  export_debounce_ms: 2000
  safety_merge: true        # Preserve historic JSON rows missing from local DB
```

The DB stays untracked in git; the JSON export is what teammates commit. On startup, missing-from-DB rows in the export are merged back into the live database — the same pattern used by `ObservationExporter` elsewhere in the consumer project.

### `llm_settings`

Persistent per-process provider/model pin map (consumed by `GET / PUT /api/llm/settings`).

```yaml
llm_settings:
  path: ${LLM_PROXY_DATA_DIR:-.data}/llm-proxy/settings.json
```

A pinned `process` is a hard override in routing — wins over `body.provider`, falls through to auto-route only if the pinned provider is unreachable.

## Environment Variable Overrides

These env vars override YAML config at runtime:

| Variable | Effect |
|----------|--------|
| `SEMANTIC_ANALYSIS_TIER=premium` | Force all requests to premium tier |
| `SEMANTIC_ANALYSIS_PROVIDER=anthropic` | Force specific provider |
| `SEMANTIC_ANALYSIS_COST_MODE=budget` | Use fast tier everywhere |
| `<TASK_TYPE>_TIER=premium` | Force tier for specific task (e.g. `INSIGHT_GENERATION_TIER=premium`) |
| `LLM_NETWORK_MODE=corporate` | Force network mode (skip auto-detection); `vpn` accepted as alias |
| `LLM_PROXY_DATA_DIR` | Base dir for SQLite DB and JSON export (default `<cwd>/.data`) |
| `LLM_PROXY_TOKEN_DB_PATH` | Absolute path override for the token-usage SQLite DB |
| `HEALTH_COORDINATOR_URL` | Wrapper-only — source of truth for network location (default `http://127.0.0.1:3034`) |
