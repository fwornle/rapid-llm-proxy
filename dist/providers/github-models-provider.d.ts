/**
 * GitHub Models Provider
 *
 * Uses GITHUB_TOKEN with the GitHub Models inference endpoint.
 * OpenAI-compatible API at https://models.github.ai/inference/v1
 */
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import type { ProviderConfig, ProviderName } from '../types.js';
export declare class GitHubModelsProvider extends OpenAICompatibleProvider {
    readonly name: ProviderName;
    readonly isLocal = false;
    constructor(config?: Partial<ProviderConfig>);
    protected getApiKey(): string | null;
    protected getClientOptions(): Record<string, any>;
}
//# sourceMappingURL=github-models-provider.d.ts.map