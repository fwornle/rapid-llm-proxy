/**
 * Abstract Base Provider
 *
 * All LLM providers extend this class.
 */
export class BaseProvider {
    config;
    _available = false;
    constructor(config = {}) {
        this.config = config;
    }
    isAvailable() {
        return this._available;
    }
    getModels() {
        return this.config.models || {};
    }
    /**
     * Resolve the model to use for a given tier
     */
    resolveModel(tier) {
        if (tier && this.config.models?.[tier]) {
            return this.config.models[tier];
        }
        return this.config.defaultModel || 'unknown';
    }
}
//# sourceMappingURL=base-provider.js.map