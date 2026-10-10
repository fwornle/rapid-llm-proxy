/**
 * Unit suite for proxy-bridge/prompt-classifier.mjs.
 *
 * This module reads prompt content in order to move a request onto a cheaper
 * model. The properties worth pinning are therefore not "does it classify well"
 * — that is what scripts/eval-prompt-classifier.mjs measures — but the ones that
 * bound the damage when it classifies badly:
 *
 *   • it can only ever LOWER a band, so the worst case is today's behaviour;
 *   • it never touches a route that declared its own band;
 *   • it never touches a turn that is mid tool-use loop;
 *   • every failure mode resolves to "no change", never to a guess;
 *   • OFF is exactly equivalent to the module not existing.
 *
 * Run: node --test tests/unit/prompt-classifier.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyRequest, classifierEligibility, lastUserText,
  vetoesDowngrade, applyDowngrade, BAND_ORDER, SKIP,
} from '../../proxy-bridge/prompt-classifier.mjs';

const userMsg = (t) => ({ role: 'user', content: t });
const sys = (t) => ({ role: 'system', content: t });
/** A tool RESULT on the OpenAI wire — what makes a turn mid-loop. */
const toolResult = () => ({ role: 'tool', tool_call_id: 'c1', content: 'file contents' });

/** Always says `small`; the most dangerous possible classifier. */
const alwaysSmall = async () => 'small';

const base = {
  enabled: true,
  bandSource: 'caller',
  declaredBand: 'medium',
  messages: [sys('You are opencode…'), userMsg('how many rs in strawberry')],
  verdictFn: alwaysSmall,
};

describe('downgrade-only — the property the whole design rests on', () => {
  it('lowers medium to small when the verdict says small', async () => {
    const r = await classifyRequest(base);
    assert.equal(r.band, 'small');
    assert.equal(r.changed, true);
    assert.equal(r.source, 'classifier');
  });

  it('REFUSES to raise a band, even when the classifier insists', async () => {
    const r = await classifyRequest({
      ...base, declaredBand: 'small', verdictFn: async () => 'high',
      allowedBands: ['small', 'medium', 'high'],
    });
    assert.equal(r.band, 'small');
    assert.equal(r.changed, false);
  });

  it('applyDowngrade caps a harder verdict rather than applying it', () => {
    const a = applyDowngrade('medium', 'high');
    assert.deepEqual(a, { band: 'medium', lowered: false, capped: true });
  });

  it('applyDowngrade is a no-op on an unknown band on either side', () => {
    assert.equal(applyDowngrade('medium', 'cheap').band, 'medium');
    assert.equal(applyDowngrade('bogus', 'small').band, 'bogus');
  });

  it('bands are ordered cheapest-first — the comparison depends on it', () => {
    assert.deepEqual(BAND_ORDER, ['small', 'medium', 'high']);
  });
});

describe('the structural gate', () => {
  it('never classifies a route that declared its own band', async () => {
    // bg-observation-writer et al. choose `small` deliberately; bg-kgbench-judge
    // chooses `high` because the model IS the measurement.
    const r = await classifyRequest({ ...base, bandSource: 'route bg-kgbench-judge', declaredBand: 'high' });
    assert.equal(r.changed, false);
    assert.equal(r.detail, SKIP.NOT_FROM_CALLER);
  });

  it('classifies a from-caller route that supplied nothing (defaults.* source)', async () => {
    // This is opencode: `from-caller`, declares nothing, falls to defaults.fg-chat.
    const r = await classifyRequest({
      ...base,
      bandSource: 'defaults.fg-chat (route asked for from-caller, caller supplied nothing)',
      declaredBand: 'high',
    });
    assert.equal(r.changed, true);
    assert.equal(r.band, 'small');
  });

  it('never downgrades a turn that is mid tool-use loop', async () => {
    // The last user message can look trivial while the turn is anything but.
    const r = await classifyRequest({
      ...base,
      messages: [sys('…'), userMsg('find the ETM'), toolResult(), userMsg('· bash(read span)')],
    });
    assert.equal(r.changed, false);
    assert.equal(r.detail, SKIP.MID_LOOP);
  });

  it('detects a mid-loop turn on the Anthropic wire shape too', async () => {
    const anthropicToolResult = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }],
    };
    const g = classifierEligibility({
      bandSource: 'caller', declaredBand: 'medium',
      messages: [userMsg('hi'), anthropicToolResult],
    });
    assert.equal(g.eligible, false);
    assert.equal(g.reason, SKIP.MID_LOOP);
  });

  it('skips when the declared band is already the cheapest', async () => {
    const r = await classifyRequest({ ...base, declaredBand: 'small' });
    assert.equal(r.detail, SKIP.ALREADY_LOWEST);
  });

  it('skips an oversized request, counting USER bytes only', async () => {
    // A 34KB system prompt must not by itself make a turn ineligible — that is
    // opencode's constant preamble, identical on every turn.
    const bigSystem = classifierEligibility({
      bandSource: 'caller', declaredBand: 'medium',
      messages: [sys('x'.repeat(34_000)), userMsg('say ok')], maxBytes: 20_000,
    });
    assert.equal(bigSystem.eligible, true, 'system prompt size is not the request size');

    const bigUser = classifierEligibility({
      bandSource: 'caller', declaredBand: 'medium',
      messages: [userMsg('x'.repeat(30_000))], maxBytes: 20_000,
    });
    assert.equal(bigUser.eligible, false);
    assert.equal(bigUser.reason, SKIP.TOO_LARGE);
  });
});

describe('lastUserText — what the classifier actually reads', () => {
  it('takes the last user message and ignores the system prompt', () => {
    const t = lastUserText([sys('You are opencode, '.repeat(2000)), userMsg('say ok')]);
    assert.equal(t, 'say ok');
  });

  it('flattens content blocks', () => {
    const t = lastUserText([{ role: 'user', content: [{ type: 'text', text: 'count' }, { type: 'text', text: 'to three' }] }]);
    assert.equal(t, 'count to three');
  });

  it('caps the text it returns', () => {
    assert.equal(lastUserText([userMsg('y'.repeat(5000))], 100).length, 100);
  });

  it('returns empty when there is no user message, and that skips classification', async () => {
    assert.equal(lastUserText([sys('only a system prompt')]), '');
    const r = await classifyRequest({ ...base, messages: [sys('only a system prompt')] });
    assert.equal(r.detail, SKIP.NO_USER_TEXT);
  });
});

describe('the stage-1 veto — cheap, and only ever prevents a downgrade', () => {
  it('lets a genuinely trivial question through', () => {
    assert.equal(vetoesDowngrade('how many rs in strawberry'), false);
    assert.equal(vetoesDowngrade('what is 2+2'), false);
  });

  for (const [label, text] of [
    ['code fences', 'fix this:\n```js\nconst a = 1\n```'],
    ['a file path', 'why does /Users/me/src/server.mjs throw'],
    ['a file:line ref', 'look at server.mjs:4367'],
    ['a complexity verb', 'refactor the routing chain builder'],
    ['multi-step phrasing', 'add the field and also update the tests'],
    ['sheer length', 'x'.repeat(700)],
    ['empty input', ''],
  ]) {
    it(`vetoes on ${label}`, () => assert.equal(vetoesDowngrade(text), true));
  }

  it('a vetoed request is left entirely alone', async () => {
    const r = await classifyRequest({
      ...base, messages: [sys('…'), userMsg('refactor the chain builder in server.mjs')],
    });
    assert.equal(r.changed, false);
    assert.equal(r.detail, SKIP.VETOED);
  });
});

describe('fail-open — every failure resolves to no change', () => {
  const failing = {
    'a throwing classifier': async () => { throw new Error('ETIMEDOUT'); },
    'an empty answer': async () => '',
    'a garbage answer': async () => 'probably quite easy?',
    'a null answer': async () => null,
    'a band outside the allowed set': async () => 'medium',
  };
  for (const [label, verdictFn] of Object.entries(failing)) {
    it(`does not change the band on ${label}`, async () => {
      const r = await classifyRequest({ ...base, verdictFn });
      assert.equal(r.band, 'medium');
      assert.equal(r.changed, false);
      assert.equal(r.source, '');
    });
  }

  it('reports a throwing classifier as an error rather than swallowing it silently', async () => {
    const r = await classifyRequest({ ...base, verdictFn: failing['a throwing classifier'] });
    assert.match(r.detail, /classifier error: ETIMEDOUT/);
  });

  it('does nothing when no impl is configured', async () => {
    const r = await classifyRequest({ ...base, verdictFn: null });
    assert.equal(r.changed, false);
    assert.match(r.detail, /no classifier impl/);
  });
});

describe('OFF is exactly equivalent to the module not existing', () => {
  it('returns the declared band untouched and calls nothing', async () => {
    let called = false;
    const r = await classifyRequest({
      ...base, enabled: false, verdictFn: async () => { called = true; return 'small'; },
    });
    assert.equal(r.band, 'medium');
    assert.equal(r.changed, false);
    assert.equal(called, false, 'a disabled classifier must not do I/O');
    assert.equal(r.detail, SKIP.DISABLED);
  });
});

describe('the 2026-08-30 cases, end to end', () => {
  it("pi's strawberry turn: medium -> small, which is what makes it offloadable", async () => {
    // pi declared `medium` because its thinking slider said medium. offload_bands
    // is [small], so this exact turn ran on gh-copilot/claude-sonnet-4.6.
    const r = await classifyRequest({
      enabled: true, bandSource: 'caller', declaredBand: 'medium',
      messages: [sys('pi system prompt'), userMsg("how many r's in strawberry")],
      verdictFn: alwaysSmall,
    });
    assert.equal(r.band, 'small');
    assert.equal(r.source, 'classifier');
  });

  it("opencode's undeclared turn: high -> small", async () => {
    const r = await classifyRequest({
      enabled: true,
      bandSource: 'defaults.fg-chat (route asked for from-caller, caller supplied nothing)',
      declaredBand: 'high',
      messages: [sys('You are opencode…'), userMsg('say ok')],
      verdictFn: alwaysSmall,
    });
    assert.equal(r.band, 'small');
  });

  it('a mid-loop opencode turn from the captured corpus is left alone', async () => {
    const r = await classifyRequest({
      enabled: true, bandSource: 'caller', declaredBand: 'high',
      messages: [sys('You are opencode…'), userMsg('find the stop pipeline'),
        toolResult(), userMsg('· bash(Find stop pipeline core calls)')],
      verdictFn: alwaysSmall,
    });
    assert.equal(r.changed, false, 'mid-loop continuations must never be downgraded');
  });
});
