/**
 * Groq Provider
 *
 * Uses the Groq SDK (which has its own API shape, similar to OpenAI).
 * Uses GROQ_API_KEY for authentication.
 */
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import type { LLMCompletionRequest, LLMCompletionResult, ProviderConfig, ProviderName } from '../types.js';
export declare class GroqProvider extends OpenAICompatibleProvider {
    readonly name: ProviderName;
    readonly isLocal = false;
    constructor(config?: Partial<ProviderConfig>);
    protected getApiKey(): string | null;
    /**
     * Override: use Groq SDK instead of OpenAI SDK
     */
    initialize(): Promise<void>;
    /**
     * Override: Groq's smaller models (e.g. llama-3.1-8b-instant) don't support
     * json_schema response format. Downgrade responseSchema to json_object mode
     * and prepend a JSON instruction to the system prompt instead. The upstream
     * LLMService still validates the Zod schema after we return.
     */
    complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
}
//# sourceMappingURL=groq-provider.d.ts.map