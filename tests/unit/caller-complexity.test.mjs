/**
 * Unit suite for proxy-bridge/caller-complexity.mjs.
 *
 * What a `from-caller` route is allowed to learn from the caller, and — the part
 * that actually matters — what it must REFUSE to learn. A band decides which
 * account pays for a call, so an unrecognised effort word turning into a band by
 * accident is a spend decision made by a typo.
 *
 * The reason this module exists: fg-chat/pi is `complexity: from-caller`, pi sent
 * no band, so every pi turn fell to defaults.fg-chat (high) and nothing pi did
 * was ever eligible for the semantic offload (observed 2026-08-28). pi does put
 * its per-turn thinking level on the wire as OpenAI's `reasoning_effort`, and
 * that is what these tests pin down.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveCallerComplexity, BANDS } from '../../proxy-bridge/caller-complexity.mjs';

describe('resolveCallerComplexity — an explicit band', () => {
  it('passes through every band the routing config understands', () => {
    for (const b of BANDS) {
      assert.equal(resolveCallerComplexity({ explicit: b }), b);
    }
  });

  it('is case- and whitespace-insensitive', () => {
    assert.equal(resolveCallerComplexity({ explicit: '  SMALL ' }), 'small');
  });

  it('wins over every weaker signal', () => {
    assert.equal(
      resolveCallerComplexity({ explicit: 'high', header: 'small', reasoningEffort: 'low' }),
      'high',
    );
  });

  it('does not become a band when it is not one', () => {
    // 'cheap' is a plausible thing for a caller to invent, and inventing it must
    // not move the call: the route's own default has to apply instead.
    assert.equal(resolveCallerComplexity({ explicit: 'cheap' }), '');
  });
});

describe('resolveCallerComplexity — the x-complexity header', () => {
  it('is read when there is no explicit body field', () => {
    assert.equal(resolveCallerComplexity({ header: 'medium' }), 'medium');
  });

  it('wins over reasoning_effort — it is the more deliberate statement', () => {
    assert.equal(resolveCallerComplexity({ header: 'high', reasoningEffort: 'minimal' }), 'high');
  });

  it('is ignored when it names something that is not a band', () => {
    assert.equal(resolveCallerComplexity({ header: 'urgent' }), '');
  });
});

describe('resolveCallerComplexity — reasoning_effort', () => {
  it('reads pi’s mapped vocabulary, which is already spelled as bands', () => {
    // config/agents/pi.sh gives the model a thinkingLevelMap that maps pi's
    // levels onto band names, so what arrives IS the band. Identity, on purpose:
    // neither side keeps a private table that can drift from the other's.
    assert.equal(resolveCallerComplexity({ reasoningEffort: 'small' }), 'small');
    assert.equal(resolveCallerComplexity({ reasoningEffort: 'medium' }), 'medium');
    assert.equal(resolveCallerComplexity({ reasoningEffort: 'high' }), 'high');
  });

  it('also reads the raw OpenAI vocabulary, for a client with no such map', () => {
    assert.equal(resolveCallerComplexity({ reasoningEffort: 'off' }), 'small');
    assert.equal(resolveCallerComplexity({ reasoningEffort: 'none' }), 'small');
    assert.equal(resolveCallerComplexity({ reasoningEffort: 'minimal' }), 'small');
    assert.equal(resolveCallerComplexity({ reasoningEffort: 'low' }), 'small');
    assert.equal(resolveCallerComplexity({ reasoningEffort: 'xhigh' }), 'high');
    assert.equal(resolveCallerComplexity({ reasoningEffort: 'max' }), 'high');
  });

  it('is what makes a cheap pi turn offloadable at all', () => {
    // `small` is the only band in semantic_routing.offload_bands, so this single
    // mapping is the whole difference between "how many r's in strawberry" going
    // to a paid account and going to the free local model.
    assert.equal(resolveCallerComplexity({ reasoningEffort: 'low' }), 'small');
  });

  it('refuses an unknown effort word rather than guessing a band', () => {
    assert.equal(resolveCallerComplexity({ reasoningEffort: 'zzz' }), '');
    assert.equal(resolveCallerComplexity({ reasoningEffort: 'very-high' }), '');
  });
});

describe('resolveCallerComplexity — nothing declared', () => {
  it('is empty for an absent, empty, or non-string input', () => {
    assert.equal(resolveCallerComplexity(), '');
    assert.equal(resolveCallerComplexity({}), '');
    assert.equal(resolveCallerComplexity({ explicit: '' }), '');
    assert.equal(resolveCallerComplexity({ explicit: 3 }), '');
    assert.equal(resolveCallerComplexity({ reasoningEffort: null }), '');
    assert.equal(resolveCallerComplexity({ header: ['small'] }), '');
  });

  it('never reads prompt content — there is nowhere to put it', () => {
    // Guards the design decision llm-routing.yaml argues for at length: the band
    // is a declaration, not an inference. If this module ever grows a `messages`
    // input, this test is the thing that should have to be deleted first.
    assert.deepEqual(
      Object.keys({ explicit: 1, header: 1, reasoningEffort: 1 }).sort(),
      ['explicit', 'header', 'reasoningEffort'].sort(),
    );
    assert.equal(resolveCallerComplexity({ messages: [{ role: 'user', content: 'trivial' }] }), '');
  });
});
