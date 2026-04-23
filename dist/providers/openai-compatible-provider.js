/**
 * OpenAI-Compatible Base Provider
 *
 * Shared base for providers that use the OpenAI SDK/API shape:
 * Groq, OpenAI, GitHub Models, DMR, Ollama.
 */
import { BaseProvider } from './base-provider.js';
import { loadOpenAISDK } from '../sdk-loader.js';
// Lazy-loaded zodResponseFormat helper
let zodResponseFormatFn = null;
async function getZodResponseFormat() {
    if (zodResponseFormatFn)
        return zodResponseFormatFn;
    try {
        const mod = await import('openai/helpers/zod');
        zodResponseFormatFn = mod.zodResponseFormat;
        return zodResponseFormatFn;
    }
    catch {
        return null;
    }
}
export class OpenAICompatibleProvider extends BaseProvider {
    client = null;
    constructor(config = {}) {
        super(config);
    }
    /**
     * Subclasses can override client creation options
     */
    getClientOptions() {
        return {
            apiKey: this.getApiKey(),
            timeout: this.config.timeout || 30000,
        };
    }
    async initialize() {
        const apiKey = this.getApiKey();
        if (!apiKey) {
            this._available = false;
            return;
        }
        const OpenAI = await loadOpenAISDK();
        if (!OpenAI) {
            this._available = false;
            return;
        }
        try {
            this.client = new OpenAI(this.getClientOptions());
            this._available = true;
        }
        catch (error) {
            console.warn(`[llm:${this.name}] Failed to initialize:`, error.message);
            this._available = false;
        }
    }
    async complete(request) {
        if (!this.client) {
            throw new Error(`${this.name} provider not initialized`);
        }
        const model = this.resolveModelForRequest(request);
        const startTime = Date.now();
        const params = {
            model,
            messages: request.messages.map(m => ({ role: m.role, content: m.content })),
            max_tokens: request.maxTokens || 4096,
            temperature: request.temperature ?? 0.7,
            stream: false,
        };
        if (request.responseSchema) {
            // Use native zodResponseFormat for OpenAI-compatible providers
            const zrf = await getZodResponseFormat();
            if (zrf) {
                params.response_format = zrf(request.responseSchema, 'structured_output');
            }
            else {
                // Fallback to JSON mode if zodResponseFormat unavailable
                params.response_format = { type: 'json_object' };
            }
        }
        else if (request.responseFormat?.type === 'json_object') {
            params.response_format = { type: 'json_object' };
        }
        const response = await this.client.chat.completions.create(params);
        const latencyMs = Date.now() - startTime;
        const content = response.choices[0]?.message?.content || '';
        const usage = response.usage;
        return {
            content,
            provider: this.name,
            model,
            tokens: {
                input: usage?.prompt_tokens || 0,
                output: usage?.completion_tokens || 0,
                total: usage?.total_tokens || 0,
            },
            latencyMs,
            local: this.isLocal,
        };
    }
    /**
     * Resolve model from request hints. Subclasses can override for per-agent routing.
     */
    resolveModelForRequest(request) {
        return this.resolveModel(request.tier);
    }
}
//# sourceMappingURL=openai-compatible-provider.js.map