// proxy-bridge/egress-decision.mjs
//
// Whether outbound traffic should currently go through a proxy, and which one.
//
// ── Why this is a module and not four lines in server.mjs ────────────────────
// bin/start-llm-proxy.sh picks HTTPS_PROXY once, at exec, from the health
// coordinator's network verdict — and until 2026-08-28 that answer was baked in
// for the life of the process. The only way to correct it was a restart, which
// is what turned a VPN drop into an outage instead of a transition:
//
//   17:00  corporate egress starts failing; three auto-heal restarts fire
//   17:07  the VPN actually drops — the coordinator still says `location=vpn`
//          for another six minutes, so every restart re-pins a dead proxy
//   17:07  pi reports "Retry failed after 3 attempts: Connection error"
//
// pi's corporate chain is gh-copilot > openai and BOTH leave through that one
// pin, so fallback depth bought nothing: one dead egress took out every hop at
// once. This decision is now re-made on a timer, and the rules below are the
// whole of it — pure, so they can be tested against that exact sequence rather
// than by disconnecting a laptop.
//
// PURE — every input is an argument. No env, no I/O, no clock.

/**
 * Decide the next egress pin.
 *
 * The two rules are asymmetric ON PURPOSE, because the costs are:
 *
 *   • Never pin a proxy without proving it reachable first. The launcher learned
 *     this twice (2026-05-21, 2026-07-22): pinning a dead corp-proxy:8080 at home
 *     made every provider call fail in milliseconds for hours.
 *   • Always un-pin one that has stopped answering, even while the coordinator
 *     still claims corporate. Direct is the safe direction — off-corp it is the
 *     only thing that works, and on-corp it fails exactly as the dead pin already
 *     did. Holding a proxy we KNOW is dead can only lose.
 *
 * And one rule about not knowing: a coordinator that did not answer is NOT
 * evidence of anything. detectNetworkMode() elsewhere in server.mjs deliberately
 * fails open to 'public' because a stray 'corporate' there only costs chain
 * resilience; here failing open would drop a proxy that is genuinely needed and
 * break every call on a blip. So 'unknown' holds whatever is in force.
 *
 * ── Why `candidates` is a LIST ──────────────────────────────────────────────
 * It used to be one string, defaulting to local proxydetox on :3128, and that
 * is why the 2026-09-01 office outage lasted six minutes instead of thirty
 * seconds. On this corporate network :3128 usually does NOT reach upstream —
 * measured over the proxy's own log, the launcher pinned the PAC-derived
 * corp-proxy:8080 399 times and :3128 only 27. The launcher copes because it
 * falls through to PAC extraction; the runtime had no second option, so it
 * probed the one candidate that typically fails, held direct, and every
 * external provider call failed with `fetch failed` for as long as the machine
 * stayed on corporate.
 *
 * Order is the caller's and mirrors the launcher's: the ADAPTIVE proxy first
 * (proxydetox re-reads the PAC per request and falls back to direct when the
 * VPN drops), a remembered known-good corporate proxy after it. Nothing here
 * pins anything unprobed — `reachableCandidate` is a probe RESULT, and the
 * un-pin rule above still drops whatever stops answering, which is what keeps
 * the non-adaptive entry from stranding the process the way a baked-in
 * HTTPS_PROXY did on 2026-07-26.
 *
 * @param {object} input
 * @param {'corporate'|'public'|null} input.verdict   coordinator's answer; null = it did not say
 * @param {string|null} input.pinned                  the proxy currently in force, or null for direct
 * @param {string[]} input.candidates                 corporate proxies to try, best first
 * @param {boolean} input.pinnedReachable             probe result for `pinned` (ignored when not pinned)
 * @param {string|null} input.reachableCandidate      the first of `candidates` that answered, or null
 * @returns {{proxy: string|null, changed: boolean, reason: string}}
 */
export function decideEgressProxy({
  verdict,
  pinned = null,
  candidates = [],
  pinnedReachable = false,
  reachableCandidate = null,
}) {
  const hold = (reason) => ({ proxy: pinned, changed: false, reason });
  const move = (proxy, reason) => ({ proxy, changed: proxy !== pinned, reason });

  if (verdict === null) {
    return hold('coordinator gave no verdict — holding the current pin');
  }

  if (verdict === 'public') {
    return move(null, 'coordinator reports public');
  }

  // Corporate.
  if (pinned) {
    if (pinnedReachable) return hold(`coordinator reports corporate and ${pinned} still answers`);
    // A dead pin used to hand straight over to DIRECT, which on a corporate
    // network is the one state where every off-prem provider fails. The other
    // candidate was not considered until the NEXT tick, once `pinned` was null
    // — so a stranded pin cost a full recheck interval of guaranteed failure on
    // top of whatever the coordinator's demotion hysteresis was already adding.
    //
    // Measured over this proxy's own log: all 16 "stopped answering" events name
    // the static PAC-derived corp-proxy:8080 and none name local proxydetox on
    // :3128, which is adaptive (it re-reads the PAC per request and falls back
    // to direct itself) and therefore cannot strand the process the same way.
    // Handing over to it is the difference between degrading and breaking.
    //
    // Still nothing unprobed: `reachableCandidate` is a probe RESULT, so this
    // keeps the module's first rule — never pin a proxy without proving it
    // reachable first — and direct remains the answer when nothing answers.
    return reachableCandidate
      ? move(reachableCandidate, `coordinator reports corporate, ${pinned} stopped answering, handing over to ${reachableCandidate}`)
      : move(null, `coordinator still reports corporate but ${pinned} stopped answering`);
  }
  if (!candidates.length) {
    return hold('coordinator reports corporate but there is no proxy candidate to try');
  }
  // Naming every candidate that was tried, not just the first: "3128 is not
  // reachable" reads as one box being down, when the fact worth acting on is
  // that NOTHING reachable was found and egress is therefore direct on a
  // network that needs a proxy.
  return reachableCandidate
    ? move(reachableCandidate, 'coordinator reports corporate, proxy verified reachable')
    : hold(`coordinator reports corporate but no proxy answered (tried: ${candidates.join(', ')}) — staying direct`);
}

/**
 * Is egress currently in the state that silently breaks every external call?
 *
 * Direct egress on a corporate network. The proxy keeps serving, routing keeps
 * resolving, on-prem targets keep working — and everything that must leave the
 * building fails with `fetch failed`. On 2026-09-01 that combination produced a
 * dashboard showing a successful local offload next to a dead fallback chain,
 * with nothing anywhere naming the cause, because a `hold` decision logged
 * nothing at all.
 *
 * Not a verdict on whether a proxy is REQUIRED — a corporate network that
 * allows direct egress is possible. It is the pairing worth surfacing, and the
 * caller states it as the fact it is rather than as a diagnosis.
 *
 * @param {'corporate'|'public'|null} verdict
 * @param {string|null} proxy the pin in force after the decision
 * @returns {boolean}
 */
export function egressIsDegraded(verdict, proxy) {
  return verdict === 'corporate' && !proxy;
}

/**
 * Does this probe need to run at all? Saves a 4s curl on every tick in the two
 * steady states that dominate the timeline: public (no proxy is involved) and
 * unknown (nothing will change regardless of the answer).
 *
 * @param {'corporate'|'public'|null} verdict
 * @returns {boolean}
 */
export function needsReachabilityProbe(verdict) {
  return verdict === 'corporate';
}

/**
 * Is a request body safe to send a second time?
 *
 * A retry re-sends the body, so anything consumed by the first attempt cannot be
 * replayed. Every caller in this proxy passes a JSON string (or a Buffer, on the
 * /v1/messages passthrough), so the common path is replayable — but a stream
 * would be silently truncated rather than loudly rejected, which is the failure
 * mode worth refusing outright.
 *
 * @param {unknown} body the `body` of a fetch init
 * @returns {boolean}
 */
export function bodyIsReplayable(body) {
  if (body === undefined || body === null) return true;
  if (typeof body === 'string') return true;
  // Buffer / TypedArray / ArrayBuffer — re-readable by definition.
  return ArrayBuffer.isView(body) || body instanceof ArrayBuffer;
}

/**
 * After a request failed on the egress path, should it be retried?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * decideEgressProxy() above is correct but only ever ran on a 30s timer, so the
 * strongest evidence the system ever gets — a request that JUST failed through
 * the pinned proxy — was thrown away. Meanwhile the coordinator's demotion
 * hysteresis (3 confirmations, deliberately, to stop flapping) guarantees a
 * window where it still reports corporate and the pin is already dead.
 *
 * That window is not a rare edge: it is every walk out of the office. On
 * 2026-09-02 it produced `Retry failed after 3 attempts: Connection error` in
 * pi, and on 2026-09-01 it lasted six minutes. Polling faster cannot fix it
 * without defeating the hysteresis; reacting to the failure can, and costs
 * nothing — a dead pin refuses the connection in single-digit milliseconds
 * (corp-proxy:8080 measured at 3.8ms once the VPN was gone).
 *
 * The retry is allowed only when the re-decision actually MOVED the egress.
 * Retrying on unchanged egress would just re-run a request against the same
 * broken path, which is the "burns three providers to hide one bug" mistake the
 * fallback classes exist to avoid.
 *
 * @param {object} input
 * @param {boolean} input.hadPin          a proxy was in force when the request failed
 * @param {boolean} input.egressChanged   the re-decision moved the pin
 * @param {boolean} input.failureIsNetwork the error was a connection failure, not an HTTP status
 * @param {boolean} input.replayableBody  see bodyIsReplayable()
 * @param {boolean} input.aborted         the caller has already given up
 * @returns {boolean}
 */
export function shouldRetryAfterEgressRecheck({
  hadPin,
  egressChanged,
  failureIsNetwork,
  replayableBody,
  aborted,
}) {
  // Direct egress that fails is telling the truth: there is no pin to blame and
  // nothing for a re-decision to move.
  if (!hadPin) return false;
  if (!failureIsNetwork) return false;
  if (!replayableBody) return false;
  if (aborted) return false;
  return egressChanged === true;
}
