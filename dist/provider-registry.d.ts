/**
 * Provider Registry
 *
 * Auto-registers providers, resolves provider chains for requests,
 * and handles tier-based routing.
 */
import type { LLMProvider, LLMCompletionRequest, LLMServiceConfig, ProviderName, ModelTier } from './types.js';
import { type NetworkMode } from './network-detect.js';
import { MockProvider } from './providers/mock-provider.js';
export interface ProviderSelection {
    provider: LLMProvider;
    model: string;
}
export declare class ProviderRegistry {
    private providers;
    private config;
    private networkMode;
    constructor(config: LLMServiceConfig);
    /**
     * Create and initialize all providers. Only registers those that are available.
     */
    initializeAll(): Promise<void>;
    /**
     * Get a specific provider
     */
    getProvider(name: ProviderName): LLMProvider | undefined;
    /**
     * Get the mock provider for configuration
     */
    getMockProvider(): MockProvider | undefined;
    /**
     * Get detected network mode (vpn or public)
     */
    getNetworkMode(): NetworkMode;
    /**
     * Get all available provider names
     */
    getAvailableProviders(): ProviderName[];
    /**
     * Get local providers (DMR, Ollama)
     */
    getLocalProviders(): LLMProvider[];
    /**
     * Resolve an ordered list of (provider, model) to try for a request
     */
    resolveProviderChain(request: LLMCompletionRequest): ProviderSelection[];
    /**
     * Resolve the effective tier for a request
     */
    private resolveTier;
    /**
     * Get tier for a task type (public method for consumers)
     */
    getTierForTask(taskType: string): ModelTier;
    /**
     * Update provider priority at runtime (called when dashboard settings change).
     * Converts a flat priority array into per-tier priority maps and optionally
     * updates taskTiers overrides.
     */
    setProviderPriority(flatPriority: string[], taskTiers?: Record<string, string[]>): void;
}
//# sourceMappingURL=provider-registry.d.ts.map