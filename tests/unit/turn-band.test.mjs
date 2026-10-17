/**
 * turn-band.mjs — "is this call inside its turn's tool loop?" on both wires, and
 * the bounded, expiring memory of what each turn's first call decided.
 *
 * Run: node --test tests/unit/turn-band.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toolsInCurrentTurn, turnBandKey, createTurnBandMemory } from '../../proxy-bridge/turn-band.mjs';

const sys = (t) => ({ role: 'system', content: t });
const user = (t) => ({ role: 'user', content: t });
const asst = (t) => ({ role: 'assistant', content: t });
const oaCall = () => ({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] });
const oaResult = () => ({ role: 'tool', tool_call_id: 'c1', content: 'file contents' });
const anUse = () => ({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] });
const anResult = () => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] });

describe('toolsInCurrentTurn', () => {
  it('a first call is not in a loop', () => {
    assert.equal(toolsInCurrentTurn([sys('s'), user('hi')]), false);
  });

  it('a tool call or result after the last human message is the loop (OpenAI wire)', () => {
    assert.equal(toolsInCurrentTurn([sys('s'), user('fix it'), oaCall()]), true);
    assert.equal(toolsInCurrentTurn([sys('s'), user('fix it'), oaCall(), oaResult()]), true);
  });

  it('the Anthropic tool_result, which arrives as role:user, does not start a turn', () => {
    assert.equal(toolsInCurrentTurn([user('fix it'), anUse(), anResult()]), true);
  });

  it('tool messages of an EARLIER turn do not make a fresh prompt mid-loop', () => {
    const msgs = [sys('s'), user('read a.ts'), oaCall(), oaResult(), asst('done'), user('thanks — what is 2+2?')];
    assert.equal(toolsInCurrentTurn(msgs), false);
    const an = [user('read a.ts'), anUse(), anResult(), asst('done'), user('and now?')];
    assert.equal(toolsInCurrentTurn(an), false);
  });

  it('a human message straight after a tool result is still inside the loop', () => {
    assert.equal(toolsInCurrentTurn([user('find the ETM'), oaCall(), oaResult(), user('· bash(read span)')]), true);
  });

  it('degrades to false on junk, never throws', () => {
    assert.equal(toolsInCurrentTurn(null), false);
    assert.equal(toolsInCurrentTurn([null, 3, 'x']), false);
  });
});

describe('turnBandKey', () => {
  it('holds still across the steps of a turn and moves with the next human prompt', () => {
    const t1 = [sys('s'), user('fix it')];
    const k1 = turnBandKey(t1, 'pi');
    assert.match(k1, /^[0-9a-f]{12}:1$/);
    assert.equal(turnBandKey([...t1, oaCall(), oaResult()], 'pi'), k1);
    assert.equal(turnBandKey([...t1, oaCall(), oaResult(), asst('ok'), user('next')], 'pi'), k1.replace(/:1$/, ':2'));
  });

  it('is empty when there is nothing to key on', () => {
    assert.equal(turnBandKey([sys('only system')], 'pi'), '');
    assert.equal(turnBandKey(undefined), '');
  });
});

describe('createTurnBandMemory', () => {
  it('remembers and recalls; an empty key is a no-op', () => {
    const m = createTurnBandMemory();
    m.remember('a:1', { band: 'small', offloaded: true });
    assert.deepEqual(m.recall('a:1'), { band: 'small', offloaded: true });
    m.remember('', { band: 'small' });
    assert.equal(m.recall(''), undefined);
    assert.equal(m.size(), 1);
  });

  it('is bounded, evicting the least recently used', () => {
    const m = createTurnBandMemory({ maxEntries: 2 });
    m.remember('a', { band: 'small' });
    m.remember('b', { band: 'small' });
    m.recall('a'); // a is now the most recent
    m.remember('c', { band: 'small' });
    assert.equal(m.size(), 2);
    assert.equal(m.recall('b'), undefined);
    assert.ok(m.recall('a'));
    assert.ok(m.recall('c'));
  });

  it('expires a record older than the TTL; a recall keeps a live turn fresh', () => {
    let t = 0;
    const m = createTurnBandMemory({ ttlMs: 100, now: () => t });
    m.remember('a', { band: 'small' });
    t = 90; assert.ok(m.recall('a'));
    t = 180; assert.ok(m.recall('a'), 'the recall at 90 refreshed it');
    t = 400; assert.equal(m.recall('a'), undefined);
    assert.equal(m.size(), 0);
  });
});
