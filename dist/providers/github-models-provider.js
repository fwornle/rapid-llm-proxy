/**
 * GitHub Models Provider
 *
 * Uses GITHUB_TOKEN with the GitHub Models inference endpoint.
 * OpenAI-compatible API at https://models.github.ai/inference/v1
 */
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
export class GitHubModelsProvider extends OpenAICompatibleProvider {
    name = 'github-models';
    isLocal = false;
    constructor(config = {}) {
        super({
            baseUrl: 'https://models.github.ai/inference/v1',
            models: { fast: 'gpt-4.1-mini', standard: 'gpt-4.1', premium: 'o4-mini' },
            defaultModel: 'gpt-4.1-mini',
            timeout: 30000,
            ...config,
        });
    }
    getApiKey() {
        return process.env.GITHUB_TOKEN || null;
    }
    getClientOptions() {
        return {
            apiKey: this.getApiKey(),
            baseURL: this.config.baseUrl || 'https://models.github.ai/inference/v1',
            timeout: this.config.timeout || 30000,
        };
    }
}
//# sourceMappingURL=github-models-provider.js.map