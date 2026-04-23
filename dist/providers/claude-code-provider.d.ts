/**
 * Claude Code Provider (CLI-based, Claude Max OAuth)
 *
 * Shells out to the `claude` CLI in non-interactive mode (-p) to get completions.
 * This uses the user's Claude Max subscription (personal OAuth) rather than the
 * company's GitHub Copilot Enterprise quota.
 *
 * Previous design used @anthropic-ai/claude-agent-sdk which spawns a full
 * Claude Code subprocess per request — 60-180s overhead. Direct API calls to
 * api.anthropic.com with the OAuth token were rejected (server-side client
 * allowlisting). The CLI handles auth natively.
 *
 * CRITICAL: ANTHROPIC_API_KEY must NOT be in the env when spawning the CLI,
 * otherwise it uses the (depleted) API key instead of the Max OAuth subscription.
 *
 * Model mapping: short names (sonnet, opus, haiku) → CLI model aliases.
 * Auth: Claude Max OAuth token from macOS keychain (managed by claude CLI).
 */
import { BaseProvider } from './base-provider.js';
import type { LLMCompletionRequest, LLMCompletionResult, ProviderConfig, ProviderName } from '../types.js';
export declare class ClaudeCodeProvider extends BaseProvider {
    readonly name: ProviderName;
    readonly isLocal = false;
    private useProxy;
    constructor(config?: Partial<ProviderConfig>);
    /**
     * Build a clean env for the claude CLI subprocess.
     * CRITICAL: removes ANTHROPIC_API_KEY to force OAuth/Max subscription usage.
     */
    private buildCleanEnv;
    /**
     * Resolve model name from tier
     */
    private resolveCliModel;
    /**
     * Extract system prompt and user prompt from messages array.
     * - system messages → joined as system prompt
     * - user/assistant messages → concatenated as the prompt
     */
    private extractPrompts;
    initialize(): Promise<void>;
    private checkProxyAvailable;
    complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
    /**
     * Complete via the claude CLI in non-interactive mode.
     * Spawns: claude -p <prompt> --output-format json --model <model> --tools "" [--system-prompt <sp>]
     */
    private completeViaCLI;
    /**
     * Complete via the host-side HTTP proxy bridge (for Docker containers).
     */
    private completeViaProxy;
}
//# sourceMappingURL=claude-code-provider.d.ts.map