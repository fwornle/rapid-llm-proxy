/**
 * Configuration Loader
 *
 * Loads and merges LLM provider config from YAML, with env var expansion.
 */
import * as fs from 'fs';
import * as path from 'path';
// Dynamic import for yaml (ES module)
let yamlModule = null;
async function loadYaml() {
    if (!yamlModule) {
        try {
            yamlModule = await import('yaml');
        }
        catch {
            // Fallback: try js-yaml (may be available in parent project)
            try {
                // @ts-ignore — js-yaml may not have type declarations
                yamlModule = await import('js-yaml');
            }
            catch {
                console.warn('[llm] No YAML parser available');
            }
        }
    }
    return yamlModule;
}
/**
 * Expand environment variables in a string: ${VAR} or ${VAR:-default}
 */
function expandEnvVars(str) {
    return str.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, varName, defaultVal) => {
        return process.env[varName] || defaultVal || '';
    });
}
/**
 * Recursively expand env vars in all string values of an object
 */
function expandEnvVarsDeep(obj) {
    if (typeof obj === 'string')
        return expandEnvVars(obj);
    if (Array.isArray(obj))
        return obj.map(expandEnvVarsDeep);
    if (obj && typeof obj === 'object') {
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = expandEnvVarsDeep(value);
        }
        return result;
    }
    return obj;
}
/**
 * Load LLM service config from YAML file, searching multiple paths
 */
export async function loadConfig(customPath) {
    const yaml = await loadYaml();
    if (!yaml)
        return getDefaultConfig();
    const searchPaths = customPath
        ? [customPath]
        : [
            path.join(process.cwd(), 'config', 'llm-providers.yaml'),
            path.join(process.cwd(), 'lib', 'llm', 'config', 'llm-providers.yaml'),
            // Fallback: package's own bundled config
            path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'config', 'llm-providers.yaml'),
            // Fallback: Docker/monorepo contexts
            path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'config', 'llm-providers.yaml'),
        ];
    for (const configPath of searchPaths) {
        if (fs.existsSync(configPath)) {
            try {
                const content = fs.readFileSync(configPath, 'utf8');
                const parse = yaml.parse || yaml.load;
                const parsed = parse(content);
                const expanded = expandEnvVarsDeep(parsed);
                console.info(`[llm] Loaded config from ${configPath}`);
                return normalizeConfig(expanded);
            }
            catch (error) {
                console.warn(`[llm] Failed to parse config at ${configPath}:`, error.message);
            }
        }
    }
    console.info('[llm] No llm-providers.yaml found, using defaults');
    return getDefaultConfig();
}
/**
 * Convert taskTiers from {task: tier} YAML format to {tier: tasks[]} format.
 * Detects format by checking if values are strings (inverted) or arrays (already correct).
 */
function invertTaskTiers(raw) {
    const firstValue = Object.values(raw)[0];
    if (typeof firstValue === 'string') {
        const inverted = {};
        for (const [task, tier] of Object.entries(raw)) {
            if (typeof tier === 'string') {
                if (!inverted[tier])
                    inverted[tier] = [];
                inverted[tier].push(task);
            }
        }
        return inverted;
    }
    // Already in {tier: tasks[]} format
    return raw;
}
/**
 * Normalize YAML snake_case keys to camelCase config
 */
function normalizeConfig(raw) {
    return {
        providers: raw.providers,
        providerPriority: raw.provider_priority || raw.providerPriority,
        taskProviderPriority: raw.task_provider_priority || raw.taskProviderPriority,
        taskTiers: (raw.task_tiers || raw.taskTiers) ? invertTaskTiers(raw.task_tiers || raw.taskTiers) : undefined,
        agentOverrides: raw.agent_overrides || raw.agentOverrides,
        operatorTiers: raw.operator_tiers || raw.operatorTiers,
        batchTaskTiers: raw.batch_task_tiers || raw.batchTaskTiers,
        modelRouting: raw.model_routing || raw.modelRouting,
        networkOverrides: raw.network_overrides || raw.networkOverrides,
        dmr: raw.dmr,
        costLimits: raw.cost_limits || raw.costLimits,
        cache: raw.cache,
        circuitBreaker: raw.circuitBreaker ? {
            threshold: raw.circuitBreaker.failureThreshold ?? raw.circuitBreaker.threshold,
            resetTimeoutMs: raw.circuitBreaker.resetTimeoutMs,
        } : raw.circuit_breaker ? {
            threshold: raw.circuit_breaker.failureThreshold ?? raw.circuit_breaker.threshold,
            resetTimeoutMs: raw.circuit_breaker.resetTimeoutMs,
        } : undefined,
    };
}
/**
 * Get default config matching existing model-tiers.yaml
 */
export function getDefaultConfig() {
    return {
        providers: {
            groq: {
                name: 'groq',
                apiKeyEnvVar: 'GROQ_API_KEY',
                models: { fast: 'llama-3.1-8b-instant', standard: 'llama-3.3-70b-versatile', premium: 'openai/gpt-oss-120b' },
                defaultModel: 'llama-3.3-70b-versatile',
            },
            anthropic: {
                name: 'anthropic',
                apiKeyEnvVar: 'ANTHROPIC_API_KEY',
                models: { fast: 'claude-haiku-4-5', standard: 'claude-sonnet-4-5', premium: 'claude-opus-4-6' },
                defaultModel: 'claude-sonnet-4-5',
            },
            openai: {
                name: 'openai',
                apiKeyEnvVar: 'OPENAI_API_KEY',
                models: { fast: 'gpt-4.1-mini', standard: 'gpt-4.1', premium: 'o4-mini' },
                defaultModel: 'gpt-4.1-mini',
            },
            gemini: {
                name: 'gemini',
                apiKeyEnvVar: 'GOOGLE_API_KEY',
                models: { fast: 'gemini-2.5-flash', standard: 'gemini-2.5-flash', premium: 'gemini-2.5-pro' },
                defaultModel: 'gemini-2.5-flash',
            },
            'github-models': {
                name: 'github-models',
                apiKeyEnvVar: 'GITHUB_TOKEN',
                baseUrl: 'https://models.github.ai/inference/v1',
                models: { fast: 'gpt-4.1-mini', standard: 'gpt-4.1', premium: 'o4-mini' },
                defaultModel: 'gpt-4.1-mini',
            },
        },
        providerPriority: {
            fast: ['copilot', 'claude-code', 'groq', 'github-models'],
            standard: ['copilot', 'claude-code', 'groq', 'openai', 'anthropic'],
            premium: ['copilot', 'claude-code', 'openai', 'anthropic', 'gemini'],
        },
        taskTiers: {
            fast: [
                'git_file_extraction', 'commit_message_parsing', 'file_pattern_matching',
                'basic_classification', 'documentation_file_scanning',
            ],
            standard: [
                'git_history_analysis', 'vibe_history_analysis', 'semantic_code_analysis',
                'documentation_linking', 'web_search_summarization', 'ontology_classification',
                'content_validation', 'deduplication_similarity', 'observation_generation',
            ],
            premium: [
                'insight_generation', 'pattern_recognition',
                'quality_assurance_review', 'deep_code_analysis', 'entity_significance_scoring',
            ],
        },
        agentOverrides: {
            insight_generation: 'premium',
            observation_generation: 'standard',
            quality_assurance: 'premium',
            semantic_analysis: 'standard',
            git_history: 'standard',
            vibe_history: 'standard',
            ontology_classification: 'standard',
            content_validation: 'standard',
            batch_scheduler: 'fast',
            batch_checkpoint_manager: 'fast',
            kg_operators: 'standard',
        },
        dmr: {
            host: process.env.DMR_HOST || 'localhost',
            port: parseInt(process.env.DMR_PORT || '12434', 10),
            baseUrl: `http://${process.env.DMR_HOST || 'localhost'}:${process.env.DMR_PORT || '12434'}/engines/v1`,
            defaultModel: 'ai/llama3.2',
            modelOverrides: {
                git_history: 'ai/llama3.2:3B-Q4_K_M',
                vibe_history: 'ai/llama3.2:3B-Q4_K_M',
                web_search: 'ai/llama3.2:3B-Q4_K_M',
                documentation_linker: 'ai/llama3.2:3B-Q4_K_M',
                semantic_analysis: 'ai/qwen2.5-coder:7B-Q4_K_M',
                ontology_classification: 'ai/qwen2.5-coder:7B-Q4_K_M',
                content_validation: 'ai/qwen2.5-coder:7B-Q4_K_M',
                insight_generation: 'ai/llama3.2',
                observation_generation: 'ai/llama3.2',
                quality_assurance: 'ai/llama3.2',
                kg_operators: 'ai/qwen2.5-coder:7B-Q4_K_M',
            },
            timeout: 120000,
            maxTokens: 4096,
            temperature: 0.7,
            connection: {
                maxRetries: 3,
                retryDelay: 1000,
                healthCheckInterval: 30000,
            },
        },
        costLimits: {
            budgetMode: 0.05,
            standardMode: 0.50,
            qualityMode: 2.00,
        },
        cache: { maxSize: 1000, ttlMs: 3600000 },
        circuitBreaker: { threshold: 5, resetTimeoutMs: 60000 },
    };
}
//# sourceMappingURL=config.js.map