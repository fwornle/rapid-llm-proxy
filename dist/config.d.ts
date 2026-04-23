/**
 * Configuration Loader
 *
 * Loads and merges LLM provider config from YAML, with env var expansion.
 */
import type { LLMServiceConfig } from './types.js';
/**
 * Load LLM service config from YAML file, searching multiple paths
 */
export declare function loadConfig(customPath?: string): Promise<LLMServiceConfig>;
/**
 * Get default config matching existing model-tiers.yaml
 */
export declare function getDefaultConfig(): LLMServiceConfig;
//# sourceMappingURL=config.d.ts.map