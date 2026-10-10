/**
 * Unit suite for the config-driven routing engine (proxy-bridge/routing-config.mjs).
 *
 * The engine replaced five routing mechanisms that lived as literals inside
 * server.mjs and could not be seen from any config file. The contract these
 * tests pin down is that NOTHING is decided outside the two YAML files:
 *
 *   - lookup precedence is exactly three steps, in order
 *   - the model always comes from (provider, complexity), never carried across
 *     a fallback (the old CLAUDE_FAMILY special case, which could hand a Claude
 *     model id to groq)
 *   - tool capability and network guards come from config, not from a hardcoded
 *     { copilot: true } map or a `corp ? [...] : [...]` ternary
 *   - a malformed config FAILS AT BOOT with a message naming the offending key,
 *     rather than being partially applied
 *
 * Run: node --test tests/unit/routing-config.test.mjs
 *
 * Everything here uses parseRoutingConfig() on in-memory objects — no fixtures
 * on disk, no filesystem, so the tests describe the decision surface rather
 * than the current contents of config/.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseRoutingConfig,
  loadRoutingConfig,
  withLocalProviders,
  localRoutingPath,
  resolveRoute,
  buildChain,
  explain,
  providerCatalogue,
  providerIdForImpl,
  jobClass,
  isSelfHosted,
  COMPLEXITY_BANDS,
  FROM_CALLER,
  classifyFailure,
  SAME_PROVIDER_RETRY_CLASSES,
  RETRY_CLASSES,
} from '../../proxy-bridge/routing-config.mjs';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A minimal but realistic routing doc; helpers below mutate clones of it. */
function routingDoc(overrides = {}) {
  return {
    version: 1,
    providers: {
      'claude-code-max': {
        account: 'anthropic-subscription',
        impl: 'claude-code',
        fg_transport: 'anthropic-passthrough',
        capabilities: { tools: false, streaming: true },
        models: { small: 'claude-haiku-4.5', medium: 'claude-sonnet-5', high: 'claude-opus-5' },
      },
      'gh-copilot': {
        account: 'copilot-subscription',
        impl: 'copilot',
        capabilities: { tools: true, streaming: true },
        available_models: ['claude-haiku-4.5', 'claude-sonnet-4.6', 'claude-sonnet-5', 'gpt-5.6-sol'],
        models: { small: 'claude-haiku-4.5', medium: 'claude-sonnet-4.6', high: 'claude-sonnet-5' },
      },
      groq: {
        account: 'groq-api',
        impl: 'groq',
        capabilities: { tools: false },
        models: { small: 'llama-3.1-8b-instant', medium: 'llama-3.3-70b-versatile', high: 'openai/gpt-oss-120b' },
      },
      'corp-gw': { account: 'corp-account', impl: null, enabled: false, models: {} },
    },
    routes: {
      'fg-chat/claude': { provider: 'claude-code-max', complexity: 'high' },
      'fg-chat/opencode': {
        provider: 'gh-copilot', complexity: FROM_CALLER,
        model_profiles: { 'gpt-5.6-sol': { high: 'gpt-5.6-sol' } },
      },
      'bg-observation-writer': { provider: 'gh-copilot', complexity: 'small' },
    },
    defaults: {
      'fg-chat': { provider: 'gh-copilot', complexity: 'high' },
      background: { provider: 'claude-code-max', complexity: 'medium' },
    },
    ...overrides,
  };
}

function fallbackDoc(overrides = {}) {
  return {
    version: 1,
    chains: {
      'gh-copilot': [
        { provider: 'claude-code-max', when: { network: ['public'] } },
        { provider: 'groq' },
      ],
      'claude-code-max': [{ provider: 'gh-copilot' }],
    },
    retry_on: ['quota_exhausted', 'network_error'],
    same_provider_retries: 1,
    enforce_capabilities: true,
    ...overrides,
  };
}

const cfg = () => parseRoutingConfig(routingDoc(), fallbackDoc());

/** Assert that building a config throws, and that the message names `needle`. */
function assertRejects(routing, fallback, needle) {
  assert.throws(
    () => parseRoutingConfig(routing, fallback),
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

// ── Lookup precedence ────────────────────────────────────────────────────────

describe('resolveRoute — three-step lookup', () => {
  it('step 1: <job>/<agent> wins when present', () => {
    const r = resolveRoute(cfg(), { job: 'fg-chat', agent: 'claude' });
    assert.equal(r.step, 1);
    assert.equal(r.matchedKey, 'fg-chat/claude');
    assert.equal(r.provider, 'claude-code-max');
  });

  it('step 2: bare <job> matches when no agent-specific route exists', () => {
    const r = resolveRoute(cfg(), { job: 'bg-observation-writer' });
    assert.equal(r.step, 2);
    assert.equal(r.matchedKey, 'bg-observation-writer');
    assert.equal(r.provider, 'gh-copilot');
  });

  it('step 2: an agent that has no <job>/<agent> route falls to the bare job, not the default', () => {
    const r = resolveRoute(cfg(), { job: 'bg-observation-writer', agent: 'someagent' });
    assert.equal(r.step, 2);
    assert.equal(r.matchedKey, 'bg-observation-writer');
  });

  it('step 3: an unknown job lands on the class default', () => {
    const r = resolveRoute(cfg(), { job: 'bg-brand-new-service' });
    assert.equal(r.step, 3);
    assert.equal(r.matchedKey, 'defaults.background');
    assert.equal(r.provider, 'claude-code-max');
  });

  it('step 3: class is derived from the fg- prefix, so an unknown fg job uses the fg default', () => {
    const r = resolveRoute(cfg(), { job: 'fg-chat', agent: 'brand-new-agent' });
    assert.equal(r.class, 'fg-chat');
    assert.equal(r.matchedKey, 'defaults.fg-chat');
    assert.equal(r.provider, 'gh-copilot');
  });

  it('jobClass keys off the fg- prefix only', () => {
    assert.equal(jobClass('fg-chat'), 'fg-chat');
    assert.equal(jobClass('fg-anything'), 'fg-chat');
    assert.equal(jobClass('bg-whatever'), 'background');
    assert.equal(jobClass(''), 'background');
    assert.equal(jobClass(undefined), 'background');
  });
});

// ── Complexity -> model ──────────────────────────────────────────────────────

describe('resolveRoute — complexity band selects the model', () => {
  it('a fixed band takes the model from the routed provider', () => {
    assert.equal(resolveRoute(cfg(), { job: 'bg-observation-writer' }).model, 'claude-haiku-4.5');
    assert.equal(resolveRoute(cfg(), { job: 'fg-chat', agent: 'claude' }).model, 'claude-opus-5');
  });

  it('from-caller: the caller supplies the band', () => {
    const r = resolveRoute(cfg(), { job: 'fg-chat', agent: 'opencode', complexity: 'small' });
    assert.equal(r.complexity, 'small');
    assert.equal(r.complexitySource, 'caller');
    assert.equal(r.model, 'claude-haiku-4.5');
  });

  it('from-caller with no caller band: falls to the class default, and says so', () => {
    const r = resolveRoute(cfg(), { job: 'fg-chat', agent: 'opencode' });
    assert.equal(r.complexity, 'high');
    assert.match(r.complexitySource, /defaults\.fg-chat/);
    assert.match(r.complexitySource, /supplied nothing/);
  });

  it('from-caller with a nonsense band: falls to the class default rather than guessing', () => {
    const r = resolveRoute(cfg(), { job: 'fg-chat', agent: 'opencode', complexity: 'enormous' });
    assert.equal(r.complexity, 'high');
    assert.match(r.complexitySource, /unknown "enormous"/);
  });

  it('the caller cannot influence a route that did not opt into from-caller', () => {
    // bg-observation-writer is pinned to `small`. A caller asking for `high`
    // must not be able to promote itself onto an expensive model.
    const r = resolveRoute(cfg(), { job: 'bg-observation-writer', complexity: 'high' });
    assert.equal(r.complexity, 'small');
    assert.equal(r.model, 'claude-haiku-4.5');
  });

  it('an allow-listed model profile applies only at its configured band', () => {
    const high = resolveRoute(cfg(), {
      job: 'fg-chat', agent: 'opencode', requestedModel: 'gpt-5.6-sol', complexity: 'high',
    });
    assert.equal(high.model, 'gpt-5.6-sol');
    assert.equal(high.modelProfile, 'gpt-5.6-sol');
    assert.equal(buildChain(cfg(), high).chain[0].model, 'gpt-5.6-sol');

    const small = resolveRoute(cfg(), {
      job: 'fg-chat', agent: 'opencode', requestedModel: 'gpt-5.6-sol', complexity: 'small',
    });
    assert.equal(small.model, 'claude-haiku-4.5');
    assert.equal(small.modelProfile, undefined);
  });

  it('an unlisted caller model cannot override the route model', () => {
    const route = resolveRoute(cfg(), {
      job: 'fg-chat', agent: 'opencode', requestedModel: 'arbitrary-expensive-model', complexity: 'high',
    });
    assert.equal(route.model, 'claude-sonnet-5');
  });
});

// ── Chain building ───────────────────────────────────────────────────────────

describe('buildChain — fallback order, guards, capabilities', () => {
  it('the routed provider is the head, followed by its configured chain', () => {
    const c = cfg();
    const route = resolveRoute(c, { job: 'bg-observation-writer' });
    const { chain } = buildChain(c, route, { network: 'public' });
    assert.deepEqual(chain.map(x => x.provider), ['gh-copilot', 'claude-code-max', 'groq']);
  });

  it('each hop gets ITS OWN provider\'s model for the band — never the head\'s', () => {
    // This is the CLAUDE_FAMILY regression: the old code carried the pinned
    // model across providers, so a fallback to groq was handed a Claude id.
    const c = cfg();
    const route = resolveRoute(c, { job: 'bg-observation-writer' }); // small
    const { chain } = buildChain(c, route, { network: 'public' });
    assert.deepEqual(chain.map(x => x.model), [
      'claude-haiku-4.5',      // gh-copilot small
      'claude-haiku-4.5',      // claude-code-max small
      'llama-3.1-8b-instant',  // groq small — NOT a Claude id
    ]);
  });

  it('a network guard skips a candidate without failing the chain', () => {
    const c = cfg();
    const route = resolveRoute(c, { job: 'bg-observation-writer' });
    const { chain, skipped } = buildChain(c, route, { network: 'corporate' });
    assert.deepEqual(chain.map(x => x.provider), ['gh-copilot', 'groq']);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].provider, 'claude-code-max');
    assert.match(skipped[0].reason, /guard network/);
  });

  it('network defaults to public when the sensor reports nothing', () => {
    const c = cfg();
    const route = resolveRoute(c, { job: 'bg-observation-writer' });
    assert.ok(buildChain(c, route, {}).chain.some(x => x.provider === 'claude-code-max'));
  });

  it('a tools-bearing request drops tool-incapable providers', () => {
    const c = cfg();
    const route = resolveRoute(c, { job: 'bg-observation-writer' });
    const { chain, skipped } = buildChain(c, route, { network: 'public', wantsTools: true });
    assert.deepEqual(chain.map(x => x.provider), ['gh-copilot']);
    assert.deepEqual(skipped.map(s => s.provider).sort(), ['claude-code-max', 'groq']);
    for (const s of skipped) assert.match(s.reason, /tools/);
  });

  it('a tools-less request keeps them', () => {
    const c = cfg();
    const route = resolveRoute(c, { job: 'bg-observation-writer' });
    assert.equal(buildChain(c, route, { network: 'public', wantsTools: false }).chain.length, 3);
  });

  it('enforce_capabilities: false lets a tools request land anywhere', () => {
    const c = parseRoutingConfig(routingDoc(), fallbackDoc({ enforce_capabilities: false }));
    const route = resolveRoute(c, { job: 'bg-observation-writer' });
    assert.equal(buildChain(c, route, { network: 'public', wantsTools: true }).chain.length, 3);
  });

  it('a provider with no chain resolves to itself alone', () => {
    const c = parseRoutingConfig(routingDoc(), fallbackDoc({ chains: {} }));
    const route = resolveRoute(c, { job: 'bg-observation-writer' });
    assert.deepEqual(buildChain(c, route, {}).chain.map(x => x.provider), ['gh-copilot']);
  });

  it('chains are flat, not recursive — the head\'s fallback does not pull in its own chain', () => {
    // gh-copilot -> [claude-code-max, groq]; claude-code-max -> [gh-copilot].
    // A recursive walk would loop or re-add gh-copilot. It must not.
    const c = cfg();
    const route = resolveRoute(c, { job: 'bg-observation-writer' });
    const ids = buildChain(c, route, { network: 'public' }).chain.map(x => x.provider);
    assert.equal(new Set(ids).size, ids.length, 'chain must not repeat a provider');
    assert.equal(ids.filter(x => x === 'gh-copilot').length, 1);
  });

  it('carries the runtime impl so server.mjs can dispatch without a second lookup', () => {
    const c = cfg();
    const route = resolveRoute(c, { job: 'bg-observation-writer' });
    assert.equal(buildChain(c, route, {}).chain[0].impl, 'copilot');
  });
});

// ── Explain ──────────────────────────────────────────────────────────────────

describe('explain — one answer for both the log line and the UI', () => {
  it('summarises the matched rule and the resolved chain', () => {
    const e = explain(cfg(), { job: 'bg-observation-writer', network: 'public' });
    assert.match(e.summary, /^bg-observation-writer \(step 2\) -> gh-copilot\/claude-haiku-4\.5/);
    assert.equal(e.request.network, 'public');
  });

  it('says so loudly when nothing is eligible', () => {
    // tools required, but the only reachable provider in this config is incapable.
    const c = parseRoutingConfig(
      routingDoc({ routes: { 'bg-x': { provider: 'groq', complexity: 'small' } } }),
      fallbackDoc({ chains: {} }),
    );
    const e = explain(c, { job: 'bg-x', wantsTools: true });
    assert.equal(e.chain.length, 0);
    assert.match(e.summary, /NO ELIGIBLE PROVIDER/);
  });
});

// ── Catalogue + impl mapping ─────────────────────────────────────────────────

describe('catalogue and impl mapping', () => {
  it('maps a runtime impl name back to the account-level provider id', () => {
    const c = cfg();
    assert.equal(providerIdForImpl(c, 'copilot'), 'gh-copilot');
    assert.equal(providerIdForImpl(c, 'claude-code'), 'claude-code-max');
  });

  it('an unmapped impl passes through rather than becoming undefined', () => {
    assert.equal(providerIdForImpl(cfg(), 'mystery'), 'mystery');
  });

  it('the catalogue exposes what the dashboard needs, disabled providers included', () => {
    const cat = providerCatalogue(cfg());
    const corpGw = cat.find(p => p.id === 'corp-gw');
    assert.equal(corpGw.enabled, false);
    const max = cat.find(p => p.id === 'claude-code-max');
    assert.equal(max.fgCapable, true);
    assert.equal(cat.find(p => p.id === 'gh-copilot').fgCapable, false);
  });
});

// ── Validation: a bad config must not boot ───────────────────────────────────

describe('parseRoutingConfig — rejects a config that would route wrongly', () => {
  it('unknown provider id in a route', () => {
    assertRejects(
      routingDoc({ routes: { 'bg-x': { provider: 'nope', complexity: 'small' } } }),
      fallbackDoc(), 'nope',
    );
  });

  it('complexity band the routed provider has no model for', () => {
    const doc = routingDoc();
    delete doc.providers['gh-copilot'].models.high;
    doc.routes['bg-x'] = { provider: 'gh-copilot', complexity: 'high' };
    assertRejects(doc, fallbackDoc(), 'declares no model for complexity "high"');
  });

  it('unknown complexity value', () => {
    assertRejects(
      routingDoc({ routes: { 'bg-x': { provider: 'gh-copilot', complexity: 'gigantic' } } }),
      fallbackDoc(), 'gigantic',
    );
  });

  it('routing to a disabled provider', () => {
    assertRejects(
      routingDoc({ routes: { 'bg-x': { provider: 'corp-gw', complexity: 'small' } } }),
      fallbackDoc(), 'disabled',
    );
  });

  it('an enabled provider with no impl (nothing to route to)', () => {
    const doc = routingDoc();
    doc.providers['corp-gw'].enabled = true;
    assertRejects(doc, fallbackDoc(), 'no `impl`');
  });

  it('fg-chat/claude pointed at a provider with no fg_transport', () => {
    // The 501-at-runtime contract starts here: the config cannot even express it.
    assertRejects(
      routingDoc({ routes: { 'fg-chat/claude': { provider: 'gh-copilot', complexity: 'high' } } }),
      fallbackDoc(), 'fg_transport',
    );
  });

  it('a fallback candidate repeated within one chain', () => {
    assertRejects(routingDoc(), fallbackDoc({
      chains: { 'gh-copilot': [{ provider: 'groq' }, { provider: 'groq' }] },
    }), 'already appears');
  });

  it('a chain listing its own head', () => {
    assertRejects(routingDoc(), fallbackDoc({
      chains: { 'gh-copilot': [{ provider: 'gh-copilot' }] },
    }), 'already appears');
  });

  it('a guard naming a sensor that does not exist', () => {
    assertRejects(routingDoc(), fallbackDoc({
      chains: { 'gh-copilot': [{ provider: 'groq', when: { moon_phase: ['full'] } }] },
    }), 'moon_phase');
  });

  it('a guard value the sensor never reports', () => {
    assertRejects(routingDoc(), fallbackDoc({
      chains: { 'gh-copilot': [{ provider: 'groq', when: { network: ['atlantis'] } }] },
    }), 'atlantis');
  });

  it('an unknown retry_on failure class', () => {
    assertRejects(routingDoc(), fallbackDoc({ retry_on: ['vibes'] }), 'vibes');
  });

  it('a negative same_provider_retries', () => {
    assertRejects(routingDoc(), fallbackDoc({ same_provider_retries: -1 }), 'non-negative');
  });

  it('a missing required default class', () => {
    const doc = routingDoc();
    delete doc.defaults.background;
    assertRejects(doc, fallbackDoc(), 'background');
  });

  it('a default that defers to the caller (nothing left to fall back to)', () => {
    const doc = routingDoc();
    doc.defaults.background.complexity = FROM_CALLER;
    assertRejects(doc, fallbackDoc(), FROM_CALLER);
  });

  it('a wrong version, on either file', () => {
    assertRejects(routingDoc({ version: 2 }), fallbackDoc(), 'version');
    assertRejects(routingDoc(), fallbackDoc({ version: 99 }), 'version');
  });

  it('an unknown complexity band in a provider model table', () => {
    const doc = routingDoc();
    doc.providers.groq.models.gigantic = 'x';
    assertRejects(doc, fallbackDoc(), 'gigantic');
  });

  // available_models is the account's catalogue; the band table is a CHOICE out
  // of it. Pointing a band outside the catalogue is the one that matters: it is
  // how `gh-copilot: high: claude-opus-5` used to become a 400 on the next call
  // instead of a boot failure naming the key.
  it('a band naming a model the account does not serve', () => {
    const doc = routingDoc();
    doc.providers.groq.available_models = ['llama-3.1-8b-instant'];
    doc.providers.groq.models.medium = 'claude-opus-5';
    assertRejects(doc, fallbackDoc(), 'claude-opus-5');
  });

  it('a duplicate id in an available_models catalogue', () => {
    const doc = routingDoc();
    const first = doc.providers.groq.models.small;
    doc.providers.groq.available_models = [first, first];
    assertRejects(doc, fallbackDoc(), 'duplicate');
  });

  it('an available_models that is not a list', () => {
    const doc = routingDoc();
    doc.providers.groq.available_models = 'llama-3.1-8b-instant';
    assertRejects(doc, fallbackDoc(), 'list of model id strings');
  });

  // The catalogue is optional on purpose: a provider can be declared before
  // anyone has probed what it serves (corp-gw is exactly that). An absent or empty
  // list must therefore constrain nothing — otherwise adding the field to one
  // provider would break every other.
  it('but an ABSENT or EMPTY catalogue constrains nothing', () => {
    for (const catalogue of [undefined, []]) {
      const doc = routingDoc();
      doc.providers.groq.available_models = catalogue;
      doc.providers.groq.models.medium = 'anything-at-all';
      assert.doesNotThrow(() => parseRoutingConfig(doc, fallbackDoc()));
    }
  });
});

// ── Disabled providers: fatal in a route, survivable in a chain ──────────────
//
// On 2026-08-28 a `corp-gw:` chain was added ahead of the endpoint being brought
// up. corp-gw is declared `enabled: false`, parseRoutingConfig refused the ENTIRE
// config over that one unreachable fallback candidate, and the proxy served
// nothing until the chain was deleted — which took bin/coding down with it.
//
// The asymmetry these tests pin: a ROUTE naming a disabled provider silently
// misroutes real traffic and stays fatal; a CHAIN entry is only a degradation
// path, so it is dropped with a warning and everything else keeps working.

describe('a disabled provider in a fallback chain', () => {
  it('is skipped, not fatal — and says so', () => {
    const c = parseRoutingConfig(routingDoc(), fallbackDoc({
      chains: {
        'gh-copilot': [{ provider: 'corp-gw' }, { provider: 'groq' }],
        'claude-code-max': [{ provider: 'gh-copilot' }],
      },
    }));
    assert.deepEqual(
      c.fallback.chains['gh-copilot'].map(x => x.provider), ['groq'],
      'the disabled candidate is gone; the rest of the chain survives intact',
    );
    assert.ok(
      c.warnings.some(w => w.includes('corp-gw') && w.includes('chains.gh-copilot')),
      `a skip must be announced with the key that caused it; got: ${JSON.stringify(c.warnings)}`,
    );
  });

  it('drops the whole chain when the HEAD is disabled', () => {
    // Nothing can ever consult a chain keyed on a provider that cannot be
    // reached, so it is not worth validating candidate by candidate.
    const c = parseRoutingConfig(routingDoc(), fallbackDoc({
      chains: { 'corp-gw': [{ provider: 'gh-copilot' }], 'gh-copilot': [{ provider: 'groq' }] },
    }));
    assert.ok(!('corp-gw' in c.fallback.chains), 'chain keyed on a disabled provider is dropped');
    assert.deepEqual(c.fallback.chains['gh-copilot'].map(x => x.provider), ['groq']);
  });

  it('but an UNKNOWN provider in a chain is still fatal — that is a typo', () => {
    assertRejects(
      routingDoc(),
      fallbackDoc({ chains: { 'gh-copilot': [{ provider: 'gh-copilto' }] } }),
      'unknown provider',
    );
  });

  it('and a ROUTE naming a disabled provider is still fatal', () => {
    // Duplicated on purpose from the rejection suite above: this is the half of
    // the asymmetry that must NOT move when the chain half is softened.
    assertRejects(
      routingDoc({ routes: { 'bg-x': { provider: 'corp-gw', complexity: 'small' } } }),
      fallbackDoc(), 'disabled',
    );
  });

  it('a config with nothing wrong carries no warnings', () => {
    assert.deepEqual(cfg().warnings, []);
  });
});

// ── The shipped config ───────────────────────────────────────────────────────

describe('the real config/ files', () => {
  const real = () => loadRoutingConfig({ force: true });

  it('load and validate', () => {
    const c = real();
    assert.ok(Object.keys(c.routes).length > 0, 'shipped config declares at least one route');
    assert.ok(c.defaults['fg-chat'] && c.defaults.background, 'both class defaults present');
  });

  it('every declared complexity band names a non-empty model', () => {
    for (const p of providerCatalogue(real())) {
      if (!p.enabled) continue;
      for (const band of COMPLEXITY_BANDS) {
        if (p.models[band] === undefined) continue;
        assert.ok(p.models[band], `${p.id}.models.${band} must be non-empty`);
      }
    }
  });

  it('more than one provider can serve tools — one exhausted quota must not stop every agent', () => {
    // The August 2026 outage: copilot was the ONLY tools-capable provider, so a
    // single quota exhaustion collapsed every tools-bearing chain to nothing and
    // blocked every agent and every background service at once. Keeping a second
    // capable provider in the config is what makes that recoverable.
    const capable = providerCatalogue(real()).filter(p => p.enabled && p.tools);
    assert.ok(
      capable.length >= 2,
      `expected >=2 tools-capable providers, got ${capable.length} (${capable.map(p => p.id).join(', ')})`,
    );
  });

  it('foreground claude resolves to a provider that can actually serve it', () => {
    const c = real();
    const r = resolveRoute(c, { job: 'fg-chat', agent: 'claude' });
    assert.ok(
      c.providers[r.provider].fgTransport,
      `fg-chat/claude resolved to ${r.provider}, which has no fg_transport`,
    );
  });
});

// ── Per-provider request timeout (2026-08-29) ────────────────────────────────

describe('providers[].timeout_ms written per band', () => {
  // qwen-local's bands land on models that are not the same kind of thing:
  // small -> a direct model (31.0s for 1131 tokens), medium -> a REASONING model
  // that thinks before it answers (70.1s for the same prompt). One number cannot
  // serve both; sized for small, medium is cut off mid-thought on every call.
  const fb = () => ({ version: 1, chains: {}, retry_on: [], same_provider_retries: 0, enforce_capabilities: false });
  const doc = (timeout) => parseRoutingConfig({
    version: 1,
    providers: {
      'qwen-local': {
        account: 'on-prem', impl: 'qwen-local',
        capabilities: { tools: true, streaming: true },
        available_models: ['fast-id', 'normal-id'],
        models: { small: 'fast-id', medium: 'normal-id' },
        timeout_ms: timeout,
      },
    },
    routes: { 'bg-x': { provider: 'qwen-local', complexity: 'small' } },
    defaults: {
      'fg-chat': { provider: 'qwen-local', complexity: 'small' },
      background: { provider: 'qwen-local', complexity: 'small' },
    },
  }, fb());

  it('accepts a per-band map with a default', () => {
    const p = doc({ default: 30000, medium: 210000 }).providers['qwen-local'];
    assert.equal(p.timeoutMs, 30000);
    assert.deepEqual(p.timeoutMsByBand, { medium: 210000 });
  });

  it('accepts a per-band map with no default — other bands stay unstated', () => {
    const p = doc({ medium: 210000 }).providers['qwen-local'];
    assert.equal(p.timeoutMs, null);
    assert.deepEqual(p.timeoutMsByBand, { medium: 210000 });
  });

  it('the scalar form still parses to exactly what it did before', () => {
    const p = doc(30000).providers['qwen-local'];
    assert.equal(p.timeoutMs, 30000);
    assert.equal(p.timeoutMsByBand, null);
  });

  it('refuses a near-miss band name rather than ignoring it', () => {
    // A silently dropped `medum:` reads as "the ceiling did not apply" at 3am.
    assert.throws(() => doc({ medum: 210000 }), /unknown band "medum"/);
  });

  it('refuses a band that has a ceiling but no model', () => {
    assert.throws(() => doc({ high: 210000 }), /no model/);
  });

  it('applies the seconds-shaped guard to every band, not just the scalar', () => {
    assert.throws(() => doc({ medium: 210 }), /MILLISECONDS/);
    assert.throws(() => doc({ default: 30, medium: 210000 }), /MILLISECONDS/);
  });

  it('refuses non-numbers per band', () => {
    for (const bad of ['210000', 0, -1]) {
      assert.throws(() => doc({ medium: bad }), /positive number of milliseconds|MILLISECONDS/);
    }
  });

  it('refuses an empty map instead of silently meaning "no ceiling"', () => {
    assert.throws(() => doc({}), /is empty/);
  });

  it('reaches the dashboard catalogue', () => {
    const entry = providerCatalogue(doc({ default: 30000, medium: 210000 }))
      .find((x) => x.id === 'qwen-local');
    assert.equal(entry.timeoutMs, 30000);
    assert.deepEqual(entry.timeoutMsByBand, { medium: 210000 });
  });
});

describe('providers[].timeout_ms — how long to wait before the fallback is the better bet', () => {
  const doc = () => ({
    version: 1,
    providers: {
      'gh-copilot': {
        account: 'copilot-subscription', impl: 'copilot',
        capabilities: { tools: true, streaming: true },
        models: { small: 'claude-haiku-4.5' },
      },
      'qwen-laptop': {
        account: 'on-device', impl: 'qwen-laptop', timeout_ms: 20000,
        capabilities: { tools: true, streaming: true },
        models: { small: 'qwen3.8-27b-local' },
      },
    },
    routes: { 'bg-x': { provider: 'gh-copilot', complexity: 'small' } },
    defaults: {
      'fg-chat': { provider: 'gh-copilot', complexity: 'small' },
      background: { provider: 'gh-copilot', complexity: 'small' },
    },
  });
  const fb = () => ({ version: 1, chains: {}, retry_on: [], same_provider_retries: 0, enforce_capabilities: false });
  const parse = (d) => parseRoutingConfig(d, fb());

  it('is null when undeclared, so the dispatcher default applies unchanged', () => {
    assert.equal(parse(doc()).providers['gh-copilot'].timeoutMs, null);
  });

  it('is carried through as a number when declared', () => {
    assert.equal(parse(doc()).providers['qwen-laptop'].timeoutMs, 20000);
  });

  it('reaches the dashboard via providerCatalogue', () => {
    const cat = providerCatalogue(parse(doc()));
    assert.equal(cat.find(p => p.id === 'qwen-laptop').timeoutMs, 20000);
  });

  it('refuses a value that looks like SECONDS — the mistake that fails every call', () => {
    // 20 would abort after 20ms. Silently accepting it would take an endpoint
    // offline in a way that reads as "the endpoint is broken".
    const d = doc(); d.providers['qwen-laptop'].timeout_ms = 20;
    assert.throws(() => parse(d), (e) => /MILLISECONDS/.test(e.message));
  });

  it('refuses a non-numeric, zero or negative timeout', () => {
    for (const bad of ['20000', 0, -1, null === undefined ? 1 : NaN]) {
      const d = doc(); d.providers['qwen-laptop'].timeout_ms = bad;
      assert.throws(() => parse(d), (e) => /positive number of milliseconds/.test(e.message),
        `timeout_ms=${String(bad)} must be refused`);
    }
  });
});

// ── Which answers came off hardware we own ───────────────────────────────────
//
// The statusline's [L:] badge counts completions served by a self-hosted
// provider. It reads that off the `account` a provider already declares rather
// than a new `self_hosted:` flag, because the account IS the fact: every other
// value names something that invoices us, and these two name a box.
describe('self-hosted providers are identified by the account they already declare', () => {
  const providers = () => parseRoutingConfig(routingDoc({
    providers: {
      ...routingDoc().providers,
      'qwen-local': {
        account: 'on-prem', impl: 'qwen-local', timeout_ms: 30000,
        capabilities: { tools: true, streaming: true },
        models: { small: 'qwen3.8-27b-dual-fast' },
      },
      'qwen-laptop': {
        account: 'on-device', impl: 'qwen-laptop', timeout_ms: 20000,
        capabilities: { tools: true, streaming: true },
        models: { small: 'qwen3.8-27b-local' },
      },
    },
  }), fallbackDoc()).providers;

  it('counts both the laptop and the on-prem cluster', () => {
    // The distinction between "this Mac" and "a rack on the corporate LAN" is
    // not the one being drawn: neither is metered and neither sends the prompt
    // off our network, which is the property [L:] reports.
    assert.equal(isSelfHosted(providers()['qwen-laptop']), true);
    assert.equal(isSelfHosted(providers()['qwen-local']), true);
  });

  it('counts no metered account, whoever the vendor is', () => {
    // claude-code-max is a subscription with no per-token cost and is STILL not
    // self-hosted — the model runs on someone else's machine and the prompt
    // leaves ours. Unmetered is not the test; whose hardware is.
    for (const id of ['claude-code-max', 'gh-copilot', 'groq']) {
      assert.equal(isSelfHosted(providers()[id]), false, `${id} must not count as local`);
    }
  });

  it('a provider with an unrecognised account is not local', () => {
    // The safe direction: a new self-hosted endpoint that forgets to declare
    // one of these accounts undercounts free work, rather than reporting a paid
    // call as free.
    assert.equal(isSelfHosted({ account: 'some-new-vendor' }), false);
    assert.equal(isSelfHosted({ account: 'unknown' }), false);
    assert.equal(isSelfHosted({}), false);
    assert.equal(isSelfHosted(null), false);
    assert.equal(isSelfHosted(undefined), false);
  });
});

describe('classifyFailure — a timeout is not a socket blip', () => {
  // The distinction this suite exists for. Until 2026-09-02 a timeout was
  // classified `network_error`, which is the one class that spends the
  // `same_provider_retries` budget. That made every missed deadline cost TWO
  // full timeout_ms for the same verdict: fg-chat/pi medium turns offloaded to
  // qwen-local burned 2 x 30s before gh-copilot answered in ~3.5s (46.6s avg
  // against 3.4s for the same band unoffloaded).

  it('a provider timeout is `timeout`, not `network_error`', () => {
    // The exact string completeOpenAICompatible throws (server.mjs).
    assert.equal(classifyFailure('qwen-local API timed out after 30000ms'), 'timeout');
    assert.equal(classifyFailure('Copilot API timed out after 120000ms'), 'timeout');
    assert.equal(classifyFailure('request timeout'), 'timeout');
  });

  it('a client abort is a timeout too — the deadline was just theirs', () => {
    // Same actionable property: someone stopped waiting, and waiting again on
    // the same provider cannot change that.
    assert.equal(classifyFailure('The operation was aborted'), 'timeout');
  });

  it('a genuine connection failure is still `network_error`', () => {
    // These must KEEP the retry, which is the whole reason the budget exists:
    // they fail in milliseconds and a fresh connection almost always works.
    for (const msg of ['fetch failed', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND api.x', 'socket hang up', 'EPIPE']) {
      assert.equal(classifyFailure(msg), 'network_error', msg);
    }
  });

  it('only network_error may be retried on the same provider', () => {
    assert.ok(SAME_PROVIDER_RETRY_CLASSES.has('network_error'));
    assert.ok(!SAME_PROVIDER_RETRY_CLASSES.has('timeout'), 'a missed deadline must never be spent twice');
    // Nothing else either: a spent quota and an unconfigured provider do not
    // become available by asking again 200ms later.
    for (const c of ['quota_exhausted', 'provider_unavailable', 'gateway_5xx']) {
      assert.ok(!SAME_PROVIDER_RETRY_CLASSES.has(c), c);
    }
  });

  it('every same-provider-retry class is a real fallback class', () => {
    // Guards against the two lists drifting into disagreement.
    for (const c of SAME_PROVIDER_RETRY_CLASSES) {
      assert.ok(RETRY_CLASSES.includes(c), `${c} is not in RETRY_CLASSES`);
    }
  });

  it('timeout still ADVANCES the chain — it is only the retry it is barred from', () => {
    // `retry_on` is matched against classifyFailure's output, so `timeout` has
    // to be a declarable class or a timed-out provider would surface verbatim
    // to the caller instead of falling back.
    assert.ok(RETRY_CLASSES.includes('timeout'));
    const c = parseRoutingConfig(routingDoc(), fallbackDoc({ retry_on: ['timeout', 'network_error'] }));
    assert.ok(c.fallback.retryOn.has('timeout'));
  });

  it('quota still wins over the deadline classes', () => {
    // A 429 says "rate limit" and often carries a timeout-ish message; it must
    // stay quota_exhausted, which has different fallback semantics.
    assert.equal(classifyFailure('429 rate limit exceeded'), 'quota_exhausted');
  });

  it('a caller/model error is still null — never fall back on someone else\'s bug', () => {
    assert.equal(classifyFailure('400 invalid request: messages[0].role'), null);
    assert.equal(classifyFailure(''), null);
  });
});

// llm-routing.local.yaml: deployment-only providers next to llm-routing.yaml.
describe('llm-routing.local.yaml', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'routing-local-'));
  it('is llm-routing.local.yaml next to the routing file', () => {
    assert.equal(localRoutingPath('/c/llm-routing.yaml'), '/c/llm-routing.local.yaml');
  });
  it('absent: the routing doc is unchanged', () => {
    const d = dir();
    const doc = { providers: { a: { impl: 'x' } } };
    assert.equal(withLocalProviders(doc, path.join(d, 'llm-routing.yaml')), doc);
  });
  it('present: its providers are added', () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'llm-routing.local.yaml'), 'version: 1\nproviders:\n  gw: { impl: gw }\n');
    const merged = withLocalProviders({ providers: { a: { impl: 'x' } }, routes: {} }, path.join(d, 'llm-routing.yaml'));
    assert.deepEqual(Object.keys(merged.providers), ['a', 'gw']);
    assert.deepEqual(merged.routes, {});
  });
  it('a provider in both files is a config error', () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'llm-routing.local.yaml'), 'providers:\n  a: { impl: y }\n');
    assert.throws(() => withLocalProviders({ providers: { a: { impl: 'x' } } }, path.join(d, 'llm-routing.yaml')), /in both llm-routing\.yaml and llm-routing\.local\.yaml/);
  });
});
