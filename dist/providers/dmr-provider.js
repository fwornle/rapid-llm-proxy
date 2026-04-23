/**
 * Docker Model Runner (DMR) Provider
 *
 * Local LLM inference via Docker Desktop's Model Runner.
 * OpenAI-compatible API at localhost:${DMR_PORT}/engines/v1.
 * Supports per-agent model overrides from DMR config.
 */
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
export class DMRProvider extends OpenAICompatibleProvider {
    name = 'dmr';
    isLocal = true;
    dmrConfig;
    _lastHealthCheck = 0;
    _healthCheckResult = null;
    constructor(config = {}, dmrConfig) {
        const dmrHost = process.env.DMR_HOST || 'localhost';
        const dmrPort = process.env.DMR_PORT || '12434';
        const baseUrl = `http://${dmrHost}:${dmrPort}/engines/v1`;
        super({
            baseUrl,
            models: {
                fast: 'ai/llama3.2:3B-Q4_K_M',
                standard: 'ai/qwen2.5-coder:7B-Q4_K_M',
                premium: 'ai/llama3.2',
            },
            defaultModel: 'ai/llama3.2',
            timeout: 120000,
            isLocal: true,
            ...config,
        });
        this.dmrConfig = dmrConfig || {
            host: dmrHost,
            port: parseInt(dmrPort, 10),
            baseUrl,
            defaultModel: 'ai/llama3.2',
            modelOverrides: {},
            timeout: 120000,
            maxTokens: 4096,
            temperature: 0.7,
            connection: {
                maxRetries: 3,
                retryDelay: 1000,
                healthCheckInterval: 30000,
            },
        };
    }
    getApiKey() {
        // DMR doesn't need an API key
        return 'not-required';
    }
    getClientOptions() {
        return {
            apiKey: 'not-required',
            baseURL: this.config.baseUrl || this.dmrConfig.baseUrl,
            timeout: this.config.timeout || this.dmrConfig.timeout,
            maxRetries: this.dmrConfig.connection.maxRetries,
        };
    }
    /**
     * Override availability check: verify DMR is reachable with cached health check
     */
    isAvailable() {
        if (!this._available)
            return false;
        const now = Date.now();
        if (this._healthCheckResult !== null &&
            now - this._lastHealthCheck < this.dmrConfig.connection.healthCheckInterval) {
            return this._healthCheckResult;
        }
        return this._available;
    }
    /**
     * Check DMR health (call periodically or before first use)
     */
    async checkHealth() {
        if (!this.client)
            return false;
        try {
            await this.client.models.list();
            this._healthCheckResult = true;
            this._lastHealthCheck = Date.now();
            return true;
        }
        catch {
            this._healthCheckResult = false;
            this._lastHealthCheck = Date.now();
            return false;
        }
    }
    async initialize() {
        await super.initialize();
        if (this._available) {
            // Verify DMR is actually running
            const healthy = await this.checkHealth();
            this._available = healthy;
        }
    }
    /**
     * Override model resolution: support per-agent model overrides from DMR config
     */
    resolveModelForRequest(request) {
        // Per-agent override
        if (request.agentId && this.dmrConfig.modelOverrides[request.agentId]) {
            return this.dmrConfig.modelOverrides[request.agentId];
        }
        return super.resolveModelForRequest(request);
    }
    /**
     * Set DMR config (for loading from YAML after construction)
     */
    setDMRConfig(config) {
        this.dmrConfig = config;
    }
}
//# sourceMappingURL=dmr-provider.js.map