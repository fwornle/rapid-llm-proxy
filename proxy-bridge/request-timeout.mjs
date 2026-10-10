// proxy-bridge/request-timeout.mjs
//
// How long a single upstream provider call may take before the fallback is the
// better bet.
//
// ── Why a provider's timeout_ms is a CAP and not a default ───────────────────
// Two parties have an opinion about this, and they are answering different
// questions:
//
//   the CALLER    "how long am I willing to wait for an answer at all"
//   the PROVIDER  "how long is it still worth waiting on THIS endpoint"
//
// Until 2026-09-02 the dispatcher resolved them as
//
//   body.timeout || providerTimeoutMs || 120_000
//
// which lets the caller's answer erase the provider's. That inverts what
// `timeout_ms` exists for. It was added for the local offload targets, whose
// whole argument is: this call was routed here BECAUSE it was cheap, a metered
// account sits one hop behind answering in ~5s, and waiting two minutes to find
// out that llama.cpp is wedged makes the offload strictly worse than never
// offloading. A ceiling that any caller can raise is not a ceiling.
//
// Measured cost of the inversion, on one day: `bg-consolidator-insight` sends
// `timeout: 300000`, so its calls to qwen-local — a provider that declares
// 30s — stalled for the full five minutes, 24 times. Roughly two hours of dead
// wait on an endpoint that had already been given a bound. The three pi turns
// that made this visible were the small half of the problem.
//
// So: the caller may ask for LESS than the provider's ceiling and get it. It
// may not ask for more. `Math.min` is the whole rule; the rest of this module
// is refusing to trust malformed input from either side.

// ── Why the ceiling is per BAND and not just per provider ────────────────────
// A provider's bands can land on models that are not the same kind of thing.
// qwen-local is the case that forced this:
//
//   small  -> qwen3.8-27b-dual-fast    37 in / 1131 out, no reasoning    31.0s
//   medium -> qwen3.8-27b-dual-normal  77 in / 2280 out, thinks first    70.1s
//
// dual-normal is a REASONING model — it spends completion tokens on
// `reasoning_content` before emitting any content, so it runs roughly twice the
// tokens, and the cost scales with context. One number cannot serve both. Set it
// for small and medium is cut off mid-thought on every call; set it for medium
// and a wedged small call — the high-volume background writers — waits minutes
// for a box that is not going to answer.
//
// That is not a hypothetical: `medium` was routed here with a 30s ceiling and
// timed out 33 times running, which was then read as "the model is dead". It was
// not dead. The ceiling was shorter than the model's own thinking time, and
// `output_tokens` hides reasoning tokens, so the rows looked self-contradictory
// (78 output tokens, 75s timeout) rather than obviously mis-configured.

/** Used when the provider declares no ceiling of its own. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * The ceiling a provider declares for one band.
 *
 * Accepts both shapes `timeout_ms` can take after parsing:
 *   scalar   → `{ timeoutMs: 30000, timeoutMsByBand: null }`
 *   per-band → `{ timeoutMs: <default or null>, timeoutMsByBand: {medium: 210000} }`
 *
 * A band named in the map wins; otherwise the provider's default applies;
 * otherwise null, meaning "not stated" and the dispatcher default takes over.
 * Deliberately NOT a merge of the two — a band either has its own answer or
 * inherits one, and there is nothing to combine.
 *
 * @param {{timeoutMs?: unknown, timeoutMsByBand?: Record<string,unknown>|null}|null|undefined} provider
 * @param {string|null|undefined} band
 * @returns {number|null}
 */
export function resolveProviderTimeout(provider, band) {
  if (!provider) return null;
  const byBand = provider.timeoutMsByBand;
  if (byBand && band && Object.prototype.hasOwnProperty.call(byBand, band)) {
    const v = usable(byBand[band]);
    if (v !== null) return v;
  }
  return usable(provider.timeoutMs);
}

/**
 * A timeout is only usable if it is a finite, positive number. Anything else —
 * null, undefined, 0, NaN, Infinity, a string that happens to look numeric — is
 * treated as "not stated" rather than coerced, so a malformed value falls back
 * to the next opinion instead of silently becoming one.
 *
 * @param {unknown} v
 * @returns {number|null}
 */
function usable(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Resolve the timeout for one upstream call.
 *
 * @param {object} input
 * @param {unknown} [input.callerTimeoutMs]   `body.timeout` from the request
 * @param {unknown} [input.providerTimeoutMs] `providers.<id>.timeout_ms`, or null
 * @param {number}  [input.defaultMs]         used when the provider declares none
 * @returns {number} milliseconds
 */
export function resolveRequestTimeout({
  callerTimeoutMs,
  providerTimeoutMs,
  defaultMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const ceiling = usable(providerTimeoutMs) ?? usable(defaultMs) ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const asked = usable(callerTimeoutMs);

  // No usable caller value → the ceiling stands, exactly as before.
  if (asked === null) return ceiling;

  return Math.min(asked, ceiling);
}
