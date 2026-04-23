/**
 * Dynamic SDK Loader
 *
 * Lazily loads provider SDKs only when the corresponding env var is set.
 * This is a performance optimization — avoids loading unused SDKs.
 */
export declare function loadOpenAISDK(): Promise<any>;
export declare function loadAnthropicSDK(): Promise<any>;
export declare function loadGroqSDK(): Promise<any>;
export declare function loadGeminiSDK(): Promise<any>;
/**
 * Load all SDKs that have corresponding env vars set.
 * Returns a map of which SDKs loaded successfully.
 */
export declare function loadAllSDKs(): Promise<Record<string, boolean>>;
//# sourceMappingURL=sdk-loader.d.ts.map