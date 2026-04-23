/**
 * Groq Provider
 *
 * Uses the Groq SDK (which has its own API shape, similar to OpenAI).
 * Uses GROQ_API_KEY for authentication.
 */
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import { loadGroqSDK } from '../sdk-loader.js';
export class GroqProvider extends OpenAICompatibleProvider {
    name = 'groq';
    isLocal = false;
    constructor(config = {}) {
        super({
            models: { fast: 'llama-3.1-8b-instant', standard: 'llama-3.3-70b-versatile', premium: 'openai/gpt-oss-120b' },
            defaultModel: 'llama-3.3-70b-versatile',
            timeout: 10000,
            ...config,
        });
    }
    getApiKey() {
        const key = process.env.GROQ_API_KEY;
        if (key && key !== 'your-groq-api-key')
            return key;
        return null;
    }
    /**
     * Override: use Groq SDK instead of OpenAI SDK
     */
    async initialize() {
        const apiKey = this.getApiKey();
        if (!apiKey) {
            this._available = false;
            return;
        }
        const Groq = await loadGroqSDK();
        if (!Groq) {
            this._available = false;
            return;
        }
        try {
            this.client = new Groq({
                apiKey,
                timeout: this.config.timeout || 10000,
            });
            this._available = true;
        }
        catch (error) {
            console.warn('[llm:groq] Failed to initialize:', error.message);
            this._available = false;
        }
    }
    /**
     * Override: Groq's smaller models (e.g. llama-3.1-8b-instant) don't support
     * json_schema response format. Downgrade responseSchema to json_object mode
     * and prepend a JSON instruction to the system prompt instead. The upstream
     * LLMService still validates the Zod schema after we return.
     */
    async complete(request) {
        if (request.responseSchema) {
            const patched = { ...request };
            // Replace structured-output schema with plain json_object mode
            patched.responseSchema = undefined;
            patched.responseFormat = { type: 'json_object' };
            // Prepend a system instruction so the model knows to return valid JSON
            patched.messages = [
                { role: 'system', content: 'You MUST respond with valid JSON only. No markdown, no explanation.' },
                ...request.messages,
            ];
            return super.complete(patched);
        }
        return super.complete(request);
    }
}
//# sourceMappingURL=groq-provider.js.map