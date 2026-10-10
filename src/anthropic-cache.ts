/**
 * Anthropic prompt-cache injection (WIRE cache-write enablement).
 *
 * WHY THIS EXISTS
 * ---------------
 * The Anthropic Messages API only *writes* to its prompt cache when the request
 * explicitly marks a prefix with a `cache_control: { type: 'ephemeral' }`
 * breakpoint. Traffic that arrives over the OpenAI wire (opencode / mastra via
 * the shim) carries NO such markers, and our native builders
 * (`completeAnthropic` / `completeClaudeCodeDirect`) historically forwarded the
 * messages verbatim — so the provider re-read the whole prefix as fresh `input`
 * every turn and `cache_write` was always 0.
 *
 * This module injects breakpoints at the two stable-prefix boundaries that
 * matter for a multi-turn agent loop:
 *
 *   1. the end of the `system` block   — the large, turn-invariant instructions
 *   2. the end of the last message     — the running conversation prefix, so the
 *                                          NEXT turn reads it back as a cache hit
 *
 * Two breakpoints stays well inside Anthropic's limit of 4. Below the per-model
 * minimum cacheable length (~1024 tok sonnet/opus, ~2048 tok haiku) Anthropic
 * silently ignores the breakpoint — so injection is always safe, never an error,
 * for short prompts.
 *
 * CONTRACT: pure, no I/O, never throws, and NON-MUTATING — the caller's original
 * `system` / `messages` are cloned, never edited in place. A malformed shape is
 * returned unchanged rather than crashing the completion path.
 */

/** An Anthropic content block; only `type: 'text'` blocks are cache-relevant here. */
export interface ContentBlock {
  type?: string;
  text?: string;
  cache_control?: { type: 'ephemeral' };
  [k: string]: unknown;
}

export type MessageContent = string | ContentBlock[];

export interface AnthropicMessage {
  role: string;
  content: MessageContent;
  [k: string]: unknown;
}

export interface CacheableRequestParts {
  /** Top-level `system` — string or block array (Anthropic accepts both). */
  system?: string | ContentBlock[];
  /** The `messages` array sent to /v1/messages. */
  messages: AnthropicMessage[];
}

const EPHEMERAL = { type: 'ephemeral' as const };

/**
 * Return a copy of `content` in block-array form whose LAST text-bearing block
 * carries a `cache_control` breakpoint. String content is promoted to a single
 * text block. Empty / unknown shapes are returned unchanged.
 */
function markCacheable(content: string | ContentBlock[] | undefined): string | ContentBlock[] | undefined {
  if (typeof content === 'string') {
    if (content.length === 0) return content;
    return [{ type: 'text', text: content, cache_control: EPHEMERAL }];
  }
  if (Array.isArray(content) && content.length > 0) {
    const out = content.map((b) => ({ ...b }));
    // Prefer the last text block; fall back to the last block of any type.
    let idx = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i] && out[i].type === 'text') { idx = i; break; }
    }
    if (idx === -1) idx = out.length - 1;
    out[idx] = { ...out[idx], cache_control: EPHEMERAL };
    return out;
  }
  return content;
}

/**
 * Inject Anthropic prompt-cache breakpoints into a request's `system` +
 * `messages`. Returns NEW `{ system, messages }` objects (inputs untouched).
 *
 * @param parts   the system + messages about to be sent to /v1/messages
 * @param enabled master switch — when false, returns the parts unchanged
 *                (clone-free) so callers can gate on an env flag cheaply.
 */
export function applyAnthropicCacheControl(
  parts: CacheableRequestParts,
  enabled = true,
): CacheableRequestParts {
  try {
    if (!enabled) return parts;
    const messages = Array.isArray(parts.messages) ? parts.messages : [];
    if (messages.length === 0) return parts;

    // 1) system breakpoint (only when there is a non-empty system).
    let system = parts.system;
    const hasSystem =
      (typeof system === 'string' && system.length > 0) ||
      (Array.isArray(system) && system.length > 0);
    if (hasSystem) {
      system = markCacheable(system) as string | ContentBlock[];
    }

    // 2) last-message breakpoint — the running conversation prefix boundary.
    const out = messages.map((m) => ({ ...m }));
    const last = out.length - 1;
    out[last] = { ...out[last], content: markCacheable(out[last].content) as MessageContent };

    return { ...parts, system, messages: out };
  } catch {
    // Never let cache injection break a completion — fall back to verbatim.
    return parts;
  }
}
