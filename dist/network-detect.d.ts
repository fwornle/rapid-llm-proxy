export type NetworkMode = 'vpn' | 'public';
/**
 * Detect current network mode (VPN/CN vs Public).
 * Results are cached for 5 minutes.
 */
export declare function detectNetworkMode(): Promise<NetworkMode>;
/**
 * Synchronous version for bridge server (which can't easily await)
 */
export declare function detectNetworkModeSync(): NetworkMode;
/**
 * Clear the cache (for testing or forced re-detection)
 */
export declare function clearNetworkCache(): void;
//# sourceMappingURL=network-detect.d.ts.map