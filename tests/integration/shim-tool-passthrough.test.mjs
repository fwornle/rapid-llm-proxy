/**
 * Phase 82-03 (WIRE-04/05) — OpenAI-shim native tool-call passthrough suite.
 *
 * Proves the three drop-points the shim previously silenced, against the pure
 * mapping/gating helpers in ../../proxy-bridge/shim-tools.mjs (the SAME helpers
 * server.mjs imports at runtime — the HTTP response code is not directly
 * importable, so the pure logic is extracted here per the plan):
 *
 *   1. FORWARD  — shimToolFields keeps tools[]/tool_choice when present and
 *                 omits them entirely otherwise (tool-less requests byte-unchanged).
 *   2. MAP      — a provider result carrying toolCalls maps into the buffered
 *                 message.tool_calls + finish_reason 'tool_calls' AND the
 *                 single-shot SSE delta.tool_calls + terminal 'tool_calls'; the
 *                 no-toolCalls path is byte-identical to the prior 'stop' envelope.
 *   3. GATE     — a tools-bearing request routed at a tools-incapable provider
 *                 (claude-code CLI, --tools '') yields a LOUD error, never a
 *                 silent strip; a capable provider is preferred when present.
 *
 * Also asserts the shim task_id precedence (header > body > path), the
 * per-request binding seam Task 1 added for header-less agents.
 *
 * Built-in node:test + node:assert/strict only. Any live-proxy assertion is
 * gated on LLM_PROXY_LIVE=1 (env, NOT argv — memory reference_node_test_argv
 * _live_gate: trailing argv is dropped for child procs). The default run passes
 * purely against the pure helpers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  shimToolFields,
  hasToolCalls,
  buildBufferedChoice,
  buildStreamDelta,
  gateToolCapableChain,
  resolveShimTaskId,
  matchShimPath,
  mergeCopilotChoices,
  responsesToChatBody,
  responseSseFrames,
  matchResponsesShimPath,
  hasNonTextParts,
  flattenContentToText,
  functionCallItemId,
  repairFunctionCallIds,
} from '../../proxy-bridge/shim-tools.mjs';

test('Responses request converts developer/input/function tools to the shared envelope', () => {
  const converted = responsesToChatBody({
    model: 'gpt-5.6-sol',
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: 'system' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { type: 'function_call_output', call_id: 'call-1', output: 'done' },
    ],
    tools: [{ type: 'function', name: 'read', description: 'read', parameters: { type: 'object' } }],
    reasoning: { effort: 'low' },
    stream: true,
  });
  assert.equal(converted.model, 'gpt-5.6-sol');
  assert.deepEqual(converted.messages.map(m => m.role), ['system', 'user', 'tool']);
  assert.deepEqual(converted.messages[1].content, [{ type: 'text', text: 'hello' }]);
  assert.equal(converted.tools[0].function.name, 'read');
  assert.equal(converted.reasoning_effort, 'low');
  assert.equal(converted.stream, true);
});

test('Responses SSE frames preserve text and tool calls', () => {
  const frames = responseSseFrames({
    content: 'checking',
    model: 'gpt-5.6-sol',
    tokens: { input: 10, output: 3, total: 13 },
    toolCalls: [{ id: 'call-1', function: { name: 'read', arguments: '{"x":1}' } }],
  }, 'resp-1');
  assert.ok(frames.some(frame => frame.type === 'response.output_text.delta'));
  assert.ok(frames.some(frame => frame.type === 'response.function_call_arguments.done'));
  const completed = frames.at(-1);
  assert.equal(completed.type, 'response.completed');
  assert.equal(completed.response.usage.total_tokens, 13);
  assert.deepEqual(completed.response.output.map(item => item.type), ['message', 'function_call']);
});

test('Responses shim path accepts bare and task-scoped OpenCode forms', () => {
  assert.deepEqual(matchResponsesShimPath('/v1/opencode/responses'), { agent: 'opencode', taskId: '', project: '' });
  assert.deepEqual(matchResponsesShimPath('/v1/opencode/t/task-1/responses'), { agent: 'opencode', taskId: 'task-1', project: '' });
  assert.equal(matchResponsesShimPath('/v1/copilot/responses'), null);
});

const SAMPLE_TOOLS = [{ type: 'function', function: { name: 'write_file', parameters: { type: 'object' } } }];
const SAMPLE_TOOL_CALLS = [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"/tmp/x"}' } }];

// ── 1. FORWARD ────────────────────────────────────────────────────────────────
test('shimToolFields forwards tools[] and tool_choice when present', () => {
  const out = shimToolFields({ tools: SAMPLE_TOOLS, tool_choice: 'auto' });
  assert.deepEqual(out.tools, SAMPLE_TOOLS);
  assert.equal(out.tool_choice, 'auto');
});

test('shimToolFields omits both keys for a tool-less body (byte-unchanged)', () => {
  const out = shimToolFields({ model: 'x', messages: [] });
  assert.equal('tools' in out, false);
  assert.equal('tool_choice' in out, false);
  assert.deepEqual(out, {});
});

test('shimToolFields forwards tool_choice even when tools omitted', () => {
  const out = shimToolFields({ tool_choice: 'none' });
  assert.equal(out.tool_choice, 'none');
  assert.equal('tools' in out, false);
});

// ── 2. MAP — buffered ──────────────────────────────────────────────────────────
test('buildBufferedChoice maps toolCalls into message.tool_calls + finish_reason tool_calls', () => {
  const choice = buildBufferedChoice({ content: '', toolCalls: SAMPLE_TOOL_CALLS });
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.deepEqual(choice.message.tool_calls, SAMPLE_TOOL_CALLS);
  assert.equal(choice.message.role, 'assistant');
});

test('buildBufferedChoice is byte-identical to the prior stop envelope with no toolCalls', () => {
  const choice = buildBufferedChoice({ content: 'hello' });
  assert.deepEqual(choice, { index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' });
  assert.equal('tool_calls' in choice.message, false);
});

// ── 2. MAP — single-shot SSE ────────────────────────────────────────────────────
test('buildStreamDelta emits delta.tool_calls + terminal finish_reason tool_calls', () => {
  const { delta, finishReason } = buildStreamDelta({ content: '', toolCalls: SAMPLE_TOOL_CALLS });
  assert.deepEqual(delta.tool_calls, SAMPLE_TOOL_CALLS);
  assert.equal(delta.role, 'assistant');
  assert.equal(finishReason, 'tool_calls');
});

test('buildStreamDelta mirrors the content reframe byte-for-byte with no toolCalls', () => {
  const { delta, finishReason } = buildStreamDelta({ content: 'hi' });
  assert.deepEqual(delta, { role: 'assistant', content: 'hi' });
  assert.equal('tool_calls' in delta, false);
  assert.equal(finishReason, 'stop');
});

test('hasToolCalls guards empty/absent arrays', () => {
  assert.equal(hasToolCalls({ toolCalls: SAMPLE_TOOL_CALLS }), true);
  assert.equal(hasToolCalls({ toolCalls: [] }), false);
  assert.equal(hasToolCalls({}), false);
  assert.equal(hasToolCalls(null), false);
});

// ── 3. GATE — capability, fail-loud never silent-strip ──────────────────────────
const supportsFn = (p) => p === 'copilot'; // only copilot forwards tools[] in the runtime

test('gateToolCapableChain fails loudly when only a tools-incapable provider is reachable', () => {
  const { chain, error } = gateToolCapableChain(['claude-code'], true, supportsFn);
  assert.equal(error?.type, 'NO_TOOL_CAPABLE_PROVIDER');
  assert.match(error.message, /claude-code/);
  assert.deepEqual(chain, []); // never a stripped request onto claude-code
});

test('gateToolCapableChain prefers the capable provider, dropping incapable ones', () => {
  const { chain, error } = gateToolCapableChain(['claude-code', 'copilot', 'groq'], true, supportsFn);
  assert.equal(error, null);
  assert.deepEqual(chain, ['copilot']);
});

test('gateToolCapableChain leaves the chain untouched for a tool-less request', () => {
  const original = ['claude-code', 'copilot'];
  const { chain, error } = gateToolCapableChain(original, false, supportsFn);
  assert.equal(error, null);
  assert.deepEqual(chain, original);
});

// ── task_id precedence (Task 1 per-request binding) ─────────────────────────────
test('resolveShimTaskId precedence is header > body > path', () => {
  assert.equal(resolveShimTaskId('H', 'B', 'P'), 'H');
  assert.equal(resolveShimTaskId('', 'B', 'P'), 'B');
  assert.equal(resolveShimTaskId('', '', 'P'), 'P');
  assert.equal(resolveShimTaskId('', '', ''), ''); // falls through to ambient downstream
});

// ── task-scoped shim path (seam B: per-request binding for header-less agents) ──
test('matchShimPath parses /v1/<agent>/t/<taskId>/chat/completions for all shim agents', () => {
  assert.deepEqual(matchShimPath('/v1/opencode/t/exp-abc--r0/chat/completions'), { agent: 'opencode', band: null, taskId: 'exp-abc--r0', project: '' });
  assert.deepEqual(matchShimPath('/v1/copilot/t/task123/chat/completions'), { agent: 'copilot', band: null, taskId: 'task123', project: '' });
  assert.deepEqual(matchShimPath('/v1/pi/t/task123/chat/completions'), { agent: 'pi', band: null, taskId: 'task123', project: '' });
  // mastra is NOT here: 11c788f retired the /v1/mastra shim route, so the path
  // no longer parses. This assertion outlived the route it covered.
  assert.equal(matchShimPath('/v1/mastra/t/task123/chat/completions'), null);
});

test('matchShimPath parses an optional band segment, with or without a task', () => {
  // The copilot seam: a band declared in the URL because the CLI can declare it
  // nowhere else. Both forms matter — an interactive launch has no TASK_ID, so
  // band-only is the one that actually runs day to day.
  assert.deepEqual(matchShimPath('/v1/copilot/b/small/chat/completions'),
    { agent: 'copilot', band: 'small', taskId: '', project: '' });
  assert.deepEqual(matchShimPath('/v1/copilot/b/small/t/task123/chat/completions'),
    { agent: 'copilot', band: 'small', taskId: 'task123', project: '' });
  assert.deepEqual(matchShimPath('/v1/pi/b/high/t/x-1/chat/completions'),
    { agent: 'pi', band: 'high', taskId: 'x-1', project: '' });
});

test('matchShimPath parses an optional leading /p/<project> segment', () => {
  // The repo the agent was launched in. copilot can send no x-project header,
  // so the launcher puts it in the URL, before band and task.
  assert.deepEqual(matchShimPath('/v1/copilot/p/coding/chat/completions'),
    { agent: 'copilot', band: null, taskId: '', project: 'coding' });
  assert.deepEqual(matchShimPath('/v1/copilot/p/a2a-xpr/b/small/t/task123/chat/completions'),
    { agent: 'copilot', band: 'small', taskId: 'task123', project: 'a2a-xpr' });
  // Order is fixed: a project after the band is not a project.
  assert.equal(matchShimPath('/v1/copilot/b/small/p/coding/chat/completions'), null);
  assert.deepEqual(matchResponsesShimPath('/v1/opencode/p/coding/t/x/responses'),
    { agent: 'opencode', taskId: 'x', project: 'coding' });
});

test('matchShimPath rejects an unknown band rather than ignoring it', () => {
  // A typo must produce a plainly wrong URL, not a silently dropped band —
  // otherwise the launcher looks configured and the routing never changes.
  assert.equal(matchShimPath('/v1/copilot/b/cheap/chat/completions'), null);
  assert.equal(matchShimPath('/v1/copilot/b/SMALL/chat/completions'), null);
  assert.equal(matchShimPath('/v1/copilot/b//chat/completions'), null);
});

test('matchShimPath still requires at least one binding segment', () => {
  // Without this the optional groups would newly match a bare
  // /v1/<agent>/chat/completions, which is either handled by the exact
  // SHIM_PATH_AGENTS map or is deliberately not a shim path.
  assert.equal(matchShimPath('/v1/opencode/chat/completions'), null);
  assert.equal(matchShimPath('/v1/pi/chat/completions'), null);
});

test('matchShimPath returns null for non-scoped / unknown-agent / malformed paths', () => {
  assert.equal(matchShimPath('/v1/chat/completions'), null);            // bare shim → ambient binding
  assert.equal(matchShimPath('/v1/claude/t/x/chat/completions'), null); // claude uses the anthropic tap, not this seam
  assert.equal(matchShimPath('/v1/opencode/t//chat/completions'), null);// empty taskId segment
  assert.equal(matchShimPath('/v1/opencode/t/x/embeddings'), null);     // only the completions endpoint binds here
  assert.equal(matchShimPath(''), null);
  assert.equal(matchShimPath(undefined), null);
});

test('matchShimPath returns the raw taskId (sanitization is the caller’s job)', () => {
  // The helper is pure; server.mjs applies sanitizeTaskId before any DB/file use.
  assert.equal(matchShimPath('/v1/opencode/t/..%2Fescape/chat/completions').taskId, '..%2Fescape');
});

// ── LIVE (gated) — real /v1/copilot tools round-trip, deferred behavioral gate ──
test('LIVE: /v1/copilot tools round-trip produces native tool_calls', { skip: process.env.LLM_PROXY_LIVE !== '1' }, () => {
  // Behavioral acceptance (a real file on disk from a copilot BYOK / opencode
  // agentic loop) is Plan 06's live gate. Placeholder so the shape is documented;
  // the offline suite above fully covers the wiring in isolation.
  assert.ok(true);
});

// ── split-choices merge (enterprise Copilot bridge) ───────────────────────────
//
// The endpoint returns an Anthropic turn's text block and tool_use block as two
// SEPARATE choices. Reading only choices[0] dropped the tool call of every turn
// that narrated before acting — the "agent stops after each line and never does
// anything" failure on pi and opencode. Shape captured live from
// copilot-api.<tenant>.ghe.com with tool_choice pinned to the function.
const SPLIT_CHOICES_BODY = {
  choices: [
    { finish_reason: 'tool_calls', message: { role: 'assistant', content: "I'll check the current weather in Munich for you." } },
    { finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'toolu_01KD', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Munich"}' } }] } },
  ],
  usage: { completion_tokens: 66 },
};

test('mergeCopilotChoices recovers a tool call stranded in choices[1]', () => {
  const { content, toolCalls } = mergeCopilotChoices(SPLIT_CHOICES_BODY);
  assert.equal(content, "I'll check the current weather in Munich for you.");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, 'get_weather');
  assert.equal(toolCalls[0].id, 'toolu_01KD');
});

test('the merged result maps to finish_reason tool_calls, not stop', () => {
  // The regression in one line: before the merge this envelope said 'stop', so
  // the agent treated a tool-calling turn as a finished text turn and ended it.
  const result = mergeCopilotChoices(SPLIT_CHOICES_BODY);
  assert.equal(buildBufferedChoice(result).finish_reason, 'tool_calls');
  assert.equal(buildStreamDelta(result).finishReason, 'tool_calls');
});

test('mergeCopilotChoices stamps index so the SSE delta is spec-valid', () => {
  const body = { choices: [
    { message: { content: 'checking both' } },
    { message: { tool_calls: [
      { id: 'a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Munich"}' } },
      { id: 'b', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Berlin"}' } },
    ] } },
  ] };
  const { toolCalls } = mergeCopilotChoices(body);
  assert.deepEqual(toolCalls.map((t) => t.index), [0, 1]);
  // buildStreamDelta re-emits these verbatim into delta.tool_calls, where a
  // client keys fragment accumulation on index.
  assert.deepEqual(buildStreamDelta({ content: '', toolCalls }).delta.tool_calls.map((t) => t.index), [0, 1]);
});

test('mergeCopilotChoices leaves the ordinary single-choice shape unchanged', () => {
  const { content, toolCalls } = mergeCopilotChoices({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'just prose' } }],
  });
  assert.equal(content, 'just prose');
  assert.equal(toolCalls, undefined);
  assert.equal(buildBufferedChoice({ content, toolCalls }).finish_reason, 'stop');
});

test('mergeCopilotChoices never throws on a malformed or empty body', () => {
  for (const bad of [undefined, null, {}, { choices: null }, { choices: [] }, { choices: [null] }, { choices: [{}] }]) {
    const out = mergeCopilotChoices(bad);
    assert.equal(out.content, '');
    assert.equal(out.toolCalls, undefined);
  }
});

// ── image passthrough (array-form content) ───────────────────────────────────
//
// The shim flattened every array-form content down to its text parts, so an
// attached image was deleted before the request left the proxy and the model
// reported "image input isn't supported" about a message that never carried one.
// Pure-text lists still flatten (the string-assuming legs need that); lists with
// a non-text part are preserved for the OpenAI-native legs.
const IMAGE_CONTENT = [
  { type: 'text', text: 'what is in this image?' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
];

test('hasNonTextParts distinguishes a pure-text list from one carrying an image', () => {
  assert.equal(hasNonTextParts(IMAGE_CONTENT), true);
  assert.equal(hasNonTextParts([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), false);
  assert.equal(hasNonTextParts('a plain string'), false);
  assert.equal(hasNonTextParts(undefined), false);
  assert.equal(hasNonTextParts([]), false);
});

test('flattenContentToText keeps text and marks what it had to drop', () => {
  const out = flattenContentToText(IMAGE_CONTENT);
  assert.match(out, /what is in this image\?/);
  assert.match(out, /\[image omitted: this provider is text-only\]/);
  // The marker exists so a text-only leg cannot present an image-bearing turn
  // as though no image was ever attached — the behaviour that made the drop
  // look like a model/session limitation.
  assert.equal(out.includes('[object Object]'), false);
});

test('flattenContentToText passes a plain string through untouched', () => {
  assert.equal(flattenContentToText('already text'), 'already text');
  assert.equal(flattenContentToText(undefined), undefined);
});

test('flattenContentToText never emits [object Object] for an unknown part', () => {
  const out = flattenContentToText([{ type: 'input_audio', input_audio: {} }, { foo: 'bar' }]);
  assert.equal(out.includes('[object Object]'), false);
  assert.match(out, /input_audio omitted/);
});

test('Responses SSE frames carry the cache split, not just fresh input', () => {
  // `result.tokens.input` is FRESH input (cache counted separately); the
  // Responses wire wants `input_tokens` INCLUSIVE of cache hits plus
  // `input_tokens_details.cached_tokens`. Reporting only the fresh slice is what
  // made a cache-heavy OpenCode conversation read as nearly empty.
  const [created] = responseSseFrames({
    content: 'ok',
    model: 'gpt-5.6-sol',
    tokens: { input: 4130, output: 69, total: 4199, cache_read_tokens: 53067 },
  }, 'resp-cache');
  assert.equal(created.response.usage.input_tokens, 4130 + 53067);
  assert.equal(created.response.usage.input_tokens_details.cached_tokens, 53067);
  assert.equal(created.response.usage.total_tokens, 4130 + 53067 + 69);
});

test('Responses SSE frames omit the cache detail when nothing was cached', () => {
  const [created] = responseSseFrames({
    content: 'ok',
    model: 'gpt-5.6-sol',
    tokens: { input: 8, output: 10, total: 18 },
  }, 'resp-nocache');
  assert.equal(created.response.usage.input_tokens, 8);
  assert.equal(created.response.usage.total_tokens, 18);
  assert.ok(!('input_tokens_details' in created.response.usage));
});

// A Responses function_call has an item id (`fc_...`) AND a call id (`call_...`).
// Emitting the call id as the item id made the client echo `call_...` back as
// input[n].id, and Copilot refused the next turn with a 400: "Expected an ID that
// begins with 'fc'". Every coding --opencode session on a Copilot model broke on
// the first turn after a tool call.
test('Responses function_call items keep an fc item id apart from the call id', () => {
  const frames = responseSseFrames({
    content: '',
    toolCalls: [
      { index: 0, id: 'call_abc', itemId: 'fc_upstream', type: 'function', function: { name: 'a', arguments: '{}' } },
      { index: 1, id: 'call_def', type: 'function', function: { name: 'b', arguments: '{}' } },
    ],
  }, 'resp-ids');
  const done = frames.find(frame => frame.type === 'response.completed');
  const calls = done.response.output.filter(item => item.type === 'function_call');
  assert.deepEqual(calls.map(c => [c.id, c.call_id]), [['fc_upstream', 'call_abc'], ['fc_def', 'call_def']]);
  for (const c of calls) assert.ok(c.id.startsWith('fc'), `${c.id} must begin with fc`);
});

test('functionCallItemId is stable for a call id and never returns a call_ id', () => {
  assert.equal(functionCallItemId(undefined, 'call_x1', 0), functionCallItemId(undefined, 'call_x1', 5));
  assert.equal(functionCallItemId('call_x1', 'call_x1', 0), 'fc_x1');
  assert.equal(functionCallItemId(undefined, undefined, 3), 'fc_3');
});

test('repairFunctionCallIds fixes call_ item ids in history and leaves good input alone', () => {
  const bad = [
    { role: 'user', content: 'hi' },
    { type: 'function_call', id: 'call_jnih', call_id: 'call_jnih', name: 'skill', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_jnih', output: 'ok' },
  ];
  const fixed = repairFunctionCallIds(bad);
  assert.equal(fixed[1].id, 'fc_jnih');
  assert.equal(fixed[1].call_id, 'call_jnih');
  assert.equal(fixed[2], bad[2]);
  const good = [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'x', arguments: '{}' }];
  assert.equal(repairFunctionCallIds(good), good);
  const noId = [{ type: 'function_call', call_id: 'call_1', name: 'x', arguments: '{}' }];
  assert.equal(repairFunctionCallIds(noId), noId);
});
