// proxy-bridge/caller-complexity.mjs
//
// What a CALLER is allowed to say about how hard its own work is.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// `complexity: from-caller` in llm-routing.yaml means the route delegates the
// band to whoever is calling. Until now the only spelling of that was an
// explicit `complexity` field on the internal /api/complete body — which the
// background services set, and which no foreground agent could set, because an
// OpenAI-compatible client has no such field and no way to add one per turn.
//
// The consequence was visible: fg-chat/pi is `from-caller`, pi sent no band, so
// every pi turn fell to `defaults.fg-chat` (high) and NOTHING pi did was ever
// eligible for the semantic offload — including "how many r's in strawberry".
//
// pi does, however, already put a per-turn effort declaration on the wire.
// Its thinking-level selector is sent as OpenAI's `reasoning_effort` on every
// request (verified live 2026-08-28: a headless `pi -p` turn against a capture
// endpoint carried `reasoning_effort: "medium"`). That is a caller declaring how
// hard it considers the turn — exactly what `from-caller` asks for — so the band
// is read from it rather than invented here.
//
// ── This is NOT a classifier ─────────────────────────────────────────────────
// Nothing here reads prompt content. llm-routing.yaml argues at length that a
// content classifier would add a decision step to the hot path and make "why did
// this call go there?" unanswerable from the config; that argument still holds
// and this module does not weaken it. Every input below is a field the caller
// set deliberately, and `GET /api/llm/routing/resolve?...&complexity=<band>`
// reproduces the decision exactly.
//
// PURE — no env, no I/O, no logging. Wired in server.mjs, tested directly.

/** The bands llm-routing.yaml understands. Kept in sync with COMPLEXITY_BANDS. */
export const BANDS = ['small', 'medium', 'high'];

/**
 * Effort words → band.
 *
 * Two vocabularies land here and both must work:
 *
 *   • pi's, once config/agents/pi.sh gives the model a `thinkingLevelMap` that
 *     maps pi's levels (off/minimal/low/medium/high/xhigh/max) onto band names.
 *     Those arrive already spelled as bands and pass through the identity rows.
 *   • the raw OpenAI vocabulary, which any other openai-completions client may
 *     send unmapped (opencode, a hand-rolled curl, a future agent).
 *
 * Anything unrecognised resolves to '' — "the caller said nothing" — which lets
 * the route's own default apply. An unknown effort word must never become a
 * band by accident: that would move spend to a different account on a typo.
 */
const EFFORT_TO_BAND = {
  // band names (pi, post-thinkingLevelMap)
  small: 'small',
  medium: 'medium',
  high: 'high',
  // OpenAI / pi-native effort words
  off: 'small',
  none: 'small',
  minimal: 'small',
  low: 'small',
  xhigh: 'high',
  max: 'high',
};

/**
 * The band this caller declared, or '' when it declared nothing usable.
 *
 * Precedence, strongest first:
 *   1. an explicit `complexity` — the internal spelling every background
 *      service already uses, and the one the resolve endpoint takes
 *   2. an `x-complexity` request header — the seam for a client that can set
 *      headers but not body fields
 *   3. `reasoning_effort` — the caller's own per-turn effort declaration
 *
 * @param {{ explicit?: unknown, header?: unknown, reasoningEffort?: unknown }} input
 * @returns {'small'|'medium'|'high'|''}
 */
export function resolveCallerComplexity(input = {}) {
  const explicit = normalise(input.explicit);
  if (BANDS.includes(explicit)) return explicit;

  const header = normalise(input.header);
  if (BANDS.includes(header)) return header;

  const effort = normalise(input.reasoningEffort);
  return EFFORT_TO_BAND[effort] || '';
}

function normalise(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}
