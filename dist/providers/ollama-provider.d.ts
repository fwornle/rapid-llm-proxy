/**
 * Ollama Provider
 *
 * Local LLM via Ollama's OpenAI-compatible API.
 * Verifies connection before marking as available.
 */
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import type { ProviderConfig, ProviderName } from '../types.js';
export declare class OllamaProvider extends OpenAICompatibleProvider {
    readonly name: ProviderName;
    readonly isLocal = true;
    private baseUrl;
    constructor(config?: Partial<ProviderConfig>);
    protected getApiKey(): string | null;
    protected getClientOptions(): Record<string, any>;
    initialize(): Promise<void>;
    /**
     * Verify Ollama is running by checking /api/tags
     */
    private verifyConnection;
}
//# sourceMappingURL=ollama-provider.d.ts.map