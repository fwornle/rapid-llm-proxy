/**
 * LLM Service - High-Level Facade
 *
 * The single public entry point for all LLM operations.
 * Handles mode routing (mock/local/public), caching, circuit breaking,
 * budget/sensitivity checks, and provider fallback.
 */
import { EventEmitter } from 'events';
import { loadConfig, getDefaultConfig } from './config.js';
import { ProviderRegistry } from './provider-registry.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { LLMCache } from './cache.js';
import { MetricsTracker } from './metrics.js';
export class LLMService extends EventEmitter {
    config;
    registry;
    circuitBreaker;
    cache;
    metrics;
    initialized = false;
    // Dependency injection slots
    modeResolver = null;
    budgetTracker = null;
    sensitivityClassifier = null;
    quotaTracker = null;
    constructor(config) {
        super();
        this.config = config || getDefaultConfig();
        this.registry = new ProviderRegistry(this.config);
        this.circuitBreaker = new CircuitBreaker(this.config.circuitBreaker?.threshold || 3, this.config.circuitBreaker?.resetTimeoutMs || 30000);
        this.cache = new LLMCache(this.config.cache?.maxSize || 1000, this.config.cache?.ttlMs || 3600000);
        this.metrics = new MetricsTracker();
    }
    /**
     * Initialize the service: load config, register providers
     */
    async initialize(configPath) {
        if (this.initialized)
            return;
        // Always load YAML config — it contains the full provider priority chain
        // including subscription providers (claude-code, copilot) that the
        // hardcoded defaults omit. The YAML is the canonical config source.
        this.config = await loadConfig(configPath);
        this.registry = new ProviderRegistry(this.config);
        await this.registry.initializeAll();
        this.initialized = true;
        this.emit('initialized', { providers: this.registry.getAvailableProviders() });
    }
    // --- Dependency Injection ---
    /**
     * Set function that resolves the current LLM mode (mock/local/public)
     */
    setModeResolver(fn) {
        this.modeResolver = fn;
    }
    /**
     * Set mock service for mock mode
     */
    setMockService(service) {
        const mockProvider = this.registry.getMockProvider();
        if (mockProvider) {
            mockProvider.setMockService(service);
        }
    }
    /**
     * Set repository path for mock provider
     */
    setRepositoryPath(path) {
        const mockProvider = this.registry.getMockProvider();
        if (mockProvider) {
            mockProvider.setRepositoryPath(path);
        }
    }
    /**
     * Set budget tracker for cost control
     */
    setBudgetTracker(tracker) {
        this.budgetTracker = tracker;
    }
    /**
     * Set sensitivity classifier for privacy routing
     */
    setSensitivityClassifier(classifier) {
        this.sensitivityClassifier = classifier;
    }
    /**
     * Set subscription quota tracker for subscription-based providers
     */
    setQuotaTracker(tracker) {
        this.quotaTracker = tracker;
    }
    // --- Core Completion Methods ---
    /**
     * Main completion method with full routing logic
     */
    async complete(request) {
        if (!this.initialized) {
            await this.initialize();
        }
        const startTime = Date.now();
        // 1. Determine LLM mode
        const mode = this.resolveMode(request.agentId);
        // 2. Mock mode — delegate immediately
        if (mode === 'mock') {
            return this.completeWithMock(request, startTime);
        }
        // 3. Local mode — only use local providers
        if (mode === 'local' || request.privacy === 'local') {
            return this.completeWithLocal(request, startTime);
        }
        // 4. Public mode — full routing with cache, budget, sensitivity
        return this.completePublic(request, startTime);
    }
    /**
     * Convenience: complete for a specific task type
     */
    async completeForTask(prompt, taskType, options = {}) {
        return this.complete({
            messages: [{ role: 'user', content: prompt }],
            taskType,
            ...options,
        });
    }
    /**
     * Convenience: complete with explicit routing key (operationType)
     */
    async completeWithRouting(prompt, routingKey, options = {}) {
        return this.complete({
            messages: [{ role: 'user', content: prompt }],
            operationType: routingKey,
            ...options,
        });
    }
    // --- Private Routing Methods ---
    resolveMode(agentId) {
        if (this.modeResolver) {
            return this.modeResolver(agentId);
        }
        return 'public';
    }
    async completeWithMock(request, startTime) {
        const mockProvider = this.registry.getMockProvider();
        if (!mockProvider?.isAvailable()) {
            // Fall through to local if mock not available
            console.warn('[llm] Mock mode requested but no mock service configured, falling back to local');
            return this.completeWithLocal(request, startTime);
        }
        const result = await mockProvider.complete(request);
        const latencyMs = Date.now() - startTime;
        result.latencyMs = latencyMs;
        this.metrics.recordCall('mock', result.model, result.tokens, latencyMs, request.operationType, request.messages[request.messages.length - 1]?.content?.slice(0, 500), result.content?.slice(0, 500));
        this.emit('complete', { mode: 'mock', ...result });
        return result;
    }
    async completeWithLocal(request, startTime) {
        const localProviders = this.registry.getLocalProviders();
        for (const provider of localProviders) {
            if (this.circuitBreaker.isOpen(provider.name))
                continue;
            try {
                const result = await provider.complete(request);
                const latencyMs = Date.now() - startTime;
                result.latencyMs = latencyMs;
                this.circuitBreaker.recordSuccess(provider.name);
                this.metrics.recordCall(provider.name, result.model, result.tokens, latencyMs, request.operationType, request.messages[request.messages.length - 1]?.content?.slice(0, 500), result.content?.slice(0, 500));
                this.emit('complete', { mode: 'local', ...result });
                return result;
            }
            catch (error) {
                if (error.message?.includes('AUTH_ERROR')) {
                    this.circuitBreaker.tripImmediately(provider.name);
                }
                else {
                    this.circuitBreaker.recordFailure(provider.name);
                }
                console.warn(`[llm] Local provider ${provider.name} failed:`, error.message);
            }
        }
        // No local providers available — fall through to public as last resort
        console.warn('[llm] No local providers available, falling back to public');
        return this.completePublic(request, startTime);
    }
    async completePublic(request, startTime) {
        // Check cache
        if (!request.skipCache) {
            const prompt = request.messages.map(m => m.content).join('\n');
            const cacheKey = LLMCache.getCacheKey(prompt, request.operationType);
            const cached = this.cache.get(cacheKey);
            if (cached) {
                this.metrics.cacheHits = this.cache.hits;
                this.metrics.cacheMisses = this.cache.misses;
                this.emit('cache-hit', { operationType: request.operationType });
                return cached;
            }
        }
        // Check sensitivity
        if (this.sensitivityClassifier) {
            try {
                const prompt = request.messages.map(m => m.content).join('\n');
                const classification = await this.sensitivityClassifier.classify(prompt, {
                    operationType: request.operationType || 'default',
                });
                if (classification.isSensitive) {
                    this.emit('sensitivity-routed', { operationType: request.operationType });
                    return this.completeWithLocal(request, startTime);
                }
            }
            catch {
                // On error, assume not sensitive
            }
        }
        // Check budget
        if (this.budgetTracker && !request.forcePaid) {
            try {
                const prompt = request.messages.map(m => m.content).join('\n');
                const canAfford = await this.budgetTracker.canAfford(prompt, {
                    operationType: request.operationType || 'default',
                });
                if (!canAfford) {
                    this.emit('budget-blocked', { operationType: request.operationType });
                    return this.completeWithLocal(request, startTime);
                }
            }
            catch {
                // On error, allow (fail open)
            }
        }
        // Check subscription quota availability
        if (this.quotaTracker) {
            for (const providerName of ['claude-code', 'copilot']) {
                const isAvailable = await this.quotaTracker.isAvailable(providerName);
                if (!isAvailable) {
                    // Mark as temporarily unavailable via circuit breaker
                    this.circuitBreaker.recordFailure(providerName);
                    console.info(`[llm] Subscription provider ${providerName} quota exhausted, temporarily disabled`);
                }
            }
        }
        // Resolve provider chain and try each
        const chain = this.registry.resolveProviderChain(request);
        const chainNames = chain.map(c => c.provider.name);
        const cbState = this.circuitBreaker.getFailures();
        const skipped = [];
        // Always log chain resolution for debugging provider selection
        console.info(`[llm] chain=[${chainNames}] tier=${request.tier || 'default'} task=${request.taskType || '-'} op=${request.operationType || '-'}`);
        for (const { provider, model } of chain) {
            if (this.circuitBreaker.isOpen(provider.name)) {
                skipped.push(`${provider.name}(f=${cbState[provider.name] || 0})`);
                continue;
            }
            try {
                // Keep the tier so the provider resolves the correct model for this tier
                const providerRequest = { ...request };
                // Hard timeout per provider call — prevents infinite hangs
                const perCallTimeout = request.timeout || 120_000; // 2 min max per provider
                let result = await Promise.race([
                    provider.complete(providerRequest),
                    new Promise((_, reject) => setTimeout(() => reject(new Error(`Provider ${provider.name} timed out after ${perCallTimeout}ms`)), perCallTimeout)),
                ]);
                const latencyMs = Date.now() - startTime;
                result.latencyMs = latencyMs;
                this.circuitBreaker.recordSuccess(provider.name);
                console.info(`[llm] used=${provider.name}/${result.model} tier=${request.tier || 'default'} ${skipped.length > 0 ? `skipped=[${skipped}]` : ''} ${latencyMs}ms`);
                this.metrics.recordCall(provider.name, result.model, result.tokens, latencyMs, request.operationType, request.messages[request.messages.length - 1]?.content?.slice(0, 500), result.content?.slice(0, 500));
                // Record subscription usage for subscription providers
                const isSubscriptionProvider = provider.name === 'claude-code' || provider.name === 'copilot';
                if (isSubscriptionProvider && this.quotaTracker) {
                    try {
                        await this.quotaTracker.recordUsage(provider.name, result.tokens.total);
                    }
                    catch (error) {
                        console.warn(`[llm] Failed to record quota usage for ${provider.name}:`, error.message);
                    }
                }
                // Record cost ($0 for subscription providers)
                if (this.budgetTracker) {
                    try {
                        // Calculate cost (zero for subscription providers)
                        const cost = isSubscriptionProvider ? 0 : undefined; // undefined = use standard calculation
                        await this.budgetTracker.recordCost(result.tokens.total, provider.name, {
                            operationType: request.operationType || 'default',
                            model: result.model,
                            cost, // Pass zero cost for subscriptions
                        });
                    }
                    catch {
                        // Non-fatal
                    }
                }
                // Cache result
                if (!request.skipCache) {
                    const prompt = request.messages.map(m => m.content).join('\n');
                    const cacheKey = LLMCache.getCacheKey(prompt, request.operationType);
                    this.cache.set(cacheKey, result);
                }
                // Strip markdown code fences from JSON responses.
                // LLM providers (especially CLI-proxied ones like claude-code and copilot)
                // sometimes wrap JSON in ```json ... ``` despite being asked for raw JSON.
                if (result.content && (request.responseFormat?.type === 'json_object' || request.responseSchema)) {
                    result.content = this.stripMarkdownFences(result.content);
                }
                // Validate responseSchema (Zod) if provided
                if (request.responseSchema && result.content) {
                    try {
                        // Defense-in-depth: strip markdown fences again before JSON.parse
                        // in case the earlier strip missed an edge case
                        const cleanedForValidation = this.stripMarkdownFences(result.content);
                        result.content = cleanedForValidation;
                        request.responseSchema.parse(this.parseJsonWithRepair(cleanedForValidation));
                    }
                    catch (validationError) {
                        // Retry once with error context appended
                        const retryMessages = [
                            ...request.messages,
                            { role: 'assistant', content: result.content },
                            { role: 'user', content: `The response did not match the required schema. Error: ${validationError instanceof Error ? validationError.message : String(validationError)}. Please fix the JSON output.` },
                        ];
                        const retryRequest = { ...request, messages: retryMessages, skipCache: true };
                        // Re-try with same provider
                        result = await provider.complete(retryRequest);
                        result.latencyMs = Date.now() - startTime;
                        // Strip markdown fences from retry response too (same aggressive logic)
                        if (result.content) {
                            result.content = this.stripMarkdownFences(result.content);
                        }
                        // Validate again -- if still fails, throw
                        request.responseSchema.parse(this.parseJsonWithRepair(result.content));
                    }
                }
                this.emit('complete', { mode: 'public', ...result });
                return result;
            }
            catch (error) {
                // Check if quota exhausted
                if (error.message?.includes('QUOTA_EXHAUSTED') && this.quotaTracker) {
                    this.quotaTracker.markQuotaExhausted(provider.name);
                    console.info(`[llm] Provider ${provider.name} quota exhausted, marked for backoff`);
                }
                // Auth errors trip circuit breaker immediately (not after threshold)
                if (error.message?.includes('AUTH_ERROR')) {
                    this.circuitBreaker.tripImmediately(provider.name);
                    console.warn(`[llm] Provider ${provider.name} auth failed, circuit breaker tripped immediately`);
                }
                else {
                    this.circuitBreaker.recordFailure(provider.name);
                }
                console.warn(`[llm] Provider ${provider.name} failed:`, error.message);
                continue;
            }
        }
        throw new Error('[llm] All providers failed. Check API keys and provider availability.');
    }
    // --- Metrics & Stats ---
    /**
     * Strip markdown code fences from LLM JSON responses.
     * Handles: ```json ... ```, ```...```, and bare JSON extraction.
     */
    stripMarkdownFences(raw) {
        const trimmed = raw.trim();
        // Simple approach: if it starts with ``` and ends with ```, extract between them
        if (trimmed.startsWith('```')) {
            // Find end of opening fence line
            const firstNewline = trimmed.indexOf('\n');
            if (firstNewline > 0) {
                // Find the last ``` in the string
                const lastFenceIdx = trimmed.lastIndexOf('```');
                if (lastFenceIdx > firstNewline) {
                    return trimmed.slice(firstNewline + 1, lastFenceIdx).trim();
                }
            }
        }
        // Last resort: extract outermost JSON object/array
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
            const firstBrace = trimmed.indexOf('{');
            const firstBracket = trimmed.indexOf('[');
            const jsonStart = firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket) ? firstBrace : firstBracket;
            if (jsonStart >= 0) {
                const opener = trimmed[jsonStart];
                const closer = opener === '{' ? '}' : ']';
                const lastClose = trimmed.lastIndexOf(closer);
                if (lastClose > jsonStart)
                    return trimmed.slice(jsonStart, lastClose + 1);
            }
        }
        return trimmed;
    }
    /**
     * Parse JSON with automatic repair for truncated LLM responses.
     *
     * Common failure: copilot API returns JSON truncated at max_tokens limit,
     * producing "Expected ',' or ']' after array element" errors at ~12K-14K.
     * This method tries JSON.parse first, then attempts repair on failure.
     */
    parseJsonWithRepair(raw) {
        try {
            return JSON.parse(raw);
        }
        catch (firstError) {
            // Attempt repair of truncated JSON
            const repaired = this.repairTruncatedJson(raw);
            try {
                const result = JSON.parse(repaired);
                console.info('[llm] JSON repair succeeded — truncated LLM response was recovered');
                return result;
            }
            catch {
                throw firstError; // Throw original error for clarity
            }
        }
    }
    /**
     * Attempt to repair truncated JSON by removing the last incomplete element
     * and closing unclosed brackets/braces.
     */
    repairTruncatedJson(raw) {
        let s = raw.trim().replace(/,\s*$/, '');
        // Try to find the last complete element boundary
        const lastCompleteObj = s.lastIndexOf('},');
        const lastCompleteArr = s.lastIndexOf('],');
        const lastCompleteStr = s.lastIndexOf('",');
        const lastComplete = Math.max(lastCompleteObj, lastCompleteArr, lastCompleteStr);
        if (lastComplete > 0) {
            const truncated = s.slice(0, lastComplete + 1);
            const repaired = this.closeUnclosedBrackets(truncated);
            try {
                JSON.parse(repaired);
                return repaired;
            }
            catch {
                // Fall through
            }
        }
        // Simpler approach: just close unclosed brackets
        const repaired = this.closeUnclosedBrackets(s);
        try {
            JSON.parse(repaired);
            return repaired;
        }
        catch {
            return raw;
        }
    }
    /**
     * Close unclosed JSON brackets/braces by scanning for unmatched openers.
     */
    closeUnclosedBrackets(s) {
        const stack = [];
        let inString = false;
        let escaped = false;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\' && inString) {
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = !inString;
                continue;
            }
            if (inString)
                continue;
            if (ch === '{')
                stack.push('}');
            else if (ch === '[')
                stack.push(']');
            else if ((ch === '}' || ch === ']') && stack.length > 0 && stack[stack.length - 1] === ch) {
                stack.pop();
            }
        }
        let suffix = '';
        if (inString)
            suffix += '"';
        let result = s.replace(/,\s*$/, '') + suffix;
        while (stack.length > 0)
            result += stack.pop();
        return result;
    }
    getMetrics() {
        this.metrics.cacheSize = this.cache.size;
        this.metrics.cacheHits = this.cache.hits;
        this.metrics.cacheMisses = this.cache.misses;
        return this.metrics.getMetrics();
    }
    resetMetrics() {
        this.metrics.reset();
    }
    getAvailableProviders() {
        return this.registry.getAvailableProviders();
    }
    clearCache() {
        this.cache.clear();
    }
    getTierForTask(taskType) {
        return this.registry.getTierForTask(taskType);
    }
    /**
     * Backward-compatible stats method (matches UnifiedInferenceEngine.getStats())
     */
    getStats() {
        const metrics = this.getMetrics();
        return {
            totalInferences: metrics.totalCalls,
            byProvider: metrics.byProvider,
            byOperationType: metrics.byOperation,
            averageLatency: this.computeAverageLatency(metrics),
            cache: metrics.cache,
            providers: this.registry.getAvailableProviders(),
            circuitBreaker: this.circuitBreaker.getFailures(),
            budgetTracking: this.budgetTracker ? 'enabled' : 'disabled',
            sensitivityRouting: this.sensitivityClassifier ? 'enabled' : 'disabled',
        };
    }
    computeAverageLatency(metrics) {
        if (metrics.totalCalls === 0)
            return 0;
        const totalLatency = Object.values(metrics.byProvider)
            .reduce((sum, p) => sum + p.totalLatencyMs, 0);
        return totalLatency / metrics.totalCalls;
    }
    /**
     * Get underlying provider registry (for advanced use)
     */
    getRegistry() {
        return this.registry;
    }
    /**
     * Update provider priority at runtime from dashboard settings.
     * Propagates the flat priority array to the ProviderRegistry so that
     * subsequent resolveProviderChain() calls use the new order.
     */
    updateProviderPriority(flatPriority, taskTiers) {
        this.registry.setProviderPriority(flatPriority, taskTiers);
        console.info(`[llm] Provider priority updated via dashboard: [${flatPriority.join(', ')}]`);
    }
    /**
     * Get the MetricsTracker instance (for per-step tracking in semantic-analysis)
     */
    getMetricsTracker() {
        return this.metrics;
    }
}
//# sourceMappingURL=llm-service.js.map