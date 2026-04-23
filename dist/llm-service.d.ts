/**
 * LLM Service - High-Level Facade
 *
 * The single public entry point for all LLM operations.
 * Handles mode routing (mock/local/public), caching, circuit breaking,
 * budget/sensitivity checks, and provider fallback.
 */
import { EventEmitter } from 'events';
import type { LLMCompletionRequest, LLMCompletionResult, LLMServiceConfig, LLMMetrics, LLMMode, ProviderName, ModelTier, BudgetTrackerInterface, SensitivityClassifierInterface, MockServiceInterface, SubscriptionQuotaTrackerInterface } from './types.js';
import { ProviderRegistry } from './provider-registry.js';
import { MetricsTracker } from './metrics.js';
export declare class LLMService extends EventEmitter {
    private config;
    private registry;
    private circuitBreaker;
    private cache;
    private metrics;
    private initialized;
    private modeResolver;
    private budgetTracker;
    private sensitivityClassifier;
    private quotaTracker;
    constructor(config?: LLMServiceConfig);
    /**
     * Initialize the service: load config, register providers
     */
    initialize(configPath?: string): Promise<void>;
    /**
     * Set function that resolves the current LLM mode (mock/local/public)
     */
    setModeResolver(fn: (agentId?: string) => LLMMode): void;
    /**
     * Set mock service for mock mode
     */
    setMockService(service: MockServiceInterface): void;
    /**
     * Set repository path for mock provider
     */
    setRepositoryPath(path: string): void;
    /**
     * Set budget tracker for cost control
     */
    setBudgetTracker(tracker: BudgetTrackerInterface): void;
    /**
     * Set sensitivity classifier for privacy routing
     */
    setSensitivityClassifier(classifier: SensitivityClassifierInterface): void;
    /**
     * Set subscription quota tracker for subscription-based providers
     */
    setQuotaTracker(tracker: SubscriptionQuotaTrackerInterface): void;
    /**
     * Main completion method with full routing logic
     */
    complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
    /**
     * Convenience: complete for a specific task type
     */
    completeForTask(prompt: string, taskType: string, options?: Partial<LLMCompletionRequest>): Promise<LLMCompletionResult>;
    /**
     * Convenience: complete with explicit routing key (operationType)
     */
    completeWithRouting(prompt: string, routingKey: string, options?: Partial<LLMCompletionRequest>): Promise<LLMCompletionResult>;
    private resolveMode;
    private completeWithMock;
    private completeWithLocal;
    private completePublic;
    /**
     * Strip markdown code fences from LLM JSON responses.
     * Handles: ```json ... ```, ```...```, and bare JSON extraction.
     */
    private stripMarkdownFences;
    /**
     * Parse JSON with automatic repair for truncated LLM responses.
     *
     * Common failure: copilot API returns JSON truncated at max_tokens limit,
     * producing "Expected ',' or ']' after array element" errors at ~12K-14K.
     * This method tries JSON.parse first, then attempts repair on failure.
     */
    private parseJsonWithRepair;
    /**
     * Attempt to repair truncated JSON by removing the last incomplete element
     * and closing unclosed brackets/braces.
     */
    private repairTruncatedJson;
    /**
     * Close unclosed JSON brackets/braces by scanning for unmatched openers.
     */
    private closeUnclosedBrackets;
    getMetrics(): LLMMetrics;
    resetMetrics(): void;
    getAvailableProviders(): ProviderName[];
    clearCache(): void;
    getTierForTask(taskType: string): ModelTier;
    /**
     * Backward-compatible stats method (matches UnifiedInferenceEngine.getStats())
     */
    getStats(): Record<string, unknown>;
    private computeAverageLatency;
    /**
     * Get underlying provider registry (for advanced use)
     */
    getRegistry(): ProviderRegistry;
    /**
     * Update provider priority at runtime from dashboard settings.
     * Propagates the flat priority array to the ProviderRegistry so that
     * subsequent resolveProviderChain() calls use the new order.
     */
    updateProviderPriority(flatPriority: string[], taskTiers?: Record<string, string[]>): void;
    /**
     * Get the MetricsTracker instance (for per-step tracking in semantic-analysis)
     */
    getMetricsTracker(): MetricsTracker;
}
//# sourceMappingURL=llm-service.d.ts.map