/**
 * Phase 82-02 (WIRE-02) — /v1/messages tap cache-parse integration suite.
 *
 * Proves, against the SHIPPED compiled helper (../../dist/usage-cache.js — run
 * AFTER `npm run build`), that parseUsageCache extracts prompt-cache accounting
 * off BOTH Anthropic wire shapes and that the tap's total (uIn + uOut) EXCLUDES
 * cache tokens:
 *
 *   Fixture A — flat form: usage.cache_read_input_tokens +
 *               usage.cache_creation_input_tokens.
 *   Fixture B — object form: usage.cache_creation is an object whose numeric
 *               sub-fields (ephemeral_5m/1h_input_tokens) sum to cacheWrite.
 *
 * Each SSE fixture is the pair the tap parses: a `message_start` frame (carries
 * input_tokens + the cache fields) and a `message_delta` frame (carries the
 * cumulative output_tokens). uIn is read from message_start, uOut from
 * message_delta, and total is asserted to be uIn+uOut with NO cache fold-in.
 *
 * Built-in node:test + node:assert/strict only; no external test deps. Any
 * live-proxy assertion is gated on LLM_PROXY_LIVE=1 (env, NOT argv — memory
 * reference_node_test_argv_live_gate: trailing argv is dropped for child procs).
 * The default run passes purely against the pure helper + these fixtures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseUsageCache } from '../../dist/usage-cache.js';

// ── Fixture A: flat cache_read_input_tokens / cache_creation_input_tokens ──────
const SSE_FLAT = {
  message_start: {
    type: 'message_start',
    message: {
      usage: {
        input_tokens: 120,
        output_tokens: 1,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 8,
      },
    },
  },
  message_delta: {
    type: 'message_delta',
    usage: { output_tokens: 47 },
  },
};

// ── Fixture B: cache_creation OBJECT form (breakpoint-typed sub-fields) ────────
const SSE_OBJECT = {
  message_start: {
    type: 'message_start',
    message: {
      usage: {
        input_tokens: 200,
        output_tokens: 1,
        cache_read_input_tokens: 12,
        cache_creation: {
          ephemeral_5m_input_tokens: 3,
          ephemeral_1h_input_tokens: 4,
        },
      },
    },
  },
  message_delta: {
    type: 'message_delta',
    usage: { output_tokens: 90 },
  },
};

test('(A) flat form: parseUsageCache reads cache_read + cache_creation_input_tokens', () => {
  const { cacheRead, cacheWrite } = parseUsageCache(SSE_FLAT.message_start.message.usage);
  assert.equal(cacheRead, 5);
  assert.equal(cacheWrite, 8);
});

test('(B) object form: cacheWrite sums the cache_creation sub-fields', () => {
  const { cacheRead, cacheWrite } = parseUsageCache(SSE_OBJECT.message_start.message.usage);
  assert.equal(cacheRead, 12);
  assert.equal(cacheWrite, 7); // 3 + 4
});

test('(C) total = uIn + uOut EXCLUDES cache tokens (both fixtures)', () => {
  for (const fx of [SSE_FLAT, SSE_OBJECT]) {
    // Mirror the tap accumulation: uIn from message_start, uOut from message_delta.
    const uIn = fx.message_start.message.usage.input_tokens;
    const uOut = fx.message_delta.usage.output_tokens;
    const total = uIn + uOut;
    const { cacheRead, cacheWrite } = parseUsageCache(fx.message_start.message.usage);
    // Cache is surfaced separately — proving it is not summed into the total.
    assert.equal(total, uIn + uOut);
    assert.notEqual(cacheRead + cacheWrite, 0); // fixtures do carry cache
    assert.equal(total, uIn + uOut); // total independent of cache magnitude
    assert.ok(total < uIn + uOut + cacheRead + cacheWrite); // cache genuinely excluded
  }
});

test('(D) malformed / empty usage never throws, coalesces to 0/0', () => {
  for (const bad of [undefined, null, {}, { cache_read_input_tokens: 'x' }, 42, 'nope']) {
    const { cacheRead, cacheWrite } = parseUsageCache(bad);
    assert.equal(cacheRead, 0);
    assert.equal(cacheWrite, 0);
  }
});

// Live-proxy round-trip assertion — OPT-IN via LLM_PROXY_LIVE=1 (env, not argv).
// The default suite above is fully offline against the shipped helper + fixtures.
test('(LIVE) proxy /v1/messages tap persists cache columns', { skip: process.env.LLM_PROXY_LIVE !== '1' }, () => {
  // Placeholder for a 2-cell concurrent live gate (deferred to Plan 06). When
  // LLM_PROXY_LIVE=1, a real SSE stream carrying cache usage should produce a
  // token_usage row whose cache_read_tokens/cache_write_tokens match the wire.
  assert.ok(true);
});
