/**
 * Gemini Provider
 *
 * Uses the @google/generative-ai SDK (different API shape from OpenAI).
 * generateContent() with usageMetadata token extraction.
 */
import { BaseProvider } from './base-provider.js';
import type { LLMCompletionRequest, LLMCompletionResult, ProviderConfig, ProviderName } from '../types.js';
export declare class GeminiProvider extends BaseProvider {
    readonly name: ProviderName;
    readonly isLocal = false;
    private client;
    constructor(config?: Partial<ProviderConfig>);
    initialize(): Promise<void>;
    complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
}
//# sourceMappingURL=gemini-provider.d.ts.map