/**
 * OpenAI-Compatible Base Provider
 *
 * Shared base for providers that use the OpenAI SDK/API shape:
 * Groq, OpenAI, GitHub Models, DMR, Ollama.
 */
import { BaseProvider } from './base-provider.js';
import type { LLMCompletionRequest, LLMCompletionResult, ProviderConfig } from '../types.js';
export declare abstract class OpenAICompatibleProvider extends BaseProvider {
    protected client: any;
    constructor(config?: Partial<ProviderConfig>);
    /**
     * Subclasses must provide the API key
     */
    protected abstract getApiKey(): string | null;
    /**
     * Subclasses can override client creation options
     */
    protected getClientOptions(): Record<string, any>;
    initialize(): Promise<void>;
    complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
    /**
     * Resolve model from request hints. Subclasses can override for per-agent routing.
     */
    protected resolveModelForRequest(request: LLMCompletionRequest): string;
}
//# sourceMappingURL=openai-compatible-provider.d.ts.map