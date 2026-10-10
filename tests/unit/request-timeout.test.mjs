// Run: node --test tests/unit/request-timeout.test.mjs
//
// proxy-bridge/request-timeout.mjs — a provider's declared timeout_ms is a
// ceiling, not a default a caller can raise.
//
// The named regression below is the one that motivated the module:
// bg-consolidator-insight sends timeout: 300000, and on 2026-09-02 that erased
// qwen-local's own bound 24 times over, for ~2 hours of dead wait on a local
// endpoint whose entire point is that it is not worth waiting on for long.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveRequestTimeout,
  resolveProviderTimeout,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '../../proxy-bridge/request-timeout.mjs';

describe('the provider ceiling caps the caller', () => {
  it('caps a caller that asks for more than the provider allows', () => {
    assert.equal(
      resolveRequestTimeout({ callerTimeoutMs: 300_000, providerTimeoutMs: 75_000 }),
      75_000,
    );
  });

  it('the bg-consolidator-insight regression: 300s against qwen-local', () => {
    // Before the fix this resolved to 300_000 and stalled for five minutes.
    const resolved = resolveRequestTimeout({
      callerTimeoutMs: 300_000,
      providerTimeoutMs: 75_000,
    });
    assert.ok(resolved <= 75_000, `waited ${resolved}ms on a 75s endpoint`);
  });

  it('honours a caller that asks for LESS — the cap is one-directional', () => {
    assert.equal(
      resolveRequestTimeout({ callerTimeoutMs: 5_000, providerTimeoutMs: 75_000 }),
      5_000,
    );
  });
});

describe('what applies when one side says nothing', () => {
  it('uses the provider ceiling when the caller states no timeout', () => {
    assert.equal(resolveRequestTimeout({ providerTimeoutMs: 30_000 }), 30_000);
  });

  it('uses the default when the provider declares none', () => {
    // parseRoutingConfig yields null for an undeclared timeout_ms — see
    // tests/unit/routing-config.test.mjs, "so the dispatcher default applies".
    assert.equal(
      resolveRequestTimeout({ callerTimeoutMs: undefined, providerTimeoutMs: null }),
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
  });

  it('still caps the caller at the default when the provider declares none', () => {
    assert.equal(
      resolveRequestTimeout({ callerTimeoutMs: 300_000, providerTimeoutMs: null }),
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
  });

  it('falls back to the default with no arguments at all', () => {
    assert.equal(resolveRequestTimeout(), DEFAULT_REQUEST_TIMEOUT_MS);
    assert.equal(resolveRequestTimeout({}), DEFAULT_REQUEST_TIMEOUT_MS);
  });
});

describe('malformed input is "not stated", never coerced', () => {
  it('ignores unusable caller values rather than trusting them', () => {
    for (const bad of [0, -1, NaN, Infinity, '5000', null, undefined, {}]) {
      assert.equal(
        resolveRequestTimeout({ callerTimeoutMs: bad, providerTimeoutMs: 30_000 }),
        30_000,
        `caller value ${JSON.stringify(bad)} should not have applied`,
      );
    }
  });

  it('ignores unusable provider values and falls to the default', () => {
    for (const bad of [0, -1, NaN, Infinity, '30000', null, undefined]) {
      assert.equal(
        resolveRequestTimeout({ providerTimeoutMs: bad }),
        DEFAULT_REQUEST_TIMEOUT_MS,
        `provider value ${JSON.stringify(bad)} should not have applied`,
      );
    }
  });

  it('never returns a non-positive or infinite timeout', () => {
    const combos = [0, -1, NaN, Infinity, null, undefined, 1, 300_000];
    for (const c of combos) {
      for (const p of combos) {
        const r = resolveRequestTimeout({ callerTimeoutMs: c, providerTimeoutMs: p });
        assert.ok(
          Number.isFinite(r) && r > 0,
          `caller=${c} provider=${p} produced ${r}`,
        );
      }
    }
  });
});

describe('resolveProviderTimeout — per-band ceilings', () => {
  const qwen = {
    timeoutMs: 30_000,
    timeoutMsByBand: { medium: 210_000 },
  };

  it('a band with its own ceiling gets it', () => {
    assert.equal(resolveProviderTimeout(qwen, 'medium'), 210_000);
  });

  it('a band without one falls to the provider default', () => {
    assert.equal(resolveProviderTimeout(qwen, 'small'), 30_000);
    assert.equal(resolveProviderTimeout(qwen, 'high'), 30_000);
  });

  it('no band named at all falls to the provider default', () => {
    assert.equal(resolveProviderTimeout(qwen, null), 30_000);
    assert.equal(resolveProviderTimeout(qwen, undefined), 30_000);
  });

  it('a scalar-only provider behaves exactly as before', () => {
    const scalar = { timeoutMs: 20_000, timeoutMsByBand: null };
    for (const b of ['small', 'medium', 'high', null]) {
      assert.equal(resolveProviderTimeout(scalar, b), 20_000);
    }
  });

  it('no ceiling declared anywhere is null, not a number', () => {
    // null means "not stated" so the dispatcher default applies — distinct from
    // a provider that deliberately declares a long one.
    assert.equal(resolveProviderTimeout({ timeoutMs: null, timeoutMsByBand: null }, 'small'), null);
    assert.equal(resolveProviderTimeout(null, 'small'), null);
    assert.equal(resolveProviderTimeout(undefined, 'small'), null);
  });

  it('a per-band map with no provider default leaves other bands unstated', () => {
    const p = { timeoutMs: null, timeoutMsByBand: { medium: 210_000 } };
    assert.equal(resolveProviderTimeout(p, 'medium'), 210_000);
    assert.equal(resolveProviderTimeout(p, 'small'), null);
  });

  it('composes with the caller cap — the band ceiling is what caps', () => {
    // The bug this whole module exists for, now band-aware: a 300s caller
    // against medium is capped at medium's ceiling, not the provider default.
    const p = { timeoutMs: 30_000, timeoutMsByBand: { medium: 210_000 } };
    assert.equal(
      resolveRequestTimeout({ callerTimeoutMs: 300_000, providerTimeoutMs: resolveProviderTimeout(p, 'medium') }),
      210_000,
    );
    assert.equal(
      resolveRequestTimeout({ callerTimeoutMs: 300_000, providerTimeoutMs: resolveProviderTimeout(p, 'small') }),
      30_000,
    );
  });

  it('ignores an unusable per-band value and falls through', () => {
    for (const bad of [0, -1, NaN, Infinity, '210000', null]) {
      assert.equal(
        resolveProviderTimeout({ timeoutMs: 30_000, timeoutMsByBand: { medium: bad } }, 'medium'),
        30_000,
        `band value ${JSON.stringify(bad)} should not have applied`,
      );
    }
  });
});
