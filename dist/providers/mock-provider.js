/**
 * Mock Provider
 *
 * Delegates to an injected MockServiceInterface.
 * Used for debug/test workflows to avoid real LLM calls.
 */
import { BaseProvider } from './base-provider.js';
export class MockProvider extends BaseProvider {
    name = 'mock';
    isLocal = true;
    mockService = null;
    repositoryPath;
    constructor(config = {}) {
        super(config);
        this.repositoryPath = process.cwd();
    }
    /**
     * Set the mock service implementation (dependency injection)
     */
    setMockService(service) {
        this.mockService = service;
        this._available = true;
    }
    /**
     * Set the repository path for mock context
     */
    setRepositoryPath(path) {
        this.repositoryPath = path;
    }
    async initialize() {
        // Available only when a mock service is injected
        this._available = !!this.mockService;
    }
    async complete(request) {
        if (!this.mockService) {
            throw new Error('Mock service not configured');
        }
        const agentType = request.agentId || request.operationType || 'default';
        const prompt = request.messages.map(m => m.content).join('\n');
        const result = await this.mockService.mockLLMCall(agentType, prompt, this.repositoryPath);
        return {
            ...result,
            provider: 'mock',
            model: result.model || 'mock-llm-v1',
            mock: true,
            local: true,
        };
    }
    getModels() {
        return { fast: 'mock-llm-v1', standard: 'mock-llm-v1', premium: 'mock-llm-v1' };
    }
}
//# sourceMappingURL=mock-provider.js.map