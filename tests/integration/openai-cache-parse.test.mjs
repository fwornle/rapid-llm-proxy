/**
 * Phase 83-02 Task 1 (D-09 / IN-05) — OpenAI-wire cache-parse unit suite.
 *
 * Proves, against the SHIPPED compiled helper (../../dist/usage-cache.js — run
 * AFTER `npm run build`), that parseOpenAICache extracts the OpenAI prompt-cache
 * counter (usage.prompt_tokens_details.cached_tokens → cache_read_tokens) and
 * that it mirrors parseUsageCache's pure / never-throw / coalesce-to-0 contract:
 *
 *   Test 1 — a well-formed usage object with prompt_tokens_details.cached_tokens
 *            yields cache_read_tokens = that value, cache_write_tokens = 0
 *            (OpenAI has no cache-write field).
 *   Test 2 — usage WITHOUT prompt_tokens_details coalesces cache_read_tokens to 0
 *            (never undefined / NaN).
 *   Test 3 — null and {} both return zeros WITHOUT throwing.
 *   Test 4 — a non-numeric cached_tokens coalesces to 0.
 *
 * These are pure-helper assertions (no live daemon), so nothing is gated on
 * LLM_PROXY_LIVE. Built-in node:test + node:assert/strict only; no external deps.
 * (Env-gate convention — LLM_PROXY_LIVE=1, NOT argv — is honored where a live
 * daemon IS required; the pure-helper cases below need no gate. See memory
 * reference_node_test_argv_live_gate: trailing argv is dropped for child procs.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseOpenAICache } from '../../dist/usage-cache.js';

test('(1) cached_tokens on prompt_tokens_details → cache_read_tokens; write=0', () => {
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 40 },
  };
  const { cache_read_tokens, cache_write_tokens } = parseOpenAICache(usage);
  assert.equal(cache_read_tokens, 40);
  assert.equal(cache_write_tokens, 0); // OpenAI exposes no cache-write counter
});

test('(2) no prompt_tokens_details → cache_read_tokens coalesces to 0', () => {
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
  const { cache_read_tokens, cache_write_tokens } = parseOpenAICache(usage);
  assert.equal(cache_read_tokens, 0);
  assert.equal(cache_write_tokens, 0);
  // Never undefined / NaN.
  assert.equal(Number.isFinite(cache_read_tokens), true);
  assert.equal(Number.isFinite(cache_write_tokens), true);
});

test('(3) null / {} return zeros without throwing', () => {
  for (const bad of [null, {}, undefined]) {
    const out = parseOpenAICache(bad);
    assert.equal(out.cache_read_tokens, 0);
    assert.equal(out.cache_write_tokens, 0);
  }
});

test('(4) non-numeric cached_tokens coalesces to 0', () => {
  for (const bad of [
    { prompt_tokens_details: { cached_tokens: 'x' } },
    { prompt_tokens_details: { cached_tokens: null } },
    { prompt_tokens_details: { cached_tokens: NaN } },
    { prompt_tokens_details: 'nope' },
    { prompt_tokens_details: 42 },
  ]) {
    const out = parseOpenAICache(bad);
    assert.equal(out.cache_read_tokens, 0);
    assert.equal(out.cache_write_tokens, 0);
  }
});
