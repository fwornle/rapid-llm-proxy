/**
 * Docker Model Runner (DMR) Provider
 *
 * Local LLM inference via Docker Desktop's Model Runner.
 * OpenAI-compatible API at localhost:${DMR_PORT}/engines/v1.
 * Supports per-agent model overrides from DMR config.
 */
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import type { LLMCompletionRequest, ProviderConfig, ProviderName, DMRConfig } from '../types.js';
export declare class DMRProvider extends OpenAICompatibleProvider {
    readonly name: ProviderName;
    readonly isLocal = true;
    private dmrConfig;
    private _lastHealthCheck;
    private _healthCheckResult;
    constructor(config?: Partial<ProviderConfig>, dmrConfig?: DMRConfig);
    protected getApiKey(): string | null;
    protected getClientOptions(): Record<string, any>;
    /**
     * Override availability check: verify DMR is reachable with cached health check
     */
    isAvailable(): boolean;
    /**
     * Check DMR health (call periodically or before first use)
     */
    checkHealth(): Promise<boolean>;
    initialize(): Promise<void>;
    /**
     * Override model resolution: support per-agent model overrides from DMR config
     */
    protected resolveModelForRequest(request: LLMCompletionRequest): string;
    /**
     * Set DMR config (for loading from YAML after construction)
     */
    setDMRConfig(config: DMRConfig): void;
}
//# sourceMappingURL=dmr-provider.d.ts.map