/**
 * Guards the tools-capable redundancy of the config actually shipped in config/
 * — deliberately separate from routing-config.test.mjs, which pins the engine's
 * decision surface using in-memory objects and never reads these files.
 *
 * Be precise about what went wrong, because the obvious framing is wrong: the
 * chain did NOT have only one tools-capable provider. It had two — gh-copilot
 * and openai. On 2026-08-18 both were exhausted at the same time (the corporate
 * Copilot contract hit its monthly cap, retry-after ~13 days; the OpenAI key ran
 * out of credit), and the chain's other members, claude-code-max and groq,
 * declare tools: false. So every tool-using agent stopped at once.
 *
 * Two capable hops is therefore demonstrably not enough redundancy for this
 * chain: both of them are single accounts with independent but equally sudden
 * exhaustion modes. This pins the third hop the fix added, on a third account,
 * so deleting it is a test failure rather than a discovery made during the next
 * outage.
 *
 * What this does NOT check: whether a capable hop has quota right now. That is
 * an account fact, not a config fact, and no config change can guarantee it.
 * The claim here is only that the config OFFERS somewhere for a tools[] request
 * to go.
 *
 * Run: node --test tests/unit/shipped-config-tool-capacity.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRoutingConfig } from '../../proxy-bridge/routing-config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = loadRoutingConfig({
  routingPath: path.join(REPO, 'config', 'llm-routing.yaml'),
  fallbackPath: path.join(REPO, 'config', 'llm-fallback.yaml'),
  force: true,
});

// The head every fg-chat/<agent> route on the OpenAI shim resolves to today.
const HEAD = 'gh-copilot';
// Two proved insufficient (see the header). Three distinct accounts is what the
// 2026-08-18 fix established; this is a floor, not a target.
const MIN_CAPABLE_HOPS = 3;

const hops = () => [HEAD, ...config.fallback.chains[HEAD].map((c) => c.provider)];
const toolsCapable = (id) => config.providers[id]?.capabilities?.tools === true;

describe('shipped config — tools capacity of the shim foreground chain', () => {
  it(`${HEAD} declares a fallback chain`, () => {
    assert.ok(Array.isArray(config.fallback.chains[HEAD]), `no chain for ${HEAD}`);
  });

  it(`keeps at least ${MIN_CAPABLE_HOPS} tools-capable providers in the chain`, () => {
    const capable = hops().filter(toolsCapable);
    assert.ok(
      capable.length >= MIN_CAPABLE_HOPS,
      `only ${capable.length} tools-capable provider(s) in [${hops().join(' > ')}] `
      + `(capable: ${capable.join(', ') || 'none'}). Two was the state on 2026-08-18 `
      + `when both were exhausted simultaneously and every tool-using agent stopped.`,
    );
  });

  it('each tools-capable hop is a distinct, enabled account', () => {
    const capable = hops().filter(toolsCapable);
    for (const id of capable) {
      assert.ok(config.providers[id].enabled, `${id} is tools-capable but disabled`);
    }
    const accounts = capable.map((id) => config.providers[id].account);
    assert.equal(new Set(accounts).size, accounts.length,
      `capable hops share an account (${accounts.join(', ')}) — they would fail together`);
  });
});
