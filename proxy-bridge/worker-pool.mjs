/**
 * Phase 62 — Worker Pool Core & stream-JSON Transport.
 *
 * `ClaudeWorker`: a persistent `claude -p --input-format stream-json
 * --output-format stream-json --verbose` subprocess that boots ONCE with the
 * verbatim context-stripping flag set and serves multiple sequential requests
 * (concurrency-1) without respawning. It frames the CLI's JSON-Lines stdout,
 * extracts `{content, model, tokens}` from the `{type:"result"}` event using the
 * SAME summation logic as the one-shot `completeClaudeCodeViaCLI` path
 * (server.mjs:1158-1178), so the worker is drop-in interchangeable as the D-06
 * overflow target. It exposes a non-destructive `cancel()` interrupt seam
 * (control_request, worker survives — Q3), a threshold-driven recycle/staleness
 * flag that bounds cross-call context leakage (Pitfall 1 / Security V3), and a
 * reap-on-exit path that settles in-flight requests as RETRYABLE.
 *
 * Transport is Node builtins only (`node:child_process` spawn + `node:crypto`).
 * No new npm dependency (RESEARCH § Installation).
 *
 * The boot flags, env (`buildClaudeEnv` strips ANTHROPIC_API_KEY/AUTH_TOKEN to
 * force Max OAuth via keychain), cwd ('/tmp' keeps the project breadcrumb out of
 * the status-line tracker), and error/token mapping all mirror
 * `completeClaudeCodeViaCLI` (server.mjs:1071-1201). The only protocol delta:
 * `--output-format json` becomes `--input-format stream-json --output-format
 * stream-json --verbose`, and the prompt travels as a JSON `{type:"user"}`
 * envelope over stdin (NEVER as an argv `--` prompt — strictly safer, V5).
 *
 * NON-STATELESS WORKER (Pitfall 1 / Security V3): a persistent worker keeps a
 * single conversation session — `session_id` on the stdin event is IGNORED, and
 * there is no in-session `clear`/`reset` control subtype. One caller's content
 * therefore persists into the next caller's context for the worker's lifetime.
 * This is a CORRECTNESS/DATA-ISOLATION hazard, mitigated here by a mandatory
 * threshold-driven recycle signal (`needsRecycle`): the pool MUST drain + respawn
 * a worker once its request count or last-seen input_tokens crosses the
 * configured ceiling. Callers must NEVER assume isolation within a worker's life.
 */

import { spawn as defaultSpawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

// --- Claude CLI config (mirrors server.mjs:395, 401-406) ---
// Re-declared here so the worker module is self-contained; the parent (server.mjs)
// may inject its own copies via the `deps` constructor seam for testability.
const CLAUDE_CLI = process.env.CLAUDE_CLI_PATH || '/opt/homebrew/bin/claude';

// GUARD-02 (CLI version pinning / D-01..D-04): a best-effort SYNCHRONOUS probe of
// the resolved `claude` CLI version. Wrapped so ANY failure (missing binary,
// non-zero exit, slow/hung exec hitting the timeout) yields `undefined` rather
// than throwing — boot must never block or crash on the version read (D-04
// degrade-open). The result is a coarse identity string (the raw `--version`
// stdout, trimmed); we only ever compare it for string-equality drift, so the
// exact format is irrelevant. A tiny timeout caps the worst case so a wedged CLI
// can't stall the (synchronous) boot path. Injectable via deps.readVersion /
// the pool's reader seam so the unit suite simulates drift with NO real binary.
function defaultReadClaudeVersion(claudeCli) {
  try {
    const out = execFileSync(claudeCli || CLAUDE_CLI, ['--version'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = (out || '').trim();
    return trimmed || undefined;
  } catch {
    // Degrade open (D-04): a failed/missing probe disables drift-recycle for the
    // caller rather than throwing out of worker boot / pool construction.
    return undefined;
  }
}

function defaultBuildClaudeEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

// server.mjs:517-533 analog — body.model tier alias -> haiku/sonnet/opus.
// Kept minimal/self-contained; the parent's resolveClaudeModel can be injected.
const CLAUDE_MODEL_MAP = {
  fast: 'haiku',
  standard: 'sonnet',
  premium: 'opus',
};

export function resolveClaudeModel(model) {
  return CLAUDE_MODEL_MAP[model] || model;
}

// Recycle defaults (RESEARCH § Pitfall 1 / Open-Q 1): conservative max-requests
// recycle, plus an input-token ceiling. Names/values are planner discretion;
// both are overridable per-worker via the `deps`/options seam, and the pool
// (Plan 03) reads them from env knobs.
const DEFAULT_MAX_REQUESTS = Number(process.env.LLM_PROXY_WORKER_MAX_REQUESTS) || 50;
const DEFAULT_MAX_INPUT_TOKENS =
  Number(process.env.LLM_PROXY_WORKER_MAX_INPUT_TOKENS) || 150_000;

// Per-request timeout (CR-01): the execFile path it replaces enforced
// `body.timeout || 120_000` (server.mjs:1075) and mapped expiry to a timeout
// error. A persistent worker that hangs mid-turn (network stall, CLI deadlock,
// lost result event) would otherwise leave `_pending` unsettled and `_busy=true`
// forever, hanging the caller AND every queued job. We arm a per-request timer
// in `_dispatch`, clear it on settle/exit, and on expiry reject as RETRYABLE +
// dispose the worker (its stdio is now unreliable — force reap, never reuse).
const DEFAULT_REQUEST_TIMEOUT_MS =
  Number(process.env.LLM_PROXY_WORKER_REQUEST_TIMEOUT_MS) || 120_000;

// Idle eviction (D-04 / WLIFE-02): a worker idle past this window disposes
// itself and is dropped from the pool, freeing its RAM during quiet periods;
// the next request for its key lazily respawns a cold worker. The timer is
// `unref()`'d (never keeps the proxy process alive) and reset on every request
// settle. Default 30 min, overridable via the `LLM_PROXY_WORKER_*` house knob
// or per-worker via the `deps.idleMs` seam (mirrors `requestTimeoutMs`).
const DEFAULT_IDLE_MS = Number(process.env.LLM_PROXY_WORKER_IDLE_MS) || 30 * 60_000;

// GUARD-03 / D-05..D-07 — per-worker stderr throttle window. Worker stderr is
// drained on EVERY chunk (the pipe must never block the subprocess — Pitfall 3),
// but a truncated sample is logged at most once per this window per worker so a
// chatty CLI (e.g. repeated "no stdin data received") surfaces for diagnosis
// without flooding the proxy logs. The throttle is PER-WORKER (D-07): one noisy
// worker cannot suppress another worker's first warning. The logged sample is
// truncated to STDERR_SAMPLE_MAX_CHARS to match the execFile path (server.mjs:1143).
// A bare named constant (env knob is optional Claude's-Discretion — not added).
const STDERR_THROTTLE_MS = 60_000;
const STDERR_SAMPLE_MAX_CHARS = 200;

/**
 * Translate the existing context-stripping flag set (server.mjs:1106-1122)
 * VERBATIM into session-start args, with two deltas:
 *   - `--output-format json` -> `--input-format stream-json --output-format
 *     stream-json --verbose` (stream-json needs --verbose to emit per-event lines)
 *   - the trailing `--`/prompt is OMITTED (the prompt arrives over stdin).
 * Omitting these strip flags burns ~14.8K input tokens vs ~130 with them
 * (server.mjs:1102-1105 measurement).
 */
export function workerBootArgs(model, systemPrompt) {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose', // REQUIRED for stream-json line-by-line events
    '--model', model, // boot-immutable — the per-model worker key (POOL-02 / Q2)
    '--tools', '', // disable tool definitions
    '--no-session-persistence', // don't persist
    '--disable-slash-commands', // skip skill resolution
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', // no MCP tool defs
    '--setting-sources', '', // skip hooks/auto-memory/CLAUDE.md
    '--system-prompt', systemPrompt || 'You are a helpful assistant.', // boot-immutable (D-01 / Q1)
  ];
  // NOTE: no `args.push('--', userPrompt)` — prompt-over-stdin, not argv (V5).
}

/**
 * Map a `{type:"result", is_error:true}` event to a typed error, reusing the
 * exact QUOTA_EXHAUSTED / AUTH_ERROR / generic string mapping from
 * server.mjs:1147-1156 so the dispatcher's downstream handling is unchanged.
 * `error_during_execution` (interrupt/abort) maps to the server.mjs:1185-1187
 * client-disconnect semantics.
 */
function mapResultError(ev) {
  const errMsg = (ev && ev.result) || '';
  const lower = errMsg.toLowerCase();
  // Quota/auth strings take precedence over the subtype: an interrupted request
  // carries an empty result, whereas a real quota/auth failure (even one the CLI
  // surfaces under error_during_execution) carries the diagnostic string. Map
  // those to the typed errors first (server.mjs:1147-1156).
  if (lower.includes('credit balance') || lower.includes('rate limit')) {
    return new Error(`QUOTA_EXHAUSTED: ${errMsg}`);
  }
  if (lower.includes('not logged in') || lower.includes('login')) {
    return new Error(`AUTH_ERROR: ${errMsg}`);
  }
  // Interrupt/abort with no diagnostic -> client-disconnect semantics
  // (server.mjs:1185-1187).
  if (ev && ev.subtype === 'error_during_execution') {
    return new Error('client disconnected — claude CLI killed');
  }
  return new Error(`Claude CLI error: ${errMsg || 'Unknown CLI error'}`);
}

/**
 * WR-02 / D-08 — the ONE cache-inclusive input-token summation, shared by
 * `toCompletion` (the return-contract path) AND the recycle-ceiling bookkeeping
 * (`_lastInputTokens` at the result boundary). When `ev.modelUsage` is present,
 * input = inputTokens + cacheReadInputTokens + cacheCreationInputTokens of the
 * first model entry — the SAME sum server.mjs:1166 treats as authoritative.
 * When `modelUsage` is absent, fall back to the raw top-level
 * `ev.usage?.input_tokens || 0`. Extracted so there is exactly one summation
 * (the recycle ceiling and the reported token contract can never diverge).
 */
function inputTokensFromEvent(ev) {
  if (ev && ev.modelUsage) {
    const modelEntry = Object.values(ev.modelUsage)[0];
    if (modelEntry) {
      return (
        modelEntry.inputTokens +
        (modelEntry.cacheReadInputTokens || 0) +
        (modelEntry.cacheCreationInputTokens || 0)
      );
    }
  }
  return ev?.usage?.input_tokens || 0;
}

/**
 * Extract the interchangeable `{content, model, tokens:{input,output,total}}`
 * return contract from a `{type:"result"}` event — ported from
 * server.mjs:1158-1178. The summation `input + cacheRead + cacheCreation`
 * (server.mjs:1165) applies unchanged — via the shared `inputTokensFromEvent`.
 */
function toCompletion(ev, fallbackModel, overheadMs) {
  const inputTokens = inputTokensFromEvent(ev);
  let outputTokens = ev.usage?.output_tokens || 0;

  if (ev.modelUsage) {
    const modelEntry = Object.values(ev.modelUsage)[0];
    if (modelEntry) {
      outputTokens = modelEntry.outputTokens;
    }
  }

  // PERF-03 (Plan 66-03): the spawn/queue overhead window (dispatch-start ->
  // first-stdout) is ADDITIVE on the existing {content,model,tokens} contract.
  // It is present ONLY for worker-pool completions; execFile-overflow and
  // direct-OAuth (haiku) results never call toCompletion, so they carry no
  // overheadMs (the server logs NULL for those — correct, no pool overhead).
  const completion = {
    content: ev.result,
    model: Object.keys(ev.modelUsage || {})[0] || fallbackModel,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      total: inputTokens + outputTokens,
    },
  };
  if (typeof overheadMs === 'number') completion.overheadMs = overheadMs;
  return completion;
}

/**
 * A persistent stream-JSON `claude` worker. Concurrency-1: at most one
 * outstanding `_pending` promise per worker (POOL-03), so no request-id
 * correlation is needed on the result event (Pattern 1).
 *
 * Emits: `'exit'` when the subprocess exits/closes.
 *
 * @extends EventEmitter
 */
export class ClaudeWorker extends EventEmitter {
  /**
   * @param {string} model        - tier alias or model id; resolved via resolveClaudeModel.
   * @param {string} systemPrompt - boot-immutable system prompt (the prompt-hash key, D-01/Q1).
   * @param {object} [deps]       - injectable dependencies for testability:
   *   @param {Function} [deps.spawn]      - spawn impl (default node:child_process spawn).
   *   @param {string}   [deps.claudeCli]  - CLI path (default CLAUDE_CLI).
   *   @param {Function} [deps.buildEnv]   - env builder (default buildClaudeEnv).
   *   @param {Function} [deps.readVersion] - GUARD-02 boot-version probe (default: a
   *     best-effort synchronous `claudeCli --version` read that degrades open). The
   *     captured string is stored on `_bootVersion` for the pool's drift-recycle.
   *   @param {Function} [deps.log]    - GUARD-03 info logger (default no-op).
   *   @param {Function} [deps.logErr] - GUARD-03 error logger for the throttled
   *     stderr sample (default: deps.log, else no-op). The drained stderr sample is
   *     emitted here at most once per STDERR_THROTTLE_MS per worker.
   *   @param {Function} [deps.now]    - GUARD-03 injectable clock for the stderr
   *     throttle gate (default Date.now); lets the unit suite advance time.
   *   @param {number}   [deps.maxRequests]      - recycle after N requests (Pitfall 1).
   *   @param {number}   [deps.maxInputTokens]   - recycle when input_tokens exceeds this.
   *   @param {number}   [deps.requestTimeoutMs] - per-request timeout (CR-01); default 120_000,
   *     per-request override via the `timeoutMs` arg to write().
   */
  constructor(model, systemPrompt, deps = {}) {
    super();
    this._model = resolveClaudeModel(model || 'sonnet');
    this._systemPrompt = systemPrompt || 'You are a helpful assistant.';

    const spawnImpl = deps.spawn || defaultSpawn;
    const claudeCli = deps.claudeCli || CLAUDE_CLI;
    const buildEnv = deps.buildEnv || defaultBuildClaudeEnv;
    // GUARD-02 / D-01: deps-injectable version reader (mirrors the spawn/claudeCli/
    // buildEnv seams). Default to the best-effort synchronous probe of the resolved
    // claudeCli — already wrapped to degrade open (returns undefined on any error).
    const readVersion = deps.readVersion || (() => defaultReadClaudeVersion(claudeCli));
    // GUARD-03 / D-06 — logger threaded into the worker via the deps seam,
    // defaulting to a no-op exactly like the pool's opts.log/opts.logErr
    // (worker-pool.mjs:796-797). The throttled stderr sample is emitted through
    // `_logErr` (falls back to `_log` only if logErr is absent) — NEVER a raw
    // stdout/stderr write (that would dodge the no-console-log / GUARD-03
    // constraint). A worker built with no logger emits nothing + never throws.
    this._log = deps.log || (() => {});
    this._logErr = deps.logErr || deps.log || (() => {});
    // GUARD-03 / D-05 — injectable monotonic clock so the unit suite can advance
    // time deterministically across the throttle window (fake clock). Defaults to
    // Date.now; reused only for the per-worker stderr throttle gate.
    this._now = deps.now || Date.now;

    this._maxRequests = deps.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this._maxInputTokens = deps.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
    // CR-01: per-request timeout default; overridable per request via write(content, timeoutMs).
    this._requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    // D-04 / WLIFE-02: idle-eviction window; overridable per-worker for the unit suite.
    this._idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
    this._idleTimer = null;

    // PERF-03 / SC-2 (Plan 66-05): opt-in artificial spawn/queue delay. When > 0,
    // `_dispatch` defers the prompt write by this many ms AFTER stamping
    // `dispatchedAt`, so the worker only starts producing stdout (and therefore
    // firstOutputAt) that much later — the delay lands ENTIRELY in the overhead
    // window (firstOutputAt - dispatchedAt), NOT in model generation. Setting it
    // above the dashboard's 5000ms red threshold inflates p50_overhead_ms past red
    // so the SC-2 regression -> red badge can be exercised deterministically on any
    // host (genuine cold-spawn overhead on a fast host tops out well below 5s).
    // A NO-OP when unset/0 (negative/NaN clamp to 0): the dispatch path is then
    // byte-for-byte identical to today (synchronous write, no setTimeout). Injectable
    // via `deps.spawnDelayMs` for the unit suite; env fallback for the live proxy.
    this._spawnDelayMs =
      Number(deps.spawnDelayMs ?? process.env.LLM_PROXY_WORKER_SPAWN_DELAY_MS ?? 0) || 0;
    if (!(this._spawnDelayMs > 0)) this._spawnDelayMs = 0; // clamp negative/NaN -> 0
    this._spawnDelayTimer = null;

    // Concurrency-1: exactly one outstanding request (POOL-03 / Pattern 1).
    // A small FIFO queue serializes any writes that arrive while a request is
    // in-flight so a second write never interleaves with the first's response;
    // the pool normally enforces this by routing to a sibling worker, but the
    // worker self-serializes as a safety net.
    this._pending = null;
    this._queue = [];
    this._busy = false;
    this._buf = ''; // stdout JSON-Lines partial-line buffer (Pitfall 3)
    this._exited = false;

    // D-02 / WLIFE-04: a per-worker monotonic request-generation counter. Bumped
    // on every `_dispatch` and stamped onto `_pending.generation`. A `result`
    // that carries a generation (`ev._gen`) which does NOT match the live
    // `_pending.generation` is a STRAY/late result from an already-settled turn
    // and is DROPPED — never used to resolve the next caller's promise. This is
    // the belt-and-suspenders behind dispose-on-cancel (Plan 04); the PRIMARY
    // defense remains `_pending === null` (a result after settle is ignored). A
    // plain incrementing integer is the minimal representation (Claude's-Discretion).
    this._generation = 0;

    // Context-leak recycle bookkeeping (Pitfall 1 / Security V3). One caller's
    // content persists into the next caller's context until the pool recycles.
    this._requestCount = 0;
    this._lastInputTokens = 0;
    this.needsRecycle = false; // pool (Plan 03) reads this before reuse
    this.isStale = false; // alias the pool may check

    // GUARD-03 / D-05 / D-07 — per-worker stderr-throttle gate: the timestamp of
    // the LAST logged stderr sample, or `null` when nothing has been logged yet
    // (so the FIRST chunk ALWAYS logs, even when the injected clock reads 0). The
    // drain handler logs again only once `_now() - this._stderrLastLoggedAt >=
    // STDERR_THROTTLE_MS`. Per-worker (not global) so one chatty worker can't mute
    // another's first warning.
    this._stderrLastLoggedAt = null;

    // GUARD-02 / D-01 + D-04: capture the claude CLI version this worker BOOTED
    // against, so the pool can recycle it when the binary drifts (prompt-cache
    // assumptions rot otherwise). The read is best-effort + degrade-open: ANY
    // failure (probe throws / returns nothing) leaves _bootVersion null, which
    // DISABLES drift-recycle for this worker rather than blocking/crashing boot.
    // The capture happens BEFORE the subprocess spawn but never awaits anything —
    // the default reader is a synchronous, timeout-capped exec wrapped in try/catch.
    this._bootVersion = null;
    try {
      const v = readVersion();
      this._bootVersion = v || null;
    } catch {
      // Degrade open (D-04): a throwing probe must never crash boot.
      this._bootVersion = null;
    }

    // Boot the persistent subprocess. cwd '/tmp' keeps the project breadcrumb out
    // of the status-line tracker; buildEnv() strips API keys -> Max OAuth.
    this._proc = spawnImpl(claudeCli, workerBootArgs(this._model, this._systemPrompt), {
      env: buildEnv(),
      cwd: '/tmp',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.pid = this._proc.pid;

    // stdout: continuous buffer, split on '\n', JSON.parse only COMPLETE lines.
    // NEVER JSON.parse a raw chunk (a result line may span chunk boundaries —
    // Pitfall 3 partial-line buffering).
    this._proc.stdout.on('data', (chunk) => this._onStdout(chunk));

    // GUARD-03 / D-05..D-07 — drain-and-throttle stderr. Every chunk is consumed
    // unconditionally so an undrained pipe never stalls a long-lived worker
    // (Pitfall 3); the drain is independent of the throttle gate. A truncated
    // sample is then logged through the injected `_logErr` at most once per
    // STDERR_THROTTLE_MS PER WORKER (per-worker last-logged timestamp gate, D-07):
    // the first chunk after boot logs, a second chunk inside the window logs
    // nothing, and a chunk after the window elapses logs again. The sample is
    // trimmed + sliced to STDERR_SAMPLE_MAX_CHARS to mirror the execFile path
    // (server.mjs:1143). Never buffer stderr unboundedly — only the throttled
    // sample is retained, the rest is drained-and-dropped.
    if (this._proc.stderr) {
      this._proc.stderr.on('data', (chunk) => this._onStderr(chunk));
    }

    // Reap-on-exit: settle any outstanding request as RETRYABLE and emit 'exit'
    // (basic reap belongs here; full crash-recovery is Phase 63).
    this._proc.on('exit', (code, signal) => this._onExit(code, signal));
    this._proc.on('close', (code, signal) => this._onExit(code, signal));

    // D-04 / WLIFE-02: a worker idle from birth must self-evict. Armed here,
    // cleared on dispatch (a busy worker is not idle), re-armed on settle.
    this._armIdleTimer();
  }

  get model() {
    return this._model;
  }

  get systemPrompt() {
    return this._systemPrompt;
  }

  get busy() {
    return this._busy;
  }

  /**
   * Send one request. Returns a Promise that resolves to the interchangeable
   * `{content, model, tokens}` contract on the `{type:"result"}` event, or
   * rejects via the QUOTA/AUTH/disconnect mapping on `is_error`. Concurrency-1:
   * the single `_pending` slot is overwritten only after the prior request
   * settles (the pool enforces no concurrent writes per worker — POOL-03).
   *
   * @param {string} content   - the user turn content.
   * @param {number} [timeoutMs] - per-request timeout override (CR-01); falls back
   *   to the worker's `_requestTimeoutMs` (default 120_000). Mirrors the execFile
   *   path's `body.timeout || 120_000` (server.mjs:1075).
   */
  write(content, timeoutMs) {
    return this.writeTracked(content, timeoutMs).promise;
  }

  /**
   * D-03 / WLIFE-04 — like `write`, but returns `{ promise, job }` so the caller
   * (the pool's abort handler) can identify EXACTLY which logical request this is
   * and discriminate in-flight vs queued on abort. The `job` object is the SAME
   * reference that is either dispatched as `_pending` or pushed onto `_queue`, so
   * the abort handler can test `worker._queue.includes(job)` (queued) vs not
   * (in-flight). The public `write` contract is preserved (it returns the promise).
   */
  writeTracked(content, timeoutMs) {
    const job = { content, resolve: null, reject: null, timeoutMs };
    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
      if (this._exited) {
        reject(makeRetryableError('worker exited before request'));
        return;
      }
      if (this._busy) {
        // Concurrency-1: do not interleave — queue until the in-flight result.
        this._queue.push(job);
        return;
      }
      this._dispatch(job);
    });
    return { promise, job };
  }

  /**
   * D-03 / WLIFE-04 — abort a QUEUED job: splice it out of `_queue` and reject it
   * RETRYABLE, leaving the in-flight `_pending` and the worker untouched. Returns
   * true iff the job was found in the queue and removed (so the pool can fall
   * through to the in-flight dispose path when it was NOT queued). Copies the
   * `job.reject(makeRetryableError(...))` shape from the `_onExit` queue-drain
   * loop; preserves FIFO for the surviving jobs (a single splice never reorders).
   */
  abortQueuedJob(job) {
    const idx = this._queue.indexOf(job);
    if (idx === -1) return false;
    this._queue.splice(idx, 1);
    job.reject(makeRetryableError('request aborted (queued — client disconnected)'));
    return true;
  }

  _dispatch(job) {
    // D-04: a busy worker is not idle — cancel any pending idle eviction.
    this._clearIdleTimer();
    // D-02: bump the monotonic request generation and stamp it on _pending so a
    // result from a PRIOR (already-settled) generation can be recognised + dropped
    // in _onEvent instead of resolving this fresh request's promise.
    this._generation += 1;
    const generation = this._generation;
    // PERF-03 (Plan 66-03): stamp the dispatch-start boundary for the spawn/queue
    // overhead window. `dispatchedAt` is captured here (just before _writeGuarded
    // writes the prompt below) via the injectable `_now` clock; `firstOutputAt`
    // starts null and is stamped ONCE by _onStdout on the first parsed line of
    // this turn (spawn + CLI cold-boot + queue-wait + dispatch, BEFORE generation).
    this._pending = {
      resolve: job.resolve,
      reject: job.reject,
      timer: null,
      generation,
      dispatchedAt: this._now(),
      firstOutputAt: null,
    };
    this._busy = true;

    // CR-01: arm a per-request timeout. A hung worker (no `result`, no exit)
    // would otherwise pin `_pending`/`_busy` forever and hang every queued job.
    // On expiry: settle the pending promise as RETRYABLE, then dispose() the
    // worker — its stdio is now unreliable, so the pool must replace it rather
    // than dispatch the next queued job into a corrupted process. dispose()
    // SIGTERMs the subprocess, whose eventual 'exit' fires _onExit, which
    // rejects every still-queued job as RETRYABLE (no silent hang).
    // PERF-03 / SC-2 (Plan 66-05): when an artificial spawn delay is injected, the
    // prompt write (and therefore the first output + terminal result) is deferred by
    // `_spawnDelayMs`. The per-request timeout MUST cover that deferral, otherwise a
    // large delay (e.g. 6000ms) on a short request timeout would trip the timeout
    // before the write even happens. Extend the armed window by the delay so the
    // timeout still measures the worker's own response budget. No-op when delay==0.
    const timeoutMs =
      (job.timeoutMs ?? this._requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) + this._spawnDelayMs;
    const timer = setTimeout(() => {
      const pending = this._pending;
      this._pending = null;
      this._busy = false;
      this.needsRecycle = true;
      this.isStale = true;
      if (pending) {
        pending.reject(makeRetryableError(`worker request timed out after ${timeoutMs}ms`));
      }
      // Force reap: the worker is non-recoverable. dispose() -> SIGTERM -> 'exit'
      // -> _onExit drains any queued jobs as RETRYABLE. We do NOT dispatch the
      // next queued job here (the stdio is corrupted).
      this.dispose();
    }, timeoutMs);
    if (timer.unref) timer.unref(); // never keep the event loop alive on a timer
    this._pending.timer = timer;

    // D-02: stamp the generation on the outgoing envelope. The live CLI ignores
    // unknown fields and does NOT echo it (so the live path relies on the
    // `_pending === null` primary defense); the unit suite echoes `_gen` back to
    // exercise the in-flight-window guard deterministically without adding any
    // request-id correlation to the protocol (Pattern 1: concurrency-1 needs none).
    const msg = { type: 'user', _gen: generation, message: { role: 'user', content: job.content } };
    const payload = JSON.stringify(msg) + '\n';
    // D-07 / WLIFE-03: the stdin pipe to a crashed subprocess can close
    // mid-write. An UNGUARDED write throws (synchronously, EPIPE) out of the
    // dispatch path and loses the queued-job rejection. Funnel any write error
    // — synchronous throw OR async write-callback `err` — into the existing
    // `_onExit` reap (signal 'EPIPE' for a diagnostic message) so the in-flight
    // promise rejects RETRYABLE, EVERY queued job rejects RETRYABLE, and 'exit'
    // fires for the pool's `_dropWorker` backstop. Never catch-and-swallow.
    //
    // PERF-03 / SC-2 (Plan 66-05): when `_spawnDelayMs > 0`, defer the prompt write
    // by that many ms so the injected delay lands in the overhead window (the write
    // is delayed but `dispatchedAt` above is NOT). When 0 (default) write
    // synchronously, exactly as before this seam existed (byte-for-byte unchanged).
    // The deferred timer is `unref()`'d (never keeps the proxy alive) and guards
    // against a superseded dispatch — if the turn already settled / the worker
    // exited / a newer generation took over, the stale write is dropped.
    if (this._spawnDelayMs > 0) {
      const delayTimer = setTimeout(() => {
        this._spawnDelayTimer = null;
        // Superseded-dispatch guard: only write if THIS generation is still the
        // live in-flight turn and the worker has not exited in the interim.
        if (this._exited) return;
        if (this._pending == null || this._pending.generation !== generation) return;
        this._writeGuarded(payload);
      }, this._spawnDelayMs);
      if (delayTimer.unref) delayTimer.unref();
      this._spawnDelayTimer = delayTimer;
    } else {
      this._writeGuarded(payload);
    }
  }

  /**
   * D-07 / WLIFE-03 — write to the subprocess stdin, treating ANY write error
   * as a crash. Covers both the synchronous-throw case (the pipe is already
   * gone) and the async write-callback `err` case (the pipe closes during the
   * write). Either way we route through `_onExit(null, 'EPIPE')` — the SAME reap
   * path a real subprocess `'exit'` uses — so the in-flight + queued jobs reject
   * RETRYABLE and the worker is marked dead and emits 'exit'. We never swallow a
   * write error: every one reaches `_onExit`.
   */
  _writeGuarded(payload) {
    try {
      this._proc.stdin.write(payload, (err) => {
        // Async error-later (pipe closed mid-write). Guard against a double-reap
        // (`_onExit` is idempotent via the `_exited` guard, so this is belt-and-
        // suspenders) and route to the same crash path.
        if (err && !this._exited) this._onExit(null, 'EPIPE');
      });
    } catch {
      // Throw-now (EPIPE / pipe already closed). Route to the crash reap instead
      // of letting the error escape the dispatch path.
      if (!this._exited) this._onExit(null, 'EPIPE');
    }
  }

  _onStdout(chunk) {
    this._buf += chunk.toString();
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        // A complete line should always be valid JSON; skip anything that isn't
        // (defensive — never throw out of the stdout reader).
        continue;
      }
      // PERF-03 (Plan 66-03): the FIRST parsed line of a dispatch marks "the
      // worker is now producing output for this turn" — the warm/cold-sensitive
      // boundary BEFORE generation completes. The system/init event is typically
      // first; stamping here (rather than on the terminal `result` in _onEvent)
      // keeps generation time OUT of the overhead window. Stamp once per dispatch
      // (`firstOutputAt === null` guard); a non-null _pending means a turn is live.
      if (this._pending && this._pending.firstOutputAt === null) {
        this._pending.firstOutputAt = this._now();
      }
      this._onEvent(ev);
    }
  }

  /**
   * GUARD-03 / D-05..D-07 — drain-and-throttle one stderr chunk. The chunk is
   * ALWAYS consumed (this method is the data handler, so reading it here drains
   * the pipe regardless of the throttle outcome — the subprocess never blocks on
   * a full stderr buffer, Pitfall 3). A truncated, trimmed sample (<=
   * STDERR_SAMPLE_MAX_CHARS) is then logged through the injected `_logErr` only
   * when at least STDERR_THROTTLE_MS has elapsed since this worker's last logged
   * sample (per-worker gate, D-07). Empty/whitespace-only chunks are drained but
   * never logged. Logging goes through the deps logger ONLY (no raw write).
   */
  _onStderr(chunk) {
    // Unconditional drain: converting the chunk consumes it; nothing is buffered
    // beyond the single throttled sample below.
    const text = String(chunk);
    const now = this._now();
    // First chunk (`_stderrLastLoggedAt === null`) always logs; afterwards gate on
    // the per-worker window so at most one sample logs per STDERR_THROTTLE_MS.
    if (this._stderrLastLoggedAt !== null && now - this._stderrLastLoggedAt < STDERR_THROTTLE_MS) {
      return; // throttled within the window
    }
    const sample = text.trim().slice(0, STDERR_SAMPLE_MAX_CHARS);
    if (!sample) return; // nothing meaningful to surface (still drained)
    this._stderrLastLoggedAt = now;
    this._logErr(`worker-pool: stderr pid=${this.pid}: ${sample}`);
  }

  _onEvent(ev) {
    // `system/init` (fires per turn) and `assistant` events are NON-terminal —
    // only `result` ends a response (anti-pattern: treating init as the
    // boundary). control_response (interrupt ack) is also non-terminal.
    if (!ev || ev.type !== 'result') return;

    // D-02 / WLIFE-04 — stray-result generation guard. PRIMARY defense: a result
    // arriving after a request has settled finds `_pending === null` and is
    // ignored. NARROWER window (closed here): a NEW request's `_pending` is
    // already in-flight when a STALE result line from the PRIOR turn lands. If the
    // result carries a generation (`ev._gen`) that does NOT match the live
    // `_pending.generation`, it belongs to an already-settled turn — DROP it
    // (never resolve the next caller with it). A result with no generation (the
    // live CLI never echoes one) falls through to normal settling, so the happy
    // path is unchanged. Belt-and-suspenders behind dispose-on-cancel (Plan 04).
    if (this._pending == null) return;
    if (
      ev._gen !== undefined &&
      this._pending.generation !== undefined &&
      ev._gen !== this._pending.generation
    ) {
      // Stale/stray result for an already-settled generation — drop it.
      return;
    }

    // --- end-of-response boundary (POOL-03 frees the worker here) ---
    this._requestCount += 1;
    // WR-02 / D-08 — measure context with the cache-inclusive sum (the SAME one
    // toCompletion / server.mjs:1166 treat as authoritative), falling back to raw
    // input_tokens only when modelUsage is absent. The recycle ceiling
    // (_lastInputTokens >= _maxInputTokens) therefore trips on the TRUE context
    // the worker carries — including cache-read/cache-creation tokens — instead of
    // firing far too late off the raw top-level input count alone.
    this._lastInputTokens = inputTokensFromEvent(ev);
    this._evaluateRecycle();

    const pending = this._pending;
    this._pending = null;
    this._busy = false;
    if (pending) {
      // CR-01: clear the per-request timer so it never fires spuriously/leaks.
      if (pending.timer) clearTimeout(pending.timer);
      if (ev.is_error) {
        pending.reject(mapResultError(ev));
      } else {
        // PERF-03 (Plan 66-03): the spawn/queue overhead is (firstOutputAt -
        // dispatchedAt). A turn that produced NO intermediate output before the
        // result (firstOutputAt still null) falls back to (dispatchedAt -
        // dispatchedAt)... no — that would read zero, hiding a cold spawn. The
        // conservative reading for a no-intermediate-output turn is the full
        // elapsed (result time - dispatch time), so use (firstOutputAt ??
        // <now>) - dispatchedAt: when first output was never stamped, _now() at
        // settle is the earliest observable "output" boundary for this turn.
        const firstOut = pending.firstOutputAt ?? this._now();
        const overheadMs = firstOut - pending.dispatchedAt;
        pending.resolve(toCompletion(ev, this._model, overheadMs));
      }
    }

    // D-04: reset the idle window from THIS settle. If a queued request is
    // dispatched next, _dispatch immediately clears it again (a busy worker is
    // not idle); otherwise the worker is now idle and the freshly-armed timer
    // governs its eviction window.
    if (!this._exited) this._armIdleTimer();

    // Drive the next queued request (concurrency-1 FIFO).
    if (this._queue.length > 0 && !this._exited) {
      this._dispatch(this._queue.shift());
    }
  }

  // Bound cross-call context leakage (Pitfall 1 / Security V3): flag for recycle
  // once request count OR last-seen input_tokens crosses the configured ceiling.
  // The pool (Plan 03) drains + respawns the worker before the next reuse.
  _evaluateRecycle() {
    if (
      this._requestCount >= this._maxRequests ||
      this._lastInputTokens >= this._maxInputTokens
    ) {
      this.needsRecycle = true;
      this.isStale = true;
    }
  }

  /**
   * D-04 / WLIFE-02 — arm the per-worker idle eviction timer. On fire, the
   * worker disposes itself: `dispose()` ends stdin + SIGTERMs the subprocess,
   * whose `'exit'` reaches the pool's existing `_dropWorker` backstop, so the
   * worker is reaped for free (NO central sweep loop). The next request for the
   * key lazily respawns. The timer is `unref()`'d so it NEVER keeps the proxy
   * process alive (Context: "so it never keeps the proxy process alive").
   */
  _armIdleTimer() {
    this._clearIdleTimer();
    if (this._exited) return;
    this._idleTimer = setTimeout(() => {
      // Idle window elapsed with no in-flight/queued work — self-evict.
      this.dispose();
    }, this._idleMs);
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  /** Clear the idle timer (dispatch / dispose) so no dangling timer survives. */
  _clearIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  // PERF-03 / SC-2 (Plan 66-05): cancel a pending deferred spawn-delay write so a
  // settled / exited / disposed turn never writes a late prompt into a process that
  // has moved on. No-op when the seam is unused (timer stays null).
  _clearSpawnDelayTimer() {
    if (this._spawnDelayTimer) {
      clearTimeout(this._spawnDelayTimer);
      this._spawnDelayTimer = null;
    }
  }

  /**
   * Non-destructive cancel seam (Q3): write a `control_request` interrupt to
   * stdin. The CLI acks with control_response{success} and the in-flight request
   * terminates with `{type:"result", is_error:true, subtype:"error_during_execution"}`,
   * which settles the pending promise via the client-disconnect mapping. The
   * worker SURVIVES (no SIGTERM, no respawn) and serves the next request. Full
   * client-disconnect propagation lands Phase 63 / WLIFE-04; this exposes the
   * seam so later phases extend rather than refactor (D-03 / Claude's discretion).
   */
  cancel() {
    const requestId = randomUUID();
    const msg = {
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'interrupt' },
    };
    // D-07 symmetry: the control_request write is the same latent EPIPE hazard
    // (mostly moot once Plan 04 replaces the disconnect path with SIGTERM+dispose,
    // but an unguarded write here would still escape). Route any write error into
    // the same `_onExit('EPIPE')` reap.
    this._writeGuarded(JSON.stringify(msg) + '\n');
    return requestId;
  }

  // Reap-on-exit: settle any outstanding request as RETRYABLE (not a silent
  // hang) and emit 'exit' so the pool can evict + respawn (Runtime State Inventory).
  _onExit(code, signal) {
    if (this._exited) return;
    this._exited = true;
    this.needsRecycle = true;
    this.isStale = true;
    // D-04: a self-exited (crashed) worker must not leave a dangling idle timer.
    this._clearIdleTimer();
    // PERF-03 / SC-2 (Plan 66-05): nor a dangling deferred spawn-delay write.
    this._clearSpawnDelayTimer();
    const pending = this._pending;
    this._pending = null;
    this._busy = false;
    if (pending) {
      // CR-01: clear the per-request timer so a SIGTERM/exit doesn't leave a
      // dangling timer that fires after settle.
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(makeRetryableError(`worker exited (code=${code}, signal=${signal})`));
    }
    // Settle any queued requests as RETRYABLE too (no silent hang).
    const queued = this._queue.splice(0);
    for (const job of queued) {
      job.reject(makeRetryableError(`worker exited (code=${code}, signal=${signal})`));
    }
    this.emit('exit', { code, signal });
  }

  /**
   * Drain + dispose: end stdin and let the subprocess exit so proxy shutdown /
   * pool eviction reaps the worker without orphans. `kill` is permitted ONLY
   * here (and reap) — never in the cancel() path.
   */
  dispose() {
    // D-04: clear the idle timer first so shutdown / disposeAll / idle-fire
    // leaves no dangling timer (no second fire, no event-loop pin).
    this._clearIdleTimer();
    // PERF-03 / SC-2 (Plan 66-05): cancel any pending deferred spawn-delay write
    // so a disposed worker never writes a late prompt into a closing stdin.
    this._clearSpawnDelayTimer();
    try {
      this._proc.stdin?.end();
    } catch {
      /* already closed */
    }
    try {
      if (!this._exited && typeof this._proc.kill === 'function') {
        this._proc.kill('SIGTERM');
      }
    } catch {
      /* best-effort */
    }
  }

  // Alias for symmetry with the pool's lifecycle vocabulary.
  drain() {
    this.dispose();
  }
}

function makeRetryableError(message) {
  const err = new Error(message);
  err.retryable = true;
  err.code = 'WORKER_RETRYABLE';
  return err;
}

/**
 * Worker key = (resolved model)::(system-prompt sha256 prefix) — D-01 / Pattern 2.
 * Per-model isolation is mandatory (POOL-02 / Q2): a sonnet request must NEVER
 * reuse a haiku-booted worker, so the model is part of the key.
 */
export function workerKeyFor(body) {
  const model = resolveClaudeModel(body?.model || 'sonnet');
  const systemPrompt = extractSystemPrompt(body) || 'You are a helpful assistant.';
  const hash = createHash('sha256').update(systemPrompt).digest('hex').slice(0, 16);
  return `${model}::${hash}`;
}

// Split system vs user turns the SAME way completeClaudeCodeViaCLI does
// (server.mjs:1076-1091): system parts feed the worker key (Q1), user parts
// become the stdin `content`.
function extractSystemPrompt(body) {
  const messages = body?.messages || [];
  const systemParts = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
  }
  return systemParts.length > 0 ? systemParts.join('\n\n') : null;
}

export function extractUserPrompt(body) {
  const messages = body?.messages || [];
  const userParts = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'assistant') userParts.push(`Assistant: ${m.content}`);
    else userParts.push(m.content);
  }
  return userParts.join('\n\n');
}

// Pool defaults (D-05 / D-02 — env knob names per RESEARCH Open-Q 2). Both are
// non-load-bearing names; values are conservative starting points pending real
// traffic tuning (Phase 63/65).
const DEFAULT_POOL_SIZE = Number(process.env.LLM_PROXY_WORKER_POOL_SIZE) || 2;
const DEFAULT_PROMPT_CAP = Number(process.env.LLM_PROXY_WORKER_PROMPT_CAP) || 8;

// Crash-cooldown respawn-storm guard (D-06 / WLIFE-03). A persistently-broken
// (model×prompt) key (bad OAuth/flags, CLI missing) boot-crashes every spawn.
// There is already NO auto-restart (respawn is lazy-on-next-request), so the
// "never auto-restarted in a tight loop" invariant is structurally true; these
// knobs add the extra protection: once a key crosses `LLM_PROXY_WORKER_CRASH_
// THRESHOLD` crashes within `LLM_PROXY_WORKER_CRASH_WINDOW_MS`, it enters
// cooldown and its requests route straight to the execFile overflow
// (completeClaudeCodeViaCLI) for the window — today's pre-milestone behavior —
// instead of spawn->crash->RETRYABLE on every request. After the window the key
// may lazily spawn again. Names follow the `LLM_PROXY_WORKER_*` house style;
// both are overridable per-pool via the `opts.crashThreshold`/`opts.crashWindowMs`
// seam (mirrors `size`/`promptCap`) so the unit suite can use a tiny window.
const DEFAULT_CRASH_THRESHOLD =
  Number(process.env.LLM_PROXY_WORKER_CRASH_THRESHOLD) || 3;
const DEFAULT_CRASH_WINDOW_MS =
  Number(process.env.LLM_PROXY_WORKER_CRASH_WINDOW_MS) || 60_000;

// GUARD-02 / D-03 — coarse re-probe cadence for the pool's current-version
// snapshot. The snapshot is captured once at construction and only re-read by a
// `complete()` call that finds the interval has elapsed since the last probe, so
// the version reader runs at most ~once per window regardless of request rate —
// the hot path never execs `claude --version`. Default 5 min; overridable via the
// `LLM_PROXY_WORKER_*` house knob or per-pool via the `opts.versionRefreshMs`
// seam (the unit suite drives the snapshot explicitly via refreshVersionSnapshot()
// so it never depends on this interval).
const DEFAULT_VERSION_REFRESH_MS =
  Number(process.env.LLM_PROXY_WORKER_VERSION_REFRESH_MS) || 5 * 60_000;

/**
 * WorkerPool — `Map<key, ClaudeWorker[]>` router keyed by (model × prompt-hash).
 *
 * Plan 03 turns the Plan-02 skeleton into the steady-state fast path:
 *   - lazy-spawn workers per (model × prompt) key on first fallback (D-07 — no
 *     allow-list; pools stay cold until that key's first CLI-fallback request).
 *   - concurrency-1 per worker with sibling dispatch up to
 *     `LLM_PROXY_WORKER_POOL_SIZE` (default 2, D-05).
 *   - all-busy-at-cap -> `overflowFn` (D-06 = completeClaudeCodeViaCLI); NOT a
 *     queue, NOT an unbounded spawn.
 *   - strict per-model isolation (Pitfall 2 / Q2 — a model-A worker is never
 *     handed to a model-B request; the model is part of the key).
 *   - recycle/staleness handling: a `needsRecycle`/`isStale` worker (Plan 02
 *     threshold-driven flag, or a reaped-on-exit worker) is drained + dropped
 *     before reuse so cross-call context never leaks (Pitfall 1 / Security V3).
 *   - LRU prompt-pool cap (D-02): when the number of distinct (model × prompt)
 *     keys exceeds `LLM_PROXY_WORKER_PROMPT_CAP`, the least-recently-used key's
 *     workers are drained/evicted.
 *
 * Injectable `deps` (resolveClaudeModel/buildClaudeEnv/claudeCli/spawn/log/logErr)
 * let the parent reuse the proxy's auth/model/logging helpers AND let the unit
 * suite drive the pool deterministically without a live CLI.
 */
export class WorkerPool {
  /**
   * @param {object} [opts]
   * @param {number}   [opts.size]            - workers per (model × prompt) key (D-05).
   * @param {number}   [opts.promptCap]       - LRU cap on distinct prompt-pools (D-02).
   * @param {Function} [opts.resolveClaudeModel] - body.model -> haiku/sonnet/opus.
   * @param {Function} [opts.buildClaudeEnv]  - env builder forwarded to each worker.
   * @param {string}   [opts.claudeCli]       - CLI path forwarded to each worker.
   * @param {Function} [opts.spawn]           - spawn impl forwarded to each worker.
   * @param {Function} [opts.log]             - info logger (spawn/overflow/evict events).
   * @param {Function} [opts.logErr]          - error logger.
   * @param {Function} [opts.readVersion]     - GUARD-02 CLI version reader for the drift snapshot
   *   (default: best-effort `claudeCli --version`); forwarded to each worker's boot-version capture.
   * @param {number}   [opts.versionRefreshMs] - coarse re-probe cadence for the version snapshot (D-03).
   * @param {Function} [opts.workerFactory]   - test seam: build a worker (model, prompt) -> ClaudeWorker.
   */
  constructor(opts = {}) {
    this.size = opts.size ?? DEFAULT_POOL_SIZE;
    this.promptCap = opts.promptCap ?? DEFAULT_PROMPT_CAP;

    // D-06 / WLIFE-03 crash-cooldown config + per-key crash-frequency tracking.
    // `_crashesByKey` is a Map<key, number[]> of recent crash timestamps (the
    // minimal representation, Claude's-Discretion); `_recordCrash` prunes to the
    // window on every push, so a key only stays "hot" while crashes keep landing.
    this._crashThreshold = opts.crashThreshold ?? DEFAULT_CRASH_THRESHOLD;
    this._crashWindowMs = opts.crashWindowMs ?? DEFAULT_CRASH_WINDOW_MS;
    this._crashesByKey = new Map();

    // Helpers reused from the parent (server.mjs) so workers share the proxy's
    // auth/model/logging surface; defaults keep the module self-contained + the
    // unit suite injection-free where it constructs its own workers directly.
    this._resolveModel = opts.resolveClaudeModel || resolveClaudeModel;
    this._buildEnv = opts.buildClaudeEnv;
    this._claudeCli = opts.claudeCli;
    this._spawn = opts.spawn;
    this._log = opts.log || (() => {});
    this._logErr = opts.logErr || (() => {});
    this._workerFactory = opts.workerFactory || null;

    // GUARD-02 / D-01..D-03 — process-level "current version" snapshot for the
    // CLI-drift recycle. The reader is the SAME best-effort, degrade-open probe
    // each worker uses (default: `claudeCli --version`), injectable via
    // `opts.readVersion` so the unit suite simulates a CLI upgrade with NO real
    // binary. The snapshot is captured ONCE at construction and re-probed only on
    // a COARSE cadence (D-03): lazily, at most once per `_versionRefreshMs`, the
    // first time `complete()` runs after the interval elapses — NEVER per request.
    // Drift detection on the hot path is an O(1) string-equality check against
    // `_currentVersion`; there is no execFile in `complete()`. A worker is also
    // constructed with this same `readVersion` so its `_bootVersion` and the
    // pool snapshot share a representation, making drift a direct `!==` compare.
    this._readVersion = opts.readVersion || (() => defaultReadClaudeVersion(this._claudeCli));
    this._versionRefreshMs = opts.versionRefreshMs ?? DEFAULT_VERSION_REFRESH_MS;
    this._currentVersion = this._readVersionSafe();
    this._lastVersionProbeAt = Date.now();

    // key -> ClaudeWorker[]. Map iteration order is insertion order; the LRU
    // touch (delete+set) re-inserts a key at the tail so the FIRST entry is
    // always the least-recently-used (D-02).
    this.workersByKey = new Map();
  }

  /** D-01 / Pattern 2 keying — never collapse to model-only (Q1). */
  keyFor(body) {
    return workerKeyFor(body);
  }

  /** LRU touch: move `key` to the tail (most-recently-used) of the Map. */
  _touch(key, workers) {
    this.workersByKey.delete(key);
    this.workersByKey.set(key, workers);
  }

  /**
   * Build a fresh worker for (model × prompt). Uses the injected `workerFactory`
   * if provided (test seam), otherwise constructs a real `ClaudeWorker` with the
   * proxy's spawn/env/cli deps. On worker 'exit' it is dropped from its pool so a
   * reaped subprocess is never reused (the worker also self-flags needsRecycle).
   */
  _spawnWorker(key, model, systemPrompt) {
    let worker;
    if (this._workerFactory) {
      worker = this._workerFactory(model, systemPrompt);
    } else {
      worker = new ClaudeWorker(model, systemPrompt, {
        spawn: this._spawn,
        claudeCli: this._claudeCli,
        buildEnv: this._buildEnv,
        // GUARD-02: the worker stamps _bootVersion from the SAME reader the pool
        // snapshots from, so drift is a direct string-equality compare at reuse.
        readVersion: this._readVersion,
        // GUARD-03 / D-06: thread the pool's loggers into the worker so its
        // throttled stderr sample reaches the proxy logs (default no-op at both
        // levels keeps test-constructed workers silent).
        log: this._log,
        logErr: this._logErr,
      });
    }
    // D-06 / WLIFE-03: EVERY exit on a freshly-spawned worker is recorded as a
    // crash candidate for its key, alongside the existing `_dropWorker` reap
    // backstop (D-08). HEURISTIC (documented in the SUMMARY): we do not try to
    // classify "boot crash vs healthy churn" at the exit site — we record every
    // exit and rely on the window+threshold to ignore healthy churn. A healthy
    // worker that serves traffic for minutes and then exits (idle-evict, recycle,
    // shutdown) produces at most one timestamp per worker, spaced far apart, so
    // it never accumulates to the threshold within the (short) crash window. Only
    // a key whose spawns die in a BURST — a persistently-broken key — crosses the
    // threshold and trips cooldown. This keeps the exit handler simple and avoids
    // a per-worker "served-ok" flag the live CLI path would have to maintain.
    worker.once?.('exit', () => {
      this._recordCrash(key);
      this._dropWorker(key, worker);
    });
    this._log(`worker-pool: spawned worker pid=${worker.pid} key=${key}`);
    return worker;
  }

  /**
   * D-06 / WLIFE-03 — record a crash timestamp for `key` and prune entries older
   * than the crash window. `_crashesByKey` is a Map<key, number[]> of recent
   * crash times; pruning on every push keeps the list bounded to the window so a
   * key only stays "hot" while crashes keep landing. The key is removed from the
   * map once its (pruned) list is empty so the map never accumulates cold keys.
   */
  _recordCrash(key) {
    const now = Date.now();
    const cutoff = now - this._crashWindowMs;
    const recent = (this._crashesByKey.get(key) || []).filter((t) => t > cutoff);
    recent.push(now);
    this._crashesByKey.set(key, recent);
  }

  /**
   * D-06 / WLIFE-03 — is `key` currently in crash cooldown? True iff it has at
   * least `_crashThreshold` crashes still inside the window. We prune the list to
   * the window first (and drop a now-cold key from the map) so the gate naturally
   * LIFTS once the window elapses with no new crashes — at which point `complete`
   * falls through to the normal lazy-spawn path (Context: "the key is allowed to
   * lazily spawn again").
   */
  _isInCooldown(key) {
    const recent = this._crashesByKey.get(key);
    if (!recent || recent.length === 0) return false;
    const cutoff = Date.now() - this._crashWindowMs;
    const pruned = recent.filter((t) => t > cutoff);
    if (pruned.length === 0) {
      this._crashesByKey.delete(key);
      return false;
    }
    if (pruned.length !== recent.length) this._crashesByKey.set(key, pruned);
    return pruned.length >= this._crashThreshold;
  }

  /**
   * D-08 — canonical synchronous lifecycle disposal. SIGTERM the worker AND
   * splice it from `workersByKey[key]` on the SAME tick, before any async
   * `'exit'` event fires. This closes the acquire-after-SIGTERM race: a
   * concurrent `acquire` (`workers.find((w) => !w.busy)` in `complete`) can never
   * be handed a worker that has already been SIGTERMed but not yet removed.
   *
   * The `'exit'`-driven `_dropWorker` backstop wired in `_spawnWorker` stays in
   * place as the idempotent async reaper for UNEXPECTED crashes — `_dropWorker`'s
   * `indexOf === -1` guard makes the later double-drop a safe no-op.
   *
   * This is the path Plans 03 (crash-cooldown) and 04 (cancel) reuse, and the
   * one the post-request recycle `finally` and the idle-timer eviction funnel
   * through, so there is exactly ONE lifecycle-disposal ordering in the pool.
   */
  _disposeAndDrop(key, worker) {
    try { worker.dispose(); } catch { /* best-effort */ }
    this._dropWorker(key, worker); // CR-02: splices + prunes the key if now empty
  }

  /** Remove a worker from its key's list (reaped/stale); delete the key if now empty (CR-02). */
  _dropWorker(key, worker) {
    const workers = this.workersByKey.get(key);
    if (!workers) return;
    const idx = workers.indexOf(worker);
    if (idx !== -1) workers.splice(idx, 1);
    // CR-02: never leave an empty array registered — it would inflate
    // workersByKey.size and corrupt the LRU cap (_enforcePromptCap).
    if (workers.length === 0) this.workersByKey.delete(key);
  }

  /**
   * GUARD-02 / D-03 / D-04 — read the current CLI version through the injected
   * reader, degrading open: any throw/empty result yields `undefined` (drift
   * detection then disables itself rather than spuriously recycling every worker
   * against a phantom version). Mirrors the worker's boot-version degrade-open.
   */
  _readVersionSafe() {
    try {
      const v = this._readVersion();
      return v || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * GUARD-02 / D-03 — force a re-read of the current-version snapshot NOW and
   * stamp the probe time. Public so the unit suite can drive the coarse cadence
   * deterministically (simulate a CLI upgrade between two acquires) and so an
   * operator/integration can refresh on demand. Never throws (degrade-open).
   */
  refreshVersionSnapshot() {
    this._currentVersion = this._readVersionSafe();
    this._lastVersionProbeAt = Date.now();
    return this._currentVersion;
  }

  /**
   * GUARD-02 / D-03 — lazy COARSE refresh: re-probe the snapshot only when the
   * refresh window has elapsed since the last probe. Called once at the TOP of
   * `complete()` so the version reader runs at most ~once per `_versionRefreshMs`
   * regardless of request rate — the per-request drift check itself is a pure
   * string-equality compare against the cached `_currentVersion` (no exec).
   */
  _maybeRefreshVersionSnapshot() {
    if (Date.now() - this._lastVersionProbeAt >= this._versionRefreshMs) {
      this.refreshVersionSnapshot();
    }
  }

  /**
   * GUARD-02 / D-01..D-04 — has `worker` drifted from the pool's current CLI
   * version? True ONLY when BOTH the worker's `_bootVersion` AND the pool snapshot
   * are truthy and they differ. A falsy boot version (probe failed at boot) or a
   * falsy snapshot (probe failed at the pool) degrades OPEN — the worker is never
   * flagged for drift and is reused normally (D-04). O(1) string equality.
   */
  _isVersionDrifted(worker) {
    const boot = worker && worker._bootVersion;
    if (!boot) return false; // degrade-open: no boot version -> never recycle
    if (!this._currentVersion) return false; // degrade-open: no snapshot -> never recycle
    return boot !== this._currentVersion;
  }

  /**
   * GUARD-02 — flag every version-drifted worker in `workers` for recycle so the
   * EXISTING `_reapStale` drain+respawn path disposes it before reuse. Sets the
   * SAME `needsRecycle`/`isStale` signals the threshold-driven recycle uses (D-02
   * — no parallel mechanism); the next request for the key then lazily respawns a
   * worker booted against the new version.
   */
  _flagDriftedWorkers(workers) {
    for (const w of workers) {
      if (this._isVersionDrifted(w)) {
        w.needsRecycle = true;
        w.isStale = true;
        this._log(`worker-pool: CLI version drift (boot=${w._bootVersion} now=${this._currentVersion}) -> recycle pid=${w.pid}`);
      }
    }
  }

  /** Drain + drop every stale/recycle-flagged worker for a key before reuse (Pitfall 1). */
  _reapStale(key, workers) {
    for (let i = workers.length - 1; i >= 0; i--) {
      const w = workers[i];
      if (w.needsRecycle || w.isStale) {
        try { w.dispose(); } catch { /* best-effort */ }
        workers.splice(i, 1);
        this._log(`worker-pool: drained stale worker pid=${w.pid} key=${key}`);
      }
    }
    // CR-02: caller (complete) prunes the key after reap if the array emptied;
    // _dropWorker handles the exit-driven path. Keep this method array-focused.
  }

  /**
   * LRU-evict the least-recently-used prompt-pool when distinct keys exceed the
   * cap (D-02). The Map's first key is the LRU (insertion/touch order); drain its
   * workers and remove it. Skips the key currently being served so we never evict
   * the pool we are about to dispatch to.
   */
  _enforcePromptCap(activeKey) {
    // CR-02: count only NON-EMPTY prompt-pools toward the cap. Empty arrays
    // should already be pruned by _dropWorker/complete, but counting non-empty
    // pools makes the cap robust to any residual empties and matches D-02's
    // intent (cap on *active* prompt-pools, not dangling map entries).
    const countActivePools = () => {
      let n = 0;
      for (const arr of this.workersByKey.values()) {
        if (arr.length > 0) n += 1;
      }
      return n;
    };

    while (countActivePools() > this.promptCap) {
      let victimKey = null;
      for (const [k, arr] of this.workersByKey) {
        if (k === activeKey) continue;
        if (arr.length === 0) continue; // empty pools are not eviction victims
        // CR-02: never evict a pool that has a busy (in-flight) worker — disposing
        // it would SIGTERM a concurrently-running request on another key. Defer.
        if (arr.some((w) => w.busy)) continue;
        victimKey = k;
        break;
      }
      if (victimKey === null) break; // no evictable (idle, non-active) pool
      const victims = this.workersByKey.get(victimKey) || [];
      for (const w of victims) {
        try { w.dispose(); } catch { /* best-effort */ }
      }
      this.workersByKey.delete(victimKey);
      this._log(`worker-pool: LRU-evicted prompt-pool key=${victimKey} (cap=${this.promptCap})`);
    }
  }

  /**
   * Complete a request through the pool (the CLI-fallback fast path):
   *   1. key by (resolved model × prompt-hash) — strict per-model isolation.
   *   2. lazily create the key's pool on first use (D-07).
   *   3. reap any stale/recycle workers, then acquire a FREE worker; if none is
   *      free and the pool is below `size`, spawn a sibling (D-05).
   *   4. if all workers are busy at cap, call `overflowFn` (D-06) exactly once.
   *   5. enforce the LRU prompt-pool cap (D-02).
   * Wires `abortSignal` to SIGTERM+dispose+drop (in-flight) or queue-dequeue
   * (queued) on abort — D-01/D-03/WLIFE-04, NEVER the hanging `worker.cancel()`.
   */
  async complete(body, abortSignal, overflowFn) {
    const key = this.keyFor(body);
    const model = this._resolveModel(body?.model || 'sonnet');
    const systemPrompt = extractSystemPromptPublic(body);
    const content = extractUserPrompt(body);

    // GUARD-02 / D-03 — coarse, lazy refresh of the current-version snapshot. This
    // is the ONLY version read on this path and it self-throttles to ~once per
    // `_versionRefreshMs`; the drift check below is a pure string compare (no exec).
    this._maybeRefreshVersionSnapshot();

    // GUARD-01 (defense-in-depth): when the worker pool is globally disabled,
    // bypass the pool entirely and route to the execFile overflow — no worker is
    // spawned, response shape is the baseline {content,model,tokens}. The dispatcher
    // (server.mjs viaCliPath) is the PRIMARY gate; honoring the flag here too means
    // "disable the whole mechanism" (D-09) holds even for direct pool callers.
    if (process.env.LLM_PROXY_DISABLE_WORKER_POOL === '1') {
      if (typeof overflowFn === 'function') return overflowFn(body, abortSignal);
      throw new Error('worker pool disabled (LLM_PROXY_DISABLE_WORKER_POOL=1) and no overflow function provided');
    }

    // D-06 / WLIFE-03 — crash-cooldown gate. Checked here, immediately AFTER the
    // GUARD-01 disable check and BEFORE the lazy-spawn acquire below, so a
    // persistently-broken key (>= `_crashThreshold` crashes within
    // `_crashWindowMs`) NEVER spawns another doomed worker: it routes straight to
    // the SAME execFile overflow the all-busy path uses — today's pre-milestone
    // `completeClaudeCodeViaCLI` behavior — for the cooldown duration, instead of
    // spawn->crash->RETRYABLE on every request. `_isInCooldown` prunes the crash
    // list to the window, so once the window elapses with no new crash the gate
    // lifts and we fall through to normal lazy-spawn (the key may spawn again).
    if (this._isInCooldown(key)) {
      if (typeof overflowFn === 'function') {
        this._log(`worker-pool: key=${key} in crash cooldown -> overflow (D-06)`);
        return overflowFn(body, abortSignal);
      }
      throw new Error('worker pool key in crash cooldown and no overflow function provided');
    }

    // CR-02: do NOT eagerly register an empty array for a new key. An empty
    // pool that never gets a worker (overflow path, or missing overflowFn)
    // would otherwise stay in the map, count toward workersByKey.size, drive
    // _enforcePromptCap to evict LIVE pools, and accumulate unbounded under
    // key churn — defeating D-02. We only set() the key once a worker joins it
    // (the existing-key branch re-touches; the new-key branch registers on
    // spawn), and we delete the entry whenever its array empties.
    let workers = this.workersByKey.get(key);
    const keyExisted = workers !== undefined;
    if (!workers) workers = []; // candidate array — registered only on spawn
    if (keyExisted) {
      this._touch(key, workers); // LRU: mark this existing key most-recently-used
      // GUARD-02: flag any CLI-version-drifted worker for recycle FIRST, so the
      // _reapStale pass below drains it on this SAME reuse (before it serves the
      // next request). Drift reuses the needsRecycle/isStale signals (D-02).
      this._flagDriftedWorkers(workers);
      // Drop stale/recycle workers before reuse (Pitfall 1 — bound context leak).
      this._reapStale(key, workers);
      // _reapStale may have emptied the array; prune the dangling key (CR-02).
      if (workers.length === 0) this.workersByKey.delete(key);
    }

    // Acquire a free worker, or spawn a sibling up to `size` (D-05).
    let worker = workers.find((w) => !w.busy);
    if (!worker && workers.length < this.size) {
      worker = this._spawnWorker(key, model, systemPrompt);
      workers.push(worker);
      // Register (or re-register) the key now that it has a live worker (CR-02).
      this.workersByKey.set(key, workers);
      this._touch(key, workers);
    }

    // All workers busy at cap -> D-06 overflow (NOT a queue, NOT an extra spawn).
    if (!worker) {
      // CR-02: the overflow path must NOT leave an empty array behind. If this
      // key has no live workers (brand-new key that went straight to overflow,
      // or one whose workers were all reaped above), ensure it is not in the map.
      if (workers.length === 0) this.workersByKey.delete(key);
      if (typeof overflowFn === 'function') {
        this._log(`worker-pool: all ${workers.length} workers busy for key=${key}; overflow -> execFile (D-06)`);
        return overflowFn(body, abortSignal);
      }
      throw new Error('no free worker and no overflow function provided');
    }

    // D-01 / D-03 / WLIFE-04 — client-disconnect / request-abort propagation.
    // The Phase-62 `worker.cancel()` seam (protocol interrupt) is DEAD for this
    // path: it was live-proved to HANG the real claude stream (62-HUMAN-UAT.md
    // test 6). The disconnect path must NEVER call it. Instead:
    //   - if the aborted request is the IN-FLIGHT one (no longer in `_queue`,
    //     i.e. it became `_pending`) -> SIGTERM + dispose + SYNCHRONOUS drop via
    //     `_disposeAndDrop` (D-08). The SIGTERM'd subprocess's 'exit' fires
    //     `_onExit`, which rejects the in-flight `_pending` RETRYABLE; the
    //     synchronous splice means a concurrent `acquire` can never pick the
    //     SIGTERMed worker, and the next same-key request lazily cold-respawns.
    //   - if the aborted request is still QUEUED -> `abortQueuedJob` splices ONLY
    //     that job and rejects it RETRYABLE; the worker + its different in-flight
    //     request are left untouched (D-03).
    // We use `writeTracked` to hold THIS call's `job` reference so the handler can
    // tell which case applies. `onAbort` is a no-op once the request has settled
    // (the `finally` removes the listener), and `abortQueuedJob`/`_disposeAndDrop`
    // are guarded so a late/duplicate abort is harmless.
    // Prefer the tracked write so the abort handler can identify THIS request's
    // job (D-03 discrimination). A worker that only exposes the plain `write`
    // contract still works — the abort handler then has no `job` to match against
    // the queue and falls through to the in-flight dispose path (D-01).
    let writePromise;
    let job = null;
    if (typeof worker.writeTracked === 'function') {
      ({ promise: writePromise, job } = worker.writeTracked(content, body?.timeout));
    } else {
      writePromise = worker.write(content, body?.timeout);
    }

    const handleAbort = () => {
      // D-03: targeted queued abort first. If the job is still in the worker's
      // FIFO queue, dequeue+reject only it and leave the worker alive.
      try {
        if (worker.abortQueuedJob?.(job)) return;
      } catch { /* best-effort: fall through to the in-flight dispose */ }
      // D-01: otherwise the job is (or has become) the in-flight request —
      // SIGTERM+dispose+synchronously-drop the worker. _onExit rejects _pending
      // RETRYABLE; the synchronous drop closes the acquire-after-SIGTERM race.
      try { this._disposeAndDrop(key, worker); } catch { /* best-effort */ }
    };

    let onAbort;
    if (abortSignal) {
      if (abortSignal.aborted) {
        handleAbort();
      } else {
        onAbort = () => handleAbort();
        abortSignal.addEventListener?.('abort', onAbort, { once: true });
      }
    }

    try {
      // CR-01: thread body.timeout into the per-request timer (mirrors the
      // execFile path's `body.timeout || 120_000`, server.mjs:1075). Undefined
      // falls back to the worker's _requestTimeoutMs default.
      return await writePromise;
    } finally {
      if (abortSignal && onAbort) {
        abortSignal.removeEventListener?.('abort', onAbort);
      }
      // If the worker flipped to needsRecycle on this turn, drain it now so the
      // next request to this key gets a fresh-context worker. Delegate to the
      // canonical synchronous dispose+drop path (D-08) so there is one lifecycle
      // disposal ordering shared with idle-evict / cancel / cooldown.
      if (worker.needsRecycle || worker.isStale) {
        this._disposeAndDrop(key, worker); // D-08: dispose() + synchronous splice+prune
        this._log(`worker-pool: post-request recycle worker pid=${worker.pid} key=${key}`);
      }
      this._enforcePromptCap(key); // D-02
    }
  }

  /**
   * Drain every worker across all keys so the proxy shutdown path reaps them
   * without orphans (basic reap; full idle-evict is Phase 63). Idempotent.
   */
  disposeAll() {
    for (const [key, workers] of this.workersByKey) {
      for (const w of workers) {
        try { w.dispose(); } catch { /* best-effort */ }
      }
      this._log(`worker-pool: disposed ${workers.length} workers for key=${key}`);
    }
    this.workersByKey.clear();
  }
}

// Public alias for the system-prompt extractor so the pool (and tests) can reuse
// the SAME system-vs-user split the worker key derives from (server.mjs:1076-1091).
export function extractSystemPromptPublic(body) {
  const messages = body?.messages || [];
  const systemParts = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
  }
  return systemParts.length > 0 ? systemParts.join('\n\n') : 'You are a helpful assistant.';
}
