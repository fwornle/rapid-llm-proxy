/**
 * LLM Metrics Tracker
 *
 * Unified per-provider/per-operation tracking. Supports per-step reset
 * for workflow step metrics in semantic-analysis.
 */
import type { LLMMetrics, LLMCallMetrics } from './types.js';
export declare class MetricsTracker {
    private byProvider;
    private byOperation;
    private totalCalls;
    cacheSize: number;
    cacheHits: number;
    cacheMisses: number;
    private calls;
    /**
     * Record a completed LLM call
     */
    recordCall(provider: string, model: string, tokens: {
        input: number;
        output: number;
        total: number;
    }, latencyMs: number, operationType?: string, promptPreview?: string, responsePreview?: string): void;
    /**
     * Get a snapshot of all metrics
     */
    getMetrics(): LLMMetrics;
    /**
     * Get detailed call log (for per-step tracking in semantic-analysis)
     */
    getCalls(): LLMCallMetrics[];
    /**
     * Get unique providers used
     */
    getProviders(): string[];
    /**
     * Reset all metrics (for per-step tracking)
     */
    reset(): void;
}
//# sourceMappingURL=metrics.d.ts.map