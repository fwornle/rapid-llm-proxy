/**
 * Network Detection Module
 *
 * Detects VPN/Corporate Network vs Public network.
 * Used to select appropriate provider priority chains from network_overrides in YAML config.
 *
 * Detection signals (ordered by reliability):
 *   1. Environment variable override: LLM_NETWORK_MODE=vpn|public
 *   2. VPN tunnel interfaces (utun*/ tun * /ppp*;
with (private - range)
    routes
        * 3.;
DNS;
resolution;
of;
a;
configurable;
probe;
hostname;
IP
    *
    * Configuration;
    * LLM_NETWORK_MODE;
force;
"vpn";
or;
"public"(skips, all, detection)
    * LLM_VPN_PROBE_HOST;
hostname;
to;
resolve;
for (VPN; detection
    * (e.g.); "ghe.mycompany.com", "vpn-gateway.corp.example.com")
        * If;
unset, only;
interface - based;
detection;
is;
used.
    *
    * On;
non - macOS / Linux;
or;
if (detection)
    fails, defaults;
to;
'public'.
    * /;
import { execSync } from 'child_process';
import { resolve as dnsResolve } from 'dns';
/** Cached result (detection is expensive, network rarely changes mid-session) */
let cachedMode = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // Re-check every 5 minutes
/**
 * Detect current network mode (VPN/CN vs Public).
 * Results are cached for 5 minutes.
 */
export async function detectNetworkMode() {
    // 1. Explicit env var override — always wins
    const envOverride = process.env.LLM_NETWORK_MODE?.toLowerCase();
    if (envOverride === 'vpn' || envOverride === 'public') {
        return envOverride;
    }
    // 2. Check cache
    if (cachedMode && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
        return cachedMode;
    }
    // 3. Detect
    const mode = await doDetect();
    cachedMode = mode;
    cacheTimestamp = Date.now();
    console.info(`[llm:network] Detected network mode: ${mode}`);
    return mode;
}
/**
 * Synchronous version for bridge server (which can't easily await)
 */
export function detectNetworkModeSync() {
    const envOverride = process.env.LLM_NETWORK_MODE?.toLowerCase();
    if (envOverride === 'vpn' || envOverride === 'public') {
        return envOverride;
    }
    if (cachedMode && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
        return cachedMode;
    }
    const mode = doDetectSync();
    cachedMode = mode;
    cacheTimestamp = Date.now();
    console.info(`[llm:network] Detected network mode (sync): ${mode}`);
    return mode;
}
/**
 * Clear the cache (for testing or forced re-detection)
 */
export function clearNetworkCache() {
    cachedMode = null;
    cacheTimestamp = 0;
}
// --- Internal detection logic ---
/** Get the user-configured probe hostname, or null if not set */
function getProbeHost() {
    return process.env.LLM_VPN_PROBE_HOST?.trim() || null;
}
async function doDetect() {
    // Signal 1: Check for VPN tunnel interfaces
    if (hasVpnInterface())
        return 'vpn';
    // Signal 2: DNS resolution of configurable probe host → private IP
    const probeHost = getProbeHost();
    if (probeHost && await resolvesToPrivateIP(probeHost))
        return 'vpn';
    return 'public';
}
function doDetectSync() {
    // Signal 1: Check for VPN tunnel interfaces
    if (hasVpnInterface())
        return 'vpn';
    // Signal 2: DNS probe (sync via dig)
    const probeHost = getProbeHost();
    if (probeHost && digResolvesToPrivateIP(probeHost))
        return 'vpn';
    return 'public';
}
/**
 * Check if any utun/tun/ppp interface exists with routes to private IP ranges.
 * Works on macOS (ifconfig/netstat) and Linux (ip route).
 */
function hasVpnInterface() {
    try {
        if (process.platform === 'linux') {
            const routes = execSync('ip route 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
            // Look for routes through tun/ppp devices to private ranges
            const vpnLines = routes.split('\n').filter(l => /\b(tun|ppp|wg)\d*\b/.test(l));
            return vpnLines.some(l => /\b(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(l));
        }
        // macOS: check for utun interfaces with an IP
        const ifconfig = execSync('ifconfig 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
        const utunMatch = ifconfig.match(/^(utun\d+):.*\n(?:.*\n)*?.*inet\s+(\d+\.\d+\.\d+\.\d+)/m);
        if (utunMatch)
            return true;
        // Fallback: check route table for private ranges via utun
        const routes = execSync('netstat -rn 2>/dev/null | grep utun', { encoding: 'utf8', timeout: 3000 });
        if (/\b(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(routes)) {
            return true;
        }
    }
    catch {
        // Command failed — unsupported platform or no permissions
    }
    return false;
}
/**
 * Async DNS resolution — check if hostname resolves to a private IP
 */
function resolvesToPrivateIP(hostname) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 3000);
        dnsResolve(hostname, (err, addresses) => {
            clearTimeout(timer);
            if (err || !addresses?.length) {
                resolve(false);
                return;
            }
            resolve(addresses.some(isPrivateIP));
        });
    });
}
/**
 * Sync DNS resolution via dig command
 */
function digResolvesToPrivateIP(hostname) {
    try {
        const result = execSync(`dig +short ${hostname} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
        const ips = result.trim().split('\n').filter(line => /^\d+\.\d+\.\d+\.\d+$/.test(line));
        return ips.some(isPrivateIP);
    }
    catch {
        return false;
    }
}
/**
 * Check if an IP address is in a private range (RFC 1918 + RFC 6598)
 */
function isPrivateIP(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p)))
        return false;
    // 10.0.0.0/8
    if (parts[0] === 10)
        return true;
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168)
        return true;
    // 100.64.0.0/10 (CGNAT — used by some VPN providers)
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
        return true;
    return false;
}
//# sourceMappingURL=network-detect.js.map