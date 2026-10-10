/**
 * Unit suite for the Anthropic prompt-caching primitive
 * (applyAnthropicCacheControl).
 *
 * Runner: `node --test src/anthropic-cache.test.ts` (Node 25 native TS type
 * stripping). The package.json `test` script (jest) is stale/uninstalled; the
 * live suites use node:test, and this file follows that convention.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAnthropicCacheControl, type CacheableRequestParts } from './anthropic-cache.ts';

const CC = { type: 'ephemeral' as const };

test('marks a string system prompt as a cacheable text block', () => {
  const out = applyAnthropicCacheControl({
    system: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.deepEqual(out.system, [
    { type: 'text', text: 'You are a helpful assistant.', cache_control: CC },
  ]);
});

test('marks only the last block of the last message', () => {
  const out = applyAnthropicCacheControl({
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'latest' },
    ],
  });
  assert.equal(out.messages[0].content, 'first');
  assert.equal(out.messages[1].content, 'reply');
  assert.deepEqual(out.messages[2].content, [{ type: 'text', text: 'latest', cache_control: CC }]);
});

test('marks the last TEXT block when content is a block array with trailing non-text', () => {
  const out = applyAnthropicCacheControl({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', source: { data: 'xxx' } },
        ],
      },
    ],
  });
  const blocks = out.messages[0].content as any[];
  assert.deepEqual(blocks[0].cache_control, CC); // last text block marked
  assert.equal(blocks[1].cache_control, undefined); // image untouched
});

test('does NOT mutate the caller inputs', () => {
  const parts: CacheableRequestParts = {
    system: 'sys',
    messages: [{ role: 'user', content: 'q' }],
  };
  const snapshotSystem = parts.system;
  const snapshotContent = parts.messages[0].content;
  applyAnthropicCacheControl(parts);
  assert.equal(parts.system, snapshotSystem); // still the raw string
  assert.equal(parts.messages[0].content, snapshotContent);
});

test('is a no-op when disabled', () => {
  const parts: CacheableRequestParts = { system: 'sys', messages: [{ role: 'user', content: 'q' }] };
  assert.equal(applyAnthropicCacheControl(parts, false), parts);
});

test('returns parts unchanged when there are no messages', () => {
  const parts: CacheableRequestParts = { system: 'sys', messages: [] };
  assert.equal(applyAnthropicCacheControl(parts), parts);
});

test('skips the system breakpoint when system is empty/absent', () => {
  const out = applyAnthropicCacheControl({
    system: '',
    messages: [{ role: 'user', content: 'q' }],
  });
  assert.equal(out.system, '');
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: 'q', cache_control: CC }]);
});

test('never throws on a malformed message shape', () => {
  const bad = { messages: [{ role: 'user' } as any] };
  assert.doesNotThrow(() => applyAnthropicCacheControl(bad));
});
