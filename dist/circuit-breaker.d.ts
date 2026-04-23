/**
 * Circuit Breaker for LLM Provider Failover
 *
 * Opens circuit after `threshold` consecutive failures.
 * Uses exponential backoff on reset timeout — providers that
 * keep failing stay disabled exponentially longer (up to maxResetMs).
 * A single success fully resets the backoff.
 */
export declare class CircuitBreaker {
    private state;
    private backoffMultiplier;
    private readonly baseResetMs;
    private readonly maxResetMs;
    constructor(threshold?: number, resetTimeoutMs?: number, maxResetMs?: number);
    /**
     * Check if the circuit is open (provider should be skipped)
     */
    isOpen(provider: string): boolean;
    /**
     * Record a provider failure — doubles the backoff multiplier
     */
    recordFailure(provider: string): void;
    /**
     * Trip the circuit breaker immediately (e.g., on auth errors).
     * Sets failure count to threshold so isOpen() returns true immediately,
     * without requiring threshold consecutive failures.
     */
    tripImmediately(provider: string): void;
    /**
     * Record a provider success — fully resets failure count and backoff
     */
    recordSuccess(provider: string): void;
    /**
     * Get current failure counts for all providers
     */
    getFailures(): Record<string, number>;
    /**
     * Reset all circuit breaker state
     */
    reset(): void;
}
//# sourceMappingURL=circuit-breaker.d.ts.map