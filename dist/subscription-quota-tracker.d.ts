/**
 * Subscription Quota Tracker
 *
 * Tracks usage and quota exhaustion for subscription-based LLM providers
 * (Claude Code, GitHub Copilot). Implements optimistic tracking with
 * exponential backoff on quota exhaustion.
 */
import type { SubscriptionQuotaTrackerInterface } from './types.js';
interface HourlyUsage {
    hour: string;
    completions: number;
    estimatedTokens: number;
}
interface ProviderUsage {
    hourlyUsage: HourlyUsage[];
    quotaExhausted: boolean;
    exhaustedAt: string | null;
    lastError: string | null;
    consecutiveFailures: number;
}
interface SubscriptionUsageData {
    [provider: string]: ProviderUsage;
}
export declare class SubscriptionQuotaTracker implements SubscriptionQuotaTrackerInterface {
    private data;
    private storagePath;
    private initialized;
    private readonly backoffSchedule;
    constructor(storagePath: string);
    /**
     * Initialize the tracker by loading existing data
     */
    initialize(): Promise<void>;
    /**
     * Get or create provider usage record
     */
    private getProviderData;
    /**
     * Get current hour as ISO string (rounded to hour)
     */
    private getCurrentHour;
    /**
     * Record usage for a provider
     */
    recordUsage(provider: string, tokens: number): Promise<void>;
    /**
     * Check if provider is available (not quota exhausted)
     */
    isAvailable(provider: string): Promise<boolean>;
    /**
     * Get current hour's usage stats
     */
    getHourlyUsage(provider: string): {
        completions: number;
        tokens: number;
    };
    /**
     * Mark provider as quota exhausted (with exponential backoff)
     */
    markQuotaExhausted(provider: string): void;
    /**
     * Check if enough time has passed to retry
     */
    canRetry(provider: string): boolean;
    /**
     * Clear old data (keep last 24 hours)
     */
    pruneOldData(): Promise<void>;
    /**
     * Persist data to disk
     */
    private persist;
    /**
     * Get all usage data (for debugging/monitoring)
     */
    getAllUsage(): SubscriptionUsageData;
    /**
     * Reset usage for a provider (for testing)
     */
    resetProvider(provider: string): Promise<void>;
}
export {};
//# sourceMappingURL=subscription-quota-tracker.d.ts.map