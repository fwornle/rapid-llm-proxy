/**
 * Proxy Provider
 *
 * Routes LLM calls through the local llm-proxy (port from LLM_CLI_PROXY_PORT, default 12435) which handles
 * network detection, provider failover, and has access to all configured
 * providers including subscription-based ones (copilot, claude-code).
 *
 * This provider is essential when the ETM runs in a context where direct
 * API calls are blocked (e.g., corporate VPN) but the llm-proxy has working
 * connections via the proxy chain.
 */
import { BaseProvider } from './base-provider.js';
import type { LLMCompletionRequest, LLMCompletionResult, ProviderConfig, ProviderName } from '../types.js';
export declare class ProxyProvider extends BaseProvider {
    readonly name: ProviderName;
    readonly isLocal = false;
    private proxyUrl;
    constructor(config?: Partial<ProviderConfig>);
    initialize(): Promise<void>;
    complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
}
//# sourceMappingURL=proxy-provider.d.ts.map