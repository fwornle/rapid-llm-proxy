/**
 * GitHub Copilot Provider (Direct HTTP)
 *
 * Uses the GitHub Copilot API directly via OpenAI-compatible HTTP endpoint.
 * Auth flow:
 *   1. Read OAuth token (gho_...) from ~/.local/share/opencode/auth.json
 *   2. Build API base URL: https://copilot-api.${enterpriseUrl} (enterprise)
 *      or https://api.individual.githubcopilot.com (public GitHub)
 *   3. Use the refresh token directly as Bearer — no token exchange needed.
 *
 * Network: Uses undici ProxyAgent when HTTPS_PROXY is set (corporate network).
 */
import { BaseProvider } from './base-provider.js';
import type { LLMCompletionRequest, LLMCompletionResult, ProviderConfig, ProviderName } from '../types.js';
export declare class CopilotProvider extends BaseProvider {
    readonly name: ProviderName;
    readonly isLocal = false;
    private auth;
    private useProxy;
    constructor(config?: Partial<ProviderConfig>);
    /**
     * Load OAuth token and build API base URL from OpenCode's auth.json.
     * Re-reads at most every 60 seconds.
     *
     * For enterprise: apiBaseUrl = https://copilot-api.${enterpriseUrl}
     * For public:     apiBaseUrl = https://api.individual.githubcopilot.com
     */
    private loadAuth;
    initialize(): Promise<void>;
    private checkProxyAvailable;
    complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
    /**
     * Direct HTTP call to Copilot API (OpenAI-compatible endpoint).
     * Uses refresh token directly as Bearer — no token exchange.
     */
    private completeDirectHTTP;
    /**
     * Complete via the host-side HTTP proxy bridge (for Docker containers).
     */
    private completeViaProxy;
}
//# sourceMappingURL=copilot-provider.d.ts.map