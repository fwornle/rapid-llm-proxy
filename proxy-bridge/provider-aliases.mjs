// proxy-bridge/provider-aliases.mjs
//
// Historical provider spellings in token_usage, mapped forward to the ACCOUNT id.
//
// ── Why the DB holds more than one spelling ──────────────────────────────────
// A provider id names the ACCOUNT that gets billed, not the company that owns
// the model. Before that distinction existed, rows were stamped with whatever
// the dispatch path called itself: the runtime impl name (`copilot`,
// `claude-code`), an older label (`github-copilot`), or — worst — `anthropic`,
// which merged personal-Max passthrough traffic with metered API-key traffic
// under one word, so the dashboard could report "anthropic 100%" and tell you
// nothing about which account your tokens came out of.
//
// ── Why this is a read-time map and not a migration ──────────────────────────
// The `anthropic` case is a JUDGEMENT, not a fact: those rows are read as Max
// because that is what the /v1/messages tap meant when it wrote them, and that
// is true of the overwhelming majority but not provably of every row. A
// destructive rewrite would bake the judgement into the data and lose the
// original spelling that justifies it. Mapping at read time keeps the raw value
// available and the interpretation reversible.
//
// New rows are written with the account id directly, so this only ever touches
// history; it is a no-op on anything written from 2026-08-16 onward.
//
// MIRRORS integrations/system-health-dashboard/src/lib/providers.ts in the
// coding repo — same keys, same values, same reasoning. Two repos, so the map is
// duplicated rather than imported; keep them in step.
//
// NOTE this is deliberately NOT routing-config's implToProvider. That index
// answers "which account does this runtime impl dispatch to" for CONFIG, where
// `anthropic` correctly means `anthropic-api`. Here the same word is a
// historical DATA label that meant Max. Same string, two questions, two answers
// — reusing one for the other is how the account split gets undone.

export const PROVIDER_ALIASES = {
  copilot: 'gh-copilot',
  'github-copilot': 'gh-copilot',
  github: 'gh-copilot',
  'claude-code': 'claude-code-max',
  anthropic: 'claude-code-max',
  'max-subscription': 'claude-code-max',
};

/**
 * The account id for a stored provider label.
 * @param {string|null|undefined} provider
 * @returns {string}
 */
export function normalizeProvider(provider) {
  if (!provider) return provider ?? '';
  const key = String(provider).trim().toLowerCase();
  return PROVIDER_ALIASES[key] ?? key;
}
