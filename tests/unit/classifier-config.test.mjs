/**
 * Unit suite for the `classifier:` block in llm-routing.yaml.
 *
 * The behaviour of the classifier itself lives in prompt-classifier.test.mjs.
 * This file is about the CONFIG surface, and the properties it pins are the same
 * three semantic-routing.test.mjs pins for its block:
 *
 *   • OFF is exactly equivalent to the block not existing;
 *   • a config that can only mislead is refused at boot, by name;
 *   • a config that can only be inert warns instead of failing, because both
 *     inert states are reachable from a dashboard toggle.
 *
 * Plus the one that is specific to reading prompt content: a classifier verdict
 * must be DISTINGUISHABLE from a caller's own declaration in the resolved route.
 *
 * Run: node --test tests/unit/classifier-config.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRoutingConfig, resolveRoute, explain, CLASSIFIER_IMPLS, FROM_CALLER,
} from '../../proxy-bridge/routing-config.mjs';

function routingDoc(overrides = {}) {
  return {
    version: 1,
    providers: {
      'gh-copilot': {
        account: 'copilot-subscription', impl: 'copilot',
        capabilities: { tools: true, streaming: true },
        models: { small: 'claude-haiku-4.5', medium: 'claude-sonnet-4.6', high: 'claude-sonnet-5' },
      },
    },
    routes: {
      'fg-chat/pi': { provider: 'gh-copilot', complexity: FROM_CALLER },
      'bg-observation-writer': { provider: 'gh-copilot', complexity: 'small' },
    },
    defaults: {
      'fg-chat': { provider: 'gh-copilot', complexity: 'high' },
      background: { provider: 'gh-copilot', complexity: 'medium' },
    },
    ...overrides,
  };
}
const fallbackDoc = () => ({ version: 1, chains: {}, retry_on: [], same_provider_retries: 0 });
const parse = (classifier) =>
  parseRoutingConfig(routingDoc(classifier === undefined ? {} : { classifier }), fallbackDoc());

const throwsNaming = (fn, needle) =>
  assert.throws(fn, (e) => {
    assert.match(e.message, needle, `message should name the offending key: ${e.message}`);
    return true;
  });

describe('defaults are inert in every direction', () => {
  it('an absent block is identical to a disabled one', () => {
    assert.deepEqual(parse(undefined).classifier, parse({ enabled: false }).classifier);
  });

  it('defaults to off, impl none, and may emit only `small`', () => {
    const c = parse(undefined).classifier;
    assert.equal(c.enabled, false);
    assert.equal(c.impl, 'none');
    assert.deepEqual(c.bands, ['small']);
  });

  it('declaring the block without enabling it changes nothing', () => {
    const c = parse({ impl: 'local-llm', timeout_ms: 2000 }).classifier;
    assert.equal(c.enabled, false);
  });
});

describe('refuses a config that would mislead', () => {
  it('rejects a non-mapping block', () => {
    throwsNaming(() => parse('yes'), /classifier: must be a mapping/);
  });

  it('rejects a non-boolean enabled rather than coercing it', () => {
    // `enabled: "true"` coerced to false would read as the feature not working.
    throwsNaming(() => parse({ enabled: 'true' }), /classifier\.enabled/);
  });

  it('rejects an unknown impl at boot, not at the first request', () => {
    throwsNaming(() => parse({ impl: 'magic' }), /classifier\.impl.*magic/s);
  });

  it('accepts every impl it advertises', () => {
    for (const impl of CLASSIFIER_IMPLS) {
      assert.equal(parse({ impl }).classifier.impl, impl);
    }
  });

  it('rejects an unknown band the classifier would be allowed to emit', () => {
    throwsNaming(() => parse({ bands: ['small', 'cheap'] }), /classifier\.bands.*cheap/s);
  });

  it('rejects an empty band list — that is what `enabled: false` is for', () => {
    throwsNaming(() => parse({ bands: [] }), /classifier\.bands/);
  });

  it('rejects a timeout that looks like seconds', () => {
    throwsNaming(() => parse({ timeout_ms: 2 }), /looks like seconds/);
  });

  it('rejects a timeout longer than any turn should wait to be classified', () => {
    // The classifier sits IN FRONT of the call it exists to make cheaper, so a
    // large value here is pure added latency on every eligible turn.
    throwsNaming(() => parse({ timeout_ms: 60_000 }), /longer than any request should wait/);
  });

  for (const [wrong, right] of [
    ['enable', 'enabled'], ['implementation', 'impl'],
    ['timeout', 'timeout_ms'], ['allowed_bands', 'bands'],
  ]) {
    it(`names \`${right}\` when the file says \`${wrong}\``, () => {
      // This parser does not reject unknown keys in general, so these four are
      // called out by name: each one silently reads as "off" or "small only",
      // which looks like the feature not working rather than a config error.
      throwsNaming(() => parse({ [wrong]: 'x' }), new RegExp(`classifier\\.${wrong}.*${right}`, 's'));
    });
  }
});

describe('warns — rather than fails — on a config that can only be inert', () => {
  it('warns when enabled with impl none', () => {
    const { warnings } = parse({ enabled: true, impl: 'none' });
    assert.ok(warnings.some((w) => /enabled but impl is "none"/.test(w)), warnings.join('; '));
  });

  it('warns when an impl is declared but the classifier is off', () => {
    const { warnings } = parse({ enabled: false, impl: 'http' });
    assert.ok(warnings.some((w) => /declared but the classifier is disabled/.test(w)), warnings.join('; '));
  });

  it('does not fail boot on either — both are one dashboard toggle away', () => {
    assert.doesNotThrow(() => parse({ enabled: true, impl: 'none' }));
    assert.doesNotThrow(() => parse({ enabled: false, impl: 'http' }));
  });
});

describe('a classifier verdict is distinguishable from a caller declaration', () => {
  const cfg = () => parse({ enabled: true, impl: 'local-llm' });

  it('reports complexitySource "caller" when the agent declared the band', () => {
    const r = resolveRoute(cfg(), { job: 'fg-chat', agent: 'pi', complexity: 'small' });
    assert.equal(r.complexitySource, 'caller');
  });

  it('reports "classifier" for the same band when the classifier lowered it', () => {
    // Same job, same resolved band, same model — only the attribution differs,
    // and that is the whole point: "who decided this?" must stay answerable.
    const r = resolveRoute(cfg(), { job: 'fg-chat', agent: 'pi', complexity: 'small', classified: true });
    assert.equal(r.complexitySource, 'classifier');
    assert.equal(r.complexity, 'small');
  });

  it('never claims "classifier" for a route that declares its own band', () => {
    const r = resolveRoute(cfg(), { job: 'bg-observation-writer', complexity: 'small', classified: true });
    assert.equal(r.complexitySource, 'route bg-observation-writer');
  });

  it('/resolve echoes `classified`, so its answer is self-describing', () => {
    const e = explain(cfg(), { job: 'fg-chat', agent: 'pi', complexity: 'small', classified: true });
    assert.equal(e.request.classified, true);
    assert.equal(e.route.complexitySource, 'classifier');
    assert.equal(explain(cfg(), { job: 'fg-chat', agent: 'pi' }).request.classified, false);
  });

  it('the decision is reproducible from the config alone — no prompt involved', () => {
    // The property the anti-classifier comment demanded: given the verdict as a
    // parameter, /resolve reproduces the routing exactly.
    const a = explain(cfg(), { job: 'fg-chat', agent: 'pi', complexity: 'small', classified: true });
    const b = explain(cfg(), { job: 'fg-chat', agent: 'pi', complexity: 'small', classified: true });
    assert.equal(a.summary, b.summary);
    assert.match(a.summary, /gh-copilot\/claude-haiku-4\.5/);
  });
});

// ── `bands: [small, medium]` ────────────────────────────────────────────────
//
// Widened 2026-09-02. Until then a `medium` verdict was discarded as "not in
// allowed bands" and the caller's declaration stood — which meant an opencode
// turn defaulting to `high` could not be lowered to `medium` even when that was
// plainly right, and pi's `medium` slider could never be confirmed rather than
// merely tolerated.
//
// The downgrade-only property is what makes the wider list safe, and it is
// asserted here rather than assumed: `bands` says what a verdict may BE, never
// which direction it may move a band.
describe('classifier.bands — widening what a verdict may say', () => {
  const cfg = () => parse({ enabled: true, impl: 'service', bands: ['small', 'medium'] });

  it('accepts a multi-band list and keeps its order', () => {
    assert.deepEqual(cfg().classifier.bands, ['small', 'medium']);
  });

  it('a medium verdict is still attributed to the classifier, not the caller', () => {
    const r = resolveRoute(cfg(), { job: 'fg-chat', agent: 'pi', complexity: 'medium', classified: true });
    assert.equal(r.complexitySource, 'classifier');
    assert.equal(r.complexity, 'medium');
  });

  it('widening the list does not let a verdict RAISE a band', async () => {
    // The guarantee lives in prompt-classifier.mjs applyDowngrade(), not here —
    // this pins that the config change did not quietly become permission to
    // move work the expensive way. `bands` and direction are separate axes.
    const { applyDowngrade } = await import('../../proxy-bridge/prompt-classifier.mjs');
    assert.deepEqual(applyDowngrade('medium', 'high'), { band: 'medium', lowered: false, capped: true });
    assert.deepEqual(applyDowngrade('high', 'medium'), { band: 'medium', lowered: true, capped: false });
    assert.deepEqual(applyDowngrade('small', 'medium'), { band: 'small', lowered: false, capped: true });
  });

  it('still refuses a band that is not a band', () => {
    throwsNaming(() => parse({ enabled: true, impl: 'service', bands: ['small', 'cheap'] }), /bands/);
  });
});
