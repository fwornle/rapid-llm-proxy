/**
 * Anthropic Provider
 *
 * Uses the Anthropic SDK (different API shape from OpenAI).
 * messages.create() with separate content extraction.
 */
import { BaseProvider } from './base-provider.js';
import type { LLMCompletionRequest, LLMCompletionResult, ProviderConfig, ProviderName } from '../types.js';
export declare class AnthropicProvider extends BaseProvider {
    readonly name: ProviderName;
    readonly isLocal = false;
    private client;
    constructor(config?: Partial<ProviderConfig>);
    initialize(): Promise<void>;
    complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
}
//# sourceMappingURL=anthropic-provider.d.ts.map