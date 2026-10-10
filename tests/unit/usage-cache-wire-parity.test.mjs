/**
 * Unit suite for the ONE property that makes token_usage rows comparable across
 * providers: `input_tokens` means the same thing on both wires.
 *
 * Anthropic reports fresh input and cache reads as two ADDITIVE counters.
 * OpenAI reports one `prompt_tokens` that already CONTAINS its cache hits, with
 * `cached_tokens` as a breakdown. Both parsers have always carried a comment
 * saying cache counters are "surfaced SEPARATELY from total_tokens ... the
 * caller must NOT fold it into the total" — and on the OpenAI path that was
 * false, not because a caller folded it in but because the provider already
 * had. Nothing tested it, so the two conventions coexisted in one column.
 *
 * What that cost, measured 2026-08-29 over 24h: the dashboard reported the
 * background mentions classifier at 51.9M tokens and intensively-used
 * foreground Opus-5 at 726K, understating the latter ~450x and inverting which
 * one dominated spend.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseUsageCache,
  parseOpenAICache,
  openAIFreshInputTokens,
} from '../../dist/usage-cache.js';

describe('wire parity — input_tokens means fresh input on both wires', () => {
  // The same logical call, as each provider reports it: 24,000 prompt tokens of
  // which 23,000 were served from cache, and 500 tokens out.
  const anthropic = {
    input_tokens: 1000,           // fresh only
    output_tokens: 500,
    cache_read_input_tokens: 23000,
  };
  const openai = {
    prompt_tokens: 24000,         // fresh + cached, together
    completion_tokens: 500,
    total_tokens: 24500,
    prompt_tokens_details: { cached_tokens: 23000 },
  };

  it('reports the same fresh input for the same call', () => {
    assert.equal(openAIFreshInputTokens(openai), anthropic.input_tokens);
  });

  it('reports the same cache read for the same call', () => {
    assert.equal(parseOpenAICache(openai).cache_read_tokens, parseUsageCache(anthropic).cacheRead);
  });

  it('yields the same total on both wires — the property the column needs', () => {
    const anthropicTotal = anthropic.input_tokens + anthropic.output_tokens;
    const openaiTotal = openAIFreshInputTokens(openai) + openai.completion_tokens;
    assert.equal(openaiTotal, anthropicTotal, 'totals must be the same quantity');
    assert.notEqual(openaiTotal, openai.total_tokens,
      'and must NOT be the provider-reported total, which double-counts the cache');
  });

  it('makes the cache counter additive on both wires', () => {
    // "Everything the prompt cost" must be reconstructible the same way for
    // either provider — that is what lets a dashboard sum across them.
    const a = anthropic.input_tokens + parseUsageCache(anthropic).cacheRead;
    const o = openAIFreshInputTokens(openai) + parseOpenAICache(openai).cache_read_tokens;
    assert.equal(o, a);
    assert.equal(o, 24000, 'and equals the prompt size the provider actually charged for');
  });
});

describe('openAIFreshInputTokens — degenerate inputs', () => {
  it('is 0 for a missing or malformed usage object, never NaN', () => {
    for (const bad of [undefined, null, 'nope', 42, []]) {
      assert.equal(openAIFreshInputTokens(bad), 0, `${JSON.stringify(bad)} -> 0`);
    }
  });

  it('passes prompt_tokens straight through when nothing was cached', () => {
    // The common case: no cache breakpoint, so the two conventions already agree
    // and the subtraction must be a no-op rather than a behaviour change.
    assert.equal(openAIFreshInputTokens({ prompt_tokens: 900 }), 900);
    assert.equal(openAIFreshInputTokens({ prompt_tokens: 900, prompt_tokens_details: {} }), 900);
    assert.equal(openAIFreshInputTokens({ prompt_tokens: 900, prompt_tokens_details: { cached_tokens: 0 } }), 900);
  });

  it('clamps at zero rather than emitting a negative token count', () => {
    // Incoherent, but a negative would poison every downstream SUM().
    assert.equal(openAIFreshInputTokens({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 500 },
    }), 0);
  });

  it('ignores a non-numeric cached_tokens instead of trusting it', () => {
    assert.equal(openAIFreshInputTokens({
      prompt_tokens: 900,
      prompt_tokens_details: { cached_tokens: 'lots' },
    }), 900);
  });
});
