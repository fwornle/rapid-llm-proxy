/**
 * Abstract Base Provider
 *
 * All LLM providers extend this class.
 */
import type { LLMProvider, LLMCompletionRequest, LLMCompletionResult, ProviderConfig, ProviderName, ModelTier } from '../types.js';
export declare abstract class BaseProvider implements LLMProvider {
    abstract readonly name: ProviderName;
    abstract readonly isLocal: boolean;
    protected config: Partial<ProviderConfig>;
    protected _available: boolean;
    constructor(config?: Partial<ProviderConfig>);
    isAvailable(): boolean;
    abstract initialize(): Promise<void>;
    abstract complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
    getModels(): Partial<Record<ModelTier, string>>;
    /**
     * Resolve the model to use for a given tier
     */
    protected resolveModel(tier?: ModelTier): string;
}
//# sourceMappingURL=base-provider.d.ts.map