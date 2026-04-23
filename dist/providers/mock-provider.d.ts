/**
 * Mock Provider
 *
 * Delegates to an injected MockServiceInterface.
 * Used for debug/test workflows to avoid real LLM calls.
 */
import { BaseProvider } from './base-provider.js';
import type { LLMCompletionRequest, LLMCompletionResult, ProviderConfig, ProviderName, MockServiceInterface } from '../types.js';
export declare class MockProvider extends BaseProvider {
    readonly name: ProviderName;
    readonly isLocal = true;
    private mockService;
    private repositoryPath;
    constructor(config?: Partial<ProviderConfig>);
    /**
     * Set the mock service implementation (dependency injection)
     */
    setMockService(service: MockServiceInterface): void;
    /**
     * Set the repository path for mock context
     */
    setRepositoryPath(path: string): void;
    initialize(): Promise<void>;
    complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
    getModels(): {
        fast: string;
        standard: string;
        premium: string;
    };
}
//# sourceMappingURL=mock-provider.d.ts.map