// proxy-bridge/routing-config.mjs
//
// The single decision point for "which provider and model serves this call, and
// what do we try if it fails". Reads config/llm-routing.yaml + config/llm-fallback.yaml
// and answers questions about them. It decides nothing on its own: every branch
// below is driven by a value in one of those two files.
//
// This replaces five mechanisms that used to live in server.mjs and could not be
// seen from any config file:
//   • a network-dependent `preferenceOrder` array
//   • PROVIDER_FUNCTION_CALLING, a hardcoded { copilot: true } capability map
//   • CLAUDE_FAMILY, which carried a pinned model across "similar" providers
//   • a heuristic promoting claude-code above copilot on upstream unreachability
//   • subscription-hint string matching on body.subscription
// The first two became config keys. The last three became unnecessary — see the
// comments on buildChain() and resolveRoute().
//
// PURE except for loadRoutingConfig(), which is the only function that touches
// the filesystem. Everything else takes an already-parsed config object, so the
// whole decision surface is unit-testable without fixtures on disk.
//
// Diagnostics go through the caller's logger — no console.* here (CLAUDE.md).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Complexity bands, in ascending order of capability/cost. */
export const COMPLEXITY_BANDS = ['small', 'medium', 'high'];

/**
 * What an offload target is allowed to serve: foreground conversation, background
 * service, or both. Spelled `fg`/`bg` rather than reusing the job-class names
 * (`fg-chat`/`background`) because this is an operator-facing field in the YAML
 * and the pair has to read as a pair. `offloadScopeOf()` maps a job class onto it.
 */
export const OFFLOAD_SCOPES = ['fg', 'bg'];

/** The band value meaning "the caller tells us per request". */
export const FROM_CALLER = 'from-caller';

/**
 * Stage-2 implementations the `classifier:` block may name.
 *
 * The axis these names describe is WHO OWNS THE RUBRIC, not how the bytes
 * travel. Both of the two working impls speak HTTP to an OpenAI-ish endpoint;
 * calling one of them `http` named the one thing they have in common.
 *
 *   none       stages 0+1 only — the structural gate and the cheap veto. Costs
 *              nothing and can never downgrade anything on its own. Not a
 *              disabled state: with `enabled: true` it still runs the free
 *              stages, which is how you find out how much traffic is even
 *              eligible before any model is asked anything.
 *   local-llm  THE PROXY JUDGES. It holds the rubric, picks the model, and asks
 *              an OpenAI-compatible endpoint for a one-word band. Fewest moving
 *              parts; the cost is that changing the rubric or the model means
 *              editing and restarting the component every LLM call goes through.
 *   service    SOMETHING ELSE JUDGES. The proxy sends only the text and takes
 *              the word back — contract is POST /classify {text} -> {band}. The
 *              rubric, the model and what `small` means for this installation
 *              all live at the other end, on their own release schedule. This
 *              is the injection point: bring your own classifier.
 *
 * A hardcoded list rather than a plugin loader, matching how provider `impl`
 * already works (server.mjs dispatches on it through an if/else ladder). An
 * unknown value fails at boot rather than at the first request.
 */
export const CLASSIFIER_IMPLS = ['none', 'local-llm', 'service'];

/**
 * Names that used to mean something and still have to resolve.
 *
 * `http` shipped as the name for `service` and is in at least one running
 * config. Refusing it at boot would turn a rename into an outage on the next
 * restart — and this loader ABORTS on a config it cannot parse, so the blast
 * radius is the whole proxy rather than one route. Accepted, normalised, and
 * warned about once per parse so the file gets fixed rather than forgotten.
 */
const CLASSIFIER_IMPL_ALIASES = { http: 'service' };

/**
 * The `account` values that mean "hardware we run ourselves, nothing is billed".
 *
 * Read off the account id a provider ALREADY declares rather than a new
 * `self_hosted:` flag, because the account is exactly the fact in question:
 * every other value here names something that invoices us (anthropic-subscription,
 * copilot-subscription, an api key with a meter behind it), and these two name a
 * box — `on-device` is this laptop under llama.cpp, `on-prem` the V100 cluster on
 * the corporate LAN. A second field would be a second source of truth for one
 * fact, and could disagree with the first.
 *
 * Both count as ours, and the distinction between them is not the one this is
 * drawing: `on-prem` is not this machine, but no per-token cost is incurred and
 * no prompt leaves the network either way.
 *
 * Adding a self-hosted provider means declaring one of these accounts — a new
 * spelling counts as metered until it is added here, which is the safe direction
 * to be wrong in: it undercounts what ran free rather than claiming a paid call
 * was free.
 */
export const SELF_HOSTED_ACCOUNTS = new Set(['on-device', 'on-prem']);

/**
 * Did this provider's answer come off hardware we run ourselves?
 *
 * @param {{account?: string}|null|undefined} provider a parsed provider entry
 * @returns {boolean}
 */
export function isSelfHosted(provider) {
  return SELF_HOSTED_ACCOUNTS.has(provider?.account);
}

/** Failure classes a fallback chain may be configured to advance on. */
export const RETRY_CLASSES = [
  'quota_exhausted',
  'provider_unavailable',
  'network_error',
  'timeout',
  'gateway_5xx',
];

/**
 * Failure classes worth re-attempting on the SAME provider before advancing the
 * chain, i.e. the ones where the next attempt has a materially different chance
 * of succeeding than the one that just failed.
 *
 * Only `network_error` qualifies. A reset, a DNS blip or a stale keep-alive
 * socket is a property of the CONNECTION, and a fresh connection almost always
 * succeeds — cheaply, because the failure arrives in milliseconds.
 *
 * `timeout` is deliberately absent, and this is the whole reason the class was
 * split out of `network_error` (2026-09-02). A timeout means the provider was
 * reached and did not answer inside its `timeout_ms`: that is a property of the
 * WORK, not of the connection, and retrying it buys a second full timeout for
 * the same verdict. Measured cost of not distinguishing them: `fg-chat/pi`
 * medium turns offloaded to qwen-local spent 2 x 30s discovering the cluster was
 * slow before gh-copilot answered in ~3.5s — 46.6s average against 3.4s for the
 * same band before the offload.
 *
 * Note this is separate from `retry_on`: a timeout still ADVANCES the chain (it
 * is a legitimate reason to try someone else), it just may not be spent twice on
 * the provider that already missed its deadline.
 */
export const SAME_PROVIDER_RETRY_CLASSES = new Set(['network_error']);

/**
 * Map a provider error message onto one of the failure classes above, or null
 * when it is a genuine client/model error that must NOT trigger a fallback.
 * This is the ONE place a message becomes a routing decision.
 *
 * Lives here rather than in server.mjs because the vocabulary it emits is the
 * vocabulary this module validates `retry_on` against — keeping them apart is
 * how `timeout` was able to hide inside `network_error` untested.
 *
 * Order matters twice over:
 *   - quota is checked before the generic 4xx/5xx tests, because a quota refusal
 *     often arrives AS a 402/429 and must not be misread as a plain gateway blip
 *     (one means "this account is spent", the other "try again");
 *   - `timeout` is checked before `gateway_5xx`, so "gateway timeout" keeps the
 *     deadline semantics it has always had rather than acquiring 5xx ones.
 *
 * `aborted` is grouped with the timeouts on the same reasoning: the client gave
 * up waiting. Whether the deadline was ours or theirs, waiting again on the same
 * provider cannot help.
 *
 * @param {string} msg provider error message
 * @returns {'quota_exhausted'|'provider_unavailable'|'network_error'|'timeout'|'gateway_5xx'|null}
 */
export function classifyFailure(msg) {
  const m = String(msg || '');
  if (/QUOTA_EXHAUSTED|quota[_ ]exceeded|rate limit|\b429\b|\b402\b/i.test(m)) return 'quota_exhausted';
  if (/AUTH_ERROR|unauthorized|\b401\b|\b403\b|PROVIDER_UNAVAILABLE|not configured|no dispatch arm/i.test(m)) return 'provider_unavailable';
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|socket hang up|fetch failed|network/i.test(m)) return 'network_error';
  if (/timeout|timed out|aborted/i.test(m)) return 'timeout';
  if (/\b50[0234]\b|bad gateway|service unavailable|gateway timeout/i.test(m)) return 'gateway_5xx';
  return null;
}

/** Guard names a fallback candidate may use in its `when:` block. */
const GUARD_SENSORS = {
  // network: [public|corporate] — matches the value detectNetworkMode() reports.
  network: { values: ['public', 'corporate'] },
};

/** The network sensor reading, defaulting to `public`. One spelling, used everywhere. */
export function normalizeNetwork(network) {
  return network === 'corporate' ? 'corporate' : 'public';
}

/**
 * The offload target that serves this network, or null when none does.
 *
 * First match wins, and an entry with no `require_network` matches everything —
 * the same "declare it, do not infer it" reading the guards elsewhere in this
 * file get. Order is the operator's; the parser refuses two entries that claim
 * the same network, so "first match" can never be a coin toss.
 *
 * A target that is not `enabled` is skipped here rather than removed by the
 * parser, so the dashboard can still list it and switch it back on. Declaring a
 * target and enabling it are deliberately two statements: a local endpoint that
 * is REACHABLE is not thereby one you want serving traffic, and the probe in
 * server.mjs can only establish the first. On 2026-08-29 that gap cost a day —
 * qwen-laptop probes green in milliseconds on loopback and then takes 23-932s
 * to generate, so "available" routed high-volume background work onto an
 * endpoint an order of magnitude slower than the account it displaced.
 *
 * @param {{targets?: Array<{provider: string, requireNetwork: string|null, enabled: boolean}>}} sr
 * @param {string} network
 * @returns {{provider: string, requireNetwork: string|null, enabled: boolean}|null}
 */
export function pickOffloadTarget(sr, network) {
  const live = normalizeNetwork(network);
  for (const t of sr?.targets || []) {
    if (t.enabled === false) continue;
    if (!t.requireNetwork || t.requireNetwork === live) return t;
  }
  return null;
}

/**
 * Human-readable target list, for the `offloadSkipped` reason string.
 *
 * Off targets are named as off rather than omitted. "No target for this
 * network" and "the target for this network is switched off" are different
 * operator errors and the reason string is the only place either one surfaces.
 */
function describeTargets(sr) {
  const list = (sr?.targets || []).map(t => (
    `${t.provider}[${t.requireNetwork || 'any'}/${(t.scope || OFFLOAD_SCOPES).join('+')}`
    // Only when the target narrows. Printing the effective band list on every
    // target would put the global policy in a per-target slot and read as though
    // each one had chosen it.
    + `${t.offloadBands
      ? `/${t.offloadBands.map(b => (t.bandScopes?.[b] ? `${b}:${t.bandScopes[b].join('+')}` : b)).join(',')}`
      : ''}]`
    + `${t.enabled === false ? ' (off)' : ''}`));
  return list.length ? list.join(', ') : 'none declared';
}

/**
 * Why a target's `foreground:` limits keep this call off it, or null when they
 * do not. An unknown size or in-flight count passes: /api/llm/routing/resolve
 * has no prompt, and must keep reproducing the config's decision without one.
 *
 * @param {{provider: string, foreground?: {maxInputTokens: number|null, maxInFlight: number|null}|null}} target
 * @param {{inputTokens?: number, inFlight?: Record<string, number>}} live
 * @returns {string|null}
 */
export function foregroundLimitReason(target, { inputTokens, inFlight } = {}) {
  const lim = target?.foreground;
  if (!lim) return null;
  if (lim.maxInputTokens != null && Number.isFinite(inputTokens) && inputTokens > lim.maxInputTokens) {
    return `target "${target.provider}" takes foreground prompts up to ${lim.maxInputTokens} tokens and this one is ~${inputTokens}`;
  }
  const open = inFlight?.[target.provider] ?? 0;
  if (lim.maxInFlight != null && open >= lim.maxInFlight) {
    return `target "${target.provider}" already has ${open} call(s) in flight (foreground limit ${lim.maxInFlight})`;
  }
  return null;
}

/**
 * Rough input size of a request, for the `foreground.max_input_tokens` gate:
 * ~4 bytes per token over the messages and tool definitions it would send.
 * Coarse on purpose — the gate separates a 500-token title call from a
 * 20K-token first turn, and nothing near the line needs a tokenizer.
 *
 * @param {{messages?: unknown, tools?: unknown}} body
 * @returns {number}
 */
export function estimateInputTokens(body) {
  let bytes = 0;
  try {
    bytes = JSON.stringify(body?.messages ?? []).length + JSON.stringify(body?.tools ?? []).length;
  } catch {
    return 0;
  }
  return Math.ceil(bytes / 4);
}

/** Job classes. A job id starting with `fg-` is foreground; everything else is background. */
export function jobClass(job) {
  return String(job || '').startsWith('fg-') ? 'fg-chat' : 'background';
}

/**
 * Which scopes a target serves FOR A GIVEN BAND.
 *
 * A target declares `scope` (what the box may serve at all) and may declare a
 * per-band scope inside `offload_bands`. The band's entry wins where it exists,
 * and validation has already guaranteed it is a subset of `scope` — so this is
 * a lookup, not a policy decision.
 *
 * @param {{scope?: string[], bandScopes?: Record<string,string[]>|null}} target
 * @param {string} band
 * @returns {string[]}
 */
export function effectiveScopeFor(target, band) {
  return target?.bandScopes?.[band] || target?.scope || [...OFFLOAD_SCOPES];
}

/** The offload-scope token for a job class: `fg-chat` -> 'fg', everything else -> 'bg'. */
export function offloadScopeOf(cls) {
  return cls === 'fg-chat' ? 'fg' : 'bg';
}

// ── Validation ───────────────────────────────────────────────────────────────

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoutingConfigError';
  }
}

function fail(where, message) {
  throw new ConfigError(`${where}: ${message}`);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate + normalize the two parsed YAML documents into one config object.
 *
 * Every failure here is a BOOT failure with a precise message. A routing config
 * that is half-wrong is worse than none: the calls still go somewhere, just not
 * where the file says. So this is strict on purpose — an unknown provider id in
 * a route, a complexity band with no model behind it, or a guard naming a sensor
 * that does not exist all stop the proxy rather than being skipped.
 *
 * @param {object} routingDoc  parsed llm-routing.yaml
 * @param {object} fallbackDoc parsed llm-fallback.yaml
 * @returns {object} validated config
 */
export function parseRoutingConfig(routingDoc, fallbackDoc) {
  if (!isPlainObject(routingDoc)) fail('llm-routing.yaml', 'top level must be a mapping');
  if (!isPlainObject(fallbackDoc)) fail('llm-fallback.yaml', 'top level must be a mapping');
  if (routingDoc.version !== 1) fail('llm-routing.yaml', `unsupported version ${routingDoc.version} (expected 1)`);
  if (fallbackDoc.version !== 1) fail('llm-fallback.yaml', `unsupported version ${fallbackDoc.version} (expected 1)`);

  // Non-fatal findings. A config can be imperfect without being unusable, and
  // the difference matters: this file refusing to parse means the proxy serves
  // NOTHING, so anything recoverable belongs here rather than in fail().
  const warnings = [];

  // ── providers ──
  if (!isPlainObject(routingDoc.providers) || Object.keys(routingDoc.providers).length === 0) {
    fail('llm-routing.yaml providers', 'must be a non-empty mapping');
  }
  const providers = {};
  for (const [id, raw] of Object.entries(routingDoc.providers)) {
    const where = `llm-routing.yaml providers.${id}`;
    if (!isPlainObject(raw)) fail(where, 'must be a mapping');
    const enabled = raw.enabled !== false;
    const impl = raw.impl == null ? null : String(raw.impl);
    // A provider that can be routed to needs something to route to. Declaring a
    // provider with no impl is fine (it documents the taxonomy); enabling one is not.
    if (enabled && !impl) {
      fail(where, 'enabled provider has no `impl` — either give it a runtime implementation or set enabled: false');
    }
    // What this account can serve, independent of which band currently points
    // where. The band table is a CHOICE out of this catalogue; keeping the two
    // separate is what lets the dashboard offer alternatives for a band, and
    // what lets a retired model id fail at boot instead of on the next call.
    if (raw.available_models != null && !Array.isArray(raw.available_models)) {
      fail(`${where}.available_models`, 'must be a list of model id strings');
    }
    const availableModels = (raw.available_models || []).map((m, i) => {
      if (!m || typeof m !== 'string') {
        fail(`${where}.available_models[${i}]`, 'must be a non-empty model id string');
      }
      return m;
    });
    const dupe = availableModels.find((m, i) => availableModels.indexOf(m) !== i);
    if (dupe) fail(`${where}.available_models`, `duplicate model id "${dupe}"`);

    const models = isPlainObject(raw.models) ? raw.models : {};
    for (const band of Object.keys(models)) {
      if (!COMPLEXITY_BANDS.includes(band)) {
        fail(`${where}.models`, `unknown complexity band "${band}" (expected one of ${COMPLEXITY_BANDS.join(', ')})`);
      }
      if (!models[band] || typeof models[band] !== 'string') {
        fail(`${where}.models.${band}`, 'must be a non-empty model id string');
      }
      // A band may only name something the account actually serves. Skipped when
      // the catalogue is empty so a provider can be declared before it is probed.
      if (availableModels.length && !availableModels.includes(models[band])) {
        fail(`${where}.models.${band}`, `"${models[band]}" is not in this provider's available_models (${availableModels.join(', ')}) — add it there if the account really serves it, otherwise the band is pointing at a model this account will reject`);
      }
    }
    if (enabled && Object.keys(models).length === 0) {
      fail(`${where}.models`, 'enabled provider must declare at least one complexity band');
    }
    // ── timeout_ms ──
    //
    // How long to wait for THIS provider before giving up and letting the
    // fallback chain take over. Null means the dispatcher's own default (120s).
    //
    // It is per-provider because the right answer is not a property of the
    // request, it is a property of the endpoint and what it displaces. 120s is
    // reasonable for a metered account answering a hard prompt. It is absurd for
    // a semantic-offload target: that call was routed to a local box BECAUSE it
    // was cheap and small, its own provider is sitting first in the fallback
    // chain, and waiting two minutes to discover the local box is wedged makes
    // the offload strictly worse than not having offloaded at all. Measured on
    // 2026-08-29: 48 calls hit the 120s ceiling and averaged 92s before the real
    // provider was even tried, against a 5.4s direct call.
    //
    // It may ALSO be written per band, because a provider's bands can land on
    // models that are not the same kind of thing. qwen-local forced this: its
    // `small` model answers directly (31.0s on a 1131-token completion) while
    // its `medium` model is a REASONING model that spends completion tokens
    // thinking first (70.1s for the same prompt, and far more as context grows).
    // One number cannot serve both — sized for small, medium is cut off
    // mid-thought on every call; sized for medium, a wedged small call makes the
    // high-volume background writers wait minutes on a box that will not answer.
    //
    //   timeout_ms: 30000                 scalar — every band
    //   timeout_ms:                       per band, with an optional default
    //     default: 30000
    //     medium: 210000
    //
    // A band named here wins; anything unnamed falls to `default`, then to the
    // dispatcher's own. Resolution lives in request-timeout.mjs.
    let timeoutMs = null;
    let timeoutMsByBand = null;
    const checkTimeoutValue = (v, key) => {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        fail(key, 'must be a positive number of milliseconds');
      }
      if (v < 1000) {
        fail(key, `${v} looks like seconds — this field is MILLISECONDS, and a sub-second timeout would fail every call`);
      }
      return Number(v);
    };
    if (raw.timeout_ms != null) {
      if (isPlainObject(raw.timeout_ms)) {
        const entries = Object.entries(raw.timeout_ms);
        if (entries.length === 0) {
          fail(`${where}.timeout_ms`, 'is empty — omit it to use the dispatcher default, or state a value');
        }
        timeoutMsByBand = {};
        for (const [key, v] of entries) {
          // Refuse a near-miss key by name rather than ignoring it. A silently
          // dropped `medum:` reads as "the ceiling did not apply" at 3am.
          if (key !== 'default' && !COMPLEXITY_BANDS.includes(key)) {
            fail(`${where}.timeout_ms`, `unknown band "${key}" (expected one of ${COMPLEXITY_BANDS.join(', ')}, or "default")`);
          }
          const n = checkTimeoutValue(v, `${where}.timeout_ms.${key}`);
          if (key === 'default') timeoutMs = n;
          else timeoutMsByBand[key] = n;
        }
        // A band with its own ceiling but no model is a statement about nothing,
        // and almost always a typo for the band that does exist.
        for (const band of Object.keys(timeoutMsByBand)) {
          if (!models[band]) {
            fail(`${where}.timeout_ms`, `band "${band}" has a timeout but no model — provider serves ${Object.keys(models).join(', ') || 'no bands'}`);
          }
        }
        if (Object.keys(timeoutMsByBand).length === 0) timeoutMsByBand = null;
      } else {
        timeoutMs = checkTimeoutValue(raw.timeout_ms, `${where}.timeout_ms`);
      }
    }
    const caps = isPlainObject(raw.capabilities) ? raw.capabilities : {};
    providers[id] = {
      id,
      account: raw.account ? String(raw.account) : 'unknown',
      description: raw.description ? String(raw.description).trim() : '',
      impl,
      timeoutMs,
      timeoutMsByBand,
      // Only a provider carrying fg_transport can serve foreground Claude Code
      // traffic, which arrives on the Anthropic wire protocol at /v1/messages.
      fgTransport: raw.fg_transport ? String(raw.fg_transport) : null,
      enabled,
      capabilities: { tools: caps.tools === true, streaming: caps.streaming === true },
      availableModels,
      models: { ...models },
    };
  }

  const knownProvider = (id, where) => {
    if (!providers[id]) {
      fail(where, `unknown provider "${id}" (declared providers: ${Object.keys(providers).join(', ')})`);
    }
    if (!providers[id].enabled) {
      fail(where, `provider "${id}" is disabled and cannot be routed to`);
    }
    return providers[id];
  };

  // Chain-only variant of the check above. An UNKNOWN provider is still fatal —
  // it is a typo, and no spelling of it will ever be routable. A DISABLED one is
  // merely premature: the operator has declared the account and not yet brought
  // the endpoint up, which is the normal state for exactly as long as that takes.
  //
  // WHY THE ASYMMETRY WITH ROUTES. A route naming a dead provider silently
  // misroutes real traffic, so it keeps failing loudly at boot. A chain entry is
  // only a degradation path: dropping it costs one fallback candidate and
  // nothing else. Treating the two the same is what took the router down on
  // 2026-08-28 — a chain for a not-yet-enabled provider was added ahead of its endpoint, and the proxy
  // refused its whole config rather than skip one unreachable candidate, so
  // every provider stopped serving. Softening this is the durable fix; deleting
  // that one chain was only the immediate one.
  const routableInChain = (id, where) => {
    if (!providers[id]) {
      fail(where, `unknown provider "${id}" (declared providers: ${Object.keys(providers).join(', ')})`);
    }
    if (!providers[id].enabled) {
      warnings.push(`${where}: provider "${id}" is disabled — skipping this fallback candidate`);
      return null;
    }
    return providers[id];
  };

  // A route entry: { provider, complexity }. Shared by `routes` and `defaults`.
  const normalizeRouteEntry = (raw, where) => {
    if (!isPlainObject(raw)) fail(where, 'must be a mapping with `provider` and `complexity`');
    if (!raw.provider) fail(where, 'missing `provider`');
    const provider = knownProvider(String(raw.provider), where);
    const complexity = raw.complexity == null ? 'medium' : String(raw.complexity);
    if (complexity !== FROM_CALLER && !COMPLEXITY_BANDS.includes(complexity)) {
      fail(where, `unknown complexity "${complexity}" (expected ${COMPLEXITY_BANDS.join(', ')} or ${FROM_CALLER})`);
    }
    // A fixed band must have a model behind it on the chosen provider. Catching
    // this at boot is the difference between a config typo and a 3am 400.
    if (complexity !== FROM_CALLER && !provider.models[complexity]) {
      fail(where, `provider "${provider.id}" declares no model for complexity "${complexity}" (has: ${Object.keys(provider.models).join(', ') || 'none'})`);
    }
    // `offload: false` pins a route to its declared provider even when semantic
    // routing would otherwise move it. It exists for routes where the model that
    // answers IS the measurement (bg-kgbench-judge, bg-kb-ab-coinage) — silently
    // changing those changes what the numbers mean. Absent = eligible.
    if (raw.offload != null && typeof raw.offload !== 'boolean') {
      fail(`${where}.offload`, 'must be true or false');
    }
    const entry = { provider: provider.id, complexity };
    if (raw.offload === false) entry.offload = false;
    if (raw.model_profiles != null) {
      if (!isPlainObject(raw.model_profiles)) {
        fail(`${where}.model_profiles`, 'must be a mapping of requested model id to band overrides');
      }
      entry.modelProfiles = {};
      for (const [requestedModel, profile] of Object.entries(raw.model_profiles)) {
        if (!requestedModel || !isPlainObject(profile)) {
          fail(`${where}.model_profiles.${requestedModel || '(empty)'}`, 'must be a mapping of complexity band to model id');
        }
        entry.modelProfiles[requestedModel] = {};
        for (const [band, model] of Object.entries(profile)) {
          if (!COMPLEXITY_BANDS.includes(band)) {
            fail(`${where}.model_profiles.${requestedModel}.${band}`, `unknown complexity band (expected one of ${COMPLEXITY_BANDS.join(', ')})`);
          }
          if (typeof model !== 'string' || !model.trim()) {
            fail(`${where}.model_profiles.${requestedModel}.${band}`, 'must be a non-empty model id');
          }
          if (provider.availableModels.length && !provider.availableModels.includes(model)) {
            fail(`${where}.model_profiles.${requestedModel}.${band}`, `"${model}" is not in provider "${provider.id}" available_models`);
          }
          entry.modelProfiles[requestedModel][band] = model;
        }
      }
    }
    return entry;
  };

  // ── defaults ── (validated first: `from-caller` routes fall back to them)
  if (!isPlainObject(routingDoc.defaults)) fail('llm-routing.yaml defaults', 'must be a mapping');
  const defaults = {};
  for (const cls of ['fg-chat', 'background']) {
    if (!routingDoc.defaults[cls]) fail('llm-routing.yaml defaults', `missing required class "${cls}"`);
    const entry = normalizeRouteEntry(routingDoc.defaults[cls], `llm-routing.yaml defaults.${cls}`);
    if (entry.complexity === FROM_CALLER) {
      fail(`llm-routing.yaml defaults.${cls}`, `complexity cannot be "${FROM_CALLER}" — defaults are what a caller-less request falls back TO`);
    }
    defaults[cls] = entry;
  }

  // ── routes ──
  const routes = {};
  const routeDoc = isPlainObject(routingDoc.routes) ? routingDoc.routes : {};
  for (const [key, raw] of Object.entries(routeDoc)) {
    const where = `llm-routing.yaml routes.${key}`;
    if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/i.test(key)) {
      fail(where, 'route key must be `<job>` or `<job>/<agent>` (lowercase, dot/dash/underscore allowed)');
    }
    const entry = normalizeRouteEntry(raw, where);
    // Foreground Claude Code cannot be translated onto an OpenAI-shaped provider
    // yet, so a route naming one is refused at boot rather than at 3am on the
    // first request. See llm-routing.yaml `fg_transport`.
    if (key === 'fg-chat/claude' && !providers[entry.provider].fgTransport) {
      fail(where, `provider "${entry.provider}" has no fg_transport — foreground Claude Code speaks the Anthropic wire protocol and cannot currently be served by this provider. Give the provider an fg_transport, or route fg-chat/claude to one that has it.`);
    }
    routes[key] = entry;
  }

  // ── semantic routing ──
  //
  // The offload policy: when enabled, work whose resolved complexity band is in
  // `offload_bands` goes to `local_provider` instead of the provider its route
  // names, and the route's own provider becomes the first fallback (buildChain).
  //
  // This block is not itself a classifier: it moves work whose band is already
  // decided, and it never reads a prompt. The band comes from the route, or from
  // the caller under `from-caller`.
  //
  // AMENDED 2026-08-30. This comment used to end "re-deriving that from prompt
  // content would add a decision step to the hot path and make 'why did this
  // call go there?' unanswerable from the config alone". The objection was
  // right, and measurement showed the premise it rested on was not: `from-caller`
  // only works when the caller declares something USEFUL. pi declared `medium`
  // on every turn because that is where its thinking slider sits, and opencode
  // declared nothing at all — so across one session, 11 pi turns and 22 opencode
  // turns were ineligible for the offload for reasons that had nothing to do
  // with the requests. "How many r's in strawberry" ran on sonnet-4.6.
  //
  // There IS a classifier now (proxy-bridge/prompt-classifier.mjs, the
  // `classifier:` block below), and it is shaped specifically to keep the
  // property this objection names:
  //
  //   • DOWNGRADE-ONLY — it can lower a band, never raise one, so the config's
  //     band remains the ceiling and the worst case is the old behaviour.
  //   • Its verdict is a distinct `complexitySource` of 'classifier', recorded
  //     on the row and in the routing trail, never blended into 'caller'.
  //   • /api/llm/routing/resolve takes `classified=<band>`, so every decision is
  //     still reproducible from the config alone, without the prompt.
  //
  // The hot-path cost is real and bounded by a structural gate that runs first:
  // a call inside a tool loop is never classified — it inherits the band its
  // turn's first call got (turn-band.mjs, recorded as band source 'turn') — so
  // the classifier is asked at most once per human prompt.
  let semanticRouting = { enabled: false, targets: [], offloadBands: [] };
  if (routingDoc.semantic_routing != null) {
    const where = 'llm-routing.yaml semantic_routing';
    const raw = routingDoc.semantic_routing;
    if (!isPlainObject(raw)) fail(where, 'must be a mapping');
    const enabled = raw.enabled === true;
    const bands = raw.offload_bands == null ? [] : raw.offload_bands;
    if (!Array.isArray(bands)) fail(`${where}.offload_bands`, 'must be a list of complexity bands');
    for (const b of bands) {
      if (!COMPLEXITY_BANDS.includes(String(b))) {
        fail(`${where}.offload_bands`, `unknown band "${b}" (expected one of ${COMPLEXITY_BANDS.join(', ')})`);
      }
    }

    // The single-target spelling this block used to take. There is exactly one
    // way to say this now, and a file still carrying the old keys is a file whose
    // author believes something about routing that is no longer true — so it is
    // named and refused rather than half-honoured.
    for (const dead of ['local_provider', 'require_network']) {
      if (raw[dead] != null) {
        fail(`${where}.${dead}`, `no longer read — the offload target is network-scoped now. Replace it with a \`targets:\` list, e.g.\n  targets:\n    - provider: <the ${dead === 'require_network' ? 'corporate' : 'old local_provider'}>\n      require_network: corporate`);
      }
    }

    // ── targets ──
    //
    // Ordered. The FIRST entry whose require_network matches the live sensor
    // serves the offload; an entry with no require_network matches any network.
    //
    // A LIST rather than one provider because "the local model" is not one
    // machine. The on-prem cluster is on 10/8 and answers only on the corporate
    // network; the laptop's llama.cpp server answers only where the laptop is.
    // With a single target and one guard, an off-VPN session had no local option
    // at all and every `small` call went back to a paid account — which is the
    // state the semantic router was in on 2026-08-28.
    const rawTargets = raw.targets == null ? [] : raw.targets;
    if (!Array.isArray(rawTargets)) fail(`${where}.targets`, 'must be a list of { provider, require_network? } mappings');
    const targets = [];
    const seenNetworks = new Set();
    for (const [idx, t] of rawTargets.entries()) {
      const tw = `${where}.targets[${idx}]`;
      if (!isPlainObject(t)) fail(tw, 'must be a mapping with at least a `provider`');
      if (t.provider == null) fail(tw, 'has no `provider` — there is nothing to offload to');
      const providerId = String(t.provider);
      // ── enabled ──
      //
      // Defaults to FALSE. Declaring a target says where an offload COULD go;
      // enabling it says work should actually be sent there. Keeping those
      // separate is the whole point: a local endpoint is unmetered but not
      // therefore cheap, and the cost it does carry — latency — is invisible to
      // the reachability probe that gates it. Measured on 2026-08-29, over the
      // 66 calls the laptop target served: mean 47s against gh-copilot's 5.4s,
      // worst case 932s for a 59-token observation-writer call, and the 48 calls
      // that timed out and fell back paid 92s on average BEFORE the real
      // provider was even tried. `offload_bands` is global, so that landed on
      // every high-volume background service, not just interactive turns.
      //
      // Opt-in also means a new target cannot start serving traffic by being
      // added, which is how this one did.
      if (t.enabled != null && typeof t.enabled !== 'boolean') {
        fail(`${tw}.enabled`, 'must be true or false');
      }
      const targetEnabled = t.enabled === true;
      // ── scope ──
      //
      // WHICH KIND of work this target may serve: foreground conversation,
      // background service, or both. Defaults to BOTH, which is what the field
      // replaces — `offload_bands` is global, so before this existed a target
      // took every eligible call on its network regardless of who was waiting
      // for it.
      //
      // The two are not interchangeable and one number separates them: a human
      // is waiting on a foreground turn and nothing is waiting on a background
      // one. That makes the tolerable latency opposite. The on-prem cluster is
      // fast enough for both. The laptop is not — measured 2026-08-29, mean 47s
      // against gh-copilot's 5.4s, which is a tolerable trade for bulk work
      // nobody is watching and an unusable one mid-conversation. Yet because
      // scope did not exist, enabling it did the reverse of what it was enabled
      // for: it took bg-observation-writer and bg-auto-measure-title, the two
      // highest-volume services there are, and a 50s call there sits
      // uncomfortably close to the ETM's 60s isProcessing watchdog.
      //
      // Declared per target rather than globally because it is a property of
      // the ENDPOINT, not of the policy: how much latency a box adds is the
      // thing that decides what it may serve.
      let scope = [...OFFLOAD_SCOPES];
      if (t.scope != null) {
        const rawScope = Array.isArray(t.scope) ? t.scope : [t.scope];
        if (rawScope.length === 0) {
          fail(`${tw}.scope`, `is empty — a target that may serve neither foreground nor background work can never be reached, which is what \`enabled: false\` is for`);
        }
        scope = [];
        for (const sRaw of rawScope) {
          const one = String(sRaw);
          if (!OFFLOAD_SCOPES.includes(one)) {
            fail(`${tw}.scope`, `unknown value "${one}" (expected one of ${OFFLOAD_SCOPES.join(', ')})`);
          }
          if (!scope.includes(one)) scope.push(one);
        }
      }
      // ── offload_bands (per target) ──
      //
      // HOW HARD the work this endpoint may take, narrowing the global list.
      // `scope` says who may be WAITING; this says what the box can actually
      // do. Both are properties of the endpoint rather than of the policy, and
      // both exist because the global list could not express them.
      //
      // Added 2026-09-02, when `medium` was made offload-eligible. The cluster
      // serves three tiers and can take it; the laptop declares only a `small`
      // model and averages 47s, so a medium turn there would be worse than not
      // offloading at all. Before this field the global list was the only knob,
      // so widening it to `medium` would have failed boot on the laptop's
      // missing model — turning "let the cluster take medium" into "delete the
      // laptop target".
      //
      // MUST BE A SUBSET of the global list. The global list states what the
      // policy permits; a target states what this box can take out of that. A
      // target that could widen the policy would let one endpoint quietly opt
      // itself into work the operator excluded everywhere, which is the one
      // direction this field must not travel.
      //
      // TWO FORMS, because a band and a scope are not independent (added
      // 2026-09-02, second revision):
      //
      //   offload_bands: [small]              — bands, each at the target `scope`
      //   offload_bands: {small: [fg, bg],    — bands, each with its OWN scope
      //                   medium: [bg]}
      //
      // The list form could not express the case that actually matters here.
      // The on-prem cluster serves `medium` in ~28s against gh-copilot's ~3s, so
      // medium is a bad trade for a foreground turn and a GOOD one for a
      // background service, where nobody is waiting and the cluster is free.
      // With one scope per target that is a single yes/no, and the only
      // answers were "make every foreground turn 8x slower" or "leave the
      // cluster at 1.6% utilisation". Neither is the policy anyone wanted.
      //
      // A band's scope MUST BE A SUBSET of the target's `scope`, for the same
      // reason the bands are a subset of the global list: the target states what
      // the box can serve at all, and a band must not opt the box into work it
      // excluded.
      let targetBands = null;
      let bandScopes = null;
      if (t.offload_bands != null) {
        const isMap = !Array.isArray(t.offload_bands)
          && typeof t.offload_bands === 'object';
        const declared = isMap ? Object.keys(t.offload_bands) : t.offload_bands;
        if (!isMap && !Array.isArray(t.offload_bands)) {
          fail(`${tw}.offload_bands`, 'must be a list of complexity bands, or a map of band -> scope list');
        }
        if (declared.length === 0) {
          fail(`${tw}.offload_bands`, 'is empty — omit it to accept every band in the global `offload_bands`, or set `enabled: false` to take this target out of service');
        }
        targetBands = [];
        if (isMap) bandScopes = {};
        for (const bRaw of declared) {
          const one = String(bRaw);
          if (!COMPLEXITY_BANDS.includes(one)) {
            fail(`${tw}.offload_bands`, `unknown band "${one}" (expected one of ${COMPLEXITY_BANDS.join(', ')})`);
          }
          if (!bands.map(String).includes(one)) {
            fail(`${tw}.offload_bands`, `"${one}" is not in the global offload_bands [${bands.join(', ')}] — a target may narrow what the policy allows, never widen it`);
          }
          if (!targetBands.includes(one)) targetBands.push(one);
          if (!isMap) continue;

          const rawBandScope = t.offload_bands[bRaw];
          const list = Array.isArray(rawBandScope) ? rawBandScope : [rawBandScope];
          if (rawBandScope == null || list.length === 0) {
            fail(`${tw}.offload_bands.${one}`, `is empty — a band that may serve neither foreground nor background work can never be reached, so remove the band instead`);
          }
          const forBand = [];
          for (const sRaw of list) {
            const sOne = String(sRaw);
            if (!OFFLOAD_SCOPES.includes(sOne)) {
              fail(`${tw}.offload_bands.${one}`, `unknown scope "${sOne}" (expected one of ${OFFLOAD_SCOPES.join(', ')})`);
            }
            if (!scope.includes(sOne)) {
              fail(`${tw}.offload_bands.${one}`, `scope "${sOne}" is not in this target's scope [${scope.join(', ')}] — a band may narrow what the target serves, never widen it`);
            }
            if (!forBand.includes(sOne)) forBand.push(sOne);
          }
          bandScopes[one] = forBand;
        }
      }
      // ── foreground (per target) ──
      //
      // Limits on the FOREGROUND work this endpoint takes, because someone is
      // waiting on it and the cluster's cost is not the per-call figure the
      // bands were tuned on. Measured against the cluster directly 2026-10-12,
      // with no other proxy traffic on it:
      //
      //   ~24 in, dual-fast               1.9s   (the floor at any size)
      //   ~2K in, uncached / cached       6.7s / 1.95s
      //   ~20K in, uncached / cached     38.8s / 2.2s   (prefill ~540 tok/s)
      //   4 tiny calls at once           12-18s each
      //   time to first byte             = total: nothing streams
      //
      // An agent's first turn carries 20-28K tokens of system prompt and tool
      // definitions, so an offloaded one spends 40-55s in prefill and hits the
      // 60s ceiling; five-prompt test 2026-10-12: opencode and copilot first
      // turns both timed out and fell back after ~61s. Small calls that
      // overlapped them took 29-39s. And since nothing streams, the ceiling is a
      // bound on the whole answer, not on the wait for its first token.
      //
      //   max_input_tokens  a larger prompt is not offloaded (estimated, ~4
      //                     bytes per token over messages + tools)
      //   timeout_ms        the ceiling for an offloaded foreground call; caps
      //                     the provider's own timeout_ms, never raises it
      //   max_in_flight     with this many calls (fg OR bg) already open on the
      //                     target, a foreground call is not offloaded rather
      //                     than queued behind them
      //
      // Background work is untouched: nobody is waiting on it, and its prompts
      // are what the per-band timeout_ms on the provider was measured against.
      let foreground = null;
      if (t.foreground != null) {
        const fw = `${tw}.foreground`;
        if (!isPlainObject(t.foreground)) fail(fw, 'must be a mapping of max_input_tokens / timeout_ms / max_in_flight');
        const KNOWN = ['max_input_tokens', 'timeout_ms', 'max_in_flight'];
        for (const k of Object.keys(t.foreground)) {
          if (!KNOWN.includes(k)) fail(`${fw}.${k}`, `unknown key (expected one of ${KNOWN.join(', ')})`);
        }
        if (!scope.includes('fg')) {
          fail(fw, `this target's scope is [${scope.join(', ')}] — it never takes foreground work, so these limits could never apply`);
        }
        const positiveInt = (v, key) => {
          if (v == null) return null;
          if (!Number.isInteger(v) || v <= 0) fail(`${fw}.${key}`, 'must be a positive whole number');
          return v;
        };
        const timeoutMs = positiveInt(t.foreground.timeout_ms, 'timeout_ms');
        if (timeoutMs != null && timeoutMs < 1000) {
          fail(`${fw}.timeout_ms`, `${timeoutMs} looks like seconds — this field is MILLISECONDS, and a sub-second timeout would fail every call`);
        }
        foreground = {
          maxInputTokens: positiveInt(t.foreground.max_input_tokens, 'max_input_tokens'),
          timeoutMs,
          maxInFlight: positiveInt(t.foreground.max_in_flight, 'max_in_flight'),
        };
      }
      // Routable-provider checks apply only where work can actually land: the
      // offload must be on AND this target enabled. A block that is switched
      // off may name a provider that is itself still disabled — the normal state
      // while an endpoint is being brought up — and refusing it would force the
      // operator to delete the target rather than switch it off, losing the
      // declaration the dashboard toggles.
      if (enabled && targetEnabled) knownProvider(providerId, `${tw}.provider`);
      else if (!providers[providerId]) {
        fail(`${tw}.provider`, `unknown provider "${providerId}" (declared providers: ${Object.keys(providers).join(', ')})`);
      }
      let requireNetwork = null;
      if (t.require_network != null) {
        requireNetwork = String(t.require_network);
        if (!GUARD_SENSORS.network.values.includes(requireNetwork)) {
          fail(`${tw}.require_network`, `unknown value "${requireNetwork}" (expected one of ${GUARD_SENSORS.network.values.join(', ')})`);
        }
      }
      // Two targets claiming the same network is not a preference order, it is a
      // typo: the second could never be reached, and the operator who wrote it
      // believes it can. Same reasoning as the duplicate-candidate check in the
      // fallback chains below.
      const netKey = requireNetwork || '*';
      if (seenNetworks.has(netKey)) {
        fail(tw, `a target for network "${netKey}" is already declared above — the first match wins, so this one can never be reached`);
      }
      if (seenNetworks.has('*')) {
        fail(tw, 'an unguarded target (no require_network) is declared above and matches every network, so this one can never be reached');
      }
      seenNetworks.add(netKey);
      if (enabled && targetEnabled) {
        // A band with no model on the target would resolve to some OTHER band's
        // model on every offloaded call. Catch it at boot like every other
        // band/model mismatch in this file.
        //
        // Checked against the target's EFFECTIVE bands, not the global list:
        // once a target can narrow, "the laptop has no medium model" stops being
        // a contradiction and becomes the reason it declares `offload_bands:
        // [small]`. Checking the global list here would still refuse the exact
        // configuration the field was added to express.
        for (const b of (targetBands || bands)) {
          if (!providers[providerId].models[String(b)]) {
            fail(`${targetBands ? `${tw}.offload_bands` : `${where}.offload_bands`}`, `target "${providerId}" declares no model for band "${b}" (has: ${Object.keys(providers[providerId].models).join(', ') || 'none'})`);
          }
        }
      }
      targets.push({
        provider: providerId,
        requireNetwork,
        enabled: targetEnabled,
        scope,
        // null means "every band in the global list". Kept as null rather than
        // materialised so a later widening of the global list reaches an
        // unrestricted target without anyone having to remember to edit it too.
        offloadBands: targetBands,
        // band -> the scopes THAT BAND may serve, or null when every allowed
        // band is served at the target's own `scope`. Null rather than a filled
        // map for the same reason as above: the list form must keep tracking
        // `scope` if someone later edits it.
        bandScopes,
        // null when the target declares no `foreground:` block — no limits.
        foreground,
      });
    }

    if (enabled) {
      if (bands.length === 0) fail(where, 'enabled but `offload_bands` is empty — it would move nothing, which is what `enabled: false` is for');
      // "No target can serve" is a WARNING, not a boot failure, because the
      // dashboard can legitimately reach it: switching the last target off is
      // one click, and a click must never leave the proxy unable to start. The
      // fatal it replaces would have turned "stop sending work to the laptop"
      // into "the proxy no longer boots". Everything still routes — the offload
      // simply moves nothing, and says so on every resolve.
      if (targets.length === 0) {
        warnings.push(`${where}: enabled but no targets are declared — nothing will be offloaded`);
      } else if (!targets.some(t => t.enabled)) {
        warnings.push(`${where}: enabled but every target is switched off (${describeTargets({ targets })}) — nothing will be offloaded`);
      }
    }
    semanticRouting = {
      enabled,
      targets,
      offloadBands: bands.map(String),
    };
  }

  // ── fallback chains ──
  const chains = {};
  const chainDoc = isPlainObject(fallbackDoc.chains) ? fallbackDoc.chains : {};
  for (const [head, raw] of Object.entries(chainDoc)) {
    const where = `llm-fallback.yaml chains.${head}`;
    // A chain keyed on a disabled provider describes what to do when a provider
    // that cannot currently be reached fails. Nothing will ever consult it, so
    // it is dropped whole rather than validated candidate by candidate.
    if (!routableInChain(head, where)) continue;
    if (!Array.isArray(raw)) fail(where, 'must be a list of candidates');
    const seen = new Set([head]);
    chains[head] = raw.flatMap((cand, i) => {
      const cw = `${where}[${i}]`;
      if (!isPlainObject(cand)) fail(cw, 'must be a mapping with `provider`');
      const id = String(cand.provider || '');
      if (!routableInChain(id, cw)) return [];
      // Chains are flat and non-recursive, so a repeat is always dead weight —
      // and usually a sign someone expected recursion. Checked AFTER the skip so
      // a disabled duplicate is reported as the duplicate it is once it is
      // enabled, not silently absorbed now.
      if (seen.has(id)) {
        fail(cw, `provider "${id}" already appears in this chain (chains are flat and non-recursive — a repeat can never be reached)`);
      }
      seen.add(id);
      let when = null;
      if (cand.when != null) {
        if (!isPlainObject(cand.when)) fail(`${cw}.when`, 'must be a mapping of sensor -> allowed values');
        when = {};
        for (const [sensor, allowed] of Object.entries(cand.when)) {
          const spec = GUARD_SENSORS[sensor];
          if (!spec) fail(`${cw}.when`, `unknown sensor "${sensor}" (available: ${Object.keys(GUARD_SENSORS).join(', ')})`);
          const list = Array.isArray(allowed) ? allowed.map(String) : [String(allowed)];
          for (const v of list) {
            if (!spec.values.includes(v)) {
              fail(`${cw}.when.${sensor}`, `unknown value "${v}" (expected one of ${spec.values.join(', ')})`);
            }
          }
          when[sensor] = list;
        }
      }
      return [{ provider: id, when }];
    });
  }

  // ── fallback policy ──
  const retryOn = Array.isArray(fallbackDoc.retry_on) ? fallbackDoc.retry_on.map(String) : [];
  for (const cls of retryOn) {
    if (!RETRY_CLASSES.includes(cls)) {
      fail('llm-fallback.yaml retry_on', `unknown failure class "${cls}" (expected one of ${RETRY_CLASSES.join(', ')})`);
    }
  }
  const sameProviderRetries = fallbackDoc.same_provider_retries == null ? 0 : Number(fallbackDoc.same_provider_retries);
  if (!Number.isInteger(sameProviderRetries) || sameProviderRetries < 0) {
    fail('llm-fallback.yaml same_provider_retries', 'must be a non-negative integer');
  }

  // ── classifier ─────────────────────────────────────────────────────────────
  //
  // WHO decides the band when the caller's own declaration is not informative.
  // See the amended note above semanticRouting for why this exists at all and
  // what keeps it answerable from the config.
  //
  // Defaults are inert in every direction: off, no impl, and allowed to emit
  // only `small`. Declaring the block changes nothing until `enabled: true`, and
  // enabling it changes nothing until an `impl` other than `none` is chosen —
  // two separate statements, because "we have somewhere to ask" and "ask it" are
  // different decisions, the same split semantic_routing.targets makes.
  let classifier = {
    enabled: false, impl: 'none', timeoutMs: 2000,
    maxRequestBytes: 20000, bands: ['small'],
  };
  if (routingDoc.classifier != null) {
    const where = 'llm-routing.yaml classifier';
    const raw = routingDoc.classifier;
    if (!isPlainObject(raw)) fail(where, 'must be a mapping');

    // Unknown keys are NOT rejected by this parser in general, so a typo in a
    // policy field would be silently inert. Named here for the fields where
    // silence would be dangerous — a misspelled `enabled` reads as OFF, and a
    // misspelled `bands` reads as "small only", both of which look like the
    // feature simply not working rather than like a config error.
    for (const [wrong, right] of [
      ['enable', 'enabled'], ['implementation', 'impl'],
      ['timeout', 'timeout_ms'], ['allowed_bands', 'bands'],
    ]) {
      if (raw[wrong] != null) fail(`${where}.${wrong}`, `not a field — did you mean \`${right}\`?`);
    }

    if (raw.enabled != null && typeof raw.enabled !== 'boolean') {
      fail(`${where}.enabled`, 'must be true or false');
    }
    const enabled = raw.enabled === true;

    const declaredImpl = raw.impl == null ? 'none' : String(raw.impl);
    const impl = CLASSIFIER_IMPL_ALIASES[declaredImpl] ?? declaredImpl;
    if (impl !== declaredImpl) {
      warnings.push(`${where}.impl: "${declaredImpl}" is the old name for "${impl}" — `
        + 'it names the transport, not who owns the rubric. Still accepted; update the file.');
    }
    if (!CLASSIFIER_IMPLS.includes(impl)) {
      fail(`${where}.impl`, `unknown impl "${impl}" (expected one of ${CLASSIFIER_IMPLS.join(', ')})`);
    }

    const timeoutMs = raw.timeout_ms == null ? 2000 : Number(raw.timeout_ms);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      fail(`${where}.timeout_ms`, 'must be a positive integer number of milliseconds');
    }
    // Same guard as providers.<id>.timeout_ms: a value this small is almost
    // certainly seconds typed into a milliseconds field.
    if (timeoutMs < 100) fail(`${where}.timeout_ms`, `${timeoutMs} looks like seconds, not milliseconds`);
    // The classifier sits IN FRONT of the call it is trying to make cheaper, so
    // its timeout is pure added latency on every eligible turn. A ceiling here
    // is what stops "make it more accurate" turning into "make every turn slow".
    if (timeoutMs > 10_000) {
      fail(`${where}.timeout_ms`, `${timeoutMs}ms is longer than any request should wait to be classified`);
    }

    const bands = raw.bands == null ? ['small'] : raw.bands;
    if (!Array.isArray(bands) || bands.length === 0) {
      fail(`${where}.bands`, 'must be a non-empty list of complexity bands the classifier may emit');
    }
    for (const b of bands) {
      if (!COMPLEXITY_BANDS.includes(String(b))) {
        fail(`${where}.bands`, `unknown band "${b}" (expected one of ${COMPLEXITY_BANDS.join(', ')})`);
      }
    }

    const maxRequestBytes = raw.max_request_bytes == null ? 20000 : Number(raw.max_request_bytes);
    if (!Number.isInteger(maxRequestBytes) || maxRequestBytes < 1) {
      fail(`${where}.max_request_bytes`, 'must be a positive integer');
    }

    // Two ways to declare something that can never do anything. Warnings rather
    // than failures: both are reachable by a dashboard toggle, and bricking boot
    // on a UI click is the trade semantic_routing already refused to make.
    if (enabled && impl === 'none') {
      warnings.push(`${where}: enabled but impl is "none" — nothing will be classified`);
    }
    if (!enabled && impl !== 'none') {
      warnings.push(`${where}: impl "${impl}" is declared but the classifier is disabled`);
    }

    classifier = { enabled, impl, timeoutMs, maxRequestBytes, bands: bands.map(String) };
  }

  return {
    providers,
    routes,
    defaults,
    semanticRouting,
    classifier,
    // Recoverable findings, in the order they were discovered. server.mjs logs
    // these at boot and on every hot reload; nothing else reads them.
    warnings,
    fallback: {
      chains,
      retryOn: new Set(retryOn),
      sameProviderRetries,
      enforceCapabilities: fallbackDoc.enforce_capabilities !== false,
    },
    // Reverse index: runtime impl name -> account-level provider id. server.mjs
    // dispatches on impl but must LABEL rows with the account id, so telemetry
    // can tell claude-code-max apart from anthropic-api.
    implToProvider: Object.fromEntries(
      Object.values(providers).filter(p => p.impl).map(p => [p.impl, p.id]),
    ),
  };
}

// ── Loading ──────────────────────────────────────────────────────────────────

const DEFAULT_ROUTING_PATH = process.env.LLM_PROXY_ROUTING_PATH
  || path.resolve(__dirname, '..', 'config', 'llm-routing.yaml');
const DEFAULT_FALLBACK_PATH = process.env.LLM_PROXY_FALLBACK_PATH
  || path.resolve(__dirname, '..', 'config', 'llm-fallback.yaml');

let _cached = null;
let _cachedMtimes = null;

function mtimesOf(routingPath, fallbackPath) {
  const local = localRoutingPath(routingPath);
  return [
    fs.statSync(routingPath).mtimeMs,
    fs.statSync(fallbackPath).mtimeMs,
    fs.existsSync(local) ? fs.statSync(local).mtimeMs : '-',
  ].join(':');
}

/**
 * llm-routing.local.yaml, next to llm-routing.yaml: providers only one deployment
 * has (a corporate gateway, with its provider module in proxy-bridge/providers/).
 * The file is optional; where it exists its `providers:` are added to the main
 * file's. Saving from the dashboard writes llm-routing.yaml only.
 */
export function localRoutingPath(routingPath) {
  return routingPath.replace(/\.yaml$/, '.local.yaml');
}

/** `routingDoc` with the providers of llm-routing.local.yaml added. A provider in both is an error. */
export function withLocalProviders(routingDoc, routingPath) {
  const p = localRoutingPath(routingPath);
  if (!fs.existsSync(p)) return routingDoc;
  let local;
  try {
    local = parseYaml(fs.readFileSync(p, 'utf8')) || {};
  } catch (err) {
    throw new ConfigError(`llm-routing.local.yaml is not valid YAML: ${err.message}`);
  }
  const extra = local.providers || {};
  for (const id of Object.keys(extra)) {
    if (routingDoc?.providers?.[id]) throw new ConfigError(`provider "${id}" is in both llm-routing.yaml and llm-routing.local.yaml`);
  }
  return { ...routingDoc, providers: { ...(routingDoc?.providers || {}), ...extra } };
}

/**
 * Read, parse and validate both config files. Cached, and invalidated when
 * either file's mtime changes — so an edit takes effect on the next request
 * without a restart, which is what makes the dashboard's Save button useful.
 *
 * Throws on any validation failure. Callers at boot should let it throw; a
 * proxy running on a config it could not parse is exactly the ambiguity this
 * whole design removes.
 *
 * @param {{routingPath?: string, fallbackPath?: string, force?: boolean}} [opts]
 */
/** Where loadRoutingConfig sends non-fatal findings. No-op until server.mjs wires it. */
let _warn = () => {};

/** @param {(msg: string) => void} fn */
export function setConfigWarningLogger(fn) {
  _warn = typeof fn === 'function' ? fn : () => {};
}

export function loadRoutingConfig(opts = {}) {
  const routingPath = opts.routingPath || DEFAULT_ROUTING_PATH;
  const fallbackPath = opts.fallbackPath || DEFAULT_FALLBACK_PATH;
  let stamp;
  try {
    stamp = mtimesOf(routingPath, fallbackPath);
  } catch (err) {
    throw new ConfigError(`cannot stat routing config (${err.code}): ${err.path || err.message}`);
  }
  if (!opts.force && _cached && _cachedMtimes === stamp) return _cached;

  const readDoc = (p, label) => {
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (err) {
      throw new ConfigError(`cannot read ${label} at ${p} (${err.code})`);
    }
    try {
      return parseYaml(raw);
    } catch (err) {
      throw new ConfigError(`${label} is not valid YAML: ${err.message}`);
    }
  };

  const config = parseRoutingConfig(
    withLocalProviders(readDoc(routingPath, 'llm-routing.yaml'), routingPath),
    readDoc(fallbackPath, 'llm-fallback.yaml'),
  );
  config.paths = { routing: routingPath, fallback: fallbackPath };
  // Emitted here rather than at the call sites because a cached hit must stay
  // silent while EVERY fresh parse must be heard — and a fresh parse happens
  // lazily, on whichever request first sees a changed mtime, not only at boot
  // and on an explicit force. Announcing it from the one place that actually
  // re-parses is what makes "warned once per parse" true by construction.
  for (const w of config.warnings) _warn(w);
  _cached = config;
  _cachedMtimes = stamp;
  return config;
}

/** Drop the cache (used by the write API after a validated save, and by tests). */
export function invalidateRoutingConfig() {
  _cached = null;
  _cachedMtimes = null;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Step 1-3 of the lookup. Returns the provider + model for a piece of work, plus
 * enough trace to answer "why here?" without reading the config by hand.
 *
 * Note what is NOT consulted: body.subscription, body.provider, the network mode,
 * or the request's model field. Routing used to blend all four with the config
 * and the result was that nobody could predict where a call would land. The
 * caller's only input now is `complexity`, and only where a route opted into it.
 *
 * @param {object} config
 * @param {{job: string, agent?: string, complexity?: string, network?: string}} req
 * @returns {{provider: string, model: string, complexity: string, matchedKey: string, step: number, class: string, offloadedFrom?: string}}
 */
export function resolveRoute(config, {
  job, agent, complexity, network, classified = false, inherited = false, requestedModel,
  inputTokens, inFlight,
} = {}) {
  const cls = jobClass(job);
  const jobId = String(job || '');
  const agentId = agent ? String(agent) : '';

  let entry = null;
  let matchedKey = null;
  let step = 0;

  if (agentId && config.routes[`${jobId}/${agentId}`]) {
    matchedKey = `${jobId}/${agentId}`;
    entry = config.routes[matchedKey];
    step = 1;
  } else if (config.routes[jobId]) {
    matchedKey = jobId;
    entry = config.routes[matchedKey];
    step = 2;
  } else {
    matchedKey = `defaults.${cls}`;
    entry = config.defaults[cls];
    step = 3;
  }

  // `from-caller` hands the band to the request. When the request supplies
  // nothing usable, the class default applies — never a silent guess.
  let band = entry.complexity;
  let bandSource = `route ${matchedKey}`;
  if (band === FROM_CALLER) {
    const asked = complexity ? String(complexity) : '';
    if (COMPLEXITY_BANDS.includes(asked)) {
      band = asked;
      // `classified` marks a band that prompt-classifier.mjs LOWERED, so the row
      // and the /resolve output can tell it apart from something the agent
      // actually declared. Blending the two into 'caller' would make the one
      // question this field exists to answer — "who decided this?" —
      // unanswerable, which is precisely the objection the classifier had to
      // survive to be built at all. server.mjs resolves twice: once to learn the
      // declared band, then again with the verdict and this flag set.
      //
      // `inherited` marks a band carried over from the first call of the same
      // turn (turn-band.mjs): a call inside a tool loop is never classified, so
      // it takes its turn's verdict instead — and says so, as 'turn', rather
      // than passing off a remembered verdict as a fresh one.
      bandSource = inherited ? 'turn' : classified ? 'classifier' : 'caller';
    } else {
      band = config.defaults[cls].complexity;
      bandSource = `defaults.${cls} (route asked for ${FROM_CALLER}, caller supplied ${asked ? `unknown "${asked}"` : 'nothing'})`;
    }
  }

  // ── Semantic offload ──
  //
  // Applied HERE, after `from-caller` has become a concrete band, so a pi or
  // copilot turn that declares `complexity: small` participates exactly like a
  // background service that declares it in the file. Applied BEFORE the model is
  // chosen, so the offloaded call gets a model the LOCAL provider serves rather
  // than an id carried over from the account it came from — the same reason
  // buildChain() does not carry a pinned model across a fallback hop.
  const sr = config.semanticRouting;
  // Which local endpoint serves this call, if any. Network-scoped: the on-prem
  // cluster answers only on corporate, the laptop server only off it, so "the
  // local provider" is a function of where the machine currently is.
  const target = sr && sr.enabled ? pickOffloadTarget(sr, network) : null;
  let offloadedFrom = null;
  let offloadSkipped = null;
  if (sr && sr.enabled && entry.provider !== target?.provider) {
    if (entry.offload === false) {
      offloadSkipped = `route ${matchedKey} sets offload: false`;
    } else if (!sr.offloadBands.includes(band)) {
      offloadSkipped = `band "${band}" is not in offload_bands [${sr.offloadBands.join(', ')}]`;
    } else if (!target) {
      offloadSkipped = `no offload target for network=${normalizeNetwork(network)} (targets: ${describeTargets(sr)})`;
    } else if (target.offloadBands && !target.offloadBands.includes(band)) {
      // The global policy allows this band and a target for this network exists
      // and is on — but this particular box does not take work this hard. A
      // distinct reason from the global band check above, because the fixes are
      // opposite: one wants the policy widened, the other wants THIS endpoint
      // widened (or a different one declared for this network). Both used to be
      // impossible to reach at once, since a target could not narrow.
      offloadSkipped = `target "${target.provider}" takes bands [${target.offloadBands.join(', ')}] and this is ${band} work`;
    } else if (!effectiveScopeFor(target, band).includes(offloadScopeOf(cls))) {
      // The target for this network exists and is on, but does not serve THIS
      // kind of work. A distinct reason from "no target for this network"
      // because the fixes are opposite: one wants a target declared, the other
      // wants an existing one widened. Both used to print the same sentence.
      //
      // Evaluated at the SAME rung whether the restriction came from the target
      // or from the band, so the ladder keeps its shape (RUNG_OFFLOADED must not
      // move again — three fixtures hardcoded it the last time it did). The
      // sentence says WHICH of the two it was, because the two fixes edit
      // different lines.
      const perBand = target.bandScopes?.[band];
      offloadSkipped = perBand
        ? `target "${target.provider}" serves ${band} work for scope [${perBand.join(', ')}] and this is ${offloadScopeOf(cls)} work (${matchedKey})`
        : `target "${target.provider}" serves scope [${effectiveScopeFor(target, band).join(', ')}] and this is ${offloadScopeOf(cls)} work (${matchedKey})`;
    } else if (
      config.providers[entry.provider]?.fgTransport
      && !config.providers[target.provider]?.fgTransport
    ) {
      // Never move a call OFF a foreground transport onto one that cannot serve
      // it. `fg-chat/claude` reaches the proxy on the Anthropic wire protocol at
      // /v1/messages, which is a verbatim passthrough and answers 501 for any
      // provider without fg_transport. Offloading it would therefore not route
      // the call somewhere cheaper — it would break every Claude Code turn the
      // moment someone added that band to offload_bands. The band table is the
      // wrong place to defend against this, because a band is a statement about
      // how hard the work is, not about which wire it arrives on.
      offloadSkipped = `route provider "${entry.provider}" serves a foreground transport (${config.providers[entry.provider].fgTransport}) that "${target.provider}" cannot`;
    } else if (cls === 'fg-chat' && foregroundLimitReason(target, { inputTokens, inFlight })) {
      // Someone is waiting, and this call would make them wait longer on the
      // target than on the account it came from: too large a prompt to prefill
      // inside the foreground ceiling, or other calls already open on the box.
      // See `foreground:` in the target parser for the measurements.
      offloadSkipped = foregroundLimitReason(target, { inputTokens, inFlight });
    } else {
      offloadedFrom = entry.provider;
      entry = { ...entry, provider: target.provider };
    }
  }

  const provider = config.providers[entry.provider];
  // A route may explicitly authorise selected caller models as a PROFILE. This
  // is not the old body.model soft pin: only listed ids are read, only listed
  // bands are overridden, and fallbacks still choose their own provider's model.
  // It lets an OpenCode Sol selection mean high→Sol while a classifier downgrade
  // still means medium→Sonnet or small→Haiku/Qwen.
  const profileModel = requestedModel && entry.modelProfiles?.[requestedModel]?.[band];
  const model = profileModel || provider.models[band]
    // A from-caller band can name a band this provider lacks. Fall to the
    // nearest declared band rather than sending an id the provider will reject.
    || provider.models[config.defaults[cls].complexity]
    || provider.models[COMPLEXITY_BANDS.find(b => provider.models[b])];

  return {
    provider: provider.id,
    model,
    complexity: band,
    complexitySource: bandSource,
    matchedKey,
    step,
    class: cls,
    ...(profileModel ? { modelProfile: requestedModel } : {}),
    // Present only when the offload actually moved the call, so every existing
    // consumer of this object is unaffected when semantic routing is off.
    ...(offloadedFrom ? { offloadedFrom } : {}),
    // The foreground ceiling for the offloaded hop. Only the hop that runs on
    // the target takes it; the fallbacks keep their own timeouts.
    ...(offloadedFrom && cls === 'fg-chat' && target.foreground?.timeoutMs
      ? { offloadTimeoutMs: target.foreground.timeoutMs } : {}),
    // Why it did NOT move, when semantic routing is on and this route was a
    // candidate. Answering "why is this still on copilot?" without it means
    // re-deriving the policy by hand, which is the thing this module exists to
    // stop people doing.
    ...(offloadSkipped ? { offloadSkipped } : {}),
  };
}

/**
 * Build the ordered attempt list for a resolved route: the chosen provider
 * followed by its configured fallbacks, guards applied and capabilities enforced.
 *
 * Two things the old code did that this deliberately does NOT do:
 *   • carry the caller's model across providers (the CLAUDE_FAMILY special case).
 *     Each entry gets the model ITS provider declares for the band, so a fallback
 *     to groq can never be handed a Claude model id.
 *   • reorder the chain based on live reachability. A provider being unreachable
 *     is just a failed attempt that advances the chain — which is what the chain
 *     is for. There is no promotion heuristic.
 *
 * @param {object} config
 * @param {{provider: string, complexity: string}} route  from resolveRoute()
 * @param {{network?: string, wantsTools?: boolean}} ctx
 * @returns {{chain: Array<{provider: string, model: string, impl: string}>, skipped: Array<{provider: string, reason: string}>}}
 */
export function buildChain(config, route, ctx = {}) {
  const network = normalizeNetwork(ctx.network);
  const wantsTools = ctx.wantsTools === true;
  const enforce = config.fallback.enforceCapabilities && wantsTools;

  // When semantic routing moved this call, the provider the ROUTE names becomes
  // the first fallback — ahead of the local provider's own declared chain. So a
  // cluster that is down, mid-restart, or serving a model that is still loading
  // degrades straight back to the routing that was in force before the offload,
  // rather than into whatever generic chain the local provider declares. The
  // existing retry_on classes (network_error, gateway_5xx, provider_unavailable)
  // are exactly what a LAN endpoint fails with, so no new class is needed.
  //
  // De-duplicated because the declared chain may already name it, and the chain
  // validator's rule that a repeat can never be reached applies just as much to
  // a chain assembled here as to one written in the file.
  const declared = config.fallback.chains[route.provider] || [];
  const tail = route.offloadedFrom
    ? [
      { provider: route.offloadedFrom, when: null },
      ...declared.filter(c => c.provider !== route.offloadedFrom),
    ]
    : declared;

  const candidates = [
    { provider: route.provider, when: null, head: true },
    ...tail,
  ];

  const chain = [];
  const skipped = [];

  for (const cand of candidates) {
    const p = config.providers[cand.provider];
    if (!p || !p.enabled) {
      skipped.push({ provider: cand.provider, reason: 'provider disabled' });
      continue;
    }
    if (cand.when) {
      const guardFail = Object.entries(cand.when).find(([sensor, allowed]) => {
        const actual = sensor === 'network' ? network : undefined;
        return !allowed.includes(actual);
      });
      if (guardFail) {
        const [sensor, allowed] = guardFail;
        skipped.push({
          provider: cand.provider,
          reason: `guard ${sensor}=[${allowed.join('|')}] not satisfied (actual: ${sensor === 'network' ? network : 'unknown'})`,
        });
        continue;
      }
    }
    if (enforce && !p.capabilities.tools) {
      skipped.push({ provider: cand.provider, reason: 'request carries tools[] and this provider is not tools-capable' });
      continue;
    }
    const model = cand.head ? route.model : p.models[route.complexity]
      || p.models[COMPLEXITY_BANDS.find(b => p.models[b])];
    if (!model) {
      skipped.push({ provider: cand.provider, reason: 'no model declared for any complexity band' });
      continue;
    }
    chain.push({ provider: p.id, model, impl: p.impl });
  }

  return { chain, skipped };
}

/**
 * One call that answers "where does this go, and why". Backs both the proxy's
 * log line and the dashboard's explain column — so the two can never disagree.
 *
 * @param {object} config
 * @param {{job: string, agent?: string, complexity?: string, network?: string, wantsTools?: boolean}} req
 */
export function explain(config, req = {}) {
  const route = resolveRoute(config, req);
  const { chain, skipped } = buildChain(config, route, req);
  // The step clause carries the offload, so the log line and the dashboard both
  // say WHY a call is on the local cluster rather than leaving the reader to
  // infer it from a provider name that no route mentions.
  const step = route.offloadedFrom
    ? `step ${route.step}, offloaded from ${route.offloadedFrom}`
    : `step ${route.step}`;
  return {
    request: {
      job: req.job || '',
      agent: req.agent || '',
      complexity: req.complexity || '',
      network: normalizeNetwork(req.network),
      wantsTools: req.wantsTools === true,
      // Echoed so a /resolve answer is self-describing: the same job+band can
      // resolve identically whether a caller declared it or a classifier lowered
      // it to that value, and only this field says which was being asked about.
      classified: req.classified === true,
      inherited: req.inherited === true,
    },
    route,
    chain,
    skipped,
    // How the request is carried. 'anthropic-passthrough' for foreground Claude
    // Code: /v1/messages forwards it verbatim to the one provider carrying
    // fg_transport, so the chain past its head is never tried — there is no
    // fallback. Readers that show a fallback (the status-line network report)
    // must check this first; it used to list one for claude that never ran.
    transport: route.matchedKey === 'fg-chat/claude'
      ? (config.providers[route.provider]?.fgTransport || null)
      : null,
    // A one-line human summary, identical in the log and in the UI.
    summary: chain.length
      ? `${route.matchedKey} (${step}) -> ${chain.map(c => `${c.provider}/${c.model}`).join(' > ')}`
      : `${route.matchedKey} (${step}) -> NO ELIGIBLE PROVIDER`,
  };
}

/** Provider catalogue in the shape the dashboard dropdowns want. */
export function providerCatalogue(config) {
  return Object.values(config.providers).map(p => ({
    id: p.id,
    account: p.account,
    description: p.description,
    enabled: p.enabled,
    tools: p.capabilities.tools,
    fgCapable: !!p.fgTransport,
    // `models` is the current band -> id choice; `availableModels` is everything
    // the account can serve, so a band dropdown has alternatives to offer.
    availableModels: [...p.availableModels],
    models: { ...p.models },
    timeoutMs: p.timeoutMs,
    timeoutMsByBand: p.timeoutMsByBand ? { ...p.timeoutMsByBand } : null,
  }));
}

/** Account-level provider id for a runtime impl name (e.g. 'copilot' -> 'gh-copilot'). */
export function providerIdForImpl(config, impl) {
  return config.implToProvider[impl] || impl;
}
