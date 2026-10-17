/**
 * Unit suite for the semantic offload policy (semantic_routing in
 * llm-routing.yaml, resolved by proxy-bridge/routing-config.mjs).
 *
 * The policy silently changes which account answers a large share of calls, so
 * the properties worth pinning are the ones that decide spend:
 *
 *   - OFF is exactly equivalent to the block not existing (the claim
 *     llm-routing.yaml makes about it, previously untested)
 *   - the target is NETWORK-SCOPED, because "the local model" is not one machine
 *   - when no target serves the live network, the call does NOT move, and the
 *     reason says so rather than the offload being a silent non-event
 *   - a config that can only mislead is refused at boot, not half-honoured
 *
 * The last two are what 2026-08-28 turned up: off-VPN there was no local target
 * at all, and every `small` call went back to a paid account with nothing
 * anywhere saying why.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRoutingConfig,
  resolveRoute,
  buildChain,
  pickOffloadTarget,
  estimateInputTokens,
  FROM_CALLER,
} from '../../proxy-bridge/routing-config.mjs';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function routingDoc(semantic) {
  return {
    version: 1,
    providers: {
      'gh-copilot': {
        account: 'copilot-subscription',
        impl: 'copilot',
        capabilities: { tools: true, streaming: true },
        models: { small: 'claude-haiku-4.5', medium: 'claude-sonnet-4.6', high: 'claude-sonnet-5' },
      },
      'claude-code-max': {
        account: 'anthropic-subscription',
        impl: 'claude-code',
        fg_transport: 'anthropic-passthrough',
        capabilities: { tools: false, streaming: true },
        models: { small: 'claude-haiku-4.5', medium: 'claude-sonnet-5', high: 'claude-opus-5' },
      },
      'qwen-local': {
        account: 'on-prem',
        impl: 'qwen-local',
        capabilities: { tools: true, streaming: true },
        models: { small: 'qwen3.8-27b-dual-fast', medium: 'qwen3.8-27b-dual-normal', high: 'qwen3.8-27b-dual-deep' },
      },
      'qwen-laptop': {
        account: 'on-device',
        impl: 'qwen-laptop',
        capabilities: { tools: true, streaming: true },
        models: { small: 'qwen3.8-27b-local' },
      },
    },
    routes: {
      'fg-chat/claude': { provider: 'claude-code-max', complexity: 'high' },
      'fg-chat/pi': { provider: 'gh-copilot', complexity: FROM_CALLER },
      'bg-observation-writer': { provider: 'gh-copilot', complexity: 'small' },
      'bg-kgbench-judge': { provider: 'gh-copilot', complexity: 'small', offload: false },
    },
    defaults: {
      'fg-chat': { provider: 'gh-copilot', complexity: 'high' },
      background: { provider: 'claude-code-max', complexity: 'medium' },
    },
    ...(semantic ? { semantic_routing: semantic } : {}),
  };
}

const fallbackDoc = () => ({
  version: 1,
  chains: { 'gh-copilot': [{ provider: 'claude-code-max' }] },
  retry_on: ['network_error'],
  same_provider_retries: 1,
  enforce_capabilities: true,
});

/** Both networks declared — the shipping shape. */
const BOTH_NETWORKS = {
  enabled: true,
  offload_bands: ['small'],
  targets: [
    { provider: 'qwen-local', require_network: 'corporate', enabled: true },
    { provider: 'qwen-laptop', require_network: 'public', enabled: true },
  ],
};

const cfg = (semantic) => parseRoutingConfig(routingDoc(semantic), fallbackDoc());

function assertRejects(semantic, needle) {
  assert.throws(
    () => parseRoutingConfig(routingDoc(semantic), fallbackDoc()),
    (err) => {
      assert.equal(err.name, 'RoutingConfigError', `expected RoutingConfigError, got ${err.name}`);
      assert.ok(
        err.message.includes(needle),
        `message should name "${needle}" so the operator can find the key; got: ${err.message}`,
      );
      return true;
    },
  );
}

// ── Off is off ───────────────────────────────────────────────────────────────

describe('semantic_routing — disabled is indistinguishable from absent', () => {
  it('routes identically with the block off and with no block at all', () => {
    const off = cfg({ enabled: false, offload_bands: ['small'], targets: [{ provider: 'qwen-local', enabled: true }] });
    const absent = cfg(undefined);
    for (const job of ['bg-observation-writer', 'fg-chat/pi']) {
      const [j, agent] = job.split('/');
      const req = { job: j, agent, complexity: 'small', network: 'corporate' };
      const a = resolveRoute(off, req);
      const b = resolveRoute(absent, req);
      assert.deepEqual(
        { provider: a.provider, model: a.model, complexity: a.complexity },
        { provider: b.provider, model: b.model, complexity: b.complexity },
        `${job} must route the same way when the policy is off`,
      );
      assert.equal(a.offloadedFrom, undefined);
    }
  });

  it('lets a disabled block name a provider that is itself disabled', () => {
    // The normal state while an endpoint is being brought up. Refusing it would
    // force the operator to delete the block rather than switch it off.
    const doc = routingDoc({ enabled: false, offload_bands: ['small'], targets: [{ provider: 'qwen-local', enabled: true }] });
    doc.providers['qwen-local'].enabled = false;
    doc.providers['qwen-local'].impl = null;
    assert.doesNotThrow(() => parseRoutingConfig(doc, fallbackDoc()));
  });
});

// ── A target serves only once it is switched on ──────────────────────────────

describe('semantic_routing.targets[].enabled — opt-in, defaulting to off', () => {
  it('does NOT offload to a target that omits `enabled`', () => {
    // The regression that cost 2026-08-29. Adding a target used to be enough to
    // start serving traffic from it: qwen-laptop was declared on 2026-08-28 and
    // immediately took every `small` background call on the public network, at
    // ~9x the latency of the account it displaced. Declaring where an offload
    // COULD go and deciding work should go there are now two statements.
    const c = cfg({
      enabled: true, offload_bands: ['small'],
      targets: [{ provider: 'qwen-laptop', require_network: 'public' }],
    });
    assert.equal(c.semanticRouting.targets[0].enabled, false, 'the default must be off');
    assert.equal(pickOffloadTarget(c.semanticRouting, 'public'), null);
    const r = resolveRoute(c, { job: 'bg-observation-writer', network: 'public' });
    assert.equal(r.provider, 'gh-copilot', 'the call must stay on the route’s own provider');
    assert.equal(r.offloadedFrom, undefined);
  });

  it('offloads once the target says enabled: true', () => {
    const c = cfg({
      enabled: true, offload_bands: ['small'],
      targets: [{ provider: 'qwen-laptop', require_network: 'public', enabled: true }],
    });
    const r = resolveRoute(c, { job: 'bg-observation-writer', network: 'public' });
    assert.equal(r.provider, 'qwen-laptop');
    assert.equal(r.offloadedFrom, 'gh-copilot');
  });

  it('skips an off target and falls through to the next one that matches', () => {
    // An unguarded target BEHIND a switched-off one is reachable, which is the
    // whole reason an off target is skipped rather than deleted at parse time.
    const c = cfg({
      enabled: true, offload_bands: ['small'],
      targets: [
        { provider: 'qwen-laptop', require_network: 'public' },
        { provider: 'qwen-local', enabled: true },
      ],
    });
    assert.equal(pickOffloadTarget(c.semanticRouting, 'public').provider, 'qwen-local');
  });

  it('keeps an off target in the parsed config, so the dashboard can switch it back on', () => {
    // Dropping it at parse time would make "off" and "not declared" the same
    // thing again — the exact conflation the targets list was introduced to end.
    const c = cfg({
      enabled: true, offload_bands: ['small'],
      targets: [
        { provider: 'qwen-local', require_network: 'corporate', enabled: true },
        { provider: 'qwen-laptop', require_network: 'public', enabled: false },
      ],
    });
    assert.deepEqual(
      c.semanticRouting.targets.map(t => [t.provider, t.enabled]),
      [['qwen-local', true], ['qwen-laptop', false]],
    );
  });

  it('names an off target as off in the skip reason', () => {
    // "No target for this network" and "the target for this network is switched
    // off" are different operator errors; the reason string is where either one
    // surfaces.
    const c = cfg({
      enabled: true, offload_bands: ['small'],
      targets: [{ provider: 'qwen-laptop', require_network: 'public' }],
    });
    const r = resolveRoute(c, { job: 'bg-observation-writer', network: 'public' });
    assert.match(r.offloadSkipped, /qwen-laptop\[public\/fg\+bg\] \(off\)/);
  });

  it('refuses a non-boolean `enabled` rather than guessing', () => {
    // 'false' and 0 are the spellings that would otherwise read as ON.
    for (const bad of ['true', 'false', 0, 1]) {
      assertRejects({
        enabled: true, offload_bands: ['small'],
        targets: [{ provider: 'qwen-local', enabled: bad }],
      }, 'must be true or false');
    }
  });

  it('lets an off target name a provider that is itself disabled', () => {
    // Same reasoning as a switched-off block naming one: the normal state while
    // an endpoint is being brought up, and refusing it would force the operator
    // to delete the declaration the dashboard toggles.
    const doc = routingDoc({
      enabled: true, offload_bands: ['small'],
      targets: [
        { provider: 'qwen-local', require_network: 'corporate', enabled: true },
        { provider: 'qwen-laptop', require_network: 'public' },
      ],
    });
    doc.providers['qwen-laptop'].enabled = false;
    doc.providers['qwen-laptop'].impl = null;
    assert.doesNotThrow(() => parseRoutingConfig(doc, fallbackDoc()));
  });

  it('does not band-check an off target — its model table is irrelevant until it is on', () => {
    // qwen-laptop declares `small` only. With it OFF, a `medium` band is not a
    // mislabelled offload, it is a band the laptop will not be asked to serve.
    assert.doesNotThrow(() => cfg({
      enabled: true, offload_bands: ['small', 'medium'],
      targets: [
        { provider: 'qwen-local', require_network: 'corporate', enabled: true },
        { provider: 'qwen-laptop', require_network: 'public' },
      ],
    }));
  });
});

// ── The target is a function of the network ──────────────────────────────────

describe('pickOffloadTarget — first match wins, per network', () => {
  const sr = cfg(BOTH_NETWORKS).semanticRouting;

  it('picks the corporate target on corporate', () => {
    assert.equal(pickOffloadTarget(sr, 'corporate').provider, 'qwen-local');
  });

  it('picks the public target off it', () => {
    assert.equal(pickOffloadTarget(sr, 'public').provider, 'qwen-laptop');
  });

  it('treats every non-corporate spelling as public, like the guards do', () => {
    for (const n of ['public', 'home', 'open', undefined]) {
      assert.equal(pickOffloadTarget(sr, n).provider, 'qwen-laptop');
    }
  });

  it('an unguarded target matches every network', () => {
    const any = cfg({ enabled: true, offload_bands: ['small'], targets: [{ provider: 'qwen-local', enabled: true }] }).semanticRouting;
    assert.equal(pickOffloadTarget(any, 'corporate').provider, 'qwen-local');
    assert.equal(pickOffloadTarget(any, 'public').provider, 'qwen-local');
  });

  it('returns null when nothing serves this network', () => {
    const corpOnly = cfg({
      enabled: true, offload_bands: ['small'],
      targets: [{ provider: 'qwen-local', require_network: 'corporate', enabled: true }],
    }).semanticRouting;
    assert.equal(pickOffloadTarget(corpOnly, 'public'), null);
  });
});

// ── What the resolver does with it ───────────────────────────────────────────

describe('resolveRoute — the offload moves the call, and says where from', () => {
  const c = cfg(BOTH_NETWORKS);

  it('moves a small background call to the cluster on corporate', () => {
    const r = resolveRoute(c, { job: 'bg-observation-writer', network: 'corporate' });
    assert.equal(r.provider, 'qwen-local');
    assert.equal(r.model, 'qwen3.8-27b-dual-fast');
    assert.equal(r.offloadedFrom, 'gh-copilot');
  });

  it('moves the SAME call to the laptop off corporate — this is the 2026-08-28 fix', () => {
    const r = resolveRoute(c, { job: 'bg-observation-writer', network: 'public' });
    assert.equal(r.provider, 'qwen-laptop');
    assert.equal(r.model, 'qwen3.8-27b-local');
    assert.equal(r.offloadedFrom, 'gh-copilot');
  });

  it('moves a from-caller foreground turn once the caller declares a small band', () => {
    // The pi case end-to-end: the band arrives from reasoning_effort, and THAT is
    // what makes the turn eligible. Without it the route falls to defaults.fg-chat.
    const declared = resolveRoute(c, { job: 'fg-chat', agent: 'pi', complexity: 'small', network: 'public' });
    assert.equal(declared.provider, 'qwen-laptop');
    assert.equal(declared.offloadedFrom, 'gh-copilot');

    const silent = resolveRoute(c, { job: 'fg-chat', agent: 'pi', network: 'public' });
    assert.equal(silent.provider, 'gh-copilot');
    assert.equal(silent.complexity, 'high');
    assert.match(silent.offloadSkipped, /band "high" is not in offload_bands/);
  });

  it('inserts the route’s own provider as the first fallback', () => {
    // A cluster that is down, restarting, or still loading a model must degrade
    // straight back to the routing that was in force before the offload.
    const r = resolveRoute(c, { job: 'bg-observation-writer', network: 'public' });
    const { chain } = buildChain(c, r, { network: 'public' });
    assert.equal(chain[0].provider, 'qwen-laptop');
    assert.equal(chain[1].provider, 'gh-copilot');
    // And the hop back carries the model ITS provider serves, not the local id.
    assert.equal(chain[1].model, 'claude-haiku-4.5');
  });
});

describe('resolveRoute — why a call did NOT move', () => {
  const c = cfg(BOTH_NETWORKS);

  it('names the missing target when no local endpoint serves this network', () => {
    // The silent non-event that hid the whole problem: "there is no local
    // provider here" used to be indistinguishable from "the policy is off".
    const corpOnly = cfg({
      enabled: true, offload_bands: ['small'],
      targets: [{ provider: 'qwen-local', require_network: 'corporate', enabled: true }],
    });
    const r = resolveRoute(corpOnly, { job: 'bg-observation-writer', network: 'public' });
    assert.equal(r.provider, 'gh-copilot');
    assert.equal(r.offloadedFrom, undefined);
    assert.match(r.offloadSkipped, /no offload target for network=public/);
    assert.match(r.offloadSkipped, /qwen-local\[corporate\/fg\+bg\]/);
  });

  it('honours offload: false, where the model that answers IS the measurement', () => {
    const r = resolveRoute(c, { job: 'bg-kgbench-judge', network: 'corporate' });
    assert.equal(r.provider, 'gh-copilot');
    assert.match(r.offloadSkipped, /sets offload: false/);
  });

  it('never moves a call off a foreground transport the target cannot serve', () => {
    // fg-chat/claude arrives on the Anthropic wire at /v1/messages, a verbatim
    // passthrough. Offloading it would not make a turn cheaper, it would 501.
    const withHigh = cfg({
      enabled: true, offload_bands: ['high'],
      targets: [{ provider: 'qwen-local', require_network: 'corporate', enabled: true }],
    });
    const r = resolveRoute(withHigh, { job: 'fg-chat', agent: 'claude', network: 'corporate' });
    assert.equal(r.provider, 'claude-code-max');
    assert.match(r.offloadSkipped, /foreground transport/);
  });
});

// ── Configs that can only mislead ────────────────────────────────────────────

describe('parseRoutingConfig — refuses a policy that would mislead', () => {
  it('rejects the retired single-target spelling by name', () => {
    // Half-honouring it would leave the operator believing something about
    // routing that is no longer true.
    assertRejects(
      { enabled: true, offload_bands: ['small'], local_provider: 'qwen-local' },
      'local_provider',
    );
    assertRejects(
      { enabled: true, offload_bands: ['small'], targets: [{ provider: 'qwen-local', enabled: true }], require_network: 'corporate' },
      'require_network',
    );
  });

  it('rejects two targets claiming the same network — the second is unreachable', () => {
    assertRejects({
      enabled: true, offload_bands: ['small'],
      targets: [
        { provider: 'qwen-local', require_network: 'corporate', enabled: true },
        { provider: 'qwen-laptop', require_network: 'corporate', enabled: true },
      ],
    }, 'already declared above');
  });

  it('rejects a target shadowed by an earlier unguarded one', () => {
    assertRejects({
      enabled: true, offload_bands: ['small'],
      targets: [{ provider: 'qwen-local', enabled: true }, { provider: 'qwen-laptop', require_network: 'public', enabled: true }],
    }, 'can never be reached');
  });

  it('rejects a band no target can serve', () => {
    // qwen-laptop declares `small` only. A `medium` band would silently resolve
    // to some other band's model on every offloaded call.
    assertRejects({
      enabled: true, offload_bands: ['small', 'medium'],
      targets: [{ provider: 'qwen-laptop', require_network: 'public', enabled: true }],
    }, 'declares no model for band "medium"');
  });

  it('rejects enabled-with-no-bands', () => {
    assertRejects({ enabled: true, offload_bands: [], targets: [{ provider: 'qwen-local', enabled: true }] }, 'offload_bands` is empty');
  });

  it('WARNS rather than refusing when nothing can serve — a UI click must not brick boot', () => {
    // This used to be fatal. It cannot be: switching the last target off is one
    // click in the dashboard, and the proxy has to come back up afterwards.
    // Turning "stop sending work to the laptop" into "the proxy no longer
    // starts" is a worse failure than the one the check was guarding against.
    for (const [semantic, needle] of [
      [{ enabled: true, offload_bands: ['small'], targets: [] }, 'no targets are declared'],
      [{ enabled: true, offload_bands: ['small'], targets: [{ provider: 'qwen-local' }] }, 'every target is switched off'],
    ]) {
      const c = cfg(semantic);
      assert.ok(
        c.warnings.some(w => w.includes(needle)),
        `expected a warning naming "${needle}"; got: ${JSON.stringify(c.warnings)}`,
      );
      // and everything still routes, by the pre-offload rules
      const r = resolveRoute(c, { job: 'bg-observation-writer', network: 'corporate' });
      assert.equal(r.provider, 'gh-copilot');
      assert.equal(r.offloadedFrom, undefined);
    }
  });

  it('rejects an unknown provider and an unknown network value', () => {
    assertRejects({ enabled: true, offload_bands: ['small'], targets: [{ provider: 'qwen-desktop', enabled: true }] }, 'qwen-desktop');
    assertRejects({
      enabled: true, offload_bands: ['small'],
      targets: [{ provider: 'qwen-local', require_network: 'wifi' }],
    }, 'wifi');
  });
});

// ── The real file ────────────────────────────────────────────────────────────

describe('the shipped config/llm-routing.yaml', () => {
  it('every ENABLED target can serve every offload band', async () => {
    // The check that survives opt-in. It cannot assert a target per network any
    // more — shipping the laptop switched off is the point — but a target that
    // IS on and cannot serve a declared band would resolve to some other band's
    // model on every offloaded call.
    const { loadRoutingConfig } = await import('../../proxy-bridge/routing-config.mjs');
    const live = loadRoutingConfig();
    if (!live.semanticRouting.enabled) return; // operator turned it off; nothing to assert
    for (const target of live.semanticRouting.targets.filter(t => t.enabled)) {
      for (const band of live.semanticRouting.offloadBands) {
        assert.ok(
          live.providers[target.provider].models[band],
          `enabled target ${target.provider} declares no model for offload band "${band}"`,
        );
      }
    }
  });

  it('ships the laptop target switched OFF', async () => {
    // Not style. qwen-laptop probes green on loopback in milliseconds and then
    // generates at a fraction of the speed of the account it displaces —
    // measured 2026-08-29 over the 66 calls it served: mean 47s vs gh-copilot's
    // 5.4s, worst case 932s for a 59-token call, and 92s wasted before fallback
    // on the 48 that timed out. offload_bands is global, so being on routed the
    // highest-volume background services onto it. Anyone re-enabling it in the
    // committed file should have to delete this test and say why.
    const { loadRoutingConfig } = await import('../../proxy-bridge/routing-config.mjs');
    const live = loadRoutingConfig();
    const laptop = live.semanticRouting.targets.find(t => t.provider === 'qwen-laptop');
    if (!laptop) return; // target removed entirely; nothing to assert
    assert.equal(laptop.enabled, false, 'qwen-laptop must ship disabled — it is a last resort, enabled per session');
    assert.equal(pickOffloadTarget(live.semanticRouting, 'public'), null,
      'with the laptop off, nothing should offload on the public network');
  });
});

// ── scope: which KIND of work a target may serve ─────────────────────────────
//
// `offload_bands` says how hard a call may be to qualify; `scope` says who may
// be waiting on it. The band alone could not express "cheap, but only when
// someone is watching", and that gap is what made the laptop target all-or-
// nothing: enabled for the sake of interactive turns, it took the two
// highest-volume BACKGROUND services on the machine with it.

describe('semantic_routing.targets[].scope — fg / bg, defaulting to both', () => {
  const fgOnly = {
    enabled: true,
    offload_bands: ['small'],
    targets: [{ provider: 'qwen-laptop', require_network: 'public', enabled: true, scope: ['fg'] }],
  };

  it('defaults to both when omitted, so adding the field changes nothing on its own', () => {
    const c = cfg(BOTH_NETWORKS);
    assert.deepEqual(c.semanticRouting.targets[0].scope, ['fg', 'bg']);
    assert.equal(
      resolveRoute(c, { job: 'bg-observation-writer', network: 'corporate' }).offloadedFrom,
      'gh-copilot',
    );
    assert.equal(
      resolveRoute(c, { job: 'fg-chat', agent: 'pi', complexity: 'small', network: 'corporate' }).offloadedFrom,
      'gh-copilot',
    );
  });

  it('an fg-only target takes a foreground turn', () => {
    const r = resolveRoute(cfg(fgOnly), {
      job: 'fg-chat', agent: 'pi', complexity: 'small', network: 'public',
    });
    assert.equal(r.provider, 'qwen-laptop');
    assert.equal(r.offloadedFrom, 'gh-copilot');
  });

  it('an fg-only target does NOT take background work — the 2026-08-29 damage', () => {
    const r = resolveRoute(cfg(fgOnly), { job: 'bg-observation-writer', network: 'public' });
    assert.equal(r.provider, 'gh-copilot');
    assert.equal(r.offloadedFrom, undefined);
  });

  it('says scope was the reason, not "no target for this network"', () => {
    const r = resolveRoute(cfg(fgOnly), { job: 'bg-observation-writer', network: 'public' });
    // The two produce opposite fixes — declare a target vs widen an existing
    // one — and used to print the same sentence.
    assert.match(r.offloadSkipped, /serves scope \[fg\]/);
    assert.match(r.offloadSkipped, /this is bg work/);
    assert.doesNotMatch(r.offloadSkipped, /no offload target/);
  });

  it('a bg-only target is the mirror image', () => {
    const bgOnly = {
      enabled: true,
      offload_bands: ['small'],
      targets: [{ provider: 'qwen-laptop', require_network: 'public', enabled: true, scope: ['bg'] }],
    };
    assert.equal(resolveRoute(cfg(bgOnly), { job: 'bg-observation-writer', network: 'public' }).provider, 'qwen-laptop');
    assert.equal(
      resolveRoute(cfg(bgOnly), { job: 'fg-chat', agent: 'pi', complexity: 'small', network: 'public' }).provider,
      'gh-copilot',
    );
  });

  it('accepts a bare string as a one-element scope', () => {
    const c = cfg({
      enabled: true,
      offload_bands: ['small'],
      targets: [{ provider: 'qwen-laptop', require_network: 'public', enabled: true, scope: 'fg' }],
    });
    assert.deepEqual(c.semanticRouting.targets[0].scope, ['fg']);
  });

  it('shows the scope in the target list, so a skip reason is self-explaining', () => {
    const r = resolveRoute(cfg({
      enabled: true,
      offload_bands: ['small'],
      targets: [{ provider: 'qwen-local', require_network: 'corporate', enabled: true, scope: ['bg'] }],
    }), { job: 'bg-observation-writer', network: 'public' });
    assert.match(r.offloadSkipped, /qwen-local\[corporate\/bg\]/);
  });

  it('refuses an unknown scope rather than dropping it', () => {
    assertRejects({
      enabled: true,
      offload_bands: ['small'],
      targets: [{ provider: 'qwen-local', enabled: true, scope: ['foreground'] }],
    }, 'scope');
  });

  it('refuses an empty scope — that is what `enabled: false` is for', () => {
    assertRejects({
      enabled: true,
      offload_bands: ['small'],
      targets: [{ provider: 'qwen-local', enabled: true, scope: [] }],
    }, 'scope');
  });
});

// ── Per-target offload_bands ─────────────────────────────────────────────────
//
// Added 2026-09-02 alongside making `medium` offloadable. Until then
// `offload_bands` was global and was the ONLY statement about band eligibility,
// which made two different facts inexpressible at once: the cluster can serve
// medium work, and the laptop cannot. Widening the global list was therefore not
// "let the cluster take medium" but "refuse to boot", because the laptop target
// declares no medium model.
//
// The property that keeps this honest is the subset rule. A target may narrow
// what the policy permits and may never widen it — otherwise one endpoint could
// opt itself into work the operator excluded everywhere, from a per-target line
// nobody reads as policy.
describe('semantic_routing.targets[].offload_bands — a target may narrow, never widen', () => {
  const BANDS_BOTH = {
    enabled: true,
    offload_bands: ['small', 'medium'],
    targets: [
      { provider: 'qwen-local', require_network: 'corporate', enabled: true },
      { provider: 'qwen-laptop', require_network: 'public', enabled: true, offload_bands: ['small'] },
    ],
  };

  it('an absent list means every band in the global list', () => {
    const c = cfg(BANDS_BOTH);
    assert.equal(c.semanticRouting.targets[0].offloadBands, null);
    for (const band of ['small', 'medium']) {
      const r = resolveRoute(c, { job: 'fg-chat/pi', complexity: band, network: 'corporate' });
      assert.equal(r.provider, 'qwen-local', `${band} should reach the cluster`);
      assert.equal(r.offloadedFrom, 'gh-copilot');
    }
  });

  it('the band table is per band, so medium lands on the medium model', () => {
    // The point of offloading medium at all: it must not resolve to the small
    // model, which is what a target with one model would have done silently.
    const c = cfg(BANDS_BOTH);
    assert.equal(
      resolveRoute(c, { job: 'fg-chat/pi', complexity: 'medium', network: 'corporate' }).model,
      'qwen3.8-27b-dual-normal',
    );
    assert.equal(
      resolveRoute(c, { job: 'fg-chat/pi', complexity: 'small', network: 'corporate' }).model,
      'qwen3.8-27b-dual-fast',
    );
  });

  it('a narrowed target takes its bands and refuses the rest, by its own name', () => {
    const c = cfg(BANDS_BOTH);
    const small = resolveRoute(c, { job: 'fg-chat/pi', complexity: 'small', network: 'public' });
    assert.equal(small.provider, 'qwen-laptop');

    const medium = resolveRoute(c, { job: 'fg-chat/pi', complexity: 'medium', network: 'public' });
    assert.equal(medium.provider, 'gh-copilot', 'must not move');
    // Distinct from the global "not in offload_bands" reason: that one wants the
    // policy widened, this one wants THIS endpoint widened or another declared.
    assert.match(medium.offloadSkipped, /target "qwen-laptop" takes bands \[small\] and this is medium work/);
    assert.doesNotMatch(medium.offloadSkipped, /is not in offload_bands/);
  });

  it('the global list is still checked first, and still says so', () => {
    const r = resolveRoute(cfg(BANDS_BOTH), { job: 'fg-chat/pi', complexity: 'high', network: 'corporate' });
    assert.equal(r.provider, 'gh-copilot');
    assert.match(r.offloadSkipped, /band "high" is not in offload_bands \[small, medium\]/);
  });

  it('refuses a target that widens beyond the global list', () => {
    assertRejects({
      enabled: true,
      offload_bands: ['small'],
      targets: [{ provider: 'qwen-local', enabled: true, offload_bands: ['small', 'medium'] }],
    }, 'offload_bands');
  });

  it('refuses a target band the target has no model for', () => {
    assertRejects({
      enabled: true,
      offload_bands: ['small', 'medium'],
      targets: [{ provider: 'qwen-laptop', enabled: true, offload_bands: ['small', 'medium'] }],
    }, 'offload_bands');
  });

  it('refuses the pre-fix shape: a global medium with a target that cannot serve it', () => {
    // The exact configuration that would have been written without this field,
    // and the reason it could not be. Kept as a test so the constraint is not
    // rediscovered by someone deleting the per-target line.
    assertRejects({
      enabled: true,
      offload_bands: ['small', 'medium'],
      targets: [
        { provider: 'qwen-local', require_network: 'corporate', enabled: true },
        { provider: 'qwen-laptop', require_network: 'public', enabled: true },
      ],
    }, 'offload_bands');
  });

  it('refuses an unknown band, and an empty list', () => {
    assertRejects({
      enabled: true,
      offload_bands: ['small'],
      targets: [{ provider: 'qwen-local', enabled: true, offload_bands: ['tiny'] }],
    }, 'offload_bands');
    assertRejects({
      enabled: true,
      offload_bands: ['small'],
      targets: [{ provider: 'qwen-local', enabled: true, offload_bands: [] }],
    }, 'offload_bands');
  });

  it('a target that is OFF may still declare bands it has no model for', () => {
    // Same reasoning as the routable-provider checks: switching a target off
    // must never force deleting it, and a target nobody can reach cannot
    // mis-resolve a model.
    assert.doesNotThrow(() => cfg({
      enabled: true,
      offload_bands: ['small', 'medium'],
      targets: [
        { provider: 'qwen-local', require_network: 'corporate', enabled: true },
        { provider: 'qwen-laptop', require_network: 'public', enabled: false },
      ],
    }));
  });

  it('names the narrowing in the target list, so the skip reason is self-explaining', () => {
    const r = resolveRoute(cfg({
      enabled: true,
      offload_bands: ['small', 'medium'],
      targets: [{ provider: 'qwen-laptop', require_network: 'public', enabled: true, offload_bands: ['small'] }],
    }), { job: 'fg-chat/pi', complexity: 'medium', network: 'corporate' });
    assert.match(r.offloadSkipped, /qwen-laptop\[public\/fg\+bg\/small\]/);
  });
});

describe('per-band scope — "cheap for anyone, slow-but-free for nobody waiting"', () => {
  // The case the single per-target `scope` could not express. qwen-local serves
  // `medium` in ~28s against gh-copilot's ~3s: a bad trade for a foreground turn
  // and a good one for a background service, where the cluster is free and
  // nobody is waiting. With one scope per target the only answers were "make
  // every foreground turn 8x slower" or "leave the cluster at 1.6%
  // utilisation".
  // A background route on gh-copilot. The shared fixture's `defaults.background`
  // is claude-code-max, which declares fg_transport — so an undeclared bg job is
  // blocked by the TRANSPORT rung one step later, and would test the wrong gate.
  const docFor = (semantic) => {
    const d = routingDoc(semantic);
    d.routes['bg-consolidator-mentions'] = { provider: 'gh-copilot', complexity: 'medium' };
    return d;
  };
  const perBand = (over = {}) => ({
    enabled: true,
    offload_bands: ['small', 'medium'],
    targets: [{
      provider: 'qwen-local',
      require_network: 'corporate',
      enabled: true,
      scope: ['fg', 'bg'],
      offload_bands: { small: ['fg', 'bg'], medium: ['bg'] },
      ...over,
    }],
    ...(over.globalBands ? { offload_bands: over.globalBands } : {}),
  });

  it('a foreground medium turn is NOT offloaded', () => {
    const c = parseRoutingConfig(docFor(perBand()), fallbackDoc());
    const r = resolveRoute(c, { job: 'fg-chat/pi', complexity: 'medium', network: 'corporate' });
    assert.equal(r.provider, 'gh-copilot', 'a person is waiting — the 28s model is the wrong trade');
    assert.match(r.offloadSkipped, /serves medium work for scope \[bg\]/);
  });

  it('a BACKGROUND medium job IS offloaded to the cluster', () => {
    // The whole point: same band, same target, opposite answer.
    const c = parseRoutingConfig(docFor(perBand()), fallbackDoc());
    const r = resolveRoute(c, { job: 'bg-consolidator-mentions', complexity: 'medium', network: 'corporate' });
    assert.equal(r.provider, 'qwen-local');
    assert.equal(r.model, 'qwen3.8-27b-dual-normal', 'the band picks the model on the TARGET');
    assert.equal(r.offloadedFrom, 'gh-copilot');
  });

  it('small is still offloaded for BOTH scopes', () => {
    const c = parseRoutingConfig(docFor(perBand()), fallbackDoc());
    for (const job of ['fg-chat/pi', 'bg-observation-writer']) {
      const r = resolveRoute(c, { job, complexity: 'small', network: 'corporate' });
      assert.equal(r.provider, 'qwen-local', `${job} small should still offload`);
      assert.equal(r.model, 'qwen3.8-27b-dual-fast');
    }
  });

  it('the list form still means "every allowed band at the target scope"', () => {
    // Back-compat: the shipping shape before this change must not shift meaning.
    const c = parseRoutingConfig(routingDoc({
      enabled: true,
      offload_bands: ['small', 'medium'],
      targets: [{ provider: 'qwen-local', require_network: 'corporate', enabled: true, scope: ['bg'], offload_bands: ['small'] }],
    }), fallbackDoc());
    assert.equal(resolveRoute(c, { job: 'bg-observation-writer', complexity: 'small', network: 'corporate' }).provider, 'qwen-local');
    const fg = resolveRoute(c, { job: 'fg-chat/pi', complexity: 'small', network: 'corporate' });
    assert.equal(fg.provider, 'gh-copilot');
    assert.match(fg.offloadSkipped, /serves scope \[bg\]/, 'target-level scope, so the target-level sentence');
  });

  it('a band may NOT widen beyond the target scope', () => {
    // Same direction of travel as bands-vs-global: the box states what it can
    // serve, and a band must not opt it into work it excluded.
    assertRejects(
      { enabled: true, offload_bands: ['small'], targets: [{ provider: 'qwen-local', require_network: 'corporate', enabled: true, scope: ['bg'], offload_bands: { small: ['fg', 'bg'] } }] },
      'is not in this target\'s scope',
    );
  });

  it('a band outside the global list is still refused in map form', () => {
    assertRejects(
      { enabled: true, offload_bands: ['small'], targets: [{ provider: 'qwen-local', require_network: 'corporate', enabled: true, offload_bands: { medium: ['bg'] } }] },
      'never widen it',
    );
  });

  it('an unknown scope name is refused, not ignored', () => {
    assertRejects(
      { enabled: true, offload_bands: ['small'], targets: [{ provider: 'qwen-local', require_network: 'corporate', enabled: true, offload_bands: { small: ['foreground'] } }] },
      'unknown scope "foreground"',
    );
  });

  it('an empty scope list for a band is refused', () => {
    assertRejects(
      { enabled: true, offload_bands: ['small'], targets: [{ provider: 'qwen-local', require_network: 'corporate', enabled: true, offload_bands: { small: [] } }] },
      'can never be reached',
    );
  });

  it('a band with no model on the target is still caught at boot', () => {
    // qwen-laptop declares only a `small` model.
    assertRejects(
      { enabled: true, offload_bands: ['small', 'medium'], targets: [{ provider: 'qwen-laptop', require_network: 'public', enabled: true, offload_bands: { medium: ['bg'] } }] },
      'declares no model for band "medium"',
    );
  });
});

describe('semantic routing — foreground limits on a target', () => {
  const limited = (foreground) => ({
    enabled: true,
    offload_bands: ['small'],
    targets: [{ provider: 'qwen-local', require_network: 'corporate', enabled: true, foreground }],
  });
  const LIMITS = { max_input_tokens: 3000, timeout_ms: 15000, max_in_flight: 1 };
  const fgSmall = { job: 'fg-chat', agent: 'pi', complexity: 'small', network: 'corporate' };

  it('a small prompt on an idle target is offloaded, with the foreground ceiling', () => {
    const r = resolveRoute(cfg(limited(LIMITS)), { ...fgSmall, inputTokens: 500, inFlight: {} });
    assert.equal(r.provider, 'qwen-local');
    assert.equal(r.offloadedFrom, 'gh-copilot');
    assert.equal(r.offloadTimeoutMs, 15000);
  });

  it('a first turn with a full tool context stays on its own account', () => {
    const r = resolveRoute(cfg(limited(LIMITS)), { ...fgSmall, inputTokens: 20500, inFlight: {} });
    assert.equal(r.provider, 'gh-copilot');
    assert.equal(r.offloadTimeoutMs, undefined);
    assert.match(r.offloadSkipped, /foreground prompts up to 3000 tokens and this one is ~20500/);
  });

  it('a call already open on the target keeps a foreground turn off it', () => {
    const r = resolveRoute(cfg(limited(LIMITS)), { ...fgSmall, inputTokens: 500, inFlight: { 'qwen-local': 1 } });
    assert.equal(r.provider, 'gh-copilot');
    assert.match(r.offloadSkipped, /already has 1 call\(s\) in flight \(foreground limit 1\)/);
  });

  it('calls open on OTHER providers do not count', () => {
    const r = resolveRoute(cfg(limited(LIMITS)), { ...fgSmall, inputTokens: 500, inFlight: { 'gh-copilot': 4 } });
    assert.equal(r.provider, 'qwen-local');
  });

  it('background work ignores the limits', () => {
    const r = resolveRoute(cfg(limited(LIMITS)), {
      job: 'bg-observation-writer', network: 'corporate', inputTokens: 20500, inFlight: { 'qwen-local': 3 },
    });
    assert.equal(r.provider, 'qwen-local');
    assert.equal(r.offloadTimeoutMs, undefined);
  });

  it('an unknown size passes, so /resolve reproduces the config without a prompt', () => {
    const r = resolveRoute(cfg(limited(LIMITS)), fgSmall);
    assert.equal(r.provider, 'qwen-local');
  });

  it('no foreground block means no limits', () => {
    const r = resolveRoute(cfg(limited(undefined)), { ...fgSmall, inputTokens: 20500, inFlight: { 'qwen-local': 5 } });
    assert.equal(r.provider, 'qwen-local');
    assert.equal(r.offloadTimeoutMs, undefined);
  });

  it('refuses limits on a target that never takes foreground work', () => {
    assertRejects(
      { enabled: true, offload_bands: ['small'], targets: [{ provider: 'qwen-local', require_network: 'corporate', enabled: true, scope: ['bg'], foreground: LIMITS }] },
      'never takes foreground work',
    );
  });

  it('refuses an unknown key and a timeout in seconds', () => {
    assertRejects(limited({ max_tokens: 3000 }), 'unknown key');
    assertRejects(limited({ timeout_ms: 15 }), 'looks like seconds');
  });

  it('estimates ~4 bytes per token over messages and tools', () => {
    const body = { messages: [{ role: 'user', content: 'x'.repeat(4000) }], tools: [{ name: 't' }] };
    const n = estimateInputTokens(body);
    assert.ok(n > 1000 && n < 1100, `got ${n}`);
    assert.equal(estimateInputTokens({}), 1);
  });
});
