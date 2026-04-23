/**
 * Ollama Provider
 *
 * Local LLM via Ollama's OpenAI-compatible API.
 * Verifies connection before marking as available.
 */
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
export class OllamaProvider extends OpenAICompatibleProvider {
    name = 'ollama';
    isLocal = true;
    baseUrl;
    constructor(config = {}) {
        const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
        const model = process.env.OLLAMA_MODEL || 'llama3.2:latest';
        super({
            baseUrl: `${baseUrl}/v1`,
            models: { fast: model, standard: model, premium: model },
            defaultModel: model,
            timeout: 30000,
            isLocal: true,
            ...config,
        });
        this.baseUrl = baseUrl;
    }
    getApiKey() {
        return 'ollama'; // Ollama doesn't need a real API key
    }
    getClientOptions() {
        return {
            apiKey: 'ollama',
            baseURL: this.config.baseUrl || `${this.baseUrl}/v1`,
            timeout: this.config.timeout || 30000,
        };
    }
    async initialize() {
        // First try to verify Ollama is running
        const reachable = await this.verifyConnection();
        if (!reachable) {
            this._available = false;
            return;
        }
        await super.initialize();
    }
    /**
     * Verify Ollama is running by checking /api/tags
     */
    async verifyConnection() {
        try {
            const response = await fetch(`${this.baseUrl}/api/tags`, {
                signal: AbortSignal.timeout(5000),
            });
            if (response.ok) {
                const data = await response.json();
                const models = data.models || [];
                console.info(`[llm:ollama] Available with ${models.length} models`);
                return true;
            }
            return false;
        }
        catch {
            console.info('[llm:ollama] Not available');
            return false;
        }
    }
}
//# sourceMappingURL=ollama-provider.js.map