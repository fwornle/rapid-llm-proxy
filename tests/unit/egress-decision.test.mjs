/**
 * Unit suite for proxy-bridge/egress-decision.mjs.
 *
 * These rules decide whether every outbound provider call leaves through a proxy.
 * Getting them wrong does not degrade routing — it takes out every provider at
 * once, because on corporate they all share the one pin. That is what happened
 * on 2026-08-28, and the sequence is replayed verbatim at the bottom of this file.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideEgressProxy,
  needsReachabilityProbe,
  egressIsDegraded,
  shouldRetryAfterEgressRecheck,
  bodyIsReplayable,
  subprocessProxyEnv,
} from '../../proxy-bridge/egress-decision.mjs';

const PX = 'http://127.0.0.1:3128';
const MUC = 'http://corp-proxy:8080';

describe('decideEgressProxy — public', () => {
  it('un-pins a proxy the moment the coordinator says public', () => {
    const d = decideEgressProxy({ verdict: 'public', pinned: MUC, candidates: [MUC] });
    assert.equal(d.proxy, null);
    assert.equal(d.changed, true);
  });

  it('is a no-op when already direct', () => {
    const d = decideEgressProxy({ verdict: 'public', pinned: null, candidates: [PX] });
    assert.equal(d.proxy, null);
    assert.equal(d.changed, false);
  });

  it('does not probe anything — there is no proxy in the answer', () => {
    assert.equal(needsReachabilityProbe('public'), false);
  });
});

describe('decideEgressProxy — corporate, nothing pinned', () => {
  it('pins the candidate only once it is proven reachable', () => {
    const d = decideEgressProxy({ verdict: 'corporate', pinned: null, candidates: [PX], reachableCandidate: PX });
    assert.equal(d.proxy, PX);
    assert.equal(d.changed, true);
  });

  it('stays DIRECT when the candidate does not answer', () => {
    // The 2026-05-21 / 2026-07-22 regression: pinning a dead corp-proxy:8080 at
    // home made every provider call fail in milliseconds, for hours.
    const d = decideEgressProxy({ verdict: 'corporate', pinned: null, candidates: [MUC] });
    assert.equal(d.proxy, null);
    assert.equal(d.changed, false);
    assert.match(d.reason, /no proxy answered/);
    // The reason names what was tried: "X is not reachable" reads as one box
    // being down, when the actionable fact is that egress is direct on a
    // network that needs a proxy.
    assert.match(d.reason, /http:\/\/corp-proxy:8080/);
  });

  it('stays direct when there is no candidate at all', () => {
    const d = decideEgressProxy({ verdict: 'corporate', pinned: null, candidates: [] });
    assert.equal(d.proxy, null);
    assert.equal(d.changed, false);
  });
});

describe('decideEgressProxy — corporate, already pinned', () => {
  it('keeps a pin that still answers', () => {
    const d = decideEgressProxy({ verdict: 'corporate', pinned: PX, candidates: [PX], pinnedReachable: true });
    assert.equal(d.proxy, PX);
    assert.equal(d.changed, false);
  });

  it('DROPS a pin that has stopped answering, even though the verdict says corporate', () => {
    // The core fix. The coordinator lags the network by minutes on a VPN drop;
    // holding a proxy we have just proven dead can only lose.
    const d = decideEgressProxy({ verdict: 'corporate', pinned: MUC, candidates: [MUC], pinnedReachable: false });
    assert.equal(d.proxy, null);
    assert.equal(d.changed, true);
    assert.match(d.reason, /stopped answering/);
  });

  it('probes on corporate, and only on corporate', () => {
    assert.equal(needsReachabilityProbe('corporate'), true);
    assert.equal(needsReachabilityProbe('public'), false);
    assert.equal(needsReachabilityProbe(null), false);
  });
});

describe('decideEgressProxy — the coordinator said nothing', () => {
  it('holds the current pin rather than guessing', () => {
    // Unreachable-coordinator is not evidence. Failing open to public here would
    // drop a proxy that is genuinely needed on every blip — the opposite of the
    // trade detectNetworkMode() makes, where a stray verdict only costs chain
    // resilience.
    for (const pinned of [MUC, null]) {
      const d = decideEgressProxy({ verdict: null, pinned, candidates: [PX], reachableCandidate: PX });
      assert.equal(d.proxy, pinned);
      assert.equal(d.changed, false);
      assert.match(d.reason, /no verdict/);
    }
  });
});

describe('the 2026-08-28 VPN drop, replayed', () => {
  it('recovers within one tick instead of taking six minutes and three restarts', () => {
    // t0 — on the VPN, proxy pinned and healthy.
    let pin = MUC;
    let d = decideEgressProxy({ verdict: 'corporate', pinned: pin, candidates: [MUC], pinnedReachable: true });
    assert.equal(d.proxy, MUC, 'steady state on the VPN: keep the pin');
    pin = d.proxy;

    // t1 — the link is gone but the coordinator has not noticed. This is the
    // window pi's request landed in; the OLD behaviour held MUC here and every
    // provider in pi's chain failed together.
    d = decideEgressProxy({ verdict: 'corporate', pinned: pin, candidates: [MUC], pinnedReachable: false });
    assert.equal(d.proxy, null, 'a dead pin is dropped without waiting for the coordinator');
    assert.equal(d.changed, true);
    pin = d.proxy;

    // t2 — still no coordinator update; nothing thrashes back.
    d = decideEgressProxy({ verdict: 'corporate', pinned: pin, candidates: [MUC] });
    assert.equal(d.proxy, null);
    assert.equal(d.changed, false, 'must not re-pin the proxy it just proved dead');
    pin = d.proxy;

    // t3 — the coordinator catches up. Already correct, so nothing happens.
    d = decideEgressProxy({ verdict: 'public', pinned: pin, candidates: [MUC] });
    assert.equal(d.proxy, null);
    assert.equal(d.changed, false, 'the coordinator catching up is a no-op, not a second transition');

    // t4 — back on the VPN later, proxydetox answering: pin again, having proved it.
    d = decideEgressProxy({ verdict: 'corporate', pinned: null, candidates: [PX], reachableCandidate: PX });
    assert.equal(d.proxy, PX, 'rejoining the VPN re-pins without a restart');
    assert.equal(d.changed, true);
  });
});

describe('the candidate list, and the state it produces', () => {
  it('prefers the earlier candidate the probe reported', () => {
    // Order is the caller's — the adaptive proxy first. This asserts the
    // decision honours it rather than re-deriving a preference of its own.
    const d = decideEgressProxy({
      verdict: 'corporate', pinned: null, candidates: [PX, MUC], reachableCandidate: PX,
    });
    assert.equal(d.proxy, PX);
    assert.equal(d.changed, true);
  });

  it('takes a later candidate when it is the one that answered', () => {
    // The 2026-09-01 office outage in one assertion: :3128 is preferred but on
    // that network it does not reach upstream, and before the list existed the
    // runtime had nothing else to try and held direct for six minutes.
    const d = decideEgressProxy({
      verdict: 'corporate', pinned: null, candidates: [PX, MUC], reachableCandidate: MUC,
    });
    assert.equal(d.proxy, MUC);
    assert.equal(d.changed, true);
  });

  it('names every candidate tried when none answered', () => {
    const d = decideEgressProxy({ verdict: 'corporate', pinned: null, candidates: [PX, MUC] });
    assert.equal(d.proxy, null);
    assert.match(d.reason, /http:\/\/127\.0\.0\.1:3128/);
    assert.match(d.reason, /http:\/\/corp-proxy:8080/);
  });
});

describe('egressIsDegraded marks the state that breaks every off-prem call', () => {
  it('corporate with no proxy is degraded', () => {
    assert.equal(egressIsDegraded('corporate', null), true);
  });

  it('corporate with a proxy is not', () => {
    assert.equal(egressIsDegraded('corporate', MUC), false);
  });

  it('public with no proxy is the normal state, not a fault', () => {
    // Direct egress at home is correct. Flagging it would make the signal
    // useless exactly where it is supposed to be quiet.
    assert.equal(egressIsDegraded('public', null), false);
  });

  it('an unknown verdict is never reported as degraded', () => {
    // A coordinator blip is not evidence of anything, and the pin is held. It
    // must not raise an alarm that says the network needs a proxy.
    assert.equal(egressIsDegraded(null, null), false);
  });
});

describe('shouldRetryAfterEgressRecheck — react to the failure, do not wait out the timer', () => {
  // The gap this closes: decideEgressProxy is right, but ran only on a 30s
  // timer, while the coordinator's demotion hysteresis (3 confirmations) makes a
  // stale-corporate window unavoidable by design. The request that just failed
  // through the dead pin is the earliest evidence available, and it used to be
  // discarded.
  const ok = (over = {}) => ({
    hadPin: true, egressChanged: true, failureIsNetwork: true,
    replayableBody: true, aborted: false, ...over,
  });

  it('retries once when the re-decision actually moved the egress', () => {
    assert.equal(shouldRetryAfterEgressRecheck(ok()), true);
  });

  it('does NOT retry when the egress did not move', () => {
    // Same broken path, second time. This is the "burn three providers to hide
    // one bug" mistake, one layer down.
    assert.equal(shouldRetryAfterEgressRecheck(ok({ egressChanged: false })), false);
  });

  it('does NOT retry a request that was already going direct', () => {
    // No pin to blame, nothing for a re-decision to move: the failure is real.
    assert.equal(shouldRetryAfterEgressRecheck(ok({ hadPin: false })), false);
  });

  it('does NOT retry an HTTP-level failure', () => {
    // A 500 from the provider proves the egress path WORKED.
    assert.equal(shouldRetryAfterEgressRecheck(ok({ failureIsNetwork: false })), false);
  });

  it('does NOT retry once the caller has given up', () => {
    assert.equal(shouldRetryAfterEgressRecheck(ok({ aborted: true })), false);
  });

  it('does NOT retry a body it cannot replay', () => {
    // Silently truncating a streamed body is worse than the failure it fixes.
    assert.equal(shouldRetryAfterEgressRecheck(ok({ replayableBody: false })), false);
  });
});

describe('bodyIsReplayable', () => {
  it('accepts the shapes this proxy actually sends', () => {
    assert.equal(bodyIsReplayable(undefined), true);
    assert.equal(bodyIsReplayable(null), true);
    assert.equal(bodyIsReplayable(JSON.stringify({ a: 1 })), true, 'every provider client sends a JSON string');
    assert.equal(bodyIsReplayable(Buffer.from('x')), true, '/v1/messages passthrough forwards a Buffer');
    assert.equal(bodyIsReplayable(new Uint8Array([1, 2])), true);
    assert.equal(bodyIsReplayable(new ArrayBuffer(4)), true);
  });

  it('refuses a stream rather than truncating it', () => {
    assert.equal(bodyIsReplayable(new ReadableStream()), false);
    assert.equal(bodyIsReplayable({ pipe() {} }), false);
  });
});

describe('decideEgressProxy — a dead pin hands over, it does not drop to direct', () => {
  // On corporate, direct egress is the ONE state where every off-prem provider
  // fails. Dropping there while another proxy is provably answering spent a full
  // recheck interval in guaranteed failure, on top of the coordinator's
  // (deliberate) demotion hysteresis. All 16 "stopped answering" events in this
  // proxy's log name the static corp-proxy:8080; none name adaptive :3128.

  it('moves to the reachable candidate rather than to direct', () => {
    const d = decideEgressProxy({
      verdict: 'corporate', pinned: MUC, candidates: [MUC, PX],
      pinnedReachable: false, reachableCandidate: PX,
    });
    assert.equal(d.proxy, PX);
    assert.equal(d.changed, true);
    assert.match(d.reason, /stopped answering, handing over to/);
  });

  it('still drops to direct when NOTHING answers', () => {
    // Direct is the honest answer when there is no working proxy — and
    // egressIsDegraded then says so out loud.
    const d = decideEgressProxy({
      verdict: 'corporate', pinned: MUC, candidates: [MUC, PX],
      pinnedReachable: false, reachableCandidate: null,
    });
    assert.equal(d.proxy, null);
    assert.equal(d.changed, true);
    assert.equal(egressIsDegraded('corporate', d.proxy), true);
  });

  it('a healthy pin is left alone even when another candidate would answer', () => {
    // No promotion heuristic: reachability is not a reason to move a working pin.
    const d = decideEgressProxy({
      verdict: 'corporate', pinned: MUC, candidates: [MUC, PX],
      pinnedReachable: true, reachableCandidate: PX,
    });
    assert.equal(d.proxy, MUC);
    assert.equal(d.changed, false);
  });

  it('public still un-pins to direct regardless of what is reachable', () => {
    // Off corporate a corporate proxy is not merely unnecessary, it is wrong.
    const d = decideEgressProxy({
      verdict: 'public', pinned: MUC, candidates: [MUC, PX],
      pinnedReachable: false, reachableCandidate: PX,
    });
    assert.equal(d.proxy, null);
  });
});

describe('subprocessProxyEnv — the claude CLI follows the egress pin, not the startup env', () => {
  const started = { PATH: '/bin', HTTPS_PROXY: MUC, https_proxy: MUC, HTTP_PROXY: MUC };

  it('before the first decision, keeps the startup env as it is', () => {
    assert.deepEqual(subprocessProxyEnv(started, { proxy: null, evaluated: false }), started);
  });

  it('pinned to a proxy: every proxy variable names it, whatever startup said', () => {
    const env = subprocessProxyEnv({ PATH: '/bin' }, { proxy: PX, evaluated: true });
    assert.equal(env.HTTPS_PROXY, PX);
    assert.equal(env.https_proxy, PX);
    assert.equal(env.HTTP_PROXY, PX);
    assert.equal(env.http_proxy, PX);
  });

  it('direct: a proxy inherited from startup is removed (started on VPN, now at home)', () => {
    const env = subprocessProxyEnv(started, { proxy: null, evaluated: true });
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) assert.equal(k in env, false, k);
    assert.equal(env.PATH, '/bin');
  });

  it('a moved pin replaces the stale one', () => {
    assert.equal(subprocessProxyEnv(started, { proxy: PX, evaluated: true }).HTTPS_PROXY, PX);
  });

  it('never mutates the env it was given', () => {
    const base = { ...started };
    subprocessProxyEnv(base, { proxy: null, evaluated: true });
    assert.deepEqual(base, started);
  });
});
