/**
 * Unified LLM Support Layer - Type Definitions
 *
 * Core types shared across all providers and consumers.
 */
import type { ZodType } from 'zod';
export type ProviderName = 'groq' | 'anthropic' | 'openai' | 'gemini' | 'github-models' | 'dmr' | 'ollama' | 'mock' | 'claude-code' | 'copilot' | 'proxy';
export type ModelTier = 'fast' | 'standard' | 'premium';
export type LLMMode = 'mock' | 'local' | 'public';
export interface LLMMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface LLMCompletionRequest {
    messages: LLMMessage[];
    maxTokens?: number;
    temperature?: number;
    stream?: boolean;
    responseFormat?: {
        type: 'json_object' | 'text';
    };
    responseSchema?: ZodType;
    operationType?: string;
    taskType?: string;
    tier?: ModelTier;
    privacy?: 'local' | 'any';
    agentId?: string;
    skipCache?: boolean;
    forcePaid?: boolean;
    timeout?: number;
}
export interface LLMCompletionResult {
    content: string;
    provider: string;
    model: string;
    tokens: {
        input: number;
        output: number;
        total: number;
    };
    latencyMs?: number;
    cached?: boolean;
    local?: boolean;
    mock?: boolean;
}
export interface LLMProvider {
    readonly name: ProviderName;
    readonly isLocal: boolean;
    isAvailable(): boolean;
    initialize(): Promise<void>;
    complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
    getModels(): Partial<Record<ModelTier, string>>;
}
export interface ProviderConfig {
    name: ProviderName;
    apiKeyEnvVar?: string;
    baseUrl?: string;
    models: Partial<Record<ModelTier, string>>;
    defaultModel: string;
    timeout?: number;
    isLocal?: boolean;
    cliCommand?: string;
    cliSubcommand?: string;
    quotaTracking?: {
        enabled: boolean;
        softLimitPerHour?: number;
    };
}
export interface DMRConfig {
    host: string;
    port: number;
    baseUrl: string;
    defaultModel: string;
    modelOverrides: Record<string, string>;
    timeout: number;
    maxTokens: number;
    temperature: number;
    connection: {
        maxRetries: number;
        retryDelay: number;
        healthCheckInterval: number;
    };
}
export interface NetworkOverrideConfig {
    default_provider?: ProviderName;
    provider_priority?: Partial<Record<ModelTier, ProviderName[]>>;
    task_provider_priority?: Record<string, ProviderName[]>;
}
export interface LLMServiceConfig {
    providers?: Record<string, Partial<ProviderConfig>>;
    providerPriority?: Partial<Record<ModelTier, ProviderName[]>>;
    taskProviderPriority?: Record<string, ProviderName[]>;
    taskTiers?: Record<string, string[]>;
    agentOverrides?: Record<string, ModelTier>;
    operatorTiers?: Record<string, ModelTier>;
    batchTaskTiers?: Record<string, ModelTier>;
    modelRouting?: Record<string, string>;
    dmr?: DMRConfig;
    costLimits?: {
        budgetMode: number;
        standardMode: number;
        qualityMode: number;
    };
    cache?: {
        maxSize?: number;
        ttlMs?: number;
    };
    circuitBreaker?: {
        threshold?: number;
        resetTimeoutMs?: number;
    };
    networkOverrides?: {
        vpn?: NetworkOverrideConfig;
        public?: NetworkOverrideConfig;
    };
}
export interface BudgetTrackerInterface {
    canAfford(prompt: string, context: Record<string, unknown>): Promise<boolean>;
    recordCost(tokens: number, provider: string, metadata: Record<string, unknown>): Promise<void>;
}
export interface SensitivityClassifierInterface {
    classify(content: string, context: Record<string, unknown>): Promise<{
        isSensitive: boolean;
    }>;
}
export interface MockServiceInterface {
    mockLLMCall(agentType: string, prompt: string, repositoryPath: string): Promise<LLMCompletionResult>;
}
export interface SubscriptionQuotaTrackerInterface {
    recordUsage(provider: string, tokens: number): Promise<void>;
    isAvailable(provider: string): Promise<boolean>;
    getHourlyUsage(provider: string): {
        completions: number;
        tokens: number;
    };
    markQuotaExhausted(provider: string): void;
    canRetry(provider: string): boolean;
}
export interface LLMCallMetrics {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    latencyMs: number;
    operationType?: string;
    timestamp: number;
    promptPreview?: string;
    responsePreview?: string;
}
export interface LLMMetrics {
    totalCalls: number;
    byProvider: Record<string, {
        count: number;
        totalLatencyMs: number;
        totalTokens: number;
    }>;
    byOperation: Record<string, {
        count: number;
        totalLatencyMs: number;
    }>;
    cache: {
        size: number;
        hits: number;
        misses: number;
        hitRate: number;
    };
}
export interface CircuitBreakerState {
    failures: Record<string, number>;
    lastFailure: Record<string, number>;
    threshold: number;
    resetTimeoutMs: number;
}
//# sourceMappingURL=types.d.ts.map