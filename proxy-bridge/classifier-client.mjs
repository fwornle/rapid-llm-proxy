// proxy-bridge/classifier-client.mjs
//
// The stage-2 client for the prompt classifier: the rubric it sends and the
// per-impl function that asks. Extracted from server.mjs so the eval script can
// measure the SAME rubric the proxy uses.
//
// That is the whole reason this file exists. The gate on turning the classifier
// on is "scripts/eval-prompt-classifier.mjs reports acceptable precision", and
// an eval carrying its own copy of the rubric would answer a question about a
// prompt the proxy does not send — silently, from the first time either copy is
// edited. server.mjs cannot be imported to borrow it (it boots an HTTP server
// on import), so the shared part moves here instead of being duplicated.
//
// `fetchImpl` is injected rather than imported: the proxy must ask through its
// egress-aware proxyFetch, and the eval runs against a local endpoint with
// plain fetch. Neither needs the other's networking.

// The rubric lives in prompt-classifier.mjs (pure, shipped to glass); re-exported
// here so the eval and server.mjs keep importing it from the client.
export { CLASSIFIER_RUBRIC } from './prompt-classifier.mjs';

/**
 * Where the classifier asks. Endpoint from env, policy from YAML — the split
 * every provider follows.
 */
export function classifierBaseUrl() {
  return process.env.CLASSIFIER_BASE_URL
    || process.env.QWEN_LAPTOP_API_BASE_URL
    || 'http://127.0.0.1:8081/v1';
}

/**
 * The root of the `service` impl's judge: the same host, without the `/v1` an
 * OpenAI-compatible base carries.
 *
 * Exported so the routes that expose the judge to the dashboard derive its
 * address the same way the client that asks it does. Two spellings of one URL is
 * how a panel ends up reporting the health of an endpoint nobody is asking.
 */
export function classifierServiceBase() {
  return classifierBaseUrl().replace(/\/v1$/, '');
}

/**
 * Build the stage-2 client for the configured impl, or null for `none`.
 *
 * `impl` -> function is a hardcoded switch, matching how provider impls already
 * dispatch in server.mjs. There is no dynamic plugin loader; `service` IS the
 * extension point, and an operator supplies their own classifier by pointing
 * CLASSIFIER_BASE_URL at it.
 *
 * Both clients return a bare band word. Neither throws for a routing reason —
 * classifyRequest() treats any throw as "no verdict" and keeps the declared
 * band, which is the fail-open contract.
 *
 * @param {{impl: string, timeoutMs: number}} cls
 * @param {{fetchImpl?: typeof fetch}} [deps]
 * @returns {((text: string) => Promise<string>) | null}
 */
export function makeClassifierVerdictFn(cls, { fetchImpl = fetch } = {}) {
  const auth = process.env.CLASSIFIER_API_KEY
    ? { Authorization: `Bearer ${process.env.CLASSIFIER_API_KEY}` }
    : {};

  if (cls.impl === 'local-llm') {
    return async (text) => {
      const body = {
        model: process.env.CLASSIFIER_MODEL || 'qwen3.8-27b-local',
        messages: [{ role: 'system', content: CLASSIFIER_RUBRIC }, { role: 'user', content: text }],
        // Three tokens is enough for the longest legal answer and caps the cost
        // of a model that decides to explain itself instead of answering.
        max_tokens: 3,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
      };
      const r = await fetchImpl(`${classifierBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cls.timeoutMs),
      });
      if (!r.ok) throw new Error(`classifier HTTP ${r.status}`);
      const j = await r.json();
      return j?.choices?.[0]?.message?.content || '';
    };
  }

  // `service` was called `http` until 2026-08-31. The loader normalises the old
  // name before this is reached; matching both anyway costs one comparison and
  // means a caller that builds a cls object by hand cannot be quietly wrong.
  if (cls.impl === 'service' || cls.impl === 'http') {
    // The operator-supplied contract, kept deliberately small so a classifier
    // can be a dozen lines of anything: POST {text} -> {band}.
    return async (text) => {
      const r = await fetchImpl(`${classifierServiceBase()}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(cls.timeoutMs),
      });
      if (!r.ok) throw new Error(`classifier HTTP ${r.status}`);
      const j = await r.json();
      return j?.band || '';
    };
  }

  return null;
}
