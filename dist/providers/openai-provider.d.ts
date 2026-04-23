/**
 * OpenAI Provider
 *
 * Standard OpenAI API. Skips if OPENAI_BASE_URL is set (that's the custom/corporate provider).
 */
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import type { ProviderConfig, ProviderName } from '../types.js';
export declare class OpenAIProvider extends OpenAICompatibleProvider {
    readonly name: ProviderName;
    readonly isLocal = false;
    constructor(config?: Partial<ProviderConfig>);
    protected getApiKey(): string | null;
}
//# sourceMappingURL=openai-provider.d.ts.map