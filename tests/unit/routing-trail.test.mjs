/**
 * Unit suite for the routing trail (proxy-bridge/routing-trail.mjs).
 *
 * The trail is written on EVERY token_usage row, from inside logCall, which is
 * best-effort by contract ("a DB hiccup must never fail the LLM call"). Two
 * properties therefore matter more than the formatting:
 *
 *   1. The empty case is '' and not '{}'. This column rides on a table that
 *      grows by thousands of rows a day and is empty for almost all of them.
 *   2. Nothing here throws. A serialisation bug must not be what turns a served
 *      completion into a 500.
 *
 * Run: node --test tests/unit/routing-trail.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRoutingTrail,
  serializeRoutingTrail,
  parseRoutingTrail,
  normalizeFailureClass,
} from '../../proxy-bridge/routing-trail.mjs';

describe('the empty-string contract', () => {
  it('a clean first-hop success serialises to the empty string', () => {
    assert.equal(serializeRoutingTrail({}), '');
    assert.equal(serializeRoutingTrail({ attempts: [], configSkipped: [], runtimeDropped: [] }), '');
  });

  it('no argument at all is also empty', () => {
    assert.equal(serializeRoutingTrail(undefined), '');
  });

  it('buildRoutingTrail returns null rather than an empty object', () => {
    // The null is what lets the serializer produce '' without a second check.
    assert.equal(buildRoutingTrail({}), null);
  });

  it('entries with no provider are dropped, not serialised as noise', () => {
    assert.equal(serializeRoutingTrail({
      attempts: [{ error: 'network_error' }, null],
      configSkipped: [{ reason: 'no provider named' }],
    }), '');
  });
});

describe('what a fallback records', () => {
  it('keeps the failed hops in order, with class and duration', () => {
    const raw = serializeRoutingTrail({
      attempts: [
        { provider: 'gh-copilot', model: 'claude-haiku-4.5', error: 'network_error', ms: 1203 },
        { provider: 'groq', model: 'llama-3.1-8b-instant', error: 'quota_exhausted', ms: 88 },
      ],
    });
    const t = parseRoutingTrail(raw);
    assert.deepEqual(t.attempts.map(a => a.provider), ['gh-copilot', 'groq']);
    assert.equal(t.attempts[0].error, 'network_error');
    assert.equal(t.attempts[0].ms, 1203);
    assert.ok(!('skipped' in t), 'nothing was skipped, so the key is absent');
  });

  it('separates a config skip from a runtime drop', () => {
    // The distinction is the whole point: one is fixed by editing a YAML file,
    // the other by logging in or joining the VPN. Collapsing them into
    // "unavailable" is what makes a routing problem un-diagnosable.
    const t = parseRoutingTrail(serializeRoutingTrail({
      configSkipped: [{ provider: 'groq', reason: 'tools not supported' }],
      runtimeDropped: [{ provider: 'qwen-local' }],
    }));
    assert.deepEqual(t.skipped, [
      { provider: 'groq', reason: 'tools not supported', kind: 'config' },
      { provider: 'qwen-local', reason: 'not reachable', kind: 'runtime' },
    ]);
  });

  it('records why the offload did NOT happen', () => {
    // Without this, a call that stayed on copilot because the network guard
    // failed looks exactly like one that was never eligible.
    const t = parseRoutingTrail(serializeRoutingTrail({
      offloadSkipped: 'require_network=corporate not satisfied (actual: public)',
    }));
    assert.match(t.offloadSkipped, /require_network=corporate/);
  });

  it('rounds a fractional duration rather than storing float noise', () => {
    const t = parseRoutingTrail(serializeRoutingTrail({
      attempts: [{ provider: 'x', error: 'timeout', ms: 12.7 }],
    }));
    assert.equal(t.attempts[0].ms, 13);
  });
});

describe('nothing throws', () => {
  it('a circular input cannot reach the JSON serialiser at all', () => {
    // The field whitelist in buildRoutingTrail copies provider/model/error/ms and
    // nothing else, so a cycle hanging off a caller's object is structurally
    // dropped rather than caught. Asserting the SURVIVING shape, not '', because
    // silently discarding a usable attempt record would be the worse outcome.
    const circular = { provider: 'x' };
    circular.self = circular;
    const t = parseRoutingTrail(serializeRoutingTrail({ attempts: [circular] }));
    assert.deepEqual(t, { attempts: [{ provider: 'x' }] });
  });

  it('a throwing getter degrades to the empty string instead of failing the call', () => {
    // This is the case the try/catch is actually for: logCall is best-effort, so
    // a hostile or broken input must cost the trail, never the completion.
    const hostile = { get provider() { throw new Error('boom'); } };
    assert.doesNotThrow(() => serializeRoutingTrail({ attempts: [hostile] }));
    assert.equal(serializeRoutingTrail({ attempts: [hostile] }), '');
  });

  it('parse tolerates every kind of garbage', () => {
    for (const bad of ['', null, undefined, 'not json', '[1,2,3]'.slice(0, 4), '{', 42, {}]) {
      assert.doesNotThrow(() => parseRoutingTrail(bad));
    }
    assert.equal(parseRoutingTrail('not json'), null);
    assert.equal(parseRoutingTrail(''), null);
  });

  it('a JSON scalar is not mistaken for a trail', () => {
    assert.equal(parseRoutingTrail('"hello"'), null);
    assert.equal(parseRoutingTrail('null'), null);
  });
});

describe('normalizeFailureClass — one classifier, not two', () => {
  it('passes the engine class through unchanged', () => {
    // routing-config.mjs classifyFailure() is authoritative: llm-fallback.yaml
    // `retry_on` is matched against ITS output, so the chain literally advances
    // on what it returns. Re-deriving the class here would let the dashboard
    // group failures differently from the engine that acted on them — which is
    // exactly how `timeout` stayed invisible inside `network_error`.
    for (const c of ['quota_exhausted', 'provider_unavailable', 'network_error', 'timeout', 'gateway_5xx']) {
      assert.equal(normalizeFailureClass(c), c);
    }
  });

  it('null becomes "error" — a non-fallback class is still information', () => {
    // null means "not in retry_on", which is WHY the chain did not advance.
    assert.equal(normalizeFailureClass(null), 'error');
    assert.equal(normalizeFailureClass(undefined), 'error');
    assert.equal(normalizeFailureClass(''), 'error');
  });
});
