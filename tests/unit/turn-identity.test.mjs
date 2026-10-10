/**
 * Unit suite for turn identity (proxy-bridge/turn-identity.mjs).
 *
 * The module exists to answer "which calls belonged to one turn?" from the
 * request alone, without any agent sending a turn number. Two properties carry
 * the whole feature:
 *
 *   1. The index HOLDS STILL across an agentic loop. If it moved on each tool
 *      hop, every call would land in its own turn and the By-turn view would be
 *      the By-call view with extra chrome.
 *   2. It holds still on BOTH wires. On the Anthropic wire a tool result is a
 *      `role: 'user'` message, so the obvious count is wrong there and only
 *      there — the exact bug this suite is built to catch.
 *
 * Run: node --test tests/unit/turn-identity.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  conversationKey,
  userTurnIndex,
  turnIdentity,
  turnPromptText,
} from '../../proxy-bridge/turn-identity.mjs';

// ── Fixtures: the real shapes, not simplified ones ───────────────────────────

const SYSTEM = { role: 'system', content: 'You are a helpful coding agent.' };

/** OpenAI wire: assistant asks for a tool, result comes back as role:'tool'. */
const openaiLoop = [
  SYSTEM,
  { role: 'user', content: 'what is this repo about?' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
  },
  { role: 'tool', tool_call_id: 'call_1', name: 'bash', content: 'README.md src/ tests/' },
];

/** Anthropic wire: the tool RESULT is a role:'user' message. */
const anthropicLoop = [
  SYSTEM,
  { role: 'user', content: 'what is this repo about?' },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'README.md src/ tests/' }],
  },
];

describe('userTurnIndex holds still across an agentic loop', () => {
  it('OpenAI wire: the tool hop does not advance the turn', () => {
    // The first call of the turn — nothing has come back yet.
    assert.equal(userTurnIndex(openaiLoop.slice(0, 2)), 1);
    // The second call, with the tool result in context. Same turn.
    assert.equal(userTurnIndex(openaiLoop), 1);
  });

  it('Anthropic wire: a tool_result arriving as role:user does not advance it', () => {
    // This is the assertion that fails if toolMeta() is dropped and the count
    // becomes a plain `role === 'user'` filter — it would read 2 here.
    assert.equal(userTurnIndex(anthropicLoop), 1);
  });

  it('a real second prompt advances it, on both wires', () => {
    const nextOpenai = [...openaiLoop,
      { role: 'assistant', content: 'It is an A2A proof-of-concept.' },
      { role: 'user', content: 'and what runs the agents?' },
    ];
    assert.equal(userTurnIndex(nextOpenai), 2);

    const nextAnthropic = [...anthropicLoop,
      { role: 'assistant', content: [{ type: 'text', text: 'It is an A2A proof-of-concept.' }] },
      { role: 'user', content: 'and what runs the agents?' },
    ];
    assert.equal(userTurnIndex(nextAnthropic), 2);
  });
});

describe('conversationKey is stable across the turns of one conversation', () => {
  it('every call of a growing conversation hashes to the same key', () => {
    const k1 = conversationKey(openaiLoop.slice(0, 2), 'pi');
    const k2 = conversationKey(openaiLoop, 'pi');
    const k3 = conversationKey([...openaiLoop, { role: 'user', content: 'follow-up' }], 'pi');
    assert.equal(k1, k2);
    assert.equal(k2, k3);
    assert.match(k1, /^[0-9a-f]{12}$/);
  });

  it('a different opening prompt is a different conversation', () => {
    const other = [SYSTEM, { role: 'user', content: 'something else entirely' }];
    assert.notEqual(conversationKey(openaiLoop, 'pi'), conversationKey(other, 'pi'));
  });

  it('the same prompt from a different agent is a different conversation', () => {
    // Two agents asking the same opening question are not one conversation, and
    // merging them would draw one turn spanning two providers for no reason.
    assert.notEqual(conversationKey(openaiLoop, 'pi'), conversationKey(openaiLoop, 'opencode'));
  });

  it('array-shaped content hashes the same as its text', () => {
    // A claude conversation whose first user message is a content-block array
    // must not rekey against the same text sent as a plain string.
    const asString = [SYSTEM, { role: 'user', content: 'hello there' }];
    const asBlocks = [SYSTEM, { role: 'user', content: [{ type: 'text', text: 'hello there' }] }];
    assert.equal(conversationKey(asString, 'claude'), conversationKey(asBlocks, 'claude'));
  });
});

describe('the not-recorded contract', () => {
  it('no messages yields the column defaults, not a fabricated turn', () => {
    assert.equal(conversationKey(undefined, 'pi'), '');
    assert.equal(conversationKey([], 'pi'), '');
    assert.equal(userTurnIndex(undefined), 0);
  });

  it('a system prompt with no user message is not a conversation', () => {
    // Keying on the system prompt alone would collapse every session of one
    // agent onto a single key — worse than admitting we do not know.
    assert.equal(conversationKey([SYSTEM], 'pi'), '');
  });

  it('turnIdentity reports 0 whenever the key is unknown', () => {
    // The two fields must never disagree: a conversation that cannot be
    // identified must not still claim a turn number.
    assert.deepEqual(turnIdentity([], 'pi'), { conversation_key: '', turn_index: 0 });
    assert.deepEqual(turnIdentity([SYSTEM], 'pi'), { conversation_key: '', turn_index: 0 });
  });

  it('malformed input never throws', () => {
    for (const junk of [null, 42, 'a string', [null], [{}], [{ role: 'user' }]]) {
      assert.doesNotThrow(() => turnIdentity(junk, 'pi'));
    }
  });

  it('turnIdentity agrees with its parts on a real turn', () => {
    assert.deepEqual(turnIdentity(openaiLoop, 'pi'), {
      conversation_key: conversationKey(openaiLoop, 'pi'),
      turn_index: 1,
    });
  });
});

describe('turnPromptText captions the CURRENT turn', () => {
  it('the last user message, not the conversation opener', () => {
    // The bug this replaces: every turn of a session displayed turn 1's
    // question, because the preview took the FIRST user message.
    const twoTurns = [
      ...openaiLoop,
      { role: 'assistant', content: 'It is an A2A proof-of-concept.' },
      { role: 'user', content: 'and what runs the agents?' },
    ];
    assert.equal(turnPromptText(twoTurns), 'and what runs the agents?');
  });

  it('mid-loop it still reports the turn\'s own prompt', () => {
    // Every call of a turn must caption the same way, or the calls of one turn
    // would carry different labels in the very view built to group them.
    assert.equal(turnPromptText(openaiLoop.slice(0, 2)), 'what is this repo about?');
    assert.equal(turnPromptText(openaiLoop), 'what is this repo about?');
  });

  it('an Anthropic tool_result is never mistaken for the prompt', () => {
    // On that wire a tool reply IS a role:'user' message. Taking the last user
    // message naively would caption the turn with tool output — useless, and a
    // far larger disclosure than the question.
    assert.equal(turnPromptText(anthropicLoop), 'what is this repo about?');
  });

  it('Anthropic content blocks are flattened, not dropped', () => {
    // The old reader returned '' for anything that was not a plain string,
    // which is why the /v1/messages tap could never have produced a preview.
    const blocks = [
      SYSTEM,
      { role: 'user', content: [{ type: 'text', text: 'explain the routing config' }] },
    ];
    assert.equal(turnPromptText(blocks), 'explain the routing config');
  });

  it('whitespace is collapsed and the result is bounded', () => {
    const long = [SYSTEM, { role: 'user', content: 'a\n\n  b\t c ' + 'x'.repeat(2000) }];
    const out = turnPromptText(long, 500);
    assert.ok(out.startsWith('a b c x'), out.slice(0, 20));
    // Bounded so the caller's redaction regexes never see an unbounded string.
    assert.equal(out.length, 500);
  });

  it('nothing usable yields the empty string, never a throw', () => {
    assert.equal(turnPromptText([SYSTEM]), '');
    assert.equal(turnPromptText([]), '');
    for (const junk of [null, undefined, 42, [{ role: 'user' }], [{ role: 'user', content: '   ' }]]) {
      assert.doesNotThrow(() => turnPromptText(junk));
      assert.equal(turnPromptText(junk), '');
    }
  });
});
