/**
 * Unit suite for the /v1/messages passthrough header builder
 * (proxy-bridge/anthropic-headers.mjs).
 *
 * REGRESSION ANCHOR. getClaudeOAuthToken() returns the whole keychain RECORD
 * ({ accessToken, expiresAt, refreshToken, subscriptionType }), not a string.
 * The passthrough interpolated the record directly:
 *
 *     fwdHeaders['authorization'] = `Bearer ${tok}`;   // -> "Bearer [object Object]"
 *
 * Anthropic answered 401 "Invalid bearer token", which is indistinguishable from
 * an expired or revoked subscription — so the documented "inject the Max-OAuth
 * bearer when the caller sent no auth" path looked like a provider-side
 * lockout and was diagnosed as one. Nothing caught it because the sibling call
 * site (completeClaudeCodeDirect) reads `.accessToken` correctly, leaving the
 * CLI-side Max path healthy; only credential-less callers were affected, and
 * the only such caller in normal use is an agent that is not Claude Code.
 *
 * The decisive assertion is not "an authorization header exists" — the buggy
 * version set one too. It is that the header carries the ACCESS TOKEN.
 *
 * Run: node --test tests/unit/anthropic-headers.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAnthropicForwardHeaders } from '../../proxy-bridge/anthropic-headers.mjs';

const RECORD = {
  accessToken: 'sk-ant-oat-TESTTOKEN',
  expiresAt: Date.now() + 3_600_000,
  refreshToken: 'sk-ant-ort-TESTREFRESH',
  subscriptionType: 'max',
};
const getToken = () => RECORD;

describe('buildAnthropicForwardHeaders — Max-OAuth injection', () => {
  it('injects the ACCESS TOKEN, not the keychain record', () => {
    const h = buildAnthropicForwardHeaders({ 'content-type': 'application/json' }, getToken);
    assert.equal(h['authorization'], `Bearer ${RECORD.accessToken}`);
    // The exact shape of the original bug.
    assert.ok(!String(h['authorization']).includes('[object Object]'),
      'authorization must not carry a stringified object');
    // The record's other fields must never reach the wire.
    assert.ok(!String(h['authorization']).includes(RECORD.refreshToken),
      'refresh token must never be forwarded');
  });

  it('adds the oauth beta header alongside an injected bearer', () => {
    const h = buildAnthropicForwardHeaders({}, getToken);
    assert.equal(h['anthropic-beta'], 'oauth-2025-04-20');
  });

  it("does not clobber a caller's own anthropic-beta", () => {
    const h = buildAnthropicForwardHeaders({ 'anthropic-beta': 'prompt-caching-2024-07-31' }, getToken);
    assert.equal(h['anthropic-beta'], 'prompt-caching-2024-07-31');
  });
});

describe('buildAnthropicForwardHeaders — transparency', () => {
  for (const authHeader of ['authorization', 'Authorization', 'x-api-key', 'X-Api-Key']) {
    it(`leaves a caller-supplied ${authHeader} untouched (no injection)`, () => {
      const h = buildAnthropicForwardHeaders({ [authHeader]: 'Bearer caller-own' }, getToken);
      assert.equal(h[authHeader], 'Bearer caller-own');
      // Injection must not fire, in EITHER header slot.
      if (authHeader.toLowerCase() !== 'authorization') {
        assert.ok(!('authorization' in h), 'must not inject alongside a caller credential');
      }
      assert.ok(!JSON.stringify(h).includes(RECORD.accessToken),
        'the Max token must not be added when the caller authenticated itself');
    });
  }

  it('injects nothing when the keychain has no token', () => {
    for (const missing of [() => null, () => undefined, () => ({}), undefined]) {
      const h = buildAnthropicForwardHeaders({ 'content-type': 'application/json' }, missing);
      assert.ok(!('authorization' in h));
      assert.ok(!('anthropic-beta' in h));
    }
  });
});

describe('buildAnthropicForwardHeaders — hop-by-hop handling', () => {
  it('drops hop-by-hop headers and forces identity encoding', () => {
    const h = buildAnthropicForwardHeaders({
      host: 'localhost:12435',
      'content-length': '123',
      connection: 'keep-alive',
      'accept-encoding': 'gzip, br',
      'x-agent': 'pi',
    }, getToken);
    for (const dropped of ['host', 'content-length', 'connection']) {
      assert.ok(!(dropped in h), `${dropped} must not be forwarded`);
    }
    // Forced, not forwarded — the SSE tap needs raw text.
    assert.equal(h['accept-encoding'], 'identity');
    // Everything else passes through, including the agent-binding headers.
    assert.equal(h['x-agent'], 'pi');
  });
});
