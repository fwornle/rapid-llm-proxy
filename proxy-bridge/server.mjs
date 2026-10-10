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
import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WorkerPool } from './worker-pool.mjs';
// Routing lives in config/llm-routing.yaml + config/llm-fallback.yaml. This
// module reads and validates them; nothing in this file decides where a call
// goes. See docs/architecture/llm-routing.md.
import {
  loadRoutingConfig,
  invalidateRoutingConfig,
  explain as explainRoute,
  resolveRoute,
  providerCatalogue,
  providerIdForImpl,
  setConfigWarningLogger,
  isSelfHosted,
  classifyFailure,
  SAME_PROVIDER_RETRY_CLASSES,
} from './routing-config.mjs';
import { detectNetworkModeSync } from '../dist/network-detect.js';
import { initTokenDb, logCall as logTokenCall, backfillCanonicalModelNames, sanitizeProject } from '../dist/token-usage.js';
// Phase 67-06 (REPRO-02): the LLM record/replay taps read the FULL active span
// (getActiveMeasurement) off the SAME single reader task binding uses
// (measurement.mjs) — do NOT add a second parser of active-measurement.json
// (SC-4). sanitizeTaskId is reused for the traversal-safe record fixtures dir
// (same guard class as the span dir).
import { getActiveMeasurement, sanitizeTaskId } from '../dist/measurement-span.js';
import { parseUsageCache, parseOpenAICache, openAIFreshInputTokens } from '../dist/usage-cache.js';
// WIRE cache-write enablement: inject cache_control breakpoints on the
// Anthropic-native builders so multi-turn prefixes are actually written to the
// prompt cache (OpenAI-wire traffic carries no markers → cache_write was 0).
// Opt out with LLM_PROXY_DISABLE_PROMPT_CACHE=1.
import { applyAnthropicCacheControl } from '../dist/anthropic-cache.js';
const PROMPT_CACHE_ENABLED = process.env.LLM_PROXY_DISABLE_PROMPT_CACHE !== '1';
// Phase 82-03 (WIRE-04/05): pure tool-call passthrough helpers (forward, response
// mapping, capability gating) — plain .mjs (no build), shared with the unit test.
// gateToolCapableChain is intentionally NOT imported here any more: tool
// capability is now a per-provider config key (llm-routing.yaml
// providers.*.capabilities.tools) applied inside buildChain(), rather than a
// hardcoded { copilot: true } map applied here. The helper stays exported from
// shim-tools.mjs with its own test coverage.
import {
  buildBufferedChoice, buildStreamDelta, matchShimPath,
  mergeCopilotChoices, hasNonTextParts, flattenContentToText,
  outboundToolFields, normalizeToolCalls, responsesToChatBody, responseSseFrames,
  matchResponsesShimPath, repairFunctionCallIds,
} from './shim-tools.mjs';
// Which outbound URLs must bypass HTTPS_PROXY. Needed the moment a provider
// lives on the corporate LAN (the on-prem Qwen cluster): undici's ProxyAgent has
// no NO_PROXY support, so without this every call to a 10/8 host would be
// tunnelled through the corporate proxy and fail. Pure sibling, unit-tested.
import { shouldBypassProxy } from './no-proxy.mjs';
// What a caller is allowed to say about how hard its own work is. `from-caller`
// routes delegate the band to the caller, and until this module the only spelling
// of that was an explicit `complexity` field no foreground agent could set — so
// every pi turn fell to defaults.fg-chat (high) and never became offloadable.
// Pure sibling, unit-tested. NOT a content classifier; see the file header.
import { resolveCallerComplexity } from './caller-complexity.mjs';
import { classifyRequest, SKIP } from './prompt-classifier.mjs';
// Rubric + per-impl clients, shared with scripts/eval-prompt-classifier.mjs so the
// gate measures the prompt this proxy actually sends. See makeClassifierVerdictFn.
import { makeClassifierVerdictFn as makeClassifierClient, classifierServiceBase } from './classifier-client.mjs';
// Whether outbound traffic should go through a proxy right now, and which one.
// Pure sibling, unit-tested against the VPN-drop sequence that made a network
// transition an outage on 2026-08-28. server.mjs owns only the I/O around it.
import {
  decideEgressProxy,
  needsReachabilityProbe,
  egressIsDegraded,
  shouldRetryAfterEgressRecheck,
  bodyIsReplayable,
} from './egress-decision.mjs';
// Serialises the routing decision onto the token_usage row. Pure sibling: the
// empty-string contract for the common case lives there, not here.
import { serializeRoutingTrail, normalizeFailureClass, parseRoutingTrail } from './routing-trail.mjs';
// Historical provider spellings → the account id. History holds `claude-code`
// and `claude-code-max` for one Max subscription; unfolded, a route reads as if
// it served two providers, which the behaviour view renders as a fallback that
// never happened.
import { normalizeProvider } from './provider-aliases.mjs';
import { resolveRequestTimeout, resolveProviderTimeout } from './request-timeout.mjs';
// Which conversation and which TURN a call belongs to, derived from the request
// itself — no agent sends a turn number. Pure sibling, unit-tested; see the file
// header for why the turn index counts non-tool-result user messages.
import { turnIdentity } from './turn-identity.mjs';
import { canonicalizeModelName } from './model-canonical.mjs';
import { handleAnthropicMessages, ANSWERING_PROVIDER_HEADER } from './anthropic-forward.mjs';
import { createUsageApi } from './usage-api.mjs';
// Phase 84-06 (D-05/D-06): the redaction set every preview and raw body goes
// through before it is written (the SHARED 27-pattern config).
import { loadRawBodyRedactionPatterns, makeRedactRawBody } from './raw-bodies.mjs';
// Task binding, the usage tap and every measurement write (token row, context
// breakdown, context turns, raw bodies). See the file header.
import {
  createMeasurement, adapterUserHash, pathTaskId, bindShimTaskId, bindCompleteTaskId,
} from './measurement.mjs';

const execFileAsync = promisify(execFile);
const PORT = parseInt(process.env.LLM_PROXY_PORT || '8089', 10);

const log = (...args) => process.stdout.write(`[llm-proxy] ${args.join(' ')}\n`);
const logErr = (...args) => process.stderr.write(`[llm-proxy] ${args.join(' ')}\n`);

// Non-fatal routing-config findings (a fallback candidate skipped because its
// provider is disabled, say). stderr, not stdout: they are the kind of thing you
// go looking for when a chain did not degrade the way you expected, and stdout
// here carries the per-call route lines.
setConfigWarningLogger((msg) => logErr(`routing config: ${msg}`));

// ── Phase 67-06 (REPRO-02): LLM record/replay fixture modules ────────────────
// The SINGLE match/record/replay implementation lives in the coding repo
// (lib/repro/fixtures, Plan 01) and is shared verbatim with the integration
// tests — the daemon must NOT re-implement matching, recording, or replay. It is
// resolved once via an env-resolved absolute path (mirroring the ../dist
// local-import discipline + the CODING_REPO allowlist) and lazy-loaded + cached
// so a load failure can NEVER break normal /api/complete serving (the taps stay
// inert). See lib/repro/fixtures/{match-key,llm-replay,llm-record}.mjs.
// Default: the coding checkout next to _work/ (<A>/_work/rapid-llm-proxy/proxy-bridge →
// <A>/coding) — the same last-resort guess bin/start-llm-proxy.sh makes.
const SIBLING_CODING = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'coding');
const REPRO_DIR = process.env.LLM_PROXY_REPRO_DIR || path.join(SIBLING_CODING, 'lib', 'repro');
// Coding-repo root (<repo>/lib/repro → <repo>) so the record tap can write
// fixtures under the snapshot dir the integration (Plan 07) archives from.
const CODING_ROOT = process.env.CODING_REPO || path.resolve(REPRO_DIR, '..', '..');
// The data root every on-disk artefact hangs off. It is NOT `<CODING_ROOT>/.data`
// any more: `coding`'s data home moved out of the tools repo, and the launcher
// exports LLM_PROXY_DATA_DIR (= `<dataHome>/var`). The repo-relative fallback is
// kept only for a proxy started by hand outside the launcher. This is the SAME
// value `resolveMeasurementPaths()` (src/measurement-span.ts) resolves, which is
// what keeps a span's archive and its context-turns capture co-located.
const DATA_DIR = process.env.LLM_PROXY_DATA_DIR || path.join(CODING_ROOT, '.data');
let _reproMods = null;        // { matchKey, normalizeReq, replayLookup, recordFixture, resetOrdinals }
let _reproLoadFailed = false;
let _lastReproSpanId = null;  // task_id\0started_at of the last armed span seen (D-07 ordinal reset)

async function loadReproMods() {
  if (_reproMods || _reproLoadFailed) return _reproMods;
  try {
    const [mk, rp, rc] = await Promise.all([
      import(path.join(REPRO_DIR, 'fixtures', 'match-key.mjs')),
      import(path.join(REPRO_DIR, 'fixtures', 'llm-replay.mjs')),
      import(path.join(REPRO_DIR, 'fixtures', 'llm-record.mjs')),
    ]);
    _reproMods = {
      matchKey: mk.matchKey,
      normalizeReq: mk.normalizeReq,
      resetOrdinals: mk.resetOrdinals,
      replayLookup: rp.replayLookup,
      recordFixture: rc.recordFixture,
    };
  } catch (err) {
    _reproLoadFailed = true;
    logErr(`repro fixtures unavailable (record/replay taps inert): ${err?.message || err}`);
  }
  return _reproMods;
}

// Resolve the record fixtures dir for the active span. An explicit path in
// span.meta.record wins (future-proofing); otherwise derive the snapshot
// fixtures dir <DATA_DIR>/run-snapshots/<sanitizeTaskId(task_id)>/fixtures — the
// SAME dir the replay side reads (span.meta.replay_from), so record and replay
// round-trip through one location (Plan 07 archives from here). DATA_DIR, not
// CODING_ROOT: run-snapshots is a data-home tree, and a recorder writing to the
// tools repo while the replay side reads the data home turns every replay into a
// silent cache miss. sanitizeTaskId keeps the path traversal-safe (same guard
// class as the span dir, T-67-04-01).
function recordFixturesDir(span) {
  const rec = span?.meta?.record;
  if (typeof rec === 'string' && rec) return rec;
  const tid = sanitizeTaskId(span?.task_id || '');
  return path.join(DATA_DIR, 'run-snapshots', tid, 'fixtures');
}

// Build identity — resolved once at module load. Surfaces the git commit the
// running node process was launched from at startup (stdout log) and on
// /health, so a stale binary still running an older build (launchd KeepAlive
// doesn't auto-pick up source changes) is diagnosable directly instead of
// inferred from drift in advertised behaviour. Falls back to 'unknown' when
// the proxy is installed outside its git checkout (npm package, container).
const BUILD_IDENTITY = (() => {
  try {
    const repoRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));
    const sha = execSync(`git -C "${repoRoot}" rev-parse --short HEAD`, { encoding: 'utf8', timeout: 1000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const date = execSync(`git -C "${repoRoot}" log -1 --format=%cd --date=short`, { encoding: 'utf8', timeout: 1000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return `${sha} (${date})`;
  } catch {
    return 'unknown';
  }
})();

// --- Proxy-Aware Fetch ---

/**
 * Node.js native fetch() does not honor HTTPS_PROXY. In corporate environments
 * all external HTTPS traffic must go through the corporate proxy.
 * We use undici's ProxyAgent to create a proxy-aware fetch function.
 *
 * ── The pin is RE-DECIDED AT RUNTIME, not just at exec ───────────────────────
 *
 * bin/start-llm-proxy.sh picks HTTPS_PROXY once, from the health coordinator's
 * network verdict, and this block used to bake that answer in for the life of
 * the process. The only way to correct it was a restart — which is what made a
 * VPN drop an outage rather than a transition.
 *
 * Observed 2026-08-28, 17:00–17:07 local: the VPN went down; the coordinator
 * still answered `location=vpn` for another six minutes; three auto-heal
 * restarts fired, and each one re-read that stale verdict and re-pinned a
 * corporate proxy (corp-proxy:8080, then 127.0.0.1:3128) whose egress was gone.
 * The proxy answered `/v1/messages forward attempt 1..3 network error: fetch
 * failed` throughout, and pi — whose corporate chain is gh-copilot > openai, BOTH
 * of which leave through that same pin — had no surviving hop and reported
 * "Retry failed after 3 attempts: Connection error". Fallback depth buys nothing
 * when every candidate shares one dead egress.
 *
 * So the pin is now re-evaluated on a timer against the live coordinator, and a
 * pinned proxy that stops answering is DROPPED rather than held. Two rules, both
 * asymmetric on purpose:
 *
 *   • Never pin a proxy without proving it reachable first (the launcher learned
 *     this the hard way on 2026-05-21 and 2026-07-22 — pinning a dead
 *     corp-proxy:8080 at home caused multi-hour outages).
 *   • Always un-pin one that has stopped answering. Direct is the safe direction:
 *     off-corp it is the only thing that works, and on-corp it fails exactly as
 *     the dead pin already did. Holding a proxy we KNOW is dead can only lose.
 */
let undiciMod = null;
try {
  undiciMod = await import('undici');
} catch (err) {
  logErr(`Failed to load undici ProxyAgent: ${err.message}. External HTTPS calls may fail.`);
}

const NO_PROXY_VALUE = process.env.NO_PROXY || process.env.no_proxy || '';

/** The proxy URL currently in force (null = direct), and its live dispatcher. */
let _egressProxyUrl = null;
let _egressDispatcher = null;

/**
 * Pin (or un-pin) the egress proxy. Returns true when the pin actually changed.
 * Rebuilding the dispatcher is the whole point: undici caches connections per
 * agent, so the stale sockets of the old pin go with it.
 */
function setEgressProxy(url, why) {
  const next = url || null;
  if (next === _egressProxyUrl) return false;
  if (!next) {
    _egressDispatcher = null;
    _egressProxyUrl = null;
    log(`egress: direct (no proxy) — ${why}`);
    return true;
  }
  if (!undiciMod) return false;
  try {
    _egressDispatcher = new undiciMod.ProxyAgent(next);
    _egressProxyUrl = next;
    log(`egress: via ${next} — ${why}${NO_PROXY_VALUE ? ` (NO_PROXY=${NO_PROXY_VALUE})` : ''}`);
    return true;
  } catch (err) {
    logErr(`egress: could not build a ProxyAgent for ${next}: ${err.message} — staying on ${_egressProxyUrl || 'direct'}`);
    return false;
  }
}

/**
 * Proxy-aware fetch. Reads the CURRENT pin on every call, so a mid-flight
 * re-evaluation takes effect on the next request rather than the next restart.
 *
 * NO_PROXY / private-address BYPASS. undici's ProxyAgent has no NO_PROXY
 * support, so this used to send EVERY request through the corporate proxy —
 * including one addressed to an RFC1918 host, which a corporate proxy cannot
 * route and can only ever fail. That did not matter while every provider was
 * on the public internet; it matters now that the on-prem Qwen cluster is a
 * provider, because it lives on 10/8 and is reachable ONLY on the same
 * network where HTTPS_PROXY is set. Decision is per-URL, so one process
 * serves both the proxied public providers and the direct LAN one.
 */
const rawProxyFetch = (url, init = {}) => {
  if (!undiciMod) return globalThis.fetch(url, init);
  const dispatcher = _egressDispatcher;
  return (!dispatcher || shouldBypassProxy(url, NO_PROXY_VALUE))
    ? undiciMod.fetch(url, init)
    : undiciMod.fetch(url, { ...init, dispatcher });
};

// A connection-level failure, as opposed to an HTTP response we dislike. Only
// these say anything about the EGRESS PATH; a 500 from the provider says the
// path worked fine. Deliberately narrower than classifyFailure()'s
// network_error: this one must not fire on a provider that merely timed out,
// because re-deciding the pin cannot help with that (the same lesson as
// SAME_PROVIDER_RETRY_CLASSES, one layer down).
function isEgressConnectionFailure(err) {
  if (!err) return false;
  const m = `${err.message || err}`;
  if (/aborted|abort/i.test(m)) return false;
  return /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|other side closed|proxy/i.test(m);
}

// One shared re-check for a burst of concurrent failures. Twenty in-flight
// requests all dying on the same dead pin is the NORMAL shape of this event —
// they must produce one probe between them, not twenty.
let _egressRecheckInFlight = null;
function recheckEgressOnce() {
  if (!_egressRecheckInFlight) {
    const before = _egressProxyUrl;
    _egressRecheckInFlight = reevaluateEgressProxy()
      .then(() => _egressProxyUrl !== before)
      .catch(() => false)
      .finally(() => { _egressRecheckInFlight = null; });
  }
  return _egressRecheckInFlight;
}

/**
 * Proxy-aware fetch that treats its OWN failure as evidence about the pin.
 *
 * rawProxyFetch above reads the current pin per call, which was already enough
 * for a re-decision made on the 30s timer to take effect. What it could not do
 * is react to the request that just proved the pin dead — so every walk out of
 * the office cost a window of hard failures while the coordinator worked
 * through its (deliberate) demotion hysteresis. See shouldRetryAfterEgressRecheck.
 *
 * The re-decision is the existing pure one; nothing new decides anything here.
 */
const proxyFetch = async (url, init = {}) => {
  const hadPin = Boolean(_egressDispatcher) && !shouldBypassProxy(url, NO_PROXY_VALUE);
  try {
    return await rawProxyFetch(url, init);
  } catch (err) {
    if (!hadPin || !isEgressConnectionFailure(err)) throw err;
    const egressChanged = await recheckEgressOnce();
    if (!shouldRetryAfterEgressRecheck({
      hadPin,
      egressChanged,
      failureIsNetwork: true,
      replayableBody: bodyIsReplayable(init.body),
      aborted: init.signal?.aborted === true,
    })) throw err;
    log(`egress: retrying ${new URL(url, 'http://x').host} on the re-decided egress after "${err.message || err}"`);
    return await rawProxyFetch(url, init);
  }
};

/**
 * The corporate proxy to try when the network turns corporate mid-process.
 *
 * Preference order mirrors the launcher's: an explicit override, then whatever
 * the launcher itself resolved into HTTPS_PROXY, then local proxydetox on :3128
 * — which is the ADAPTIVE one (it re-reads the PAC per request and falls back to
 * DIRECT when the VPN drops), and therefore the least bad thing to hold.
 */
const REMEMBERED_PROXY_FILE = path.join(DATA_DIR, 'llm-proxy', 'last-corporate-proxy');

/**
 * The corporate proxy this machine last PROVED reachable, from a previous run.
 *
 * The runtime cannot do PAC extraction — that lives in bin/start-llm-proxy.sh —
 * so without this its only candidate is proxydetox on :3128, which on this
 * network usually does not reach upstream (the launcher pinned the PAC-derived
 * proxy 399 times against :3128's 27). Remembering what worked gives the
 * runtime the same option the launcher has, learned rather than hardcoded: a
 * hostname baked into this file would be wrong on any other network, and would
 * resurrect exactly the non-adaptive pin the launcher demoted after 2026-07-26.
 *
 * Advisory only. It is still probed before use like every other candidate, and
 * still un-pinned the moment it stops answering.
 */
function rememberedCorporateProxy() {
  try {
    const v = fs.readFileSync(REMEMBERED_PROXY_FILE, 'utf8').trim();
    return /^https?:\/\/[^\s]+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

function rememberCorporateProxy(url) {
  try {
    if (!url) return;
    if (rememberedCorporateProxy() === url) return;
    fs.mkdirSync(path.dirname(REMEMBERED_PROXY_FILE), { recursive: true });
    fs.writeFileSync(REMEMBERED_PROXY_FILE, `${url}\n`);
  } catch { /* best-effort: a read-only disk must not break egress */ }
}

/**
 * Corporate proxies to try, best first — the launcher's own order.
 *
 * Rebuilt per tick rather than frozen at import, so a proxy proven during THIS
 * process (or by a launcher run since) is available without a restart.
 */
function corporateProxyCandidates() {
  return [...new Set([
    process.env.LLM_CORPORATE_PROXY_URL,
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    // The ADAPTIVE one first, as bin/start-llm-proxy.sh argues at length: it
    // re-reads the PAC per request and falls back to direct when the VPN drops,
    // so it survives a transition that a raw pin cannot.
    'http://127.0.0.1:3128',
    rememberedCorporateProxy(),
  ].filter(Boolean))];
}

/**
 * The egress state as last decided, for /health and the Routing tab.
 *
 * `network: null` means the coordinator did not answer — kept distinct from
 * 'public' because "we do not know" and "no proxy needed" justify different
 * actions, and conflating them is how a coordinator blip reads as an all-clear.
 */
let _egressState = { proxy: null, network: null, degraded: false, reason: 'not yet evaluated', since: null };
/** Last degraded reason LOGGED, so a persisting state does not log every tick. */
let _egressDegradedReason = '';

/** Host used to prove a proxy actually reaches the outside world. */
const EGRESS_PROBE_URL = process.env.LLM_EGRESS_PROBE_URL || 'https://api.github.com';
const EGRESS_RECHECK_MS = Number(process.env.LLM_EGRESS_RECHECK_MS || 30_000);

/**
 * Does `proxyUrl` actually reach upstream? curl returns 0 for ANY HTTP answer
 * (401/403/405 included) and non-zero only on connect/DNS/TLS failure or
 * timeout — so this tests reachability, not auth. Same probe, same host and the
 * same 4s budget the launcher uses, deliberately: two components disagreeing
 * about what "reachable" means is how a pin gets held that the shell already
 * rejected.
 */
async function egressProxyReachable(proxyUrl) {
  try {
    await execFileAsync('curl', ['-so', '/dev/null', '--max-time', '4', '--proxy', proxyUrl, EGRESS_PROBE_URL], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The coordinator's verdict as a TRI-STATE: 'corporate', 'public', or null for
 * "it did not say".
 *
 * detectNetworkMode() above deliberately fails OPEN to 'public' when the
 * coordinator is unreachable, because a stray 'corporate' there only collapses
 * the provider chain and losing resilience is the worse error. Here the cost is
 * inverted: failing open would un-pin a corporate proxy that is genuinely
 * needed, breaking every call on a coordinator blip. So this reader keeps
 * "unknown" as its own answer and the caller leaves the pin alone.
 */
async function coordinatorNetworkVerdict() {
  try {
    const { stdout } = await execFileAsync('curl', ['-sf', '--max-time', '2', `${COORDINATOR_URL}/health/state`], { timeout: 4000 });
    const location = JSON.parse(stdout)?.network?.location;
    if (location === 'corporate' || location === 'vpn') return 'corporate';
    if (location === 'home' || location === 'public' || location === 'open' || location === 'direct') return 'public';
    return null;
  } catch {
    return null;
  }
}

/**
 * Re-decide the egress pin. Cheap (one local coordinator read, and a 4s curl
 * only when a proxy is actually in play), and a no-op in the steady state.
 *
 * The RULES live in proxy-bridge/egress-decision.mjs — pure, so the VPN-drop
 * sequence that caused the 2026-08-28 outage is a unit test rather than
 * something you have to disconnect a laptop to exercise. This function is only
 * the I/O around them: read the coordinator, probe if the decision needs it,
 * apply the answer.
 */
async function reevaluateEgressProxy() {
  const verdict = await coordinatorNetworkVerdict();
  const candidates = corporateProxyCandidates();

  let pinnedReachable = false;
  let reachableCandidate = null;
  if (needsReachabilityProbe(verdict)) {
    if (_egressProxyUrl) pinnedReachable = await egressProxyReachable(_egressProxyUrl);
    // Candidates are probed when nothing is pinned, AND when the pin just failed
    // its probe — so decideEgressProxy can hand a dead pin over to a working
    // proxy in the SAME decision instead of dropping to direct and waiting a
    // full interval to reconsider. The dead pin is excluded: it just answered
    // the question.
    if (!_egressProxyUrl || !pinnedReachable) {
      // First that answers wins; the list is already in preference order, so a
      // later entry is only reached when everything better failed.
      for (const c of candidates) {
        if (c === _egressProxyUrl) continue;
        if (await egressProxyReachable(c)) { reachableCandidate = c; break; }
      }
    }
  }

  const decision = decideEgressProxy({
    verdict,
    pinned: _egressProxyUrl,
    candidates,
    pinnedReachable,
    reachableCandidate,
  });
  if (decision.changed) setEgressProxy(decision.proxy, decision.reason);
  // Remember what worked, so a future process that starts on public still has a
  // corporate option when the machine moves. Only ever a proxy just PROVED
  // reachable — never a guess, never one that merely stayed pinned.
  if (decision.changed && decision.proxy) rememberCorporateProxy(decision.proxy);

  noteEgressState(verdict, decision);
}

/**
 * Publish the egress state, and say out loud when it is the broken one.
 *
 * ── Why a `hold` has to speak ───────────────────────────────────────────────
 * Only `changed` decisions used to be logged, and the failure that matters most
 * is a HOLD: corporate network, no proxy reachable, egress stays direct. On
 * 2026-09-01 the proxy sat in exactly that state for six minutes — routing
 * resolving correctly, the on-prem offload target answering fine, and every
 * external provider failing with `fetch failed` — and emitted not one line
 * about it. The cause had to be reconstructed from the ABSENCE of a re-pin
 * message, which is not a diagnostic anyone should have to run.
 *
 * Logged on TRANSITION, not per tick: this runs every 30s and a degraded state
 * lasts as long as the network does, so per-tick logging would bury the
 * transition it exists to mark.
 */
function noteEgressState(verdict, decision) {
  const degraded = egressIsDegraded(verdict, decision.proxy);
  _egressState = {
    proxy: decision.proxy,
    network: verdict,
    degraded,
    reason: decision.reason,
    since: degraded ? (_egressState.since || Date.now()) : null,
  };

  if (degraded && _egressDegradedReason !== decision.reason) {
    logErr(`egress DEGRADED: ${decision.reason}. `
      + 'The network needs a proxy and none is in force, so every provider that '
      + 'is not on-prem will fail with "fetch failed" until this clears.');
    _egressDegradedReason = decision.reason;
  } else if (!degraded && _egressDegradedReason) {
    log(`egress recovered: ${decision.reason}`);
    _egressDegradedReason = '';
  }
}

// Startup: adopt the launcher's decision verbatim, so a process that comes up on
// corporate behaves exactly as it did before this block was re-decidable. The
// timer only ever corrects it from here.
if (process.env.HTTPS_PROXY || process.env.https_proxy) {
  const pin = process.env.HTTPS_PROXY || process.env.https_proxy;
  setEgressProxy(pin, 'HTTPS_PROXY set by bin/start-llm-proxy.sh');
  // The launcher only exports a proxy it has just proved reachable, so this is
  // the best evidence on the machine of what works on corporate. Remembering it
  // is what lets a LATER process — one started at home, with no HTTPS_PROXY —
  // recover when the laptop moves, instead of probing only :3128 and holding
  // direct because that one candidate happened to be the one that fails here.
  rememberCorporateProxy(pin);
} else {
  log('egress: direct (no proxy) — no HTTPS_PROXY set at startup');
}
// One re-decision at a time. The 30s timer and a coordinator nudge can land
// together, and two overlapping runs would probe the same candidates twice and
// race on setEgressProxy. A caller arriving mid-run gets the run in flight —
// it started after the network changed, so its answer is current.
let _egressReevaluation = null;
function reevaluateEgressNow() {
  if (!_egressReevaluation) {
    _egressReevaluation = reevaluateEgressProxy().finally(() => { _egressReevaluation = null; });
  }
  return _egressReevaluation;
}

// Decide once now rather than waiting out the first interval: a process started
// at home and still running when the laptop reaches the office should not spend
// its first 30s on corporate with direct egress. Fire-and-forget — a network
// probe must never gate boot.
reevaluateEgressNow().catch(() => {});

{
  const t = setInterval(() => {
    reevaluateEgressNow().catch((err) => logErr(`egress re-evaluation failed: ${err?.message || err}`));
  }, EGRESS_RECHECK_MS);
  // Never hold the process open for a network probe.
  if (typeof t.unref === 'function') t.unref();
}

// --- Token Usage Persistence ---

// Per-instance SQLite DB for token-usage rows. Path resolves from
// LLM_PROXY_DATA_DIR so coding and OKB each own their own DB. Init is
// best-effort — if it fails (disk full, missing native module, perms),
// the proxy still serves completions, just without persistence.
// Outbound model canonicalization (Phase 36-06): see model-canonical.mjs.

// ── Foreground routing enforcement (fg-chat/<agent>) for /v1/messages ────────
//
// That route is a VERBATIM passthrough to api.anthropic.com: Claude Code
// speaks the Anthropic wire protocol, and the proxy forwards it unchanged
// rather than selecting a provider. That is why foreground claude has no
// fallback and why llm-routing.yaml marks the only provider that can serve
// it with `fg_transport: anthropic-passthrough`.
//
// What must NOT happen is what happened before: the config said one thing
// and this route silently did another, because it never read the config at
// all. So we look up the route and REFUSE loudly if it names a provider this
// transport cannot reach. A 501 that names the rule is worth far more than a
// request that quietly goes somewhere the config does not describe.
//
// Serving this combination for real needs an Anthropic<->OpenAI translation
// layer (messages API <-> chat/completions, SSE re-framing, tool_use <->
// tool_calls). That is deliberately not built yet — see
// docs/architecture/llm-routing.md, "Foreground Claude".
function fgChatRouteGuard(agent) {
  try {
    const rc = loadRoutingConfig();
    const fgRoute = resolveRoute(rc, { job: 'fg-chat', agent });
    const routedProvider = rc.providers[fgRoute.provider];
    if (!routedProvider?.fgTransport) {
      const msg = `foreground ${agent} is routed to "${fgRoute.provider}" by ${fgRoute.matchedKey}, `
        + `but this endpoint is an Anthropic-protocol passthrough and "${fgRoute.provider}" has no fg_transport. `
        + `Serving it needs an Anthropic<->OpenAI bridge, which is not implemented. `
        + `Either route ${fgRoute.matchedKey} to a provider with fg_transport, or use an agent that speaks the OpenAI shim.`;
      logErr(`/v1/messages route refused: ${msg}`);
      return { status: 501, body: { error: msg, type: 'ROUTE_NOT_IMPLEMENTED', route: fgRoute } };
    }
    return { route: fgRoute };
  } catch (err) {
    if (err?.name === 'RoutingConfigError') {
      logErr(`/v1/messages routing config unusable: ${err.message}`);
      return { status: 500, body: { error: `routing config unusable: ${err.message}`, type: 'ROUTING_CONFIG_ERROR' } };
    }
    throw err;
  }
}

let _tokenDb = null;
try {
  _tokenDb = initTokenDb();
  log(`token-usage DB ready at ${process.env.LLM_PROXY_TOKEN_DB_PATH || path.join(DATA_DIR, 'llm-proxy', 'token-usage.db')}`);
  // Phase 36-06: one-shot model-name canonicalization backfill. Runs once
  // per boot after initTokenDb (which itself runs hydrateFromExports), so
  // any rows hydrated from peer files in this same boot are normalised in
  // the same pass. Idempotent — subsequent boots scan 0 rows because all
  // remaining records have model_raw set.
  try {
    const bf = backfillCanonicalModelNames(_tokenDb, canonicalizeModelName);
    log(`token-usage model canonicalization backfill: scanned=${bf.scanned} rewritten=${bf.rewritten}`);
  } catch (err) {
    logErr(`token-usage canonicalization backfill failed (non-fatal): ${err.message}`);
  }
} catch (err) {
  logErr(`token-usage DB init failed (non-fatal): ${err.message}`);
}

// --- Cost + cadence settings (NOT routing) ---
//
// This file used to carry `processOverrides` — the per-process (provider, model)
// pins that were, in practice, the real routing config. They now live in
// config/llm-routing.yaml, where they are versioned, commented, validated and
// visible. What remains here is genuine runtime settings: model prices, budgets
// and the consolidation cadence, all consumed by the dashboard.
//
// `processOverrides` and `providerModels` are still READ for backward
// compatibility with an existing on-disk file, but nothing routes on them any
// more; they are ignored by the request path.
const SETTINGS_PATH = process.env.LLM_PROXY_SETTINGS_PATH
  || path.join(DATA_DIR, 'llm-proxy', 'llm-settings.json');

// Dropdown labels use the friendly canonical names ("claude-haiku-4.5") for
// all three Anthropic-serving providers — the proxy maps these back to the
// short aliases each backend wants. Before the direct-OAuth path landed, the
// CLI subprocess only accepted "haiku"/"sonnet"/"opus", so claude-code was
// stuck with bare aliases here. That constraint is gone.
const DEFAULT_SETTINGS = {
  processOverrides: {},
  providerModels: {
    'claude-code': ['claude-sonnet-4.6', 'claude-haiku-4.5', 'claude-opus-4.6'],
    'copilot':     ['claude-sonnet-4.6', 'claude-haiku-4.5', 'claude-opus-4.6', 'gpt-4o', 'gpt-4o-mini'],
    'groq':        ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    'openai':      ['gpt-4o', 'gpt-4o-mini'],
    'anthropic':   ['claude-sonnet-4.6', 'claude-haiku-4.5', 'claude-opus-4.6'],
  },
  // Cost/budget config for the dashboard Cost tab. Prices are USD per 1M tokens
  // (public provider rates); the dashboard multiplies raw token counts from
  // /api/token-usage/cost by these client-side, so edits take effect instantly.
  // Two canonical budget buckets = the two real subscriptions: `copilot`
  // (usage-based credits, real monthly cap) and `claude-max` (flat sub, notional).
  cost: {
    currency: { display: 'EUR', usdToEur: 0.92 },
    // Keyed by canonical model name; the dashboard resolves version/date
    // variants (claude-opus-4-8, ...-20251001) by family fallback (any *opus*
    // → the opus row), so this list only needs one entry per family.
    modelPrices: {
      'claude-haiku-4.5':  { in: 1,   out: 5,   cacheRead: 0.10,  cacheWrite: 1.25 },
      'claude-sonnet-4.6': { in: 3,   out: 15,  cacheRead: 0.30,  cacheWrite: 3.75 },
      'claude-opus-4.8':   { in: 5,   out: 25,  cacheRead: 0.50,  cacheWrite: 6.25 },
      'claude-fable-5':    { in: 10,  out: 50,  cacheRead: 1.00,  cacheWrite: 12.50 },
      'gpt-4o':            { in: 2.5, out: 10,  cacheRead: 1.25,  cacheWrite: 0 },
      'gpt-4o-mini':       { in: 0.15, out: 0.6, cacheRead: 0.075, cacheWrite: 0 },
      'gpt-5':             { in: 1.25, out: 10, cacheRead: 0.125, cacheWrite: 0 },
    },
    providerScale: { copilot: 1.0, 'claude-max': 1.0 },
    // GitHub Copilot Business: $19/mo seat includes 1,900 credits (1 credit = $0.01).
    // Overage billed at model token rates (default = modelPrices).
    copilot: { plan: 'business', includedCreditsUsd: 19, creditUsd: 0.01, overagePrices: 'sameAsModelPrices' },
    // budgetBasis: 'gross' compares projected gross usage cost to the cap;
    // 'overage' compares only spend above the included allowance.
    // `monthlyEur` is the standing cap; `monthlyEurByMonth` overrides it for
    // named months. A cap is not a constant — this one went 300 -> 600 -> 1000
    // during 2026-08 as extensions were approved — and without the history a
    // single number retroactively re-judges every past month against a budget it
    // never had, reporting July as comfortably inside a cap that did not exist.
    budgets: {
      copilot:     { monthlyEur: 300,  monthlyEurByMonth: { '2026-08': 1000 }, enforce: true,  budgetBasis: 'gross' },
      'claude-max': { monthlyEur: null, enforce: false, budgetBasis: 'gross' },
    },
  },
  // Runtime-tunable cadence for the dashboard auto-consolidation daemon
  // (server.js reads this each tick — see startAutoConsolidation()).
  consolidationCadence: { enabled: true, checkIntervalMinutes: 30, undigestedThreshold: 10 },
};

let _settings = null;

function loadSettings() {
  if (_settings) return _settings;
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    _settings = {
      processOverrides: parsed.processOverrides && typeof parsed.processOverrides === 'object'
        ? parsed.processOverrides : {},
      providerModels: parsed.providerModels && typeof parsed.providerModels === 'object'
        ? parsed.providerModels : DEFAULT_SETTINGS.providerModels,
      // Cost/cadence blocks are opaque config objects consumed by the dashboard;
      // shallow-merge onto defaults so a partial on-disk file keeps new default keys.
      cost: (parsed.cost && typeof parsed.cost === 'object')
        ? { ...DEFAULT_SETTINGS.cost, ...parsed.cost }
        : JSON.parse(JSON.stringify(DEFAULT_SETTINGS.cost)),
      consolidationCadence: (parsed.consolidationCadence && typeof parsed.consolidationCadence === 'object')
        ? { ...DEFAULT_SETTINGS.consolidationCadence, ...parsed.consolidationCadence }
        : { ...DEFAULT_SETTINGS.consolidationCadence },
    };
    log(`settings loaded from ${SETTINGS_PATH} (overrides for ${Object.keys(_settings.processOverrides).length} processes)`);
  } catch (err) {
    if (err.code !== 'ENOENT') logErr(`settings load failed (${err.code}): ${err.message}`);
    _settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    log(`settings: using defaults (no ${SETTINGS_PATH})`);
  }
  return _settings;
}

function saveSettings(next) {
  if (!next || typeof next !== 'object') throw new Error('settings body must be an object');
  // Partial PUTs must preserve blocks they omit — the Cost dialog sends only
  // { cost } / { consolidationCadence } and must NOT wipe routing overrides.
  // An explicit (present) processOverrides — even {} — still means "replace".
  const providerModels = next.providerModels && typeof next.providerModels === 'object'
    ? next.providerModels
    : (_settings?.providerModels || DEFAULT_SETTINGS.providerModels);
  const validProviders = new Set(Object.keys(providerModels));
  let cleanedOverrides;
  if ('processOverrides' in next) {
    cleanedOverrides = {};
    for (const [proc, override] of Object.entries(next.processOverrides || {})) {
      if (!override || typeof override !== 'object') continue;
      if (override.provider && !validProviders.has(override.provider)) {
        throw new Error(`processOverrides.${proc}.provider="${override.provider}" not in providerModels`);
      }
      // Strip empty rows so the on-disk file stays tidy
      if (override.provider || override.model) {
        cleanedOverrides[proc] = {
          ...(override.provider && { provider: String(override.provider) }),
          ...(override.model && { model: String(override.model) }),
        };
      }
    }
  } else {
    cleanedOverrides = _settings?.processOverrides || {};
  }
  const finalSettings = {
    processOverrides: cleanedOverrides,
    providerModels,
    // Persist the Cost-tab config blocks. Shallow-validated (must be objects);
    // merged onto defaults so a PUT that omits a sub-key doesn't wipe it.
    cost: (next.cost && typeof next.cost === 'object')
      ? { ...DEFAULT_SETTINGS.cost, ..._settings?.cost, ...next.cost }
      : (_settings?.cost || JSON.parse(JSON.stringify(DEFAULT_SETTINGS.cost))),
    consolidationCadence: (next.consolidationCadence && typeof next.consolidationCadence === 'object')
      ? { ...DEFAULT_SETTINGS.consolidationCadence, ..._settings?.consolidationCadence, ...next.consolidationCadence }
      : (_settings?.consolidationCadence || { ...DEFAULT_SETTINGS.consolidationCadence }),
  };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(finalSettings, null, 2), 'utf8');
  _settings = finalSettings;
  log(`settings saved to ${SETTINGS_PATH} (${Object.keys(cleanedOverrides).length} overrides)`);
  return finalSettings;
}

// Eager-load so a malformed file fails fast on boot rather than mid-request.
loadSettings();

// Same contract for the routing config, but harder: llm-settings.json now holds
// only cost/cadence, so a bad one degrades the dashboard. A bad routing config
// means we do not know where ANY call should go — so refuse to start rather than
// serve traffic on a policy nobody wrote. The thrown message names the key.
try {
  const _rc = loadRoutingConfig();
  log(`routing config loaded: ${Object.keys(_rc.routes).length} routes, `
    + `${Object.values(_rc.providers).filter(p => p.enabled).length} enabled providers `
    + `(${_rc.paths.routing})`);
} catch (err) {
  logErr(`FATAL: routing config unusable — ${err.message}`);
  logErr('The proxy will not start on an unreadable routing policy. Fix the file named above, then restart.');
  process.exit(1);
}

// Distinct `process` values seen in the token-usage DB — populates the
// settings UI's "known services" list. Returns empty array if the DB
// isn't initialized.
function distinctProcesses(handle) {
  if (!handle?.db) return [];
  try {
    return handle.db.prepare(`SELECT DISTINCT process FROM token_usage ORDER BY process`).all().map(r => r.process);
  } catch {
    return [];
  }
}

// Provider → default subscription label for the dashboard's billing-context
// breakdown when the caller doesn't tag the request explicitly. Takes the
// ACCOUNT id, so it reads the label straight off the routing config rather than
// re-deriving it from a hardcoded impl-name table.
function defaultSubscription(providerId) {
  try {
    const p = loadRoutingConfig().providers[providerId];
    if (p?.account) return p.account;
  } catch { /* config unusable — fall through to the legacy labels */ }
  if (providerId === 'copilot' || providerId === 'gh-copilot') return 'copilot-subscription';
  if (providerId === 'claude-code' || providerId === 'claude-code-max') return 'anthropic-subscription';
  return 'api-key';
}

// ── Routing helpers (config-driven) ──────────────────────────────────────────

// Agents whose traffic is a FOREGROUND conversation with a human, as opposed to
// a background cognitive service. Routing keys these as `fg-chat/<agent>`.
const FOREGROUND_AGENTS = new Set(['claude', 'copilot', 'opencode', 'pi']);
function agentIsForeground(agent) {
  return typeof agent === 'string' && FOREGROUND_AGENTS.has(agent);
}

// classifyFailure() lives in routing-config.mjs, next to the RETRY_CLASSES
// vocabulary it emits and the `retry_on` validation that consumes it. It is
// imported above; this file decides nothing about failure classes.

// --- VPN / Corporate Network Detection ---

// Delegates to ../src/network-detect.ts (compiled). That module's signals,
// in priority order: LLM_NETWORK_MODE env override → utun/tun with IPv4 inet
// AND private routes → DNS resolution of LLM_VPN_PROBE_HOST to a private IP.
// The previous inline check matched any utun* interface name, which gave a
// false positive on every modern macOS due to iCloud Private Relay /
// iMessage / FaceTime utun tunnels (IPv6-link-local only, no real VPN).
let cachedNetworkMode = null;
let networkModeCheckedAt = 0;
const COORDINATOR_URL = process.env.HEALTH_COORDINATOR_URL || 'http://127.0.0.1:3034';
const NETWORK_CACHE_TTL_MS = 30_000; // 30s — coordinator polls at the same rate

function detectNetworkMode() {
  const now = Date.now();
  if (cachedNetworkMode && (now - networkModeCheckedAt) < NETWORK_CACHE_TTL_MS) return cachedNetworkMode;

  let mode;

  // Try coordinator first (single source of truth)
  try {
    const raw = execSync(
      `curl -sf --max-time 1 ${COORDINATOR_URL}/health/state`,
      { encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    const state = JSON.parse(raw);
    if (state?.network?.location) {
      mode = state.network.location === 'corporate' || state.network.location === 'vpn'
        ? 'corporate' : 'public';
      log(`Network mode from coordinator: ${mode} (location: ${state.network.location})`);
    }
  } catch (_) {
    // Coordinator unavailable — fall back to local detection
  }

  if (!mode) {
    // Coordinator unreachable (e.g. a blip on flaky / off-corp wifi). FAIL OPEN
    // to 'public' instead of trusting the local heuristic: proxydetox listens on
    // :3128 at home/off-corp too, so detectNetworkModeSync() can wrongly report
    // 'corporate', which collapses the provider chain to copilot-only and drops
    // the claude-code fallback — brittle exactly when the link is flaky. A stray
    // 'public' is harmless (copilot stays the pinned primary via the enterprise
    // endpoint regardless of mode; networkMode only affects chain order, never
    // proxy routing), whereas a stray 'corporate' removes resilience. The
    // coordinator stays authoritative whenever it is reachable (above).
    const localGuess = detectNetworkModeSync();
    mode = 'public';
    log(`Network mode (local fallback): public (coordinator unreachable; local heuristic guessed '${localGuess}', failing open to keep the provider fallback)`);
  }

  cachedNetworkMode = mode;
  networkModeCheckedAt = now;
  return mode;
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
 * Enterprise: https://copilot-api.<tenant>.ghe.com
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

// --- Claude Max OAuth Token (direct-API fast path) ---
//
// Reads the Max OAuth bearer token from the macOS keychain (where the `claude`
// CLI persists it) and exposes it for direct POSTs to api.anthropic.com.
// Probed 2026-05-19: a vanilla `Authorization: Bearer <token>` against
// /v1/messages is accepted by Anthropic, returns ~0.9s total — vs. ~7.5s for
// the CLI subprocess path which auto-injects ~22K tokens of Claude Code system
// prompt for caching.
//
// Refresh policy: the CLI rotates the keychain blob whenever it makes a call.
// We cache in memory; re-read keychain when within 60s of expiry; on a 401
// from the API we clear the cache and fall back to the CLI (which performs
// the OAuth refresh as a side effect of its own completion). No bespoke
// refresh-endpoint logic in the proxy.

let _claudeOAuthCache = null;
const CLAUDE_OAUTH_REFRESH_BUFFER_MS = 60_000;

function readClaudeKeychain() {
  try {
    const out = execSync(`security find-generic-password -s 'Claude Code-credentials' -w`, {
      encoding: 'utf8',
      timeout: 5_000,
    });
    const parsed = JSON.parse(out.trim());
    const oauth = parsed?.claudeAiOauth;
    if (!oauth?.accessToken || !oauth?.expiresAt) return null;
    return {
      accessToken: oauth.accessToken,
      expiresAt: Number(oauth.expiresAt),
      refreshToken: oauth.refreshToken || null,
      subscriptionType: oauth.subscriptionType || null,
    };
  } catch (err) {
    logErr(`claude-code: keychain read failed: ${(err.message || '').slice(0, 120)}`);
    return null;
  }
}

function getClaudeOAuthToken() {
  const now = Date.now();
  if (!_claudeOAuthCache || (_claudeOAuthCache.expiresAt - now) < CLAUDE_OAUTH_REFRESH_BUFFER_MS) {
    const fresh = readClaudeKeychain();
    if (fresh) _claudeOAuthCache = fresh;
  }
  return _claudeOAuthCache;
}


// Model names accepted by the Anthropic API for the OAuth bearer flow.
// Distinct from ANTHROPIC_MODEL_MAP below — that one targets the api-key path
// with older dated snapshots that pre-date Haiku 4.5 / Sonnet 4.6. Anthropic
// returns the dated snapshot in the response so `model_raw` stays informative.
const CLAUDE_OAUTH_MODEL_MAP = {
  'sonnet':              'claude-sonnet-4-6',
  'haiku':               'claude-haiku-4-5',
  // Floating alias → current generation. An explicit claude-opus-4.6 below
  // still resolves to 4.6; only the unversioned alias moves.
  'opus':                'claude-opus-5',
  'claude-sonnet-4.6':   'claude-sonnet-4-6',
  'claude-haiku-4.5':    'claude-haiku-4-5',
  'claude-opus-4.6':     'claude-opus-4-6',
  'claude-sonnet-4-6':   'claude-sonnet-4-6',
  'claude-haiku-4-5':    'claude-haiku-4-5',
  'claude-opus-4-6':     'claude-opus-4-6',
};

// Anthropic's API expects HYPHENATED version suffixes (claude-opus-4-8,
// claude-sonnet-4-6). The opencode/copilot catalogs use the DOTTED form
// (claude-opus-4.8), which api.anthropic.com rejects verbatim ("model
// claude-opus-4.8 was not found. Did you mean claude-opus-4-8?"). Normalize the
// trailing <major>.<minor> → <major>-<minor> for ANY claude model, so a new
// version (4.8, 4.9, …) works on the Anthropic path without a per-version map
// entry. Returns the input unchanged when it doesn't match a claude model id.
function hyphenateClaudeVersion(name) {
  const m = String(name || '').match(/^(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)$/i);
  return m ? `${m[1]}-${m[2]}`.toLowerCase() : name;
}

function resolveClaudeOAuthModel(name) {
  if (!name) return 'claude-sonnet-4-6';
  return CLAUDE_OAUTH_MODEL_MAP[name]
    || CLAUDE_OAUTH_MODEL_MAP[String(name).toLowerCase()]
    || hyphenateClaudeVersion(name);
}

// --- Provider State ---

const providers = {
  'anthropic': { available: false, method: 'http' },
  'claude-code': { available: false, method: 'cli' },
  'copilot': { available: false, method: 'http' },
  'openai': { available: false, method: 'http' },
  'groq': { available: false, method: 'http' },
  // On-prem Qwen3.8-27B cluster. LAN-only, so unlike every provider above its
  // availability is a function of WHICH NETWORK we are on right now, not of a
  // key being present — see reprobeQwenLocal() below.
  'qwen-local': { available: false, method: 'http' },
  'qwen-laptop': { available: false, method: 'http' },
  // Optional providers (proxy-bridge/providers/*.mjs) add their own entry at
  // startup — see loadProviderPlugins().
};

// --- Copilot enterprise-upstream reachability (<tenant>.ghe.com) — DIAGNOSTIC ONLY ---
//
// The copilot provider talks to copilot-api.<enterpriseUrl> (e.g.
// copilot-api.<tenant>.ghe.com), which is unreachable off-corp.
//
// This probe used to REORDER the provider chain: when the upstream looked down
// it promoted claude-code above copilot. That heuristic is gone. It was invisible
// from any config file, it fired on a 30s-stale boolean, and it is redundant —
// an unreachable provider is simply a failed attempt, and llm-fallback.yaml
// already says where to go next. Removing it means one fewer thing that can move
// your traffic without telling you.
//
// The probe survives because the SIGNAL is genuinely useful when diagnosing a
// slow first call. It now only logs; nothing reads the flag to make a decision.
let _copilotEnterpriseReachable = true;
let _copilotEnterpriseProbedAt = 0;

// The enterprise API base (https://copilot-api.<host>) when copilot is configured
// for enterprise; null for public copilot (api.githubcopilot.com — no GHE dependency).
function copilotEnterpriseBase() {
  try {
    const { apiBaseUrl } = getCopilotCredentials();
    return apiBaseUrl && !apiBaseUrl.includes('api.githubcopilot.com') ? apiBaseUrl : null;
  } catch {
    return null;
  }
}

async function probeCopilotEnterpriseReachable() {
  const base = copilotEnterpriseBase();
  if (!base) { _copilotEnterpriseReachable = true; return; } // public copilot → no GHE dependency
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    // Any HTTP response (even 401/404) proves the host is reachable; only a
    // network error / DNS failure / timeout means "unreachable". proxyFetch is
    // used so the probe traverses the SAME path (incl. any corp proxy) the real
    // copilot call would — so enabling px on-corp flips this back to reachable.
    await proxyFetch(`${base}/models`, {
      method: 'GET',
      headers: { 'User-Agent': 'opencode/1.0' },
      signal: controller.signal,
    });
    if (!_copilotEnterpriseReachable) log(`copilot enterprise upstream reachable again (${base})`);
    _copilotEnterpriseReachable = true;
  } catch {
    // Diagnostic only — routing is unchanged by this. A copilot call that fails
    // here advances the chain configured in llm-fallback.yaml, same as any other
    // failure.
    if (_copilotEnterpriseReachable) logErr(`copilot enterprise upstream unreachable (${base}) — copilot calls will fail and fall back per llm-fallback.yaml`);
    _copilotEnterpriseReachable = false;
  } finally {
    clearTimeout(timer);
    _copilotEnterpriseProbedAt = Date.now();
  }
}

// --- Model Mapping ---

/**
 * Map provider-specific model names to API/CLI model names.
 * Copilot uses full model names; Claude CLI uses short aliases.
 * Anthropic uses full model names with date suffixes.
 */
// Anthropic accepts both the short alias ("claude-haiku-4-5") and the dated
// snapshot ("claude-haiku-4-5-20251001") on /v1/messages. Use the short alias
// so we automatically get whatever the current snapshot is — no map update
// needed every time Anthropic rotates a snapshot date.
const ANTHROPIC_MODEL_MAP = {
  'sonnet': 'claude-sonnet-4-6',
  'haiku': 'claude-haiku-4-5',
  'opus': 'claude-opus-5',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'claude-haiku-4.5': 'claude-haiku-4-5',
  'claude-opus-4.6': 'claude-opus-4-6',
};

function resolveAnthropicModel(model) {
  // Explicit map first (short aliases + known dotted ids), then the general
  // dotted→hyphenated normalizer so new versions (opus-4.8, …) resolve without
  // a per-version entry. api.anthropic.com only accepts the hyphenated form.
  return ANTHROPIC_MODEL_MAP[model] || hyphenateClaudeVersion(model);
}

const COPILOT_MODEL_MAP = {
  'sonnet': 'claude-sonnet-4.6',
  'haiku': 'claude-haiku-4.5',
  // NOT bumped to opus-5 with the Anthropic maps above, because three records
  // in this repo disagree about whether this leg serves opus at all, and the
  // endpoint (copilot-api.<enterprise>) is unreachable off-corp so none of them
  // can be settled from a public network:
  //   • the comment below says Copilot serves dotted claude-opus-4.8, verified live
  //   • llm-routing.yaml:113 (probed 2026-09-02) says every opus id earns
  //     "The requested model is not supported" from this same leg
  //   • token_usage has 98 successful copilot/claude-opus-4.8 rows — but the
  //     last is 2026-07-26, which is consistent with both if the catalogue drifted
  // Probe on corporate before changing this line. Do not infer it.
  'opus': 'claude-opus-4.6',
  // Opus 4.8 send-forms that Copilot's /models catalog does NOT accept verbatim.
  // Copilot serves the dotted `claude-opus-4.8` (verified live), but 400s on the
  // Claude-Code `-fast` variant and the dash spelling. Collapse both to the dotted
  // id HERE (copilot send-path only) rather than in MODEL_CANONICAL_MAP, so token
  // attribution elsewhere keeps recording `claude-opus-4.8-fast` distinctly.
  'claude-opus-4.8-fast': 'claude-opus-4.8',
  'claude-opus-4-8': 'claude-opus-4.8',
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
  // Short tier aliases (sonnet/haiku/opus) map directly. For full upstream
  // spellings (e.g. OpenCode's `claude-haiku-4-5` dash form, or a dated
  // snapshot) collapse to the canonical dot-form Copilot's API expects
  // (`claude-haiku-4.5`) via the shared canonicalizer — otherwise Copilot
  // 400s with "The requested model is not supported." (Phase 70-02: the
  // OpenCode→shim→copilot route sends full dash-form model ids.)
  return COPILOT_MODEL_MAP[model] || canonicalizeModelName(model);
}

function resolveClaudeModel(model) {
  // Map first (full dotted ids → short CLI aliases), then normalize any remaining
  // dotted version to the hyphenated full id the claude CLI accepts (it rejects the
  // dotted `claude-opus-4.8` but accepts `claude-opus-4-8`). This keeps a version-
  // pinned dotted id (e.g. opencode's `claude-opus-4.8`) working on the CLI path
  // without collapsing it to the floating `opus` alias.
  return CLAUDE_MODEL_MAP[model] || hyphenateClaudeVersion(model);
}

// OpenAI tier aliases — callers pass 'sonnet'/'haiku'/'opus' or 'fast'/'standard'/'premium';
// real model IDs need the full string.
const OPENAI_MODEL_MAP = {
  'fast':     'gpt-4o-mini',
  'standard': 'gpt-4o',
  'premium':  'gpt-4o',
  // Generic aliases map to closest OpenAI tier so callers with provider-agnostic
  // prompts don't 400 just because they passed 'sonnet'.
  'sonnet':   'gpt-4o',
  'haiku':    'gpt-4o-mini',
  'opus':     'gpt-4o',
};

function resolveOpenAIModel(model) {
  return OPENAI_MODEL_MAP[model] || model;
}

// Groq tier aliases — Groq runs Llama, DeepSeek, Mixtral, and a Whisper. We
// expose Llama 3.3 70B as the default, with the smaller 8B as the fast tier.
const GROQ_MODEL_MAP = {
  'fast':     'llama-3.1-8b-instant',
  'standard': 'llama-3.3-70b-versatile',
  'premium':  'llama-3.3-70b-versatile',
  'sonnet':   'llama-3.3-70b-versatile',
  'haiku':    'llama-3.1-8b-instant',
  'opus':     'llama-3.3-70b-versatile',
};

function resolveGroqModel(model) {
  return GROQ_MODEL_MAP[model] || model;
}

// --- Copilot: Direct HTTP Completion ---

// Above this requested-output budget, the Copilot API's non-streaming path
// must generate the WHOLE response before the gateway returns — large
// generations then exceed the upstream's ~240s response-time ceiling and come
// back as HTTP 500 with an empty body (2026-06-19 regression: 8192/16384 →
// 500/240s, 4096 → 200/80s). Streaming sidesteps that ceiling entirely because
// tokens flow incrementally and the connection never sits idle. We only stream
// for large budgets so the common small-prompt path keeps its simple single-
// JSON shape. `consolidator-insight` (insight synthesis, ~5-16k output) is the
// caller this unblocks.
const COPILOT_STREAM_MAXTOKENS_THRESHOLD = 4096;

/**
 * Parse an OpenAI-compatible SSE stream from the Copilot API, accumulating
 * `choices[0].delta.content` and capturing the terminal `usage` block (emitted
 * because we send `stream_options.include_usage = true`). Returns the same
 * `{ content, model, tokens }` shape as the non-streaming path so callers of
 * /api/complete are unaffected.
 */
async function readCopilotStream(response, fallbackModel) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage = {};
  let model = fallbackModel;
  // Phase 82-03: accumulate streamed tool_calls by index. OpenAI streams a
  // function call as index-keyed delta fragments: the first carries id/type/
  // function.name, subsequent ones append function.arguments string chunks.
  const toolCallsByIndex = new Map();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by newlines; each data line is `data: {json}`
    // or `data: [DONE]`. Process complete lines, keep any partial tail.
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '' || payload === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(payload); } catch { continue; }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') content += delta;
      const deltaToolCalls = chunk.choices?.[0]?.delta?.tool_calls;
      if (Array.isArray(deltaToolCalls)) {
        for (const tc of deltaToolCalls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          const acc = toolCallsByIndex.get(idx) || { index: idx, type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) acc.id = tc.id;
          if (tc.type) acc.type = tc.type;
          if (tc.function?.name) acc.function.name = tc.function.name;
          if (typeof tc.function?.arguments === 'string') acc.function.arguments += tc.function.arguments;
          toolCallsByIndex.set(idx, acc);
        }
      }
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
    }
  }

  // Renumber to a 0-based contiguous sequence. The upstream index groups
  // fragments DURING accumulation and is not an array position: this endpoint
  // numbers tool_call deltas after the turn's text block, so a narrated
  // two-call turn arrives as index 1 and 2 (observed live). Emitting those
  // verbatim leaves a hole at 0 for any client that indexes an array by it, and
  // disagrees with the buffered path, which numbers from 0. Order is preserved.
  const toolCalls = toolCallsByIndex.size > 0
    ? [...toolCallsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v], i) => ({ ...v, index: i }))
    : undefined;

  return {
    content,
    model,
    tokens: {
      // OpenAI's prompt_tokens INCLUDES cache hits; Anthropic's input_tokens
      // does not. Subtracting here makes `input` mean fresh input on both wires,
      // so total_tokens is the same quantity whichever provider answered and the
      // cache columns are additive everywhere. See openAIFreshInputTokens.
      input: openAIFreshInputTokens(usage),
      output: usage.completion_tokens || 0,
      total: openAIFreshInputTokens(usage) + (usage.completion_tokens || 0),
      // D-09 (IN-05): OpenAI-wire cache split — cached_tokens rides on
      // prompt_tokens_details, and is now genuinely separate from the total
      // rather than nominally so.
      ...parseOpenAICache(usage),
    },
    ...(toolCalls ? { toolCalls } : {}),
  };
}

/**
 * Complete via direct HTTP to the Copilot API (OpenAI-compatible endpoint).
 * Single HTTP POST (~2-5s) for typical prompts; switches to a streamed read
 * for large output budgets to dodge the upstream gateway's response-time
 * ceiling (see COPILOT_STREAM_MAXTOKENS_THRESHOLD).
 */
async function completeCopilot(body) {
  const creds = getCopilotCredentials();

  const model = resolveCopilotModel(body.model || 'claude-sonnet-4.6');
  const timeoutMs = body.timeout || 120_000;
  const maxTokens = body.maxTokens || body.max_tokens || 4096;
  const useStream = maxTokens > COPILOT_STREAM_MAXTOKENS_THRESHOLD;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const requestBody = {
    model,
    messages: body.messages || [],
    max_tokens: maxTokens,
    stream: useStream,
    // include_usage makes the upstream emit a terminal chunk carrying the
    // token counts; harmless (ignored) when stream is false.
    ...(useStream ? { stream_options: { include_usage: true } } : {}),
  };

  if (body.temperature !== undefined) {
    requestBody.temperature = body.temperature;
  }
  if (body.responseFormat) {
    requestBody.response_format = body.responseFormat;
  }
  // Phase 82-03: forward tools[]/tool_choice for native function calling. This
  // is the RUNTIME path the OpenAI shim actually hits (the internalBody built at
  // the /v1/copilot route flows here as `body`). Copilot's /chat/completions is
  // OpenAI-native. Guarded so tool-less requests are byte-unchanged.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    requestBody.tools = body.tools;
  }
  if (body.tool_choice !== undefined) {
    requestBody.tool_choice = body.tool_choice;
  }

  try {
    const response = await proxyFetch(`${creds.apiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'opencode/1.0',
        'Openai-Intent': 'conversation-edits',
        ...(useStream ? { 'Accept': 'text/event-stream' } : {}),
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      clearTimeout(timer);
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

    if (useStream) {
      const result = await readCopilotStream(response, model);
      clearTimeout(timer);
      return result;
    }

    const data = await response.json();
    clearTimeout(timer);
    // Read across ALL choices, not just choices[0]: the enterprise Copilot
    // bridge splits an Anthropic turn's text block and tool_use block into
    // SEPARATE choices, so a model that narrates before acting put its tool call
    // in choices[1] and had it silently dropped. Full rationale, and why the
    // streamed path is unaffected, on mergeCopilotChoices.
    const { content, toolCalls } = mergeCopilotChoices(data);
    const usage = data.usage || {};

    return {
      content,
      model: data.model || model,
      tokens: {
        // Fresh input only — see readCopilotStream and openAIFreshInputTokens.
        input: openAIFreshInputTokens(usage),
        output: usage.completion_tokens || 0,
        total: openAIFreshInputTokens(usage) + (usage.completion_tokens || 0),
        // D-09 (IN-05): OpenAI-wire cache split (see readCopilotStream).
        ...parseOpenAICache(usage),
      },
      ...(toolCalls ? { toolCalls } : {}),
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Copilot API timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

/** Copilot's GPT-5.x models use the OpenAI Responses endpoint, not chat/completions. */
async function completeCopilotResponses(body) {
  const creds = getCopilotCredentials();
  const model = resolveCopilotModel(body.model);
  const timeoutMs = body.timeout || 120_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestBody = {
    ...(body.responses_body || {}),
    ...(Array.isArray(body.responses_body?.input)
      ? { input: repairFunctionCallIds(body.responses_body.input) }
      : {}),
    model,
    // Buffer inside the proxy. The caller still receives a correctly framed
    // single-shot Responses SSE stream from responseSseFrames().
    stream: false,
  };
  try {
    const response = await proxyFetch(`${creds.apiBaseUrl}/responses`, {
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
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Copilot Responses API error (${response.status}): ${errBody}`);
    }
    const data = await response.json();
    const output = Array.isArray(data.output) ? data.output : [];
    const content = output
      .filter(item => item?.type === 'message')
      .flatMap(item => Array.isArray(item.content) ? item.content : [])
      .filter(part => part?.type === 'output_text')
      .map(part => part.text || '')
      .join('');
    const toolCalls = output
      .filter(item => item?.type === 'function_call')
      .map((item, index) => ({
        index,
        id: item.call_id || item.id,
        // The Responses item id (`fc_...`) is a different id from the call id;
        // responseSseFrames needs it to hand the client back an id Copilot accepts.
        ...(item.id ? { itemId: item.id } : {}),
        type: 'function',
        function: { name: item.name || '', arguments: item.arguments || '{}' },
      }));
    const usage = data.usage || {};
    const cached = usage.input_tokens_details?.cached_tokens || 0;
    return {
      content,
      model: data.model || model,
      tokens: {
        input: Math.max(0, (usage.input_tokens || 0) - cached),
        output: usage.output_tokens || 0,
        total: Math.max(0, (usage.input_tokens || 0) - cached) + (usage.output_tokens || 0),
        cache_read_tokens: cached,
        cache_write_tokens: 0,
      },
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Copilot Responses API timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
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
    // flattenContentToText: the shim now PRESERVES an OpenAI block list that
    // carries an image so the OpenAI-native legs can use it. This leg builds
    // Anthropic's own message shape (which spells images differently), so it
    // reduces the list to text here rather than sending something the API
    // rejects. A string passes through untouched.
    const content = flattenContentToText(msg.content);
    if (msg.role === 'system') {
      system = system || content;
    } else {
      apiMessages.push({ role: msg.role, content });
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

  // Inject ephemeral cache_control breakpoints (system + last message) so the
  // stable prefix is written to Anthropic's prompt cache and re-read (~0.1x) on
  // subsequent turns. Pure/idempotent; below-minimum prefixes are ignored by
  // the API. Without this, cache_creation_input_tokens is always 0.
  const cached = PROMPT_CACHE_ENABLED
    ? applyAnthropicCacheControl({ system, messages: apiMessages })
    : { system, messages: apiMessages };

  const requestBody = {
    model,
    max_tokens: maxTokens,
    messages: cached.messages,
    ...(cached.system ? { system: cached.system } : {}),
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

    // Normalize to the {content, model, tokens:{input,output,total}} shape
    // shared by completeCopilot / completeClaudeCode so the dispatcher's
    // result.content + result.tokens.total reads work uniformly across
    // providers. (Earlier shape returned {text, usage} and silently broke
    // anthropic responses through this bridge.)
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    const cache = parseUsageCache(data.usage);
    return {
      content: text,
      model: data.model,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        total: inputTokens + outputTokens,
        cache_read_tokens: cache.cacheRead,
        cache_write_tokens: cache.cacheWrite,
      },
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Anthropic API timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

// --- OpenAI / Groq: shared OpenAI-compatible HTTP completion ---

/**
 * Single implementation for both OpenAI's API and Groq's OpenAI-compatible
 * endpoint. Same wire format (chat/completions), same response shape, different
 * base URL + API key env var. Both honor HTTPS_PROXY via proxyFetch.
 *
 * Returns the normalized {content, model, tokens:{i,o,t}} shape the dispatcher
 * expects, with real tokens from data.usage.{prompt_tokens, completion_tokens,
 * total_tokens}.
 *
 * Error mapping mirrors completeCopilot — 401/403 → AUTH_ERROR, 429 →
 * QUOTA_EXHAUSTED — so the existing dispatcher status-code mapping kicks in.
 */
async function completeOpenAICompatible({ body, providerLabel, apiBaseUrl, apiKey, model, timeoutMs: providerTimeoutMs }) {
  // The provider's declared ceiling (llm-routing.yaml `timeout_ms`) CAPS the
  // caller's request; it is not a default the caller can raise. A provider that
  // declares one is saying "past this point, the fallback is the better bet" —
  // which for a local offload target is a much shorter wait than for a metered
  // account, and is not a judgement any individual caller is in a position to
  // overrule. `body.timeout || providerTimeoutMs` let it, and that is how a
  // 300s consolidator call sat on a 30s endpoint for five minutes, 24 times in
  // one day. See request-timeout.mjs for the measurement, and
  // routing-config.mjs for why the ceiling is a property of the endpoint.
  //
  // NOTE `providerTimeoutMs` here is the DESTRUCTURED PARAMETER above (renamed
  // from `timeoutMs`), not the module-level helper of the same name near the
  // dispatcher. The callers that supply it are the two local targets.
  const timeoutMs = resolveRequestTimeout({
    callerTimeoutMs: body.timeout,
    providerTimeoutMs,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const requestBody = {
    model,
    messages: body.messages || [],
    max_tokens: body.maxTokens || body.max_tokens || 4096,
    stream: false,
    // tools[]/tool_choice, when the caller sent any. This leg used to build its
    // body from the fixed list above and drop them, which made `openai`'s
    // capabilities.tools: true in llm-routing.yaml a mis-declaration: the
    // capability gate exists to keep a tools-bearing request OFF a provider that
    // would drop the tools and answer in prose, and it was waving one through.
    // outboundToolFields returns {} for a tool-less request, so that case stays
    // byte-identical to before.
    ...outboundToolFields(body),
  };
  if (body.temperature !== undefined) requestBody.temperature = body.temperature;
  if (body.responseFormat) requestBody.response_format = body.responseFormat;

  try {
    const response = await proxyFetch(`${apiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        // Omitted entirely when there is no key, rather than sent as an empty
        // `Bearer `. Every metered provider on this leg refuses to call without
        // one long before reaching here, so this only ever applies to the local
        // llama.cpp server — which is unauthenticated, and where a malformed
        // Authorization header is a way to get a 401 out of something that has
        // no auth at all.
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      let errMsg = errBody;
      try {
        const j = JSON.parse(errBody);
        errMsg = j.error?.message || j.error || errBody;
      } catch { /* keep raw text */ }
      if (response.status === 401 || response.status === 403) {
        throw new Error(`AUTH_ERROR: ${providerLabel} API returned ${response.status}: ${errMsg}`);
      }
      if (response.status === 429) {
        throw new Error(`QUOTA_EXHAUSTED: ${providerLabel} API rate limited: ${errMsg}`);
      }
      throw new Error(`${providerLabel} API error (${response.status}): ${errMsg}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || {};
    // Renumbered to the same 0-based contiguous shape mergeCopilotChoices
    // produces, so buildBufferedChoice / buildStreamDelta cannot tell the
    // buffered leg from the streamed Copilot one. undefined when there are none,
    // so a tool-less result is unchanged.
    const toolCalls = normalizeToolCalls(data.choices?.[0]?.message?.tool_calls);
    return {
      content,
      model: data.model || model,
      tokens: {
        // Fresh input only — see readCopilotStream and openAIFreshInputTokens.
        input: openAIFreshInputTokens(usage),
        output: usage.completion_tokens || 0,
        total: openAIFreshInputTokens(usage) + (usage.completion_tokens || 0),
        // D-09 (IN-05): OpenAI-wire cache split (see readCopilotStream).
        ...parseOpenAICache(usage),
      },
      ...(toolCalls ? { toolCalls } : {}),
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`${providerLabel} API timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

async function completeOpenAI(body) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('AUTH_ERROR: OPENAI_API_KEY not set');
  const apiBaseUrl = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1';
  return completeOpenAICompatible({
    body,
    providerLabel: 'OpenAI',
    apiBaseUrl,
    apiKey,
    model: resolveOpenAIModel(body.model || 'standard'),
  });
}

async function completeGroq(body) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('AUTH_ERROR: GROQ_API_KEY not set');
  const apiBaseUrl = process.env.GROQ_API_BASE_URL || 'https://api.groq.com/openai/v1';
  return completeOpenAICompatible({
    body,
    providerLabel: 'Groq',
    apiBaseUrl,
    apiKey,
    model: resolveGroqModel(body.model || 'standard'),
  });
}

/**
 * The timeout a provider declares in llm-routing.yaml, or null for the default.
 *
 * Read per call rather than cached: the YAML is hot-reloaded on mtime, so an
 * operator shortening a misbehaving endpoint's ceiling takes effect on the next
 * request instead of after a restart — the same contract every other routing
 * field already has.
 */
function providerTimeoutMs(providerId, model) {
  try {
    const p = loadRoutingConfig().providers[providerId];
    if (!p) return null;
    // The ceiling is resolved by BAND, but the band is not in scope at the
    // completer — the model id is, and it is the more accurate key anyway: the
    // ceiling exists to bound how long THIS model may take, and the band is only
    // how that model got chosen. Reverse-map through the provider's own band
    // table, which is the same table that picked the id in the first place.
    //
    // If two bands share one model, take the most generous of their ceilings.
    // The model does the same work whichever band selected it, so the shorter
    // ceiling would cut off a call the config elsewhere says is allowed to run.
    let band = null;
    if (model) {
      const matches = Object.keys(p.models || {}).filter((b) => p.models[b] === model);
      band = matches.reduce((best, b) => {
        const v = resolveProviderTimeout(p, b);
        const bestV = best === null ? -1 : (resolveProviderTimeout(p, best) ?? -1);
        return v !== null && v > bestV ? b : best;
      }, null);
    }
    return resolveProviderTimeout(p, band);
  } catch {
    // A config that will not parse must not take the dispatcher down with it;
    // the default ceiling is always a safe answer.
    return null;
  }
}

/**
 * Base URL of the on-prem Qwen cluster. Also read by the reachability re-probe.
 *
 * MOVED 2026-09-07: node 1 -> nodes 2+3. The old address is NOT simply gone, which is what made the
 * move hard to see: it still answers /v1/models with a full model list, so
 * every reachability check passed, while /chat/completions returned
 * `503 dual-server backend unavailable: [Errno 111] Connection refused`. A
 * probe that only lists models cannot tell a live cluster from a dead one.
 */
function qwenLocalBaseUrl() {
  return process.env.QWEN_LOCAL_API_BASE_URL || '';
}

/**
 * The stage-2 client, bound to this process's egress-aware fetch.
 *
 * The rubric, the endpoint resolution and the per-impl clients live in
 * classifier-client.mjs, NOT here. That split is load-bearing rather than
 * tidiness: the gate on enabling the classifier is what
 * scripts/eval-prompt-classifier.mjs measures, and an eval carrying its own
 * copy of the rubric would be measuring a prompt this proxy does not send —
 * silently, from the first time either copy was edited. server.mjs cannot be
 * imported to borrow it (it boots an HTTP server on import), so the shared part
 * moved out and both sides import it.
 *
 * proxyFetch is injected because the choice is this file's alone: the classifier
 * endpoint is loopback or LAN, and shouldBypassProxy() already keeps both off
 * the corporate proxy — which is what makes a verdict work identically on VPN
 * and off it. The eval, running against the same endpoint from a shell, needs
 * none of that.
 *
 * @param {{impl: string, timeoutMs: number}} cls
 * @returns {((text: string) => Promise<string>) | null}
 */
function makeClassifierVerdictFn(cls) {
  return makeClassifierClient(cls, { fetchImpl: proxyFetch });
}

/**
 * What the classifier has actually done since this process started.
 *
 * In-process and deliberately not persisted. The question a reader has is "is
 * this thing doing anything right now", and a counter that survives restarts
 * answers a different one — it would keep showing a healthy number through an
 * outage that started an hour ago. Resetting to zero on restart is the honest
 * behaviour: a statusline badge stuck at the same figure for an hour is a
 * signal, where a large lifetime total is wallpaper.
 *
 * MONOTONIC between restarts, which is what makes it safe to read from a
 * surface that refreshes on its own schedule: a stale read undercounts, and
 * can never report the wrong STATE the way a "last call was downgraded"
 * indicator would.
 */
const _processStartedAt = Date.now();
const classifierStats = { asked: 0, downgraded: 0, unchanged: 0, failed: 0 };

/**
 * How much work actually ran on hardware we own.
 *
 * A DIFFERENT question from classifierStats.downgraded, and the reason that
 * counter is labelled `[D:]` on the statusline rather than `[L:]`. The two sets
 * overlap only partially:
 *
 *   - A downgraded turn off-VPN with the laptop target off goes to
 *     gh-copilot/claude-haiku-4.5 — cheaper, still metered, nothing local.
 *   - The background services that DO reach a local box (observation-writer,
 *     health-coordinator) were never classified at all, because their band is
 *     fixed in config. They are absent from the downgrade count entirely.
 *
 * So this counts the thing itself: completions SERVED by a provider whose
 * account is self-hosted (see SELF_HOSTED_ACCOUNTS). Counted after the call
 * returns, keyed on the provider that actually answered — not on the one the
 * route named. A turn routed to qwen-laptop that times out at 20s and falls
 * back to gh-copilot ran on a paid account, and must not be counted here just
 * because the offload intended otherwise.
 *
 * `completions` is the denominator over the same window, so a reader can tell
 * "3 local out of 4" from "3 out of 900".
 *
 * WHAT IT CANNOT SEE, and this is by design elsewhere: picking
 * qwen-laptop/qwen3.8-27b-local directly in opencode's or pi's model picker
 * does not traverse this proxy, writes no token_usage row, and is invisible
 * here. That work is genuinely local and genuinely uncounted — the endpoint is
 * loopback, unmetered and credential-free, so there is nothing to bill and
 * nothing leaves the machine, which is why it was left unmeasured. `[L:]`
 * therefore means "local work the proxy routed", not "all local work".
 *
 * Same lifecycle as classifierStats: in-process, reset by a restart, monotonic
 * in between — a stale read undercounts and can never show the wrong state.
 */
const executionStats = { completions: 0, local: 0 };

/**
 * The details that mean "no call was made", taken from SKIP rather than
 * restated — a new skip reason added there must not silently start counting as
 * a classifier that declined to act.
 */
const SKIP_DETAILS = new Set(Object.values(SKIP));

/**
 * On-prem Qwen3.8-27B cluster — an ordinary OpenAI-compatible endpoint, so it
 * reuses the shared leg exactly as groq/openai do.
 *
 * NOTE there is no model-name resolution here, deliberately. resolveGroqModel /
 * resolveOpenAIModel translate tier words ('fast'/'standard') that predate the
 * routing config; the model reaching this function is already the exact wire id
 * llm-routing.yaml picked for the resolved complexity band, and inventing a
 * second mapping is how a launcher and the proxy end up disagreeing about which
 * model is running.
 */
async function completeQwenLocal(body) {
  const apiKey = process.env.QWEN_LOCAL_API_KEY;
  if (!apiKey) throw new Error('AUTH_ERROR: QWEN_LOCAL_API_KEY not set');
  return completeOpenAICompatible({
    body,
    providerLabel: 'Qwen local',
    apiBaseUrl: qwenLocalBaseUrl(),
    apiKey,
    model: body.model,
    timeoutMs: providerTimeoutMs('qwen-local', body.model),
  });
}

/**
 * Base URL of the Qwen server running on THIS laptop (llama.cpp, Metal).
 *
 * :8081 and not :8080 — Docker holds 8080 on this machine. Also read by the
 * reachability re-probe.
 */
function qwenLaptopBaseUrl() {
  return process.env.QWEN_LAPTOP_API_BASE_URL || 'http://127.0.0.1:8081/v1';
}

/**
 * On-device Qwen under llama.cpp — an ordinary OpenAI-compatible endpoint, so it
 * reuses the shared leg exactly as qwen-local/groq/openai do.
 *
 * NO key is required, unlike the cluster: llama.cpp's server is unauthenticated
 * on loopback. QWEN_LAPTOP_API_KEY is honoured when set, for anyone who fronts it
 * with something that wants one, but its absence is the normal case and must not
 * be an error — refusing to call would leave the off-corp offload with nowhere to
 * go, which is the whole reason this provider exists.
 *
 * Model-name resolution is deliberately absent here for the same reason as
 * qwen-local: the id arriving has already been chosen by (provider, complexity)
 * in llm-routing.yaml, and a second mapping is how a launcher and the proxy end
 * up disagreeing about which model is running.
 */
async function completeQwenLaptop(body) {
  return completeOpenAICompatible({
    body,
    providerLabel: 'Qwen laptop',
    apiBaseUrl: qwenLaptopBaseUrl(),
    apiKey: process.env.QWEN_LAPTOP_API_KEY || '',
    model: body.model,
    timeoutMs: providerTimeoutMs('qwen-laptop', body.model),
  });
}

// --- Optional providers: proxy-bridge/providers/*.mjs ---
//
// A provider that only some deployments have (a corporate gateway, say) lives in a
// module of its own. Its default export takes { proxyFetch, log, logErr } and
// returns { impl, method, init(): boolean, complete(body) }. A deployment without
// the file has no such provider: an impl with no `providers` entry is already
// treated as unavailable when chains are filtered, so llm-routing.yaml may still
// declare it.

const PROVIDERS_DIR = process.env.LLM_PROXY_PROVIDERS_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'providers');
const providerPlugins = {};

async function loadProviderPlugins(dir = PROVIDERS_DIR) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  } catch {
    return; // no providers directory: none of them
  }
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      const p = mod.default({ proxyFetch, log, logErr });
      providerPlugins[p.impl] = p;
      providers[p.impl] = { available: Boolean(await p.init()), method: p.method };
    } catch (err) {
      logErr(`provider module ${f} failed to load: ${err?.message || err}`);
    }
  }
}

// --- Claude Code: Direct API Completion (Max OAuth, fast path) ---

/**
 * Complete via a direct POST to api.anthropic.com/v1/messages with the
 * Max-subscription OAuth bearer token. Bypasses the `claude` CLI subprocess
 * entirely, eliminating both:
 *   1. ~3-5s of subprocess spawn + CLI boot overhead per call.
 *   2. ~16-22K tokens of cache_creation that the CLI auto-injects (its full
 *      system prompt + tool definitions) — billed even on a "say OK" ping.
 *
 * Probed 2026-05-19 end-to-end at ~0.9s and 9 input + 4 output tokens for
 * "say OK", vs. ~7.5s / 14.9K tokens via the CLI path.
 *
 * Falls back to the CLI on AUTH_ERROR (401/403) or network failure — the CLI
 * rotates the keychain blob as a side effect, so the next direct call picks
 * up the refreshed token automatically. No bespoke OAuth refresh logic.
 */
async function completeClaudeCodeDirect(body, clientAbortSignal) {
  const token = getClaudeOAuthToken();
  if (!token) {
    const err = new Error('AUTH_ERROR: no Claude Max OAuth token in keychain');
    err.shouldFallbackToCLI = true;
    throw err;
  }

  // Split system messages from chat messages — Anthropic API takes `system`
  // as a top-level parameter, not as a system-role message in the array.
  const messages = body.messages || [];
  const systemParts = [];
  const apiMessages = [];
  for (const m of messages) {
    // See completeAnthropic: reduce a preserved block list to text for the
    // Anthropic-shaped request this leg builds.
    const _c = flattenContentToText(m.content);
    if (m.role === 'system') systemParts.push(_c);
    else apiMessages.push({ role: m.role, content: _c });
  }
  if (apiMessages.length === 0) {
    if (body.prompt) apiMessages.push({ role: 'user', content: body.prompt });
    else throw new Error('No messages or prompt provided');
  }
  // Allow systemPrompt/system_prompt body fields too (mirrors completeAnthropic).
  const explicitSystem = body.systemPrompt || body.system_prompt || '';
  const system = explicitSystem || (systemParts.length ? systemParts.join('\n\n') : '');

  const model = resolveClaudeOAuthModel(body.model || 'sonnet');
  // Inject ephemeral cache_control breakpoints (system + last message) so the
  // stable prefix is written to / re-read from Anthropic's prompt cache across
  // turns. Pure/idempotent; below-minimum prefixes are ignored by the API.
  const cached = PROMPT_CACHE_ENABLED
    ? applyAnthropicCacheControl({ system, messages: apiMessages })
    : { system, messages: apiMessages };
  const requestBody = {
    model,
    max_tokens: body.maxTokens || body.max_tokens || 4096,
    messages: cached.messages,
    ...(cached.system ? { system: cached.system } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
  };

  const timeoutMs = body.timeout || 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Propagate client disconnect → abort the in-flight fetch.
  if (clientAbortSignal) {
    if (clientAbortSignal.aborted) controller.abort();
    else clientAbortSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const resp = await proxyFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token.accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      let errBody = {};
      try { errBody = await resp.json(); } catch {}
      const errMsg = errBody.error?.message || errBody.message || `HTTP ${resp.status}`;
      if (resp.status === 401 || resp.status === 403) {
        _claudeOAuthCache = null; // force keychain re-read on next call
        const err = new Error(`AUTH_ERROR: ${errMsg}`);
        err.shouldFallbackToCLI = true;
        throw err;
      }
      if (resp.status === 429) {
        // Empirically (probed 2026-05-19) the Max-OAuth bearer endpoint enforces
        // per-model rate limits separately from the Claude Code CLI session
        // endpoint — the CLI succeeds for sonnet/opus when this direct path
        // 429s. Falling back keeps the call on the SAME Max subscription, just
        // routed through a different rate-limit bucket. Cross-provider
        // (claude-code → copilot) is NOT used here because pinning to
        // claude-code expresses user intent ("use Max"), not just "anything
        // that works".
        const err = new Error(`RATE_LIMITED: ${errMsg}`);
        err.shouldFallbackToCLI = true;
        throw err;
      }
      throw new Error(`Claude API error (${resp.status}): ${errMsg}`);
    }

    const data = await resp.json();
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    const usage = data.usage || {};
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cache = parseUsageCache(usage);
    return {
      content: text,
      model: data.model || model,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        total: inputTokens + outputTokens,
        cache_read_tokens: cache.cacheRead,
        cache_write_tokens: cache.cacheWrite,
      },
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
      throw new Error('client disconnected — claude direct call aborted');
    }
    throw err;
  }
}

// --- Claude Code: CLI Completion (fallback / legacy) ---

/**
 * Complete via the `claude` CLI in non-interactive mode.
 * Spawns: claude -p <prompt> --output-format json --model <model> --tools "" [--system-prompt <sp>]
 *
 * Used as a fallback for the direct-API path above when:
 *   - the keychain read fails,
 *   - the direct call returns 401/403 (token needs refresh — CLI does it),
 *   - the proxy is launched with LLM_PROXY_DISABLE_CLAUDE_DIRECT=1.
 *
 * ~10-15s per call (CLI startup overhead), but the API call itself is ~2-5s.
 */
async function completeClaudeCodeViaCLI(body, clientAbortSignal) {
  const messages = body.messages || [];
  const model = resolveClaudeModel(body.model || 'sonnet');
  const timeoutMs = body.timeout || 120_000;

  // Extract system prompt and user prompt from messages
  const systemParts = [];
  const userParts = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(flattenContentToText(m.content));
    } else if (m.role === 'assistant') {
      // Templated into a CLI argument, so a block list would stringify to
      // "[object Object]". Reduce it to text first.
      userParts.push(`Assistant: ${flattenContentToText(m.content)}`);
    } else {
      userParts.push(flattenContentToText(m.content));
    }
  }

  const userPrompt = userParts.join('\n\n');
  const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : null;

  if (!userPrompt) {
    throw new Error('No user message provided');
  }

  // `--` terminates option parsing so user prompts whose first non-whitespace
  // is `-` (like the consolidator's `--- NEW DIGESTS (1) ---` block headers)
  // aren't misread as unknown CLI flags. The prompt must therefore go LAST,
  // after all option flags. Reproduced before fix: error: unknown option '---'.
  // The proxy is a pure completion service — no tools, no skills, no MCP, no
  // project memory. Each flag below strips a chunk of context that the CLI
  // would otherwise inject by default. Measured on a "say OK" probe: omitting
  // these flags burns 14.8K input tokens; with them it's ~130. Cannot use
  // --bare because it disables keychain reads and breaks Max OAuth auth.
  const args = [
    '-p',
    '--output-format', 'json',
    '--model', model,
    '--tools', '',                              // disable tool definitions
    '--no-session-persistence',                 // don't persist
    '--disable-slash-commands',                 // skip skill resolution
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', // no MCP tool defs
    '--setting-sources', '',                    // skip hooks/auto-memory/CLAUDE.md
  ];

  // Always pass --system-prompt. Without it the CLI auto-injects Claude Code's
  // default system prompt (~14-22K tokens for caching). Callers that didn't
  // specify a system prompt get a minimal one.
  args.push('--system-prompt', systemPrompt || 'You are a helpful assistant.');

  args.push('--', userPrompt);

  try {
    const { stdout, stderr } = await execFileAsync(CLAUDE_CLI, args, {
      timeout: timeoutMs,
      env: buildClaudeEnv(),
      maxBuffer: 10 * 1024 * 1024, // 10MB for large responses
      // cwd: '/tmp' so Claude Code's project breadcrumb lands under
      // ~/.claude/projects/-tmp instead of inheriting the proxy's launchd
      // WorkingDirectory (rapid-llm-proxy). Without this, every spawned CLI
      // registers project activity for "RLP" in the status-line's project
      // tracker, polluting the active-projects list.
      cwd: '/tmp',
      // When the HTTP client disconnects (caller dropped, obs-api SIGTERMed),
      // Node kills the spawned claude CLI subprocess via this signal — no
      // more orphans hanging on after the parent's gone.
      signal: clientAbortSignal,
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

    // Client-disconnect abort (req.on('close') -> reqAbort.abort()): the
    // spawned CLI was killed because the caller's gone. Don't log this as
    // a timeout — it's a clean cancellation, not a real failure.
    if (err.code === 'ABORT_ERR' || msg.includes('client disconnected') || msg.includes('aborted')) {
      throw new Error('client disconnected — claude CLI killed');
    }

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

// --- Claude Code: Dispatcher (direct API → CLI fallback) ---
//
// All callers go through this. Default path is the direct OAuth POST to
// api.anthropic.com (~0.9s, real token counts). Falls back to the CLI on:
//   - keychain read failure (no token cached),
//   - 401/403 from the API (token expired — CLI refresh path),
//   - LLM_PROXY_DISABLE_CLAUDE_DIRECT=1 (escape hatch for emergencies).
//
// Non-auth errors (Anthropic 5xx, 429 quota, network reset) bubble up to the
// caller unchanged — falling back to the CLI wouldn't help with those.
//
// Phase 62: the CLI-fallback path is served by a warm per-(model×prompt) worker
// pool (worker-pool.mjs). The pool reuses the proxy's auth/model/logging helpers
// and overflows to the verbatim execFile path (completeClaudeCodeViaCLI) when all
// workers for a key are busy (D-06). `LLM_PROXY_DISABLE_WORKER_POOL=1` reverts to
// the per-call execFile path (GUARD-01), orthogonally to
// LLM_PROXY_DISABLE_CLAUDE_DIRECT (D-08). The direct OAuth path is untouched
// (POOL-04). A single module-level instance is reaped on proxy shutdown.
const workerPool = new WorkerPool({
  resolveClaudeModel,
  buildClaudeEnv,
  claudeCli: CLAUDE_CLI,
  log,
  logErr,
});

async function completeClaudeCode(body, clientAbortSignal) {
  const poolDisabled = process.env.LLM_PROXY_DISABLE_WORKER_POOL === '1'; // GUARD-01 (orthogonal to DISABLE_CLAUDE_DIRECT — D-08)

  // CLI-fallback path: the worker pool is the steady-state fast path; when the
  // pool is disabled (GUARD-01) OR all workers for a key are busy (D-06 overflow,
  // handled inside the pool) the verbatim per-call execFile path serves.
  const viaCliPath = (b, sig) =>
    poolDisabled ? completeClaudeCodeViaCLI(b, sig)
                 : workerPool.complete(b, sig, completeClaudeCodeViaCLI); // overflow = D-06

  if (process.env.LLM_PROXY_DISABLE_CLAUDE_DIRECT === '1') {
    return viaCliPath(body, clientAbortSignal);
  }
  try {
    return await completeClaudeCodeDirect(body, clientAbortSignal);
  } catch (err) {
    if (err && err.shouldFallbackToCLI) {
      const msg = err.message || '';
      const reason = msg.startsWith('RATE_LIMITED') ? 'rate-limited'
                   : msg.startsWith('AUTH_ERROR')   ? 'auth-error'
                   : 'unknown';
      log(`claude-code: direct API ${reason} (${msg.slice(0, 80)}); falling back to CLI via ${poolDisabled ? 'execFile' : 'worker pool'} (same Max subscription, different rate-limit bucket)`);
      return viaCliPath(body, clientAbortSignal);
    }
    throw err;
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

  // Initialize OpenAI — presence of OPENAI_API_KEY is enough; we skip the
  // network probe to avoid burning quota on every proxy startup. Mirror the
  // groq path below.
  if (process.env.OPENAI_API_KEY) {
    providers.openai.available = true;
    log(`openai: marked available (OPENAI_API_KEY set, key: ${process.env.OPENAI_API_KEY.slice(0, 10)}...)`);
  } else {
    log(`openai: OPENAI_API_KEY not set, skipping`);
  }

  // Initialize Groq — same shape, different env var.
  if (process.env.GROQ_API_KEY) {
    providers.groq.available = true;
    log(`groq: marked available (GROQ_API_KEY set, key: ${process.env.GROQ_API_KEY.slice(0, 10)}...)`);
  } else {
    log(`groq: GROQ_API_KEY not set, skipping`);
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

  // Initialize Groq (env-gated; HTTP call validates lazily on first use).
  // No startup ping — Groq's free tier has strict rate limits and a wasted
  // /models call at every restart isn't worth the validation when the first
  // real /api/complete will surface a 401 with the same error.
  if (process.env.GROQ_API_KEY) {
    providers.groq.available = true;
    log(`groq: initialized (env-gated, key: ${process.env.GROQ_API_KEY.slice(0, 10)}...)`);
  } else {
    log(`groq: GROQ_API_KEY not set, skipping`);
  }

  // Initialize OpenAI (env-gated; HTTP call validates lazily on first use)
  if (process.env.OPENAI_API_KEY) {
    providers.openai.available = true;
    log(`openai: initialized (env-gated, key: ${process.env.OPENAI_API_KEY.slice(0, 10)}...)`);
  } else {
    log(`openai: OPENAI_API_KEY not set, skipping`);
  }

  // Optional providers decide their own availability (proxy-bridge/providers/).
  await loadProviderPlugins();

  // Initialize the local, unmetered endpoints (the on-prem cluster and the
  // laptop server). See reprobeLocalEndpoint(): unlike every provider above,
  // "available" here is not a property of the config but of the network we are
  // on this minute, so it is re-evaluated on a timer.
  await reprobeLocalEndpoints();
  startLocalEndpointReprobe();
  warmClassifier();
}

/**
 * Prime the classifier's prompt cache, once, in the background.
 *
 * WHY THIS EXISTS, measured rather than assumed. A `local-llm` verdict costs
 * ~900ms warm, but the FIRST call after the server has not seen the rubric
 * prefix pays a full prefill — ~4.8s in isolation. Observed live on 2026-08-30:
 * the first classified opencode turn recorded
 * `classifier error: The operation was aborted due to timeout` and kept its
 * band, and the very next turn recorded `classified high -> small`.
 *
 * Fail-open meant that cost nothing but a missed downgrade, which is the design
 * working. It is still avoidable: one throwaway call at boot moves the prefill
 * off the first real request, which is what lets the timeout stay tight enough
 * to be worth having. Raising the timeout instead would tax EVERY genuine
 * timeout by the same amount, on every turn, forever.
 *
 * Best-effort in every direction: never awaited, never throws, logs once.
 */
function warmClassifier() {
  let cls;
  try { cls = loadRoutingConfig().classifier; } catch { return; }
  if (!cls?.enabled || cls.impl === 'none') return;
  const verdictFn = makeClassifierVerdictFn(cls);
  if (!verdictFn) return;
  // A generous one-off budget: this is off the request path entirely, so the
  // only thing a slow prefill delays here is the warm-up itself.
  Promise.resolve()
    .then(() => makeClassifierVerdictFn({ ...cls, timeoutMs: 30_000 })('ping'))
    .then(() => log(`classifier (${cls.impl}) warmed — prompt cache primed`))
    .catch((e) => log(`classifier (${cls.impl}) warm-up failed: ${e?.message || e} (first real call will pay the prefill)`));
}

// ── On-prem Qwen reachability ────────────────────────────────────────────────
//
// Every other provider's availability is decided ONCE, in initProviders(), and
// that is correct for them: a key either is or is not in the environment, and a
// hosted endpoint is reachable from any network. The on-prem cluster is neither.
// It lives on 10/8 and answers ONLY on the corporate network, and this daemon
// outlives a VPN connect/disconnect — so a boot-time verdict would mean a laptop
// started at home never reaches the cluster after joining the VPN, and one
// started on the VPN keeps a dead head at the front of every offloaded chain
// after leaving it.
//
// The chain builder already drops unavailable providers (`providers[c.impl]
// ?.available` in the /api/complete handler), so keeping this flag honest is the
// whole mechanism — there is no separate reachability policy to write. Contrast
// _copilotEnterpriseReachable above, which is DIAGNOSTIC ONLY: it used to reorder
// the chain, that heuristic was removed, and nothing reads it. This one is read.
//
// Cost of being wrong in each direction is asymmetric and shapes the design: a
// false "available" costs one failed request plus a fallback hop; a false
// "unavailable" silently sends offloadable work to a paid account. So the probe
// is cheap (a LAN GET, no tokens), frequent, and fails closed.
const QWEN_REPROBE_MS = Number(process.env.QWEN_LOCAL_REPROBE_MS || 60_000);

/**
 * The local, unmetered endpoints the semantic offload can land on.
 *
 * TWO of them, because there is no one machine that is always reachable: the
 * on-prem cluster answers only on corporate, the laptop server only where the
 * laptop is. llm-routing.yaml's `semantic_routing.targets` decides WHICH one a
 * given network uses; this table only keeps their availability honest.
 *
 * `requiresKey` differs on purpose. The cluster is a shared service behind a
 * bearer token, and probing it without one would report a reachable endpoint we
 * cannot actually call. The laptop server is llama.cpp on loopback with no auth
 * at all — demanding a key there would mark it permanently unavailable and the
 * off-corp offload would never fire, which is the bug this endpoint exists to
 * fix. An optional QWEN_LAPTOP_API_KEY is still sent when set, for anyone who
 * puts the server behind one.
 */
const LOCAL_ENDPOINTS = [
  { id: 'qwen-local', baseUrl: () => qwenLocalBaseUrl(), apiKeyEnv: 'QWEN_LOCAL_API_KEY', requiresKey: true },
  { id: 'qwen-laptop', baseUrl: () => qwenLaptopBaseUrl(), apiKeyEnv: 'QWEN_LAPTOP_API_KEY', requiresKey: false },
];

let _localProbeTimer = null;
/** Endpoint ids that have produced at least one verdict — first one always logs. */
const _localProbeSeen = new Set();

/**
 * The network llm-routing.yaml says this endpoint answers on, or null when it
 * declares none. Read from the SAME `semantic_routing.targets` list that decides
 * where an offload goes — there is no second table of "which network is this box
 * on", because a second one would drift.
 */
function targetNetworkFor(id) {
  try {
    const t = (loadRoutingConfig().semanticRouting?.targets || []).find(x => x.provider === id);
    return t ? t.requireNetwork : null;
  } catch {
    // An unparseable config is reported loudly on every real request. Here it
    // must not stop the probe: failing to probe is the same as failing closed,
    // and that silently sends offloadable work to a paid account.
    return null;
  }
}

async function reprobeLocalEndpoint(ep) {
  const base = ep.baseUrl();
  const was = providers[ep.id].available;
  const first = !_localProbeSeen.has(ep.id);
  _localProbeSeen.add(ep.id);
  const apiKey = process.env[ep.apiKeyEnv];

  // ── Do not touch an endpoint that cannot be ours to touch ──
  //
  // The cluster lives on 10/8 and answers only on corporate. Off-VPN this probe
  // was still firing every 60s: it opened a connection to a private-range address
  // on whatever network the laptop was actually on, and — once the key is set —
  // sent the corporate bearer token with it. The cluster's address is not ours at a
  // cafe or on a hotel LAN, and something there may well answer.
  //
  // The routing guard already refuses to SEND work here off-corp
  // (`require_network: corporate`), so probing off-corp could never do anything
  // but produce a `false` we are contractually going to ignore. Skipping it is
  // free, and marking unavailable is the honest state: on the wrong network,
  // this endpoint genuinely cannot serve.
  const wantNetwork = targetNetworkFor(ep.id);
  if (wantNetwork && detectNetworkMode() !== wantNetwork) {
    providers[ep.id].available = false;
    if (was || first) log(`${ep.id}: network is ${detectNetworkMode()}, endpoint answers only on ${wantNetwork} — not probed, marked unavailable`);
    return;
  }

  if (!base) {
    providers[ep.id].available = false;
    if (was || first) log(`${ep.id}: no base URL configured — marked unavailable`);
    return;
  }

  if (ep.requiresKey && !apiKey) {
    providers[ep.id].available = false;
    if (was) log(`${ep.id}: ${ep.apiKeyEnv} unset — marked unavailable`);
    else if (first) log(`${ep.id}: ${ep.apiKeyEnv} not set, skipping`);
    return;
  }

  let ok = false;
  let detail = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    // /models on an OpenAI-compatible server: no tokens, no side effects. Any
    // HTTP answer means the endpoint is there; only a connect/DNS/timeout failure
    // means it is not. A 401 is "reachable but the key is wrong", which must
    // surface as a loud auth error on the real call, not as silent unavailability.
    const resp = await proxyFetch(`${base}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    clearTimeout(timer);
    ok = true;
    detail = `HTTP ${resp.status}`;
  } catch (err) {
    ok = false;
    detail = err?.name === 'AbortError' ? 'timed out' : (err?.message || String(err));
  }
  providers[ep.id].available = ok;
  // Log only on a TRANSITION, or the first verdict. A 60s timer that logged every
  // tick would bury the proxy log in noise on either network.
  if (ok !== was || first) {
    if (ok) log(`${ep.id}: reachable at ${base} (${detail})`);
    else log(`${ep.id}: unreachable at ${base} (${detail}) — dropped from every chain until it returns`);
  }
}

function reprobeLocalEndpoints() {
  return Promise.all(LOCAL_ENDPOINTS.map(ep =>
    reprobeLocalEndpoint(ep).catch(err => logErr(`${ep.id} reprobe failed: ${err?.message || err}`))));
}

function startLocalEndpointReprobe() {
  if (_localProbeTimer) return;
  // No probe here: the caller awaits reprobeLocalEndpoints() first, so firing one
  // now would double-probe every endpoint at boot.
  _localProbeTimer = setInterval(() => { reprobeLocalEndpoints(); }, QWEN_REPROBE_MS);
  // Never hold the process open for a probe.
  if (typeof _localProbeTimer.unref === 'function') _localProbeTimer.unref();
}

// ── Measurement (context capture, task binding, usage tap) ──────────────────
// Lives in proxy-bridge/measurement.mjs + context-capture.mjs; created here,
// once the data dir, the token DB and the redaction set are known.

/** decodeURIComponent that never throws (a malformed escape yields the raw text). */
function safeDecode(raw) {
  if (!raw) return '';
  try { return decodeURIComponent(raw); } catch { return raw; }
}

// Phase 84-06 (D-06): compile the 27-pattern redaction set ONCE at startup from
// the coding repo's SINGLE source of truth — <CODING_ROOT>/config/redaction/
// redaction-patterns.json (or LLM_PROXY_REDACTION_CONFIG). The shared loader
// (Plan 02's enhanced-redaction-system.cjs) is preferred; the sibling falls back to a byte-identical inline loader against
// the same config file (no second divergent regex set, T-84-06-04). redactRawBody
// is fail-closed on CONTENT: any error → '[REDACTION_ERROR_CONTENT_BLOCKED]', never
// throws (a redaction error must never crash the daemon, T-84-06-03).
const _rawBodyRedactionPatterns = loadRawBodyRedactionPatterns(CODING_ROOT, process.env.LLM_PROXY_REDACTION_CONFIG);
const redactRawBody = makeRedactRawBody(_rawBodyRedactionPatterns);
const measurement = createMeasurement({
  dataDir: DATA_DIR,
  tokenDb: () => _tokenDb,
  redactRawBody,
  canonicalModel: canonicalizeModelName,
  log,
  logErr,
});
const usageRead = createUsageApi({ tokenDb: () => _tokenDb, measurement });

// --- HTTP Server ---

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // PATCH is here for /api/llm/routing, whose field-level edits are what the
  // dashboard's Routing/Fallback tabs send. Omitting it fails the CORS preflight
  // and the browser reports a bare "Failed to fetch" with no server-side trace —
  // the request never arrives, so the proxy log stays silent and it looks like a
  // save that did nothing.
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Re-decide egress NOW. The health coordinator calls this the moment the
  // host's network class changes (VPN on/off, office <-> home), which is what
  // lets a network switch reach this process without a restart: no in-flight
  // request is dropped and :12435 never stops listening. Clears the
  // network-mode cache too, so /health and chain ordering follow at once
  // instead of after up to NETWORK_CACHE_TTL_MS.
  if (req.method === 'POST' && req.url === '/api/egress/reevaluate') {
    cachedNetworkMode = null;
    try {
      await reevaluateEgressNow();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ networkMode: detectNetworkMode(), egress: _egressState }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err?.message || String(err) }));
    }
  }

  // The port opens BEFORE provider init (see main()), so a request can arrive
  // while init's network probes are still running. Anything that routes over
  // providers waits for them; the Anthropic passthrough and /health do not need
  // them and answer immediately — those are what a restarting proxy's clients
  // (a live claude session, the coordinator) actually hit.
  if (!_providersInitialized && !(
    (req.method === 'GET' && req.url === '/health')
    || (req.method === 'POST' && (req.url || '').split('?')[0].startsWith('/v1/messages'))
  )) {
    await _providersReady;
  }

  // --- Token usage (summary / cost / recent) + context breakdown / turns:
  // read-only, served by usage-api.mjs (shared with glass).
  if (usageRead(req, res)) return;

  // LLM settings: GET returns current overrides + reference data so the
  // dashboard's settings dialog can populate dropdowns. PUT replaces the
  // settings document atomically (validated, persisted to disk).
  // ── Routing config API ───────────────────────────────────────────────────
  //
  // Reads and writes config/llm-routing.yaml + config/llm-fallback.yaml — the
  // two files that decide everything. This is what the dashboard's Routing and
  // Fallback tabs edit, and what a launcher asks when it needs to know which
  // model to start an agent on.
  //
  // Note the split from /api/llm/settings below: that endpoint now owns ONLY
  // cost and consolidation cadence. Routing used to live there as
  // `processOverrides` in a .data JSON file, which is precisely why routing was
  // invisible — it was runtime state, not configuration.
  // What the classifier has done since boot, for a surface that polls.
  //
  // Its own endpoint rather than a field on /api/llm/routing, which reads two
  // YAML files off disk on every call — fine for a dashboard someone opened,
  // wrong for something a statusline hits on a timer. Config included so the
  // caller can render "off" without a second request, and so it can never show
  // a count beside a switch that is actually off.
  if (req.method === 'GET' && req.url === '/api/llm/classifier/stats') {
    let cfg = null;
    try { cfg = loadRoutingConfig().classifier; } catch { /* a broken config is not this route's problem */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      enabled: cfg?.enabled === true && cfg.impl !== 'none',
      impl: cfg?.impl ?? 'none',
      // Since THIS process started. Not persisted — see classifierStats.
      sinceBootMs: Date.now() - _processStartedAt,
      ...classifierStats,
    }));
  }

  // The whole judge, in one call: this proxy's policy plus the service's own
  // report of who is answering.
  //
  // ── Why the proxy fronts a service it does not own ──────────────────────────
  // The two halves live in different repos on purpose — the proxy decides
  // WHETHER to ask and which bands a verdict may take; the service owns the
  // model, the rubric, and which endpoint serves which network. But they are one
  // question to anybody looking at a dashboard ("why was this not downgraded?"),
  // and answering it from two origins would mean the browser reaching a second
  // port that exists on the host and not in the container the dashboard is
  // served from. One call, one origin, both halves.
  //
  // A judge that cannot be reached is NOT an error here. It is the single most
  // important thing this endpoint has to report — it is exactly the state that
  // went unnoticed on 2026-09-02 — so it comes back as `judge: null` with the
  // reason beside it, and the panel renders a dead judge rather than failing to
  // render at all.
  if (req.method === 'GET' && req.url === '/api/llm/classifier') {
    let cfg = null;
    try { cfg = loadRoutingConfig().classifier; } catch { /* reported as policy: null */ }
    let judge = null;
    let judgeError = null;
    try {
      const r = await fetch(`${classifierServiceBase()}/health`, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      judge = await r.json();
    } catch (e) {
      judgeError = String(e?.message || e);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      policy: cfg,
      // Where this proxy would send a verdict request, so a mismatch between the
      // impl named in policy and the service actually answering is visible
      // rather than inferred.
      judgeUrl: classifierServiceBase(),
      judge,
      ...(judgeError ? { judgeError } : {}),
      ...classifierStats,
    }));
  }

  // Edits to the judge's OWN config, forwarded verbatim.
  //
  // Deliberately a dumb pipe: the service validates its own file and is the only
  // thing that may write it. Re-validating here would mean this proxy carried a
  // second copy of a schema it does not own — the drift that
  // scripts/eval-prompt-classifier.mjs importing the real veto exists to avoid.
  // The status and body are passed through so a 400 arrives with the service's
  // own message naming the offending key.
  if (req.method === 'PATCH' && req.url === '/api/llm/classifier') {
    let rawBody = '';
    for await (const chunk of req) rawBody += chunk;
    try {
      const r = await fetch(`${classifierServiceBase()}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: rawBody,
        signal: AbortSignal.timeout(5000),
      });
      const text = await r.text();
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      return res.end(text);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: `prompt-classifier service unreachable at ${classifierServiceBase()}: ${e?.message || e}`,
        type: 'CLASSIFIER_SERVICE_UNREACHABLE',
      }));
    }
  }

  // How much work ran on hardware we own, since boot.
  //
  // A sibling of classifier/stats rather than a field on it: the classifier can
  // be off while this still has something to report (a fixed `small` band in
  // config offloads without any verdict being sought), and merging them would
  // put a count behind an `enabled: false` that hides it. Same shape and same
  // cost — two integers, no disk, no config read.
  if (req.method === 'GET' && req.url === '/api/llm/execution/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      sinceBootMs: Date.now() - _processStartedAt,
      ...executionStats,
    }));
  }

  if (req.method === 'GET' && req.url === '/api/llm/routing') {
    try {
      const cfg = loadRoutingConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        // Raw YAML text, so the UI can offer an "edit the file" view and a save
        // round-trips comments rather than silently deleting them.
        files: {
          routing: fs.readFileSync(cfg.paths.routing, 'utf8'),
          fallback: fs.readFileSync(cfg.paths.fallback, 'utf8'),
        },
        paths: cfg.paths,
        // Parsed views the form controls bind to.
        providers: providerCatalogue(cfg),
        routes: cfg.routes,
        defaults: cfg.defaults,
        // The offload policy. Exposed so the dashboard can show and toggle it —
        // without this it is the one routing decision that is invisible from the
        // UI while silently changing which provider answers every cheap call.
        semanticRouting: cfg.semanticRouting,
        // The prompt classifier. Same argument as the offload block above: it
        // decides which model answers a foreground turn, and without this it is
        // configurable only by editing YAML — invisible from the UI that owns
        // every other routing decision. Exposing it is also what lets the
        // dashboard state the two things the block's own defaults make easy to
        // miss: `enabled: true` with `impl: none` still cannot downgrade
        // anything, and `bands` is the ceiling on what a verdict may say.
        classifier: cfg.classifier,
        fallback: {
          chains: cfg.fallback.chains,
          retryOn: [...cfg.fallback.retryOn],
          sameProviderRetries: cfg.fallback.sameProviderRetries,
          enforceCapabilities: cfg.fallback.enforceCapabilities,
        },
        // Non-fatal findings from the last parse (a fallback candidate skipped
        // because its provider is disabled, say), so the UI can surface them
        // instead of leaving them in stderr.
        warnings: cfg.warnings,
        // Runtime facts, kept separate from config so the UI can show "routed
        // here but not currently reachable" instead of conflating the two.
        runtime: {
          network: detectNetworkMode(),
          availableImpls: Object.entries(providers).filter(([, v]) => v.available).map(([k]) => k),
          allImpls: Object.keys(providers),
          // Egress belongs with the other runtime facts and not with config,
          // for the reason above: a route can resolve perfectly and still be
          // unreachable. `degraded` is the corporate-network-with-direct-egress
          // pairing, which takes out every provider that is not on-prem while
          // leaving the routing tables looking entirely correct.
          egress: _egressState,
        },
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message, type: 'ROUTING_CONFIG_ERROR' }));
    }
  }

  // PUT the raw YAML for either or both files. VALIDATED BEFORE IT IS WRITTEN:
  // a config that would not load is rejected with the offending key named, and
  // nothing on disk changes. Saving a broken routing config from a web form and
  // discovering it at the next LLM call is exactly the failure mode this whole
  // change exists to remove.
  if (req.method === 'PUT' && req.url === '/api/llm/routing') {
    let rawBody = '';
    for await (const chunk of req) rawBody += chunk;
    try {
      const body = JSON.parse(rawBody);
      const cfg = loadRoutingConfig();
      const nextRouting = typeof body.routing === 'string'
        ? body.routing : fs.readFileSync(cfg.paths.routing, 'utf8');
      const nextFallback = typeof body.fallback === 'string'
        ? body.fallback : fs.readFileSync(cfg.paths.fallback, 'utf8');

      // Parse + validate the CANDIDATE before touching disk.
      const { parse: parseYamlDoc } = await import('yaml');
      const { parseRoutingConfig, withLocalProviders } = await import('./routing-config.mjs');
      parseRoutingConfig(withLocalProviders(parseYamlDoc(nextRouting), cfg.paths.routing), parseYamlDoc(nextFallback));

      fs.writeFileSync(cfg.paths.routing, nextRouting, 'utf8');
      fs.writeFileSync(cfg.paths.fallback, nextFallback, 'utf8');
      invalidateRoutingConfig();
      const reloaded = loadRoutingConfig({ force: true });
      log(`routing config saved (${Object.keys(reloaded.routes).length} routes, ${Object.keys(reloaded.providers).length} providers)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, routes: reloaded.routes, defaults: reloaded.defaults }));
    } catch (err) {
      logErr(`routing config rejected (nothing written): ${err.message}`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message, type: 'ROUTING_CONFIG_INVALID' }));
    }
  }

  // Surgical field-level edits, comment-preserving. The dashboard uses THIS
  // rather than PUT.
  //
  // Why not just serialize the form state back to YAML: these two files are
  // mostly prose. The comments explain why claude-code-max is guarded to the
  // public network, why the Copilot catalogue lists no opus id, why a route uses
  // `from-caller`. A JSON -> YAML round-trip from a web form would delete all of
  // it on the first Save, and the config would degrade back into an opaque table
  // of values — exactly the state this work exists to get out of.
  //
  // So edits go through the yaml Document API, which rewrites individual nodes
  // and leaves everything around them, comments included, untouched. Same
  // validate-before-write contract as PUT: a rejected patch leaves both files
  // byte-identical.
  //
  // Body: { routes?: {<key>: {provider, complexity} | null},   null = delete
  //         defaults?: {<class>: {provider, complexity}},
  //         fallback?: { sameProviderRetries?, enforceCapabilities?, retryOn?,
  //                      chains?: {<provider>: [{provider, when?}]} } }
  if (req.method === 'PATCH' && req.url === '/api/llm/routing') {
    let rawBody = '';
    for await (const chunk of req) rawBody += chunk;
    try {
      const patch = JSON.parse(rawBody);
      const cfg = loadRoutingConfig();
      const { parseDocument, parse: parseYamlDoc } = await import('yaml');
      const { parseRoutingConfig } = await import('./routing-config.mjs');

      const routingDoc = parseDocument(fs.readFileSync(cfg.paths.routing, 'utf8'));
      const fallbackDoc = parseDocument(fs.readFileSync(cfg.paths.fallback, 'utf8'));

      if (patch.routes && typeof patch.routes === 'object') {
        for (const [key, val] of Object.entries(patch.routes)) {
          if (val === null) { routingDoc.deleteIn(['routes', key]); continue; }
          if (!val || typeof val !== 'object') continue;
          // setIn on a leaf keeps the surrounding mapping (and its comments)
          // intact; only the scalar is rewritten.
          if (val.provider) routingDoc.setIn(['routes', key, 'provider'], String(val.provider));
          if (val.complexity) routingDoc.setIn(['routes', key, 'complexity'], String(val.complexity));
        }
      }
      if (patch.defaults && typeof patch.defaults === 'object') {
        for (const [cls, val] of Object.entries(patch.defaults)) {
          if (!val || typeof val !== 'object') continue;
          if (val.provider) routingDoc.setIn(['defaults', cls, 'provider'], String(val.provider));
          if (val.complexity) routingDoc.setIn(['defaults', cls, 'complexity'], String(val.complexity));
        }
      }
      // The offload policy. `enabled` is the switch an operator actually reaches
      // for — "stop sending work to the cluster, it is misbehaving" — so it has
      // to be one toggle away, not a YAML edit. The candidate is validated below
      // like every other patch, which is what stops the UI from writing a policy
      // that names a band the local provider has no model for.
      if (patch.semanticRouting && typeof patch.semanticRouting === 'object') {
        const s = patch.semanticRouting;
        if (typeof s.enabled === 'boolean') routingDoc.setIn(['semantic_routing', 'enabled'], s.enabled);
        if (Array.isArray(s.offloadBands)) {
          routingDoc.setIn(['semantic_routing', 'offload_bands'], s.offloadBands.map(String));
        }
        // The target list. Two write paths, and which one runs decides whether
        // the prose in this block survives the save.
        //
        // The common edit by far is flipping one target on or off — that is what
        // the switch exists for, and the comment under each target is WHY it is
        // set the way it is (the laptop's measured 47s-vs-5.4s latency, the
        // cluster's missing key). Rewriting the list whole would delete every one
        // of those on the first click, which is the failure the comment-preserving
        // Document API was adopted to avoid in the first place. So when the
        // incoming list names the same providers in the same order, each field is
        // written surgically and everything around it is left alone.
        //
        // Only a membership or order CHANGE falls back to replacing the sequence,
        // and it is not merged entry-by-entry: order is meaningful (first enabled
        // network match wins) and a partial write could leave two entries claiming
        // one network, which the loader refuses at boot — i.e. a UI save that
        // bricks the proxy until someone edits YAML. `requireNetwork: null` means
        // "any network". Documented in the UI as "adding or reordering targets
        // drops their inline notes".
        //
        // `enabled` is written ALWAYS, including when false. It is the per-target
        // on/off switch, and omitting a false one would let the loader's default
        // (off) coincidentally agree today while leaving the file silent about a
        // decision the operator made explicitly. It also has to survive a
        // round-trip: switching a target off and reloading must show it off.
        if (Array.isArray(s.targets)) {
          const next = s.targets.filter(t => t && t.provider);
          const current = routingDoc.getIn(['semantic_routing', 'targets']);
          const currentProviders = (current?.items || []).map(item => String(item?.get?.('provider') ?? ''));
          const sameShape = currentProviders.length === next.length
            && next.every((t, i) => currentProviders[i] === String(t.provider));

          // `scope` is carried on BOTH paths, and the reorder path is the one
          // that matters. It rebuilds each entry from the incoming object, so a
          // field it does not name is not preserved — it is deleted, and the
          // loader's default silently takes over. For scope that default is
          // "both", which would re-widen the laptop target to background work on
          // the first reorder: precisely the state `scope: [fg]` exists to
          // prevent, restored by a UI action nobody would connect to it.
          //
          // On the surgical path an omitted scope is LEFT ALONE rather than
          // reset, so a client that predates the field (or simply does not send
          // it) cannot change it by toggling `enabled`.
          // Same shape and same reasoning as scopeOf below. A target's band
          // narrowing is a statement about what that BOX can serve, and the
          // reorder path rebuilds each entry from the incoming object — so a
          // field it does not name is DELETED, not preserved. For this one the
          // loader's default is "every band the policy allows", which on the
          // laptop target means claiming a medium model it does not have: the
          // save would be refused by the validator, and an operator would be
          // told their reorder was invalid for a reason nothing on screen
          // explains.
          const bandsOf = (t) => {
            if (t.offloadBands == null) return null;
            const list = (Array.isArray(t.offloadBands) ? t.offloadBands : [t.offloadBands]).map(String);
            return list.length ? list : null;
          };
          const scopeOf = (t) => {
            if (t.scope == null) return null;
            const list = (Array.isArray(t.scope) ? t.scope : [t.scope]).map(String);
            return list.length ? list : null;
          };
          if (sameShape) {
            next.forEach((t, i) => {
              routingDoc.setIn(['semantic_routing', 'targets', i, 'enabled'], t.enabled === true);
              if (t.requireNetwork) {
                routingDoc.setIn(['semantic_routing', 'targets', i, 'require_network'], String(t.requireNetwork));
              } else {
                routingDoc.deleteIn(['semantic_routing', 'targets', i, 'require_network']);
              }
              const scope = scopeOf(t);
              if (scope) routingDoc.setIn(['semantic_routing', 'targets', i, 'scope'], scope);
              // On the surgical path an omitted value is LEFT ALONE rather than
              // cleared, so a client that predates the field cannot delete it by
              // toggling `enabled`.
              const bands = bandsOf(t);
              if (bands) routingDoc.setIn(['semantic_routing', 'targets', i, 'offload_bands'], bands);
            });
          } else {
            // Fall back to what the LOADED config says for this provider, so a
            // client that reorders without echoing scope still cannot lose it.
            const scopeFromLoaded = new Map(
              (cfg.semanticRouting?.targets || []).map(t => [t.provider, t.scope]));
            const bandsFromLoaded = new Map(
              (cfg.semanticRouting?.targets || []).map(t => [t.provider, t.offloadBands]));
            routingDoc.setIn(['semantic_routing', 'targets'], next.map(t => {
              const scope = scopeOf(t) || scopeFromLoaded.get(String(t.provider)) || null;
              const bands = bandsOf(t) || bandsFromLoaded.get(String(t.provider)) || null;
              return {
                provider: String(t.provider),
                ...(t.requireNetwork ? { require_network: String(t.requireNetwork) } : {}),
                enabled: t.enabled === true,
                ...(scope ? { scope } : {}),
                ...(bands ? { offload_bands: bands } : {}),
              };
            }));
          }
        }
      }
      // The classifier. `enabled` and `impl` are the pair an operator reaches
      // for, and they are deliberately separate switches: turning the block on
      // with `impl: none` runs the free stages and can still downgrade nothing,
      // which is the safe first step and would be unreachable if one toggle did
      // both. Written surgically — the block carries a ~50-line rationale above
      // it, including the measurement that gates turning it on, and a save that
      // deleted that would cost more than the setting is worth.
      //
      // Every value here is validated by parseRoutingConfig on the candidate
      // below, so an impl the loader does not know, or a band no provider can
      // serve, is refused before either file is written.
      if (patch.classifier && typeof patch.classifier === 'object') {
        const c = patch.classifier;
        if (typeof c.enabled === 'boolean') routingDoc.setIn(['classifier', 'enabled'], c.enabled);
        if (c.impl) routingDoc.setIn(['classifier', 'impl'], String(c.impl));
        if (typeof c.timeoutMs === 'number') routingDoc.setIn(['classifier', 'timeout_ms'], c.timeoutMs);
        if (typeof c.maxRequestBytes === 'number') {
          routingDoc.setIn(['classifier', 'max_request_bytes'], c.maxRequestBytes);
        }
        // Order carries no meaning here (unlike the offload targets), so
        // replacing the sequence loses nothing but the inline notes, and the
        // list is three words long.
        if (Array.isArray(c.bands) && c.bands.length) {
          routingDoc.setIn(['classifier', 'bands'], c.bands.map(String));
        }
      }
      if (patch.fallback && typeof patch.fallback === 'object') {
        const f = patch.fallback;
        if (typeof f.sameProviderRetries === 'number') fallbackDoc.setIn(['same_provider_retries'], f.sameProviderRetries);
        if (typeof f.enforceCapabilities === 'boolean') fallbackDoc.setIn(['enforce_capabilities'], f.enforceCapabilities);
        if (Array.isArray(f.retryOn)) fallbackDoc.setIn(['retry_on'], f.retryOn.map(String));
        if (f.chains && typeof f.chains === 'object') {
          // A chain is an ordered list: reordering it means replacing the
          // sequence, so per-candidate comments inside a rewritten chain do not
          // survive. Comments elsewhere in the file (including on other chains)
          // are unaffected. Documented in the UI as "reordering drops that
          // chain's inline notes".
          for (const [head, list] of Object.entries(f.chains)) {
            if (list === null) { fallbackDoc.deleteIn(['chains', head]); continue; }
            if (!Array.isArray(list)) continue;
            fallbackDoc.setIn(['chains', head], list.map((c) => (
              c && c.when ? { provider: String(c.provider), when: c.when } : { provider: String(c.provider) }
            )));
          }
        }
      }

      const nextRouting = routingDoc.toString();
      const nextFallback = fallbackDoc.toString();
      // Validate the CANDIDATE before either file is touched.
      parseRoutingConfig(withLocalProviders(parseYamlDoc(nextRouting), cfg.paths.routing), parseYamlDoc(nextFallback));

      fs.writeFileSync(cfg.paths.routing, nextRouting, 'utf8');
      fs.writeFileSync(cfg.paths.fallback, nextFallback, 'utf8');
      invalidateRoutingConfig();
      const reloaded = loadRoutingConfig({ force: true });
      // Boot is not the only moment the classifier can come on. warmClassifier()
      // reads the config once at startup, so a classifier enabled from the
      // dashboard was never primed — and the first real turn after the toggle
      // paid the ~4.8s prefill against a 2s timeout, failed open, and kept its
      // band. Reproduced 2026-08-31 immediately after adding this endpoint: one
      // PATCH, then `how many r's in strawberry` on fg-chat/pi stayed on
      // sonnet-4.6; the identical request a moment later resolved to haiku-4.5.
      // The toggle appeared not to work, when what it actually did was work
      // once, invisibly, into a timeout.
      //
      // Only on the OFF -> ON edge: warming is a real call to a local model, and
      // re-warming on every unrelated route edit would spend one per save.
      if (reloaded.classifier?.enabled && reloaded.classifier.impl !== 'none'
          && !(cfg.classifier?.enabled && cfg.classifier.impl !== 'none')) {
        warmClassifier();
      }
      log(`routing config patched (${Object.keys(patch.routes || {}).length} routes touched)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, routes: reloaded.routes, defaults: reloaded.defaults }));
    } catch (err) {
      logErr(`routing patch rejected (nothing written): ${err.message}`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message, type: 'ROUTING_CONFIG_INVALID' }));
    }
  }

  // "What did routing ACTUALLY do?" — the observed counterpart to /resolve,
  // which answers what it WOULD do. Reads the routing-decision columns written
  // at dispatch, so a fallback here is a recorded fact rather than the guess the
  // dashboard used to make from an unexpected provider total.
  //
  // Every count is scoped to rows with routing_source != '', because a row that
  // predates those columns reads back as chain_position 0 / no offload, which
  // would silently inflate "everything went to plan".
  if (req.method === 'GET' && req.url?.startsWith('/api/llm/routing/behaviour')) {
    if (!_tokenDb?.db) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'token-usage DB not initialized' }));
    }
    try {
      const url = new URL(req.url, 'http://localhost');
      const hoursParam = url.searchParams.get('hours') || '24';
      const hours = hoursParam === 'all' ? 10 * 365 * 24 : Math.max(1, parseInt(hoursParam, 10) || 24);
      const since = new Date(Date.now() - hours * 3600_000).toISOString();

      // Per route × the provider that actually served it. The pair is the point:
      // one row per route would hide a route that lands on two accounts, which is
      // precisely the shape a partial fallback makes.
      //
      // Grouped RAW here and folded onto account ids below, because history holds
      // several spellings of the same account (`claude-code` and `claude-code-max`
      // are one Max subscription). Left unfolded, a route reads as if it served
      // two different providers — which this view renders as a divergence, i.e. a
      // fallback that never happened.
      const perRouteRaw = _tokenDb.db.prepare(`
        SELECT route_key, route_band, route_step, provider, model,
               COUNT(*)                                   AS calls,
               -- Consumption, cache included. total_tokens alone is fresh
               -- input + output, which on the Anthropic wire is a rounding
               -- error against the prompt: a foreground turn reads as ~800
               -- tokens for ~470K actually sent. The edge weights and account
               -- totals this feeds are meant to show where the volume goes.
               SUM(total_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
               SUM(CASE WHEN chain_position > 0 THEN 1 ELSE 0 END) AS fallback_calls,
               SUM(CASE WHEN offloaded_from != '' THEN 1 ELSE 0 END) AS offloaded_calls,
               SUM(CASE WHEN routing_source = 'backfill' THEN 1 ELSE 0 END) AS reconstructed_calls
        FROM token_usage
        WHERE timestamp >= ? AND routing_source != ''
        GROUP BY route_key, route_band, route_step, provider, model
        ORDER BY tokens DESC
      `).all(since);

      // Fold the historical spellings together. Done in JS rather than a SQL CASE
      // so the alias map has exactly one definition (provider-aliases.mjs) instead
      // of a second copy embedded in a query string.
      const perRouteMerged = new Map();
      for (const r of perRouteRaw) {
        const provider = normalizeProvider(r.provider);
        const key = `${r.route_key}|${r.route_band}|${r.route_step}|${provider}|${r.model}`;
        const cur = perRouteMerged.get(key);
        if (cur) {
          cur.calls += r.calls;
          cur.tokens += r.tokens;
          cur.fallback_calls += r.fallback_calls;
          cur.offloaded_calls += r.offloaded_calls;
          cur.reconstructed_calls += r.reconstructed_calls;
        } else {
          perRouteMerged.set(key, { ...r, provider });
        }
      }
      const perRoute = [...perRouteMerged.values()].sort((a, b) => b.tokens - a.tokens);

      // The trail columns need parsing, so the edge/reason tallies are built in
      // JS rather than SQL. Bounded by the same window; only rows that actually
      // carry a trail are read, which is a small minority.
      const trailRows = _tokenDb.db.prepare(`
        SELECT route_key, provider, chain_position, offloaded_from, attempt_trail
        FROM token_usage
        WHERE timestamp >= ? AND routing_source != '' AND attempt_trail != ''
      `).all(since);

      const fallbackEdges = new Map();   // "from>to" -> { from, to, count, errors: {class: n} }
      const skipReasons = new Map();     // "provider|reason|kind" -> count
      const offloadSkips = new Map();    // reason -> count
      // What the prompt classifier DID, or why it did nothing.
      //
      // Aggregated since 2026-09-02. The note has been written per row since the
      // classifier shipped, and read only per row — which is how a dead judge
      // stayed invisible for a day. On 2026-09-02 every classified turn recorded
      // `classifier error: classifier HTTP 502` because the judge's backend was
      // not running, and no board on the dashboard had anywhere to show it: the
      // routing looked correct at every level anyone could see, and the question
      // "why was this not downgraded?" could only be answered by expanding one
      // row and reading a string. A tally is what makes an outage look like an
      // outage instead of like a policy.
      const classifierNotes = new Map();  // note -> count
      for (const row of trailRows) {
        const trail = parseRoutingTrail(row.attempt_trail);
        if (!trail) continue;
        for (const a of trail.attempts || []) {
          // The hop is "the candidate that failed" -> "the provider that served".
          // Both ends normalized, so a hop recorded under an old spelling lands on
          // the same edge as one recorded under the account id.
          const from = normalizeProvider(a.provider);
          const to = normalizeProvider(row.provider);
          const key = `${from}>${to}`;
          const edge = fallbackEdges.get(key) || { from, to, count: 0, errors: {} };
          edge.count += 1;
          edge.errors[a.error || 'error'] = (edge.errors[a.error || 'error'] || 0) + 1;
          fallbackEdges.set(key, edge);
        }
        for (const s of trail.skipped || []) {
          const key = `${normalizeProvider(s.provider)}|${s.reason}|${s.kind}`;
          skipReasons.set(key, (skipReasons.get(key) || 0) + 1);
        }
        if (trail.offloadSkipped) {
          offloadSkips.set(trail.offloadSkipped, (offloadSkips.get(trail.offloadSkipped) || 0) + 1);
        }
        if (trail.classifier) {
          classifierNotes.set(trail.classifier, (classifierNotes.get(trail.classifier) || 0) + 1);
        }
      }

      const totals = _tokenDb.db.prepare(`
        SELECT COUNT(*) AS calls,
               SUM(CASE WHEN chain_position > 0 THEN 1 ELSE 0 END)   AS fallback_calls,
               SUM(CASE WHEN offloaded_from != '' THEN 1 ELSE 0 END) AS offloaded_calls,
               SUM(CASE WHEN routing_source = 'backfill' THEN 1 ELSE 0 END) AS reconstructed_calls
        FROM token_usage WHERE timestamp >= ? AND routing_source != ''
      `).get(since);

      // Rows in the window that carry NO decision at all. Reported rather than
      // filtered away in silence: if this dwarfs `totals.calls`, every percentage
      // above is computed over a slice, and the reader needs to know that.
      const unrecorded = _tokenDb.db.prepare(
        `SELECT COUNT(*) AS calls FROM token_usage WHERE timestamp >= ? AND routing_source = ''`,
      ).get(since);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        window: { hours, since },
        totals: { ...totals, unrecorded_calls: unrecorded?.calls ?? 0 },
        perRoute,
        fallbackEdges: [...fallbackEdges.values()].sort((a, b) => b.count - a.count),
        skipReasons: [...skipReasons.entries()]
          .map(([k, count]) => {
            const [provider, reason, kind] = k.split('|');
            return { provider, reason, kind, count };
          })
          .sort((a, b) => b.count - a.count),
        offloadSkips: [...offloadSkips.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count),
        classifierNotes: [...classifierNotes.entries()]
          .map(([note, count]) => ({ note, count }))
          .sort((a, b) => b.count - a.count),
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // "Why did this call go there?" — the same decision the request path makes,
  // answered without making one. Used by the launchers to pick an agent's model
  // and by the dashboard's explain column, so all three agree by construction.
  if (req.method === 'GET' && req.url?.startsWith('/api/llm/routing/resolve')) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const cfg = loadRoutingConfig();
      const wantsTools = url.searchParams.get('tools') === 'true';
      const decision = explainRoute(cfg, {
        job: url.searchParams.get('job') || '',
        agent: url.searchParams.get('agent') || '',
        complexity: url.searchParams.get('complexity') || '',
        requestedModel: url.searchParams.get('model') || '',
        // Default to the live sensor reading; overridable so the UI can show
        // "what would happen on the other network" without moving the laptop.
        network: url.searchParams.get('network')
          || (detectNetworkMode() === 'corporate' ? 'corporate' : 'public'),
        wantsTools,
        // `classified=true` says "treat the band above as a classifier verdict
        // rather than a caller declaration". This endpoint has no prompt and
        // must never acquire one — it is the thing that keeps a routing decision
        // reproducible from the config alone, which is the property the
        // classifier had to preserve to be built. Passing the VERDICT as a
        // parameter reproduces the decision exactly, without re-deriving it.
        classified: url.searchParams.get('classified') === 'true',
      });
      // Mark which hops are reachable right now. Config and runtime are reported
      // separately and never merged — a provider being logged out is not a
      // routing decision.
      const chain = decision.chain.map((c) => ({ ...c, available: !!providers[c.impl]?.available }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ...decision, chain }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message, type: 'ROUTING_CONFIG_ERROR' }));
    }
  }

  if (req.method === 'GET' && req.url === '/api/llm/settings') {
    const s = loadSettings();
    const procs = distinctProcesses(_tokenDb);
    const availableProviders = Object.entries(providers)
      .filter(([, v]) => v.available)
      .map(([k]) => k);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      settings: s,
      processes: procs,
      availableProviders,
      // All providers (even unavailable) so the UI can still show them with
      // a "not currently reachable" badge.
      allProviders: Object.keys(providers),
    }));
  }

  if (req.method === 'PUT' && req.url === '/api/llm/settings') {
    let rawBody = '';
    for await (const chunk of req) rawBody += chunk;
    try {
      const body = JSON.parse(rawBody);
      const saved = saveSettings(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, settings: saved }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
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
      // false for the few seconds after boot while provider init still runs;
      // `providers` below is not authoritative until it flips.
      ready: _providersInitialized,
      networkMode: detectNetworkMode(),
      build: BUILD_IDENTITY,
      // Whether outbound traffic currently has a proxy, and whether that is the
      // combination that breaks every off-prem call. Exposed because the state
      // is otherwise invisible: the process stays healthy, routing keeps
      // resolving, and only the calls fail.
      egress: _egressState,
      providers: status,
    }));
  }

  // ── ATTR-05 (Route 1): Anthropic /v1/messages transparent passthrough ──────
  // Forward + usage tap live in anthropic-forward.mjs (shared with glass); this
  // daemon adds the foreground routing check, the keychain token fallback and
  // its re-pinning egress.
  const _v1Path = (req.url || '').split('?')[0];
  if (req.method === 'POST' && _v1Path.startsWith('/v1/messages')) {
    return handleAnthropicMessages(req, res, {
      measurement, fetch: proxyFetch, getToken: getClaudeOAuthToken, routeGuard: fgChatRouteGuard, logErr,
    });
  }

  // ── Phase 70-01 Task 2 (ADAPT-03): OpenAI-compatible shim ──────────────────
  // POST /v1/chat/completions maps an OpenAI chat/completions request onto the
  // existing /api/complete pipeline so OpenCode (and later Mastra) can route LLM
  // calls through the proxy and get a per-llm-call token_usage row for free,
  // reusing the provider chain + token logging with NO second writer.
  //
  // The shim normalizes the OpenAI body into the internal /api/complete envelope
  // (setting agent / granularity_tier='per-llm-call' / task_id), stashes it on
  // the request, rewrites req.url to '/api/complete', and falls through to the
  // shared pipeline below. On success that branch detects req._shimOpenAI and
  // wraps the proxy result in the OpenAI chat.completion envelope. This is a
  // DELIBERATE single-pipeline design (D-02 non-streaming-only) — no duplicated
  // provider-chain logic.
  //
  // agent precedence (D-06, mirrors the X-Task-Id/body.task_id precedence below):
  // an incoming X-Agent request header OR body.agent wins when non-empty, else
  // it DEFAULTS to the path-derived agent. This lets Plan 04 Track A stamp
  // agent='mastra' by sending `X-Agent: mastra` with NO server.mjs change.
  //
  // Phase 70-04 (A1 — operator decision): a dedicated mastra sub-route
  // /v1/mastra/chat/completions exists because mastracode's
  // ModelRouterLanguageModel custom-provider seam can attach NEITHER an X-Agent
  // header NOR a body.agent field on outbound requests — so pointing it at the
  // bare /v1/chat/completions would mis-stamp its rows as agent='opencode'. The
  // dedicated path derives a default agent='mastra' from the URL. The
  // X-Agent/body.agent precedence still wins when present (auth-agnostic). The
  // pipeline below is reused VERBATIM — the only change is accepting the second
  // path + a path-derived default agent.
  // Phase 82-03: a dedicated /v1/copilot/chat/completions sub-route joins the
  // mastra precedent (path → default agent) so copilot BYOK rows stamp
  // agent='copilot' instead of being mis-stamped 'opencode' (spike probe 1,
  // row 163286). A small 3-entry {path: defaultAgent} table replaces the || chain
  // (the natural next step after the mastra addition).
  //
  // ADDITIONALLY (plan-checker Warning 1): header-less agents (copilot BYOK,
  // mastra's ModelRouterLanguageModel) cannot attach X-Task-Id / X-Agent, but
  // their base URL IS launcher-controlled per launch — so accept an OPTIONAL
  // task-scoped path form /v1/<copilot|mastra>/t/<taskId>/chat/completions. The
  // <taskId> segment is their only per-request binding seam; it slots into the
  // EXISTING task_id precedence at LOWER priority than an explicit X-Task-Id
  // header and body.task_id but HIGHER than the ambient span:
  //   header > body > path > ambient  (kills the ambient-singleton leak).
  //
  // Phase 84 (seam B): opencode joins this task-scoped path form. When a measured
  // opencode cell uses its openai-compatible provider wire (inside-CN github-copilot,
  // or any openai provider), the launcher points its base URL at
  // /v1/opencode/t/<taskId> and the openai client appends /chat/completions →
  // /v1/opencode/t/<taskId>/chat/completions. This gives opencode's openai wire the
  // SAME per-request binding claude/copilot already have (was ambient-bound → flaky/
  // empty context-turn capture). Downstream behaviour is byte-identical to the bare
  // /v1/chat/completions opencode shim — only the task_id binding is added.
  const SHIM_PATH_AGENTS = {
    '/v1/chat/completions': 'opencode',
    '/v1/opencode/chat/completions': 'opencode',
    '/v1/copilot/chat/completions': 'copilot',
    // T2 egress lockdown: code-graph-rag's pydantic_ai openai client points its
    // base URL here (CYPHER_ENDPOINT/ORCHESTRATOR_ENDPOINT in its .env) instead
    // of api.groq.com, so its rows stamp agent='codegraph' rather than the bare
    // path's 'opencode' default. Same pipeline, path-derived agent only.
    '/v1/codegraph/chat/completions': 'codegraph',
  };

  // T2 egress lockdown: OpenAI-compat embeddings passthrough. In-container
  // embedding clients (semantic-analysis deduplication / git-staleness, which
  // used to hold a raw OPENAI_API_KEY) now point `new OpenAI({ baseURL })` at
  // this daemon; the key lives ONLY here on the host. Verbatim forward — the
  // body is already OpenAI-shaped and the response is returned untouched.
  if (req.method === 'POST' && req.url === '/v1/embeddings') {
    let rawBody = '';
    for await (const chunk of req) rawBody += chunk;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'OPENAI_API_KEY not configured on proxy host', type: 'PROVIDER_UNAVAILABLE' }));
    }
    try {
      const base = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1';
      const upstream = await proxyFetch(`${base}/embeddings`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: rawBody,
        signal: AbortSignal.timeout(60_000),
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      return res.end(text);
    } catch (err) {
      logErr(`/v1/embeddings passthrough failed: ${err?.message || err}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `embeddings upstream failed: ${err?.message || err}` }));
    }
  }
  let shimDefaultAgent = null;
  let shimPathTaskId = '';
  // A band declared in the URL, for an agent that can express it nowhere else.
  // See matchShimPath in shim-tools.mjs for why copilot needs this and why it is
  // session-scoped rather than per-turn.
  let shimPathBand = '';
  let shimPathProject = '';
  let shimResponsesBody = null;
  const responsesPath = req.method === 'POST' ? matchResponsesShimPath(req.url) : null;
  if (responsesPath) {
    let rawBody = '';
    for await (const chunk of req) rawBody += chunk;
    try {
      shimResponsesBody = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    shimDefaultAgent = 'opencode';
    shimPathProject = safeDecode(responsesPath.project);
    if (responsesPath.taskId) shimPathTaskId = pathTaskId(responsesPath.taskId);
  }
  if (req.method === 'POST') {
    if (shimResponsesBody) {
      // already identified above; the request stream is consumed once
    } else if (Object.prototype.hasOwnProperty.call(SHIM_PATH_AGENTS, req.url)) {
      shimDefaultAgent = SHIM_PATH_AGENTS[req.url];
    } else {
      const m = matchShimPath(req.url);
      if (m) {
        shimDefaultAgent = m.agent;
        shimPathBand = m.band || '';
        shimPathProject = safeDecode(m.project);
        // sanitizeTaskId (charset whitelist + path.basename) neutralizes any
        // traversal/injection in the untrusted path segment before it reaches
        // the DB / per-run snapshot filenames (T-82-03-03 mitigation). Guarded on
        // a present segment: the band-only path form carries no taskId at all.
        if (m.taskId) shimPathTaskId = pathTaskId(m.taskId);
      }
    }
  }
  const isOpenAIShim = shimDefaultAgent !== null;
  if (isOpenAIShim) {
    const defaultAgent = shimDefaultAgent;

    let oaBody;
    if (shimResponsesBody) {
      oaBody = responsesToChatBody(shimResponsesBody);
    } else {
      let rawBody = '';
      for await (const chunk of req) rawBody += chunk;
      try {
        oaBody = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    }

    // agent: X-Agent header OR body.agent wins (non-empty string), else the
    // path-derived default ('mastra' on /v1/mastra/..., else 'opencode').
    const hdrAgent = typeof req.headers['x-agent'] === 'string' ? req.headers['x-agent'].trim() : '';
    const bodyAgent = typeof oaBody.agent === 'string' && oaBody.agent ? oaBody.agent : '';
    const agent = hdrAgent || bodyAgent || defaultAgent;

    // task_id: X-Task-Id header OR body.task_id (non-empty). Left UNSET on the
    // internal body when absent, so Task 1's `body.task_id ?? resolveLiveTaskId()`
    // precedence resolves the active span.
    const hdrTaskId = typeof req.headers['x-task-id'] === 'string' ? req.headers['x-task-id'].trim() : '';
    const bodyTaskId = typeof oaBody.task_id === 'string' && oaBody.task_id ? oaBody.task_id : '';
    // Precedence: X-Task-Id header > body.task_id > path-scoped /t/<taskId> >
    // ambient span — sanitized once (bindShimTaskId, measurement.mjs).
    const taskId = bindShimTaskId({ hdrTaskId, bodyTaskId, pathTaskId: shimPathTaskId });
    // project: x-project header > body.project > /p/<project> path segment —
    // the same precedence as task_id, sanitized once here.
    const project = sanitizeProject(req.headers['x-project'])
      || sanitizeProject(oaBody.project)
      || sanitizeProject(shimPathProject);

    // Phase 78: per-run context-window capture for the OpenAI-shim path (non-fatal).
    measurement.captureOpenAIBreakdown({ oaBody, agent, taskId });

    // Normalise the OpenAI `developer` role to `system` before anything reads
    // the array. OpenAI renamed the system role to `developer` (o1-era spec) and
    // modern clients emit it — pi (@earendil-works/pi-coding-agent) sends its
    // system prompt that way. Nothing downstream knew the name: every consumer
    // here tests `role === 'system'` (~:1115, :1347, :1474, :2178), so a
    // developer-role message fell through all of them and reached the provider
    // verbatim, where Claude hard-400s with
    //   messages: Unexpected role "developer". Allowed roles are "user" or "assistant"
    // Mapping it once, here, fixes it for every openai-completions client rather
    // than at each of those four sites. Byte-unchanged for clients that do not
    // send the role: the array is only rebuilt when a developer role is present.
    //
    // The same normalisation pass also flattens ARRAY-form content. Modern
    // OpenAI clients may send content as a block list —
    //   [{ "type": "text", "text": "..." }]
    // — rather than a bare string. Every completion path here assumes a string:
    // completeClaudeCode joins m.content (~:1347) and the CLI path templates it
    // (~:1474-1479), so a block list arrives at the provider as the literal
    // "[object Object]" and the model replies that the message did not send.
    // There is already a flattener for exactly this shape at :2146, but it is
    // only wired into token accounting, never into the request that goes out.
    //
    // PURE-TEXT block lists are still concatenated here, because that is what
    // the string-assuming legs need and it is the overwhelmingly common shape.
    // A list carrying a non-text part (an attached image) is PRESERVED: the
    // copilot and openai legs are OpenAI-native and accept image_url parts
    // verbatim, and flattening here deleted them before the request ever left
    // the proxy. That is why an attached image reached the model as a message
    // that never had one, and the model reported "image input isn't supported"
    // as though it were a property of the session.
    //
    // The legs that genuinely cannot take a block list (the Anthropic message
    // builder, the claude-code CLI template) now reduce it themselves via
    // flattenContentToText, so preserving it here cannot reach them as
    // "[object Object]".
    const _flattenContent = (c) => (Array.isArray(c) && !hasNonTextParts(c)
      ? c.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
      : c);
    const _needsNormalise = Array.isArray(oaBody.messages) && oaBody.messages.some(
      (m) => m?.role === 'developer' || Array.isArray(m?.content),
    );
    const oaMessages = _needsNormalise
      ? oaBody.messages.map((m) => {
        const role = m?.role === 'developer' ? 'system' : m?.role;
        return { ...m, role, content: _flattenContent(m?.content) };
      })
      : oaBody.messages;

    // Build the internal /api/complete-shaped body. model + messages pass
    // straight through apart from the role mapping above; NO new routing logic
    // (Claude's Discretion guardrail — let the existing chain resolve
    // body.model). D-02: stream is ignored — single buffered response.
    const internalBody = {
      model: oaBody.model,
      messages: oaMessages,
      agent,
      granularity_tier: 'per-llm-call',
      // WR-06 (Phase 83 re-review): stamp a per-request id so shim-originated
      // wire rows (copilot BYOK / opencode / mastra) carry an identity. With
      // tool_call_id='' the reconcile request-id probe could never match a
      // copilot wire row, reconcileGapFill was a no-op (token-db.mjs rejects
      // empty ids), and the D-04 copilotCacheSplit merge could never apply in
      // production. A generated UUID is unique per HTTP request, so it never
      // dedup-collides; retries within ONE request share the id (logged once).
      tool_call_id: 'shim-' + randomUUID(),
    };
    if (shimResponsesBody) internalBody.responses_body = shimResponsesBody;
    if (taskId) internalBody.task_id = taskId;
    if (project) internalBody.project = project;
    // process: client-supplied body.process wins; otherwise DEFAULT to the agent
    // name so operator processOverrides can route per-agent (e.g. opencode/mastra
    // → copilot) without the OpenAI-compatible client needing to send a routing
    // field. (Phase 70-02: OpenCode's @ai-sdk/openai-compatible client sends no
    // process; without this default its calls fall to the claude-code-first chain,
    // which hard-400s on the Claude 'extra usage' plan-limit policy with NO
    // fallback for the agentic 42-tool payload — surfacing as a 400 to OpenCode.)
    internalBody.process = (typeof oaBody.process === 'string' && oaBody.process) ? oaBody.process : agent;
    // Carry forward optional routing hints if the client supplied them.
    if (typeof oaBody.subscription === 'string' && oaBody.subscription) internalBody.subscription = oaBody.subscription;
    if (oaBody.provider) internalBody.provider = oaBody.provider;
    // The caller's own band, translated from the OpenAI vocabulary into the
    // internal one HERE and only here. A `from-caller` route (fg-chat/pi) reads
    // internalBody.complexity like any background service's; nothing downstream
    // needs to learn what `reasoning_effort` is.
    //
    // Translating rather than forwarding the raw field is deliberate: the
    // provider legs are handed `{...body, model}`, so a raw `reasoning_effort`
    // riding the internal envelope would reach copilot/openai as an effort word
    // they did not ask for. `complexity` is a field the pipeline already strips.
    const callerBand = resolveCallerComplexity({
      explicit: oaBody.complexity,
      header: req.headers['x-complexity'],
      reasoningEffort: oaBody.reasoning_effort,
    });
    // Path band is the LAST resort, deliberately. It is fixed for the whole
    // session (the launcher builds the base URL once), so anything the caller
    // says per-turn — a body field, an x-complexity header, a reasoning_effort —
    // must be able to override it. An agent that gains a per-turn seam later
    // therefore needs no change here: it simply starts winning.
    const effectiveBand = callerBand || shimPathBand;
    if (effectiveBand) internalBody.complexity = effectiveBand;
    // Phase 82-03 drop point 1: forward OpenAI tools[]/tool_choice into the
    // internal envelope so function-calling-capable providers (copilot HTTP)
    // receive them. Guarded (Array.isArray / !== undefined) so tool-less
    // requests are byte-unchanged — no tools/tool_choice key is added.
    if (Array.isArray(oaBody.tools)) internalBody.tools = oaBody.tools;
    if (oaBody.tool_choice !== undefined) internalBody.tool_choice = oaBody.tool_choice;
    // Forward the caller's output budget under BOTH OpenAI spellings.
    //
    // Without this the shim dropped it and every provider leg fell back to its
    // `|| 4096` default, which had a non-obvious consequence on the copilot leg:
    // useStream is `maxTokens > COPILOT_STREAM_MAXTOKENS_THRESHOLD` (4096), so a
    // defaulted 4096 is never greater and EVERY shim request took the buffered
    // path. The streamed reader was unreachable for pi and opencode.
    //
    // Both spellings are needed: pi's openai-completions client sends
    // `max_completion_tokens` (observed live: 16384), the older field name
    // `max_tokens` is what @ai-sdk/openai-compatible and hand-written callers
    // send. Reading only one silently ignored the other.
    const oaMaxTokens = (typeof oaBody.max_tokens === 'number' && oaBody.max_tokens > 0)
      ? oaBody.max_tokens
      : ((typeof oaBody.max_completion_tokens === 'number' && oaBody.max_completion_tokens > 0)
        ? oaBody.max_completion_tokens
        : undefined);
    if (oaMaxTokens !== undefined) internalBody.max_tokens = oaMaxTokens;

    // Stash the pre-parsed body + the OpenAI-envelope flag, then fall through to
    // the shared /api/complete pipeline (which uses req._shimBody instead of
    // re-reading the already-consumed stream, and wraps its 200 on _shimOpenAI).
    req._shimBody = internalBody;
    req._shimOpenAI = true;
    req._shimResponses = Boolean(shimResponsesBody);
    // Phase 70-02: remember whether the client asked for streaming. The shared
    // pipeline still produces ONE buffered result (D-02 single-pipeline design);
    // the _shimOpenAI response branch below re-frames that buffered result as a
    // single-shot SSE stream when _shimStream is set, so OpenCode's
    // @ai-sdk/openai-compatible client renders the reply instead of showing a
    // blank turn. This is NOT incremental token streaming.
    req._shimStream = oaBody.stream === true;
    req.url = '/api/complete';
  }

  if (req.method === 'POST' && req.url === '/api/complete') {
    let body;
    if (req._shimBody) {
      // Phase 70-01: the shim already parsed + normalized the body and consumed
      // the request stream. Reuse it rather than re-reading (the stream is spent).
      body = req._shimBody;
    } else {
      let rawBody = '';
      for await (const chunk of req) rawBody += chunk;
      try {
        body = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    }

    // ── Phase 67-06 (REPRO-02): LLM replay/record taps ──────────────────────
    // Read the active span ONCE via the single reader (getActiveMeasurement,
    // imported at the top — no second parser of active-measurement.json, SC-4).
    // The taps are INERT unless the active span arms them via meta.replay_from /
    // meta.record, so normal (unarmed) /api/complete serving is byte-for-byte
    // unchanged. `span` / `repro` stay in scope for the record tap further down.
    const span = getActiveMeasurement();
    let repro = null;
    if (span?.meta?.replay_from || span?.meta?.record) {
      repro = await loadReproMods();
      if (repro) {
        // New armed span → restart the D-07 per-hash ordinal sequence. The
        // daemon is long-lived and spans many runs; resetOrdinals is otherwise
        // only called span-side (measurement-start, a different process), so
        // without this the replay run's ordinals would not line up with the
        // record run's fixture keys. Reset once per armed span (task_id +
        // started_at identity), before any matchKey call in this request.
        const spanId = `${span.task_id}|${span.started_at}`;
        if (spanId !== _lastReproSpanId) {
          _lastReproSpanId = spanId;
          repro.resetOrdinals();
        }
        // REPLAY TAP (D-06): serve the recorded response by match key, or
        // hard-fail 409 REPLAY_MISS — NEVER fall through to a live provider.
        // This `return` precedes the provider-chain resolution below, mirroring
        // the 404 PROVIDER_UNAVAILABLE hard-fail return style.
        if (span.meta.replay_from) {
          const key = repro.matchKey(repro.normalizeReq(body));
          const hit = repro.replayLookup(span.meta.replay_from, key);
          if (!hit) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `replay miss: ${key}`, type: 'REPLAY_MISS' }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(hit)); // { content, provider, model, tokens, latencyMs }
        }
      }
    }

    // Abort propagation: when the HTTP client disconnects (obs-api SIGTERM,
    // browser tab close, etc.), abort downstream work — most importantly
    // kills the spawned claude CLI subprocess so it doesn't keep running
    // and consuming the Max quota under a dead parent.
    //
    // We listen on BOTH req and res 'close'. Node has a long-standing quirk
    // where req 'close' on a fully-consumed body doesn't always fire on
    // peer disconnect; res 'close' is the reliable signal (it fires when
    // the underlying socket is destroyed before res.end()). Either source
    // triggers the same abort, idempotent via signal.aborted check.
    const reqAbort = new AbortController();
    const triggerAbort = (reason) => {
      if (!reqAbort.signal.aborted && !res.writableEnded) {
        log(`request aborted: ${reason}`);
        reqAbort.abort(new Error(`client disconnected (${reason})`));
      }
    };
    req.on('close', () => triggerAbort('req close'));
    res.on('close', () => triggerAbort('res close'));

    // ── Routing: config decides, this code obeys ─────────────────────────────
    //
    // Everything below comes from config/llm-routing.yaml + config/llm-fallback.yaml
    // via proxy-bridge/routing-config.mjs. There is no preference order, no
    // capability map, no model-carrying special case and no reachability
    // heuristic in this file any more — those five mechanisms decided routing
    // invisibly and are gone. If a call lands somewhere surprising, the answer
    // is in those two files, and `GET /api/llm/routing/resolve` will read them
    // back for you.
    //
    // Deliberately NOT consulted: body.subscription (was a session-intent hint
    // matched by substring) and body.provider (was a soft pin). The caller's
    // only routing input is `complexity`, and only where a route opted into it
    // with `from-caller`. A caller that could re-route itself is a caller that
    // could quietly move spend onto a different account.
    const procName = typeof body.process === 'string' ? body.process : '';
    const networkMode = detectNetworkMode();
    const wantsTools = Array.isArray(body.tools) && body.tools.length > 0;

    // The job id. A shim-originated request carries body.agent (opencode /
    // mastra / copilot / codegraph) and is a foreground conversation; a
    // background service identifies itself by body.process. `fg-` vs `bg-` is
    // what routing-config keys the class defaults off.
    const routeReq = agentIsForeground(body.agent)
      ? { job: 'fg-chat', agent: String(body.agent) }
      : { job: procName ? `bg-${procName}` : 'bg-unknown' };
    routeReq.requestedModel = typeof body.model === 'string' ? body.model : '';
    // The caller's band. `complexity` is the internal spelling every background
    // service uses; `x-complexity` is the header seam for a direct caller that
    // can set headers but not body fields. The OpenAI `reasoning_effort`
    // vocabulary was already folded into `complexity` by the shim above, so it
    // is deliberately not re-read here.
    routeReq.complexity = resolveCallerComplexity({
      explicit: body.complexity,
      header: req.headers['x-complexity'],
    });
    routeReq.network = networkMode === 'vpn' || networkMode === 'corporate' ? 'corporate' : 'public';
    routeReq.wantsTools = wantsTools;

    let routingConfig;
    let decision;
    let classifierNote = '';
    try {
      routingConfig = loadRoutingConfig();
      decision = explainRoute(routingConfig, routeReq);
    } catch (err) {
      // A config that will not parse is not something to route around: every
      // decision below depends on it. Fail the request loudly and name the key.
      logErr(`routing config unusable: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `routing config unusable: ${err.message}`, type: 'ROUTING_CONFIG_ERROR' }));
    }

    // ── Prompt complexity, when the caller's declaration was not informative ──
    //
    // Resolved TWICE, on purpose. routing-config.mjs is pure and synchronous
    // (its own header says so) and the classifier does I/O, so the classifier
    // cannot live inside resolveRoute. Instead: resolve once to learn what the
    // band WOULD be and who decided it, ask the classifier only when that answer
    // came from the caller, then resolve again carrying the verdict. Both
    // resolves are pure and free; only the classifier costs anything, and the
    // structural gate inside it means most turns never reach that cost.
    //
    // Downgrade-only, so the second resolve can never produce a more expensive
    // route than the first would have.
    //
    // OUTSIDE the config try/catch above, and wrapped in its own, because that
    // one deliberately 500s the request — a classifier is an optimisation and
    // must never be able to fail a call. Every failure path here ends at "keep
    // the band we already had".
    const clsCfg = routingConfig.classifier;
    if (clsCfg?.enabled && clsCfg.impl !== 'none') {
      try {
        const verdict = await classifyRequest({
          enabled: true,
          bandSource: decision.route.complexitySource,
          declaredBand: decision.route.complexity,
          messages: body.messages,
          maxBytes: clsCfg.maxRequestBytes,
          allowedBands: clsCfg.bands,
          verdictFn: makeClassifierVerdictFn(clsCfg),
        });
        classifierNote = verdict.detail || '';
        if (verdict.changed) {
          classifierStats.asked += 1;
          classifierStats.downgraded += 1;
          routeReq.complexity = verdict.band;
          routeReq.classified = true;
          decision = explainRoute(routingConfig, routeReq);
        } else if (/^classifier error/.test(verdict.detail || '')) {
          // Counted apart from `unchanged`, because the two mean opposite
          // things about the classifier: one is it working and declining to
          // move a turn, the other is it not answering at all. Merged, a dead
          // endpoint reads as a cautious judge.
          classifierStats.asked += 1;
          classifierStats.failed += 1;
        } else if (!SKIP_DETAILS.has(verdict.detail || '')) {
          // A turn the gates let through and a verdict left alone. The skips
          // (mid-loop, vetoed, already lowest) are NOT counted as asked — no
          // call was made, and inflating the denominator with them would make
          // the downgrade rate look far worse than the judge is.
          classifierStats.asked += 1;
          classifierStats.unchanged += 1;
        }
      } catch (e) {
        classifierStats.failed += 1;
        classifierNote = `classifier skipped: ${e?.message || 'unknown error'}`;
      }
    }

    // Config says where it should go; initProviders() says what is actually
    // reachable right now. Availability is a runtime FACT, not a policy — a
    // provider that never authenticated cannot serve anything, so it drops out
    // of the chain here rather than being written out of the config.
    const chain = decision.chain.filter((c) => providers[c.impl]?.available);
    const unavailable = decision.chain.filter((c) => !providers[c.impl]?.available);

    if (chain.length === 0) {
      // Distinguish the two ways this happens, because the fixes are different:
      // a capability gate means "config has no capable provider for tools[]";
      // an empty chain after the availability filter means "nothing is logged in".
      if (wantsTools && decision.skipped.some((s) => /tools/.test(s.reason))) {
        const msg = `tools[] requested but no tools-capable provider is routable for ${decision.route.matchedKey}: `
          + decision.skipped.map((s) => `${s.provider} (${s.reason})`).join('; ');
        logErr(`tool-capability gate: ${msg}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: msg, type: 'NO_TOOL_CAPABLE_PROVIDER' }));
      }
      const msg = `no available provider for ${decision.route.matchedKey}. `
        + `Config chain: [${decision.chain.map((c) => c.provider).join(' > ') || 'empty'}]; `
        + `unavailable at runtime: [${unavailable.map((c) => c.provider).join(', ') || 'none'}]; `
        + `skipped by config: [${decision.skipped.map((s) => `${s.provider}: ${s.reason}`).join('; ') || 'none'}]`;
      logErr(msg);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: msg, type: 'PROVIDER_UNAVAILABLE' }));
    }

    // One log line that says exactly what the config decided and why — the same
    // string /api/llm/routing/resolve returns, so the log and the dashboard can
    // never tell you different stories.
    log(`route ${decision.summary} [network=${routeReq.network}${wantsTools ? ', tools' : ''}]`
      + (unavailable.length ? ` (dropped, not reachable: ${unavailable.map((c) => c.provider).join(', ')})` : ''));

    const startTime = Date.now();
    let lastErr = null;
    // Failed candidates, in the order they were tried, for the row's
    // attempt_trail. Populated in the catch below; empty on the common path, and
    // an empty trail serialises to '' rather than '{}' (routing-trail.mjs).
    const failedAttempts = [];
    // Same-provider retry budget, from llm-fallback.yaml `same_provider_retries`.
    // A transient network error (stale keep-alive socket after idle, reset, DNS
    // blip) on an HTTP provider almost always succeeds on a fresh connection, so
    // it is worth one cheap retry before advancing to a slower fallback.
    const retryBudget = routingConfig.fallback.sameProviderRetries;
    const retriedProviders = new Map();
    // Every hop's outcome, so an exhausted chain can report what the WHOLE chain
    // did rather than only what the last hop happened to say.
    const attempts = [];

    for (let ci = 0; ci < chain.length; ci++) {
      // `providerName` is the ACCOUNT id (gh-copilot, claude-code-max) — the
      // thing that gets billed and the label every row and log line carries.
      // `impl` is the runtime implementation it dispatches to. Keeping the two
      // apart is what lets telemetry tell claude-code-max from anthropic-api,
      // which the old single-name scheme could not.
      const { provider: providerName, model: routedModel, impl } = chain[ci];
      const providerInfo = providers[impl];
      const isFallback = ci > 0;
      // The model comes from (provider, complexity) in llm-routing.yaml, so each
      // hop is handed a model ITS OWN provider serves. This replaces the
      // CLAUDE_FAMILY special case, which carried one pinned model across
      // "similar" providers and could hand groq a Claude model id.
      const callBody = { ...body, model: routedModel };
      // Per-ATTEMPT clock, distinct from startTime (the whole-request clock that
      // latency_ms is measured against). A trail entry saying "gh-copilot failed
      // after 1203ms" must mean this hop, not time since the request arrived —
      // otherwise every later hop inherits the earlier ones' cost and a fast
      // failure after a slow one reads as slow.
      const attemptStart = Date.now();

      try {
        log(`${providerName}: model=${routedModel} messages=${callBody.messages?.length || 0} method=${providerInfo.method}${isFallback ? ` (fallback from ${chain[0].provider})` : ''}`);

        let result;
        if (impl === 'claude-code') {
          result = await completeClaudeCode(callBody, reqAbort.signal);
        } else if (impl === 'anthropic') {
          result = await completeAnthropic(callBody);
        } else if (impl === 'openai') {
          result = await completeOpenAI(callBody);
        } else if (impl === 'groq') {
          result = await completeGroq(callBody);
        } else if (impl === 'copilot') {
          result = callBody.responses_body && /^gpt-5\./.test(routedModel)
            ? await completeCopilotResponses(callBody)
            : await completeCopilot(callBody);
        } else if (impl === 'qwen-local') {
          result = await completeQwenLocal(callBody);
        } else if (impl === 'qwen-laptop') {
          result = await completeQwenLaptop(callBody);
        } else if (providerPlugins[impl]) {
          result = await providerPlugins[impl].complete(callBody);
        } else {
          // Unreachable via config (an enabled provider must declare an impl,
          // enforced at load), so this only fires if someone adds a provider to
          // the yaml without adding its dispatch arm here or a provider module. Say which.
          throw new Error(`PROVIDER_UNAVAILABLE: provider "${providerName}" declares impl "${impl}", which has no dispatch arm in server.mjs and no provider module`);
        }

        const latencyMs = Date.now() - startTime;
        log(`${providerName}: completed in ${latencyMs}ms model=${result.model} tokens=${result.tokens.total}${isFallback ? ' (via fallback)' : ''}`);

        // Counted HERE — after the provider returned — and against the provider
        // that actually answered, which on a fallback hop is not the one the
        // route named. See executionStats.
        executionStats.completions += 1;
        if (isSelfHosted(routingConfig.providers[providerName])) executionStats.local += 1;
        // Phase 36-06: log if canonicalization rewrote the spelling (useful
        // for the first few hours after rollout to confirm map coverage).
        if (result.model && canonicalizeModelName(result.model) !== result.model) {
          log(`canonicalized: ${result.model} → ${canonicalizeModelName(result.model)}`);
        }

        // ── Phase 67-06 (REPRO-02): record tap — best-effort fixture append ──
        // Mirrors the `if (_tokenDb) logTokenCall(...)` best-effort contract: a
        // fixture write must NEVER fail or slow the real LLM call. Guarded by the
        // active span's meta.record; uses the SAME single match-key impl and the
        // Plan 01 recordFixture. On a replay run the replay tap has already
        // returned above, so this only fires on genuine (record-armed) live
        // completions. The recorded shape matches the served response contract.
        if (repro && span?.meta?.record) {
          try {
            const key = repro.matchKey(repro.normalizeReq(body));
            repro.recordFixture(recordFixturesDir(span), key, {
              content: result.content,
              provider: providerName,
              model: result.model,
              tokens: result.tokens,
              latencyMs,
              ...(typeof result.overheadMs === 'number' ? { overheadMs: result.overheadMs } : {}),
            });
          } catch (err) {
            logErr(`record tap failed (non-fatal): ${err?.message || err}`);
          }
        }

        // Resolve the row's task_id ONCE — the context-turn write below REUSES it
        // (bindCompleteTaskId, measurement.mjs: explicit id, else the ambient span
        // unless this is a background daemon).
        const resolvedTaskId = bindCompleteTaskId(body, procName);

        // Persist token usage for the dashboard. Best-effort — never let a
        // DB hiccup fail the LLM call.
        if (_tokenDb) {
          const tokensEstimated = (result.tokens?.total ?? 0) === 0 ? 1 : 0;
          logTokenCall(_tokenDb, {
            timestamp: new Date().toISOString(),
            provider: providerName,
            model: canonicalizeModelName(result.model) || 'unknown',
            model_raw: result.model || 'unknown',
            process: typeof body.process === 'string' && body.process ? body.process : 'unknown',
            subscription: typeof body.subscription === 'string' && body.subscription
              ? body.subscription
              : defaultSubscription(providerName),
            input_tokens: result.tokens?.input ?? 0,
            output_tokens: result.tokens?.output ?? 0,
            total_tokens: result.tokens?.total ?? 0,
            // D-09 (IN-05): copilot/opencode wire rows now carry the real
            // OpenAI-wire cache split parsed at the completion parse sites
            // (readCopilotStream / completeCopilot / completeOpenAICompatible).
            // Surfaced SEPARATELY from total_tokens; coalesced to 0 for providers
            // whose result.tokens omits it (backward compatible).
            cache_read_tokens: result.tokens?.cache_read_tokens ?? 0,
            cache_write_tokens: result.tokens?.cache_write_tokens ?? 0,
            // ── The routing decision that produced this row ──
            // Everything here was already computed above and used to be thrown
            // away, which is why the dashboard could only ever INFER a fallback
            // from an unexpected provider total. `ci` is the chain index that
            // actually served, so chain_position > 0 IS the fallback, recorded
            // rather than deduced.
            route_key: decision.route.matchedKey,
            route_band: decision.route.complexity,
            route_step: decision.route.step,
            offloaded_from: decision.route.offloadedFrom || '',
            chain_position: ci,
            attempt_trail: serializeRoutingTrail({
              attempts: failedAttempts,
              configSkipped: decision.skipped,
              runtimeDropped: unavailable,
              // Why the offload did NOT move this call. Recording the non-event
              // is what separates "stayed on copilot because the guard failed"
              // from "was never eligible" — indistinguishable without it.
              offloadSkipped: decision.route.offloadSkipped || '',
              classifier: classifierNote,
            }),
            routing_source: 'live',
            // ── Which turn this call is part of, and who chose its band ──
            //
            // The routing fields above describe this call alone. They are why a
            // pi turn that ran its first call on qwen-local and its second on
            // Sonnet read as two unrelated decisions: nothing said the rows were
            // one turn, and nothing said the bands came from different deciders
            // (the classifier downgraded the first; the second kept the
            // caller's, because the classifier's mid-loop gate declines once a
            // tool result is in context).
            //
            // Derived from body.messages, so no agent has to send anything.
            //
            // FOREGROUND ONLY, and that restriction is load-bearing. A turn is a
            // property of a CONVERSATION — messages accumulating around a human.
            // A background service is one-shot: it sends system+prompt, gets an
            // answer, and never continues. Its calls therefore all hash to the
            // same conversation and all count one user message, so keying them
            // the same way merges genuinely separate jobs into a fabricated
            // turn. Observed immediately on real traffic: three independent
            // bg-auto-measure-title runs, which re-send an identical prompt,
            // rendered as one turn of three calls. Background rows keep '' / 0
            // and read as "no turn recorded", which is the truth.
            ...(decision.route.class === 'fg-chat'
              ? turnIdentity(body.messages, typeof body.agent === 'string' ? body.agent : '')
              : {}),
            band_source: decision.route.complexitySource || '',
            latency_ms: latencyMs,
            // PERF-03 (Plan 66-03): the worker-pool spawn/queue overhead rides
            // alongside latency_ms. Present ONLY for claude-code worker-pool
            // completions (result.overheadMs from toCompletion); direct-OAuth
            // (haiku) and execFile-overflow results have no overheadMs, so NULL
            // is logged — correct, those paths carry no pool overhead.
            overhead_ms: typeof result.overheadMs === 'number' ? result.overheadMs : null,
            prompt_preview: measurement.promptPreview(body.messages),
            tokens_estimated: tokensEstimated,
            // ── Phase 70-01 Task 1 (ADAPT-03 / D-06): generic agent +
            // granularity_tier envelope passthrough. Stamped the SAME way
            // body.process / body.subscription are threaded above, so ONE code
            // path serves opencode, mastra, and any future proxy-routed agent
            // with zero per-agent branches. Existing /api/complete callers that
            // omit these fields keep the column defaults ('' each) — backward
            // compatible. The shim (POST /v1/chat/completions) sets the internal
            // body.agent (X-Agent/body.agent precedence, default 'opencode') and
            // body.granularity_tier='per-llm-call'; logCall reads them off the
            // row generically.
            agent: typeof body.agent === 'string' && body.agent ? body.agent : '',
            // CR-02 (83-09): copilot BYOK wire rows reach here via the /v1/copilot
            // shim with body.agent='copilot'; stamping the adapter hash (mirroring
            // the /v1/messages tap at :2217) makes them discoverable by the
            // coding-side copadt-keyed snapshotWireRowIds (they were defaulting to
            // the machine USER_HASH → copilot unmatched_wire was vacuously 0). An
            // omitted body.agent (direct /api/complete callers, e.g. the km-core
            // wrapper) leaves user_hash unset so logCall keeps the machine default
            // (backward compatible). This ALSO unifies opencode/mastra shim wire-row
            // provenance with the tap (reconcile for those agents is stamp-only and
            // unaffected).
            ...(typeof body.agent === 'string' && body.agent
              ? { user_hash: adapterUserHash(body.agent) }
              : {}),
            granularity_tier: typeof body.granularity_tier === 'string' && body.granularity_tier
              ? body.granularity_tier
              : '',
            // parent_call_id/reasoning_tokens stay unset here — logCall defaults
            // them ('' / 0).
            //
            // WR-06 (Phase 83 re-review): the shim threads a generated
            // per-request id via internalBody.tool_call_id so shim wire rows
            // (copilot BYOK / opencode / mastra) carry an identity — enabling
            // the reconcile request-id probe, reconcileGapFill (task_id/cache
            // backfill), and the D-04 copilotCacheSplit merge, all of which are
            // no-ops on an empty id. Direct /api/complete callers that omit it
            // keep the '' default (backward compatible).
            tool_call_id: typeof body.tool_call_id === 'string' ? body.tool_call_id : '',
            // task_id precedence and the background-daemon guard: bindCompleteTaskId.
            task_id: resolvedTaskId,
            // body.project: the shim's resolved project, or a background
            // caller (coding's ObservationWriter, …) naming the repo it serves.
            project: sanitizeProject(body.project),
          });
        }

        // Context-turns line + opt-in raw bodies for a measured completion.
        measurement.recordCompletionCapture({ body, result, taskId: resolvedTaskId, span });

        // Phase 70-01 Task 2 (D-02): when the request arrived via the
        // /v1/chat/completions shim, wrap the proxy result in the OpenAI
        // chat.completion envelope (non-streaming, single buffered JSON).
        if (req._shimOpenAI) {
          const chatId = 'chatcmpl-' + randomUUID();
          const created = Math.floor(Date.now() / 1000);
          // The cache split has to ride along, and on the OPENAI wire that means
          // two things at once — `prompt_tokens` INCLUDING the cache hits, and
          // `prompt_tokens_details.cached_tokens` naming them. `result.tokens`
          // uses the other convention (`input` is FRESH input, cache separate —
          // see openAIFreshInputTokens), so the two are added back here.
          //
          // Dropping them, as this did until 2026-09-18, is not merely a
          // reporting gap: an OpenAI-compatible client reconstructs occupancy as
          // `prompt_tokens - cached_tokens` + `cached_tokens`, so with no cache
          // field it sees only the fresh slice. Measured on this machine, a
          // ~57K-token OpenCode conversation reported 4,130 — and OpenCode's own
          // sidebar and the tmux context gauge, which both read that number,
          // showed "0% used" on a session that was most of the way through its
          // window. Every one of the 4,731 `rapid-proxy` assistant rows in
          // OpenCode's database carries cache.read = 0, against 26,178 of 27,435
          // for native github-copilot: the tell that this envelope, not the
          // upstream provider, was where the number was lost.
          const cachedTokens = result.tokens?.cache_read_tokens ?? 0;
          const freshInput = result.tokens?.input ?? 0;
          const completionTokens = result.tokens?.output ?? 0;
          const usage = {
            prompt_tokens: freshInput + cachedTokens,
            completion_tokens: completionTokens,
            total_tokens: freshInput + cachedTokens + completionTokens,
            ...(cachedTokens > 0
              ? { prompt_tokens_details: { cached_tokens: cachedTokens } }
              : {}),
          };
          if (req._shimResponses) {
            const frames = responseSseFrames(result, `resp_${randomUUID()}`);
            if (req._shimStream) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                [ANSWERING_PROVIDER_HEADER]: providerName,
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
              });
              for (const frame of frames) res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
              return res.end();
            }
            res.writeHead(200, { 'Content-Type': 'application/json', [ANSWERING_PROVIDER_HEADER]: providerName });
            return res.end(JSON.stringify(frames.at(-1).response));
          }
          // Phase 70-02: client asked for streaming → emit a minimal SSE stream
          // (one content delta + a terminal finish/usage chunk + [DONE]) so the
          // OpenAI-compatible client renders the reply. Single-shot framing of the
          // already-buffered result — NOT incremental token streaming (D-02).
          if (req._shimStream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
                [ANSWERING_PROVIDER_HEADER]: providerName,
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });
            const base = { id: chatId, object: 'chat.completion.chunk', created, model: result.model };
            // Phase 82-03: buildStreamDelta reframes the buffered result — the
            // first chunk carries delta.tool_calls when result.toolCalls present,
            // and the terminal chunk's finish_reason becomes 'tool_calls' (else
            // byte-identical to the prior content-delta + 'stop' reframe).
            const { delta: streamDelta, finishReason: streamFinish } = buildStreamDelta(result);
            res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: streamDelta, finish_reason: null }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: streamFinish }], usage })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
          }
          res.writeHead(200, { 'Content-Type': 'application/json', [ANSWERING_PROVIDER_HEADER]: providerName });
          // Phase 82-03: buildBufferedChoice sets message.tool_calls +
          // finish_reason 'tool_calls' when result.toolCalls present; otherwise
          // byte-identical to the prior { role, content } + 'stop' envelope.
          return res.end(JSON.stringify({
            id: chatId,
            object: 'chat.completion',
            created,
            model: result.model,
            choices: [buildBufferedChoice(result)],
            usage,
          }));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          content: result.content,
          provider: providerName,
          model: result.model,
          tokens: result.tokens,
          latencyMs,
          // PERF-03 (Plan 66-03): surface overhead on the response for forensic
          // visibility (null for non-pool paths). Additive; does not change the
          // existing { content, provider, model, tokens, latencyMs } contract.
          ...(typeof result.overheadMs === 'number' ? { overheadMs: result.overheadMs } : {}),
          ...(isFallback ? { fallbackFrom: chain[0].provider } : {}),
        }));
      } catch (err) {
        lastErr = err;
        const msg = err.message || String(err);
        // Which of llm-fallback.yaml's failure classes this is (or null for a
        // genuine client/model error, which must NOT be retried on three
        // providers — that just burns three quotas and hides the bug).
        const failureClass = classifyFailure(msg);
        attempts.push({ provider: providerName, model: routedModel, failureClass, msg });

        // Record the failed hop for the row. The CLASS, never the message: the
        // message is the one part of a failure that can echo request content
        // into the DB. Recorded before the retry/fallback branches below so a
        // same-provider retry shows up as the two separate attempts it is.
        failedAttempts.push({
          provider: providerName,
          model: routedModel,
          error: normalizeFailureClass(failureClass),
          ms: Date.now() - attemptStart,
        });

        // Same-provider retry, for the failure classes where a second attempt has
        // a materially different chance of succeeding — see
        // SAME_PROVIDER_RETRY_CLASSES for which those are and why. In practice:
        // a PURE network error (stale keep-alive socket / reset / DNS blip).
        // Copilot normally answers in ~1.5s, but on a fresh "fetch failed" the
        // loop would otherwise jump straight to the 15-20s claude-code fallback
        // — which frequently gets aborted by the caller's timeout, yielding a
        // 500 that trips the health watchdog into restarting the proxy (the
        // observed flap). A fresh connection almost always succeeds.
        //
        // A `timeout` is NOT in that set: the provider was reached and missed
        // its deadline, so a retry buys a second full timeout_ms for the same
        // answer. It still advances the chain below.
        //
        // Budget comes from `same_provider_retries`; never retry once the client
        // has already disconnected.
        const used = retriedProviders.get(providerName) || 0;
        if (SAME_PROVIDER_RETRY_CLASSES.has(failureClass) && used < retryBudget && !reqAbort.signal.aborted) {
          retriedProviders.set(providerName, used + 1);
          logErr(`${providerName}: ${msg} — retrying same provider (${used + 1}/${retryBudget}, transient network)`);
          await new Promise((r) => setTimeout(r, 200));
          ci--; // repeat the current provider on the next loop iteration
          continue;
        }
        // Advance the chain ONLY for a failure class llm-fallback.yaml lists in
        // `retry_on`. Everything else surfaces to the caller verbatim.
        const mayFallBack = failureClass !== null && routingConfig.fallback.retryOn.has(failureClass);
        const hasNext = ci < chain.length - 1;
        if (mayFallBack && hasNext) {
          logErr(`${providerName}: ${msg} [${failureClass}] — falling back to ${chain[ci + 1].provider}/${chain[ci + 1].model}`);
          continue;
        }
        if (failureClass !== null && !routingConfig.fallback.retryOn.has(failureClass) && hasNext) {
          logErr(`${providerName}: ${msg} [${failureClass}] — NOT falling back (${failureClass} is absent from llm-fallback.yaml retry_on)`);
        }
        // Terminal: map the (last) error to an HTTP status and return.
        const latencyMs = Date.now() - startTime;
        logErr(`${providerName}: error after ${latencyMs}ms (chain exhausted): ${msg}`);

        // Name the whole chain, not just the hop that happened to be last. The
        // caller otherwise sees only the final upstream message — e.g. OpenAI's
        // "you exceeded your current quota" — and reasonably concludes the
        // request was routed to OpenAI, when gh-copilot was tried first and
        // refused. `detail` is ADDITIVE: `error` keeps the verbatim upstream
        // text, which callers already match on.
        const chainReport = attempts
          .map((a) => `${a.provider}/${a.model}: ${a.failureClass || 'error'} — ${String(a.msg).slice(0, 160)}`)
          .join(' | ');
        const neverTried = [
          ...unavailable.map((c) => `${c.provider} (not reachable)`),
          ...decision.skipped.map((s) => `${s.provider} (${s.reason})`),
        ];
        const detail = `all ${attempts.length} provider(s) in ${decision.route.matchedKey} failed`
          + (wantsTools ? ' for a tools[] request' : '')
          + `: ${chainReport}`
          + (neverTried.length ? `; never attempted: ${neverTried.join(', ')}` : '');
        logErr(detail);

        const envelope = (type) => JSON.stringify({
          error: msg, type, detail, attempts, route: decision.route.matchedKey,
        });
        if (msg.includes('QUOTA_EXHAUSTED') || msg.toLowerCase().includes('rate limit')) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          return res.end(envelope('QUOTA_EXHAUSTED'));
        }
        if (msg.includes('AUTH_ERROR') || msg.toLowerCase().includes('unauthorized')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(envelope('AUTH_ERROR'));
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(envelope('API_ERROR'));
      }
    }

    // Defensive — only reached if the chain was non-empty but every provider
    // threw a transient error (the last iteration returns above, so this is a
    // belt-and-suspenders guard).
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: lastErr?.message || 'all providers failed', type: 'API_ERROR' }));
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
      // Locate raas-api. Two install paths in the wild:
      //   1. Legacy: ${RAPID_HOME}/bin/raas-api (in-toolkit symlink/wrapper).
      //   2. Modern: `uv tool install tools/raas-api` → ~/.local/bin/raas-api.
      // We probe both. The toolkit dropped bin/ at some point in favor of uv-
      // managed tools, so the legacy path no longer exists in current clones
      // — but we keep checking it for installs that still wire it up locally.
      const candidates = [
        path.join(rapidHome, 'bin', 'raas-api'),
        path.join(os.homedir(), '.local', 'bin', 'raas-api'),
      ];
      const raasApiBin = candidates.find(p => fs.existsSync(p)) || 'raas-api';

      const { stdout, stderr } = await execFileAsync(raasApiBin, ['job', uuid], {
        timeout: 30_000,
        env: {
          ...process.env,
          RAPID_HOME: rapidHome,
          // Prepend ~/.local/bin so subprocesses launched by raas-api (uv
          // shims, platform-auth) also resolve correctly under launchd's
          // otherwise-minimal PATH.
          PATH: `${path.join(os.homedir(), '.local', 'bin')}:${rapidHome}/bin:${process.env.PATH}`,
        },
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

// Provider init does network I/O with timeouts (copilot /models 10s, local
// endpoints 4s, copilot-enterprise reachability 3s). It used to run BEFORE
// listen(), so every restart refused connections for as long as those probes
// took — longest exactly when they are flakiest, during a network change. On
// 2026-10-05 a VPN drop turned that into a live claude session retrying
// ECONNREFUSED. The port now opens first; requests that need providers await
// this promise in the handler, the passthrough does not.
let _providersInitialized = false;
let _providersReady = Promise.resolve();

async function initAllProviders() {
  log('Initializing providers...');
  await initProviders();

  // Prime the copilot enterprise-upstream reachability probe (see
  // probeCopilotEnterpriseReachable) so the first routed requests order the
  // chain correctly; main() schedules the 30s repeat.
  await probeCopilotEnterpriseReachable().catch(() => {});
  _providersInitialized = true;
  log('Providers initialized');
}

async function main() {
  server.listen(PORT, '0.0.0.0', () => {
    log(`Listening on http://0.0.0.0:${PORT}`);
    log(`Build: ${BUILD_IDENTITY}`);
    log(`Docker: LLM_CLI_PROXY_URL=http://host.docker.internal:${PORT}`);
  });

  _providersReady = initAllProviders();
  _providersReady.catch((err) => {
    logErr(`Fatal: provider init failed: ${err.message}`);
    process.exit(1);
  });

  const _copilotProbeTimer = setInterval(() => { probeCopilotEnterpriseReachable().catch(() => {}); }, 30_000);
  if (typeof _copilotProbeTimer.unref === 'function') _copilotProbeTimer.unref();

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
}

// Graceful shutdown. Stop accepting, let in-flight requests finish for up to
// SHUTDOWN_DRAIN_MS, then reap warm worker subprocesses (Phase 62 basic reap;
// full idle-evict is Phase 63) so the persistent `claude -p` children don't
// orphan, and exit.
//
// This used to exit on the spot, which cut every streaming reply mid-response
// ("Connection lost mid-response" in a live claude session). The drain is
// bounded because the port stays closed while it runs — the replacement cannot
// bind until this process exits — so a longer drain trades cut streams for a
// longer refused-connection window. 10s finishes the short calls and keeps
// well inside launchd's 20s ExitTimeOut (SIGKILL after that); a long opus
// stream can still be cut. Workers are reaped AFTER the drain because a
// `claude -p` worker may be serving one of the requests being drained.
const SHUTDOWN_DRAIN_MS = Number(process.env.LLM_PROXY_DRAIN_MS || 10_000);
let _shuttingDown = false;
function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  log(`Shutting down (${signal}) — draining in-flight requests (up to ${SHUTDOWN_DRAIN_MS}ms)...`);
  const finish = (how) => {
    log(`Shutdown: ${how}`);
    try { workerPool.disposeAll(); } catch { /* best-effort reap */ }
    process.exit(0);
  };
  // close() stops accepting and calls back once every connection has ended;
  // closeIdleConnections() drops keep-alive sockets with no request on them so
  // they do not hold the drain open.
  server.close(() => finish('drained'));
  server.closeIdleConnections?.();
  setTimeout(() => finish(`drain timed out after ${SHUTDOWN_DRAIN_MS}ms`), SHUTDOWN_DRAIN_MS);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch(err => {
  logErr(`Fatal: ${err.message}`);
  process.exit(1);
});
