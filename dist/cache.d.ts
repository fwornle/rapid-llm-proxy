/**
 * LRU Cache with TTL for LLM Responses
 *
 * Extracted from identical patterns in SemanticValidator and UnifiedInferenceEngine.
 * FIFO eviction when maxSize reached, entries expire after ttlMs.
 */
import type { LLMCompletionResult } from './types.js';
export declare class LLMCache {
    private cache;
    private maxSize;
    private ttlMs;
    hits: number;
    misses: number;
    constructor(maxSize?: number, ttlMs?: number);
    /**
     * Get a cached result if it exists and is within TTL
     */
    get(key: string): LLMCompletionResult | null;
    /**
     * Store a result in the cache
     */
    set(key: string, result: LLMCompletionResult): void;
    /**
     * Generate a cache key from prompt content and routing context
     */
    static getCacheKey(prompt: string, operationType?: string): string;
    /**
     * Simple hash function (same as used in all 3 existing consumers)
     */
    private static simpleHash;
    get size(): number;
    get hitRate(): number;
    clear(): void;
}
//# sourceMappingURL=cache.d.ts.map