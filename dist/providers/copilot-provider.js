/**
 * GitHub Copilot Provider (Direct HTTP)
 *
 * Uses the GitHub Copilot API directly via OpenAI-compatible HTTP endpoint.
 * Auth flow:
 *   1. Read OAuth token (gho_...) from ~/.local/share/opencode/auth.json
 *   2. Build API base URL: https://copilot-api.${enterpriseUrl} (enterprise)
 *      or https://api.individual.githubcopilot.com (public GitHub)
 *   3. Use the refresh token directly as Bearer — no token exchange needed.
 *
 * Network: Uses undici ProxyAgent when HTTPS_PROXY is set (corporate network).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BaseProvider } from './base-provider.js';
const AUTH_FILE = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
/**
 * Create a fetch function that respects HTTPS_PROXY via HTTP CONNECT tunnel.
 * Zero external dependencies — uses Node.js built-in http + tls modules.
 * Falls back to global fetch if no proxy is configured.
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
let _proxyFetch = null;
let _proxyFetchInitialized = false;
function getProxyUrl() {
    return process.env.HTTPS_PROXY || process.env.https_proxy || null;
}
/**
 * Establish an HTTP CONNECT tunnel through the proxy, then TLS-wrap it.
 * Returns a Node.js Agent that routes through the tunnel.
 */
function createTunnelAgent(proxyUrl, targetHost, targetPort) {
    return new Promise((resolve, reject) => {
        const proxy = new URL(proxyUrl);
        const req = http.request({
            host: proxy.hostname,
            port: parseInt(proxy.port) || 3128,
            method: 'CONNECT',
            path: `${targetHost}:${targetPort}`,
        });
        req.on('connect', (_res, socket) => {
            const tlsSocket = tls.connect({ host: targetHost, socket, servername: targetHost });
            const agent = new https.Agent({ maxSockets: 1 });
            // Monkey-patch createConnection to return our pre-connected TLS socket
            agent.createConnection = () => tlsSocket;
            resolve(agent);
        });
        req.on('error', reject);
        req.setTimeout(10_000, () => { req.destroy(new Error('CONNECT tunnel timeout')); });
        req.end();
    });
}
/**
 * Proxy-aware fetch: if HTTPS_PROXY is set, establish a CONNECT tunnel
 * for each request. Otherwise use global fetch.
 */
async function proxyFetchImpl(url, init = {}) {
    const proxyUrl = getProxyUrl();
    if (!proxyUrl)
        return globalThis.fetch(url, init);
    const parsed = new URL(url);
    const agent = await createTunnelAgent(proxyUrl, parsed.hostname, parseInt(parsed.port) || 443);
    return new Promise((resolve, reject) => {
        const body = init.body ? String(init.body) : undefined;
        const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k, String(v)]));
        const req = https.request(parsed.href, {
            method: init.method || 'GET',
            headers,
            agent,
            signal: init.signal,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const bodyText = Buffer.concat(chunks).toString('utf8');
                resolve(new Response(bodyText, {
                    status: res.statusCode || 500,
                    statusText: res.statusMessage || '',
                    headers: new Headers(res.headers),
                }));
            });
        });
        req.on('error', reject);
        if (body)
            req.write(body);
        req.end();
    });
}
async function getProxyFetch() {
    if (_proxyFetchInitialized && _proxyFetch)
        return _proxyFetch;
    const proxyUrl = getProxyUrl();
    if (proxyUrl) {
        _proxyFetch = proxyFetchImpl;
        console.info(`[llm:copilot] Using HTTPS_PROXY: ${proxyUrl} (CONNECT tunnel)`);
    }
    else {
        _proxyFetch = globalThis.fetch;
    }
    _proxyFetchInitialized = true;
    return _proxyFetch;
}
export class CopilotProvider extends BaseProvider {
    name = 'copilot';
    isLocal = false;
    auth = null;
    useProxy = false;
    constructor(config = {}) {
        super({
            models: {
                fast: 'claude-haiku-4.5',
                standard: 'claude-sonnet-4.6',
                premium: 'claude-opus-4.6',
            },
            defaultModel: 'claude-sonnet-4.6',
            timeout: 120000,
            ...config,
        });
    }
    /**
     * Load OAuth token and build API base URL from OpenCode's auth.json.
     * Re-reads at most every 60 seconds.
     *
     * For enterprise: apiBaseUrl = https://copilot-api.${enterpriseUrl}
     * For public:     apiBaseUrl = https://api.individual.githubcopilot.com
     */
    loadAuth() {
        const now = Date.now();
        if (this.auth && (now - this.auth.lastLoaded) < 60_000) {
            return this.auth;
        }
        try {
            const raw = fs.readFileSync(AUTH_FILE, 'utf8');
            const authData = JSON.parse(raw);
            // Prefer enterprise entry, fall back to public
            const enterprise = authData['github-copilot-enterprise'];
            const public_ = authData['github-copilot'];
            const entry = enterprise || public_;
            if (!entry?.refresh) {
                return null;
            }
            const enterpriseUrl = entry.enterpriseUrl || null;
            const apiBaseUrl = enterpriseUrl
                ? `https://copilot-api.${enterpriseUrl}`
                : 'https://api.individual.githubcopilot.com';
            this.auth = {
                token: entry.refresh,
                apiBaseUrl,
                lastLoaded: now,
            };
            return this.auth;
        }
        catch {
            return null;
        }
    }
    async initialize() {
        // In Docker, prefer proxy bridge (host has the auth tokens)
        const inDocker = !!process.env.LLM_CLI_PROXY_URL;
        if (!inDocker) {
            // Running on host — try direct HTTP
            const auth = this.loadAuth();
            if (auth) {
                try {
                    const pFetch = await getProxyFetch();
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), 10_000);
                    const response = await pFetch(`${auth.apiBaseUrl}/models`, {
                        headers: {
                            'Authorization': `Bearer ${auth.token}`,
                            'User-Agent': 'opencode/1.0',
                            'Openai-Intent': 'conversation-edits',
                        },
                        signal: controller.signal,
                    });
                    clearTimeout(timer);
                    if (response.ok) {
                        this._available = true;
                        this.useProxy = false;
                        console.info(`[llm:copilot] Provider initialized (direct HTTP → ${auth.apiBaseUrl})`);
                        return;
                    }
                }
                catch {
                    // Direct HTTP failed — try proxy bridge
                }
            }
        }
        // Proxy bridge (for Docker containers or when direct fails)
        const proxyAvailable = await this.checkProxyAvailable();
        if (proxyAvailable) {
            this._available = true;
            this.useProxy = true;
            console.info('[llm:copilot] Provider initialized (HTTP proxy → direct HTTP on host)');
            return;
        }
        console.info('[llm:copilot] Neither direct HTTP nor proxy available');
        this._available = false;
    }
    async checkProxyAvailable() {
        const proxyUrl = process.env.LLM_CLI_PROXY_URL;
        if (!proxyUrl)
            return false;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const response = await fetch(`${proxyUrl}/health`, { signal: controller.signal });
            clearTimeout(timeout);
            if (!response.ok)
                return false;
            const data = (await response.json());
            return data.providers?.copilot?.available === true;
        }
        catch {
            return false;
        }
    }
    async complete(request) {
        if (!this._available) {
            throw new Error('GitHub Copilot provider not available');
        }
        if (this.useProxy) {
            return this.completeViaProxy(request);
        }
        return this.completeDirectHTTP(request);
    }
    /**
     * Direct HTTP call to Copilot API (OpenAI-compatible endpoint).
     * Uses refresh token directly as Bearer — no token exchange.
     */
    async completeDirectHTTP(request) {
        const auth = this.loadAuth();
        if (!auth) {
            throw new Error('AUTH_ERROR: No Copilot OAuth token available. Run `opencode` to authenticate.');
        }
        const pFetch = await getProxyFetch();
        const model = this.resolveModel(request.tier);
        const timeoutMs = request.timeout || this.config.timeout || 120000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const body = {
            model,
            messages: request.messages.map(m => ({ role: m.role, content: m.content })),
            max_tokens: request.maxTokens || 4096,
            stream: false,
        };
        if (request.temperature !== undefined) {
            body.temperature = request.temperature;
        }
        if (request.responseFormat?.type === 'json_object') {
            body.response_format = { type: 'json_object' };
        }
        try {
            const startTime = Date.now();
            const response = await pFetch(`${auth.apiBaseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${auth.token}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'opencode/1.0',
                    'Openai-Intent': 'conversation-edits',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            clearTimeout(timer);
            if (!response.ok) {
                const errBody = await response.text().catch(() => '');
                if (response.status === 401 || response.status === 403) {
                    this.auth = null; // Force re-read
                    throw new Error(`AUTH_ERROR: Copilot API returned ${response.status}: ${errBody}`);
                }
                if (response.status === 429) {
                    throw new Error(`QUOTA_EXHAUSTED: Copilot API rate limited: ${errBody}`);
                }
                throw new Error(`Copilot API error (${response.status}): ${errBody}`);
            }
            const data = await response.json();
            const content = data.choices?.[0]?.message?.content || '';
            const usage = data.usage;
            return {
                content,
                provider: this.name,
                model: data.model || model,
                tokens: {
                    input: usage?.prompt_tokens || 0,
                    output: usage?.completion_tokens || 0,
                    total: usage?.total_tokens || 0,
                },
                latencyMs: Date.now() - startTime,
                cached: false,
                local: false,
                mock: false,
            };
        }
        catch (error) {
            clearTimeout(timer);
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes('AbortError') || (error instanceof Error && error.name === 'AbortError')) {
                throw new Error(`Copilot API timed out after ${timeoutMs}ms`);
            }
            throw error instanceof Error ? error : new Error(msg);
        }
    }
    /**
     * Complete via the host-side HTTP proxy bridge (for Docker containers).
     */
    async completeViaProxy(request) {
        const proxyUrl = process.env.LLM_CLI_PROXY_URL;
        if (!proxyUrl)
            throw new Error('LLM_CLI_PROXY_URL not configured');
        const startTime = Date.now();
        const timeoutMs = request.timeout || this.config.timeout || 120000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(`${proxyUrl}/api/complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider: this.name,
                    messages: request.messages,
                    model: this.resolveModel(request.tier),
                    maxTokens: request.maxTokens || 4096,
                    temperature: request.temperature,
                }),
                signal: controller.signal,
            });
            clearTimeout(timer);
            if (!response.ok) {
                const err = (await response.json().catch(() => ({})));
                if (response.status === 429 || err.type === 'QUOTA_EXHAUSTED')
                    throw new Error(`QUOTA_EXHAUSTED: ${err.error}`);
                if (response.status === 401 || err.type === 'AUTH_ERROR')
                    throw new Error(`AUTH_ERROR: ${err.error}`);
                throw new Error(`Proxy error (${response.status}): ${err.error}`);
            }
            const data = (await response.json());
            return {
                content: data.content, provider: this.name, model: data.model,
                tokens: data.tokens, latencyMs: data.latencyMs || (Date.now() - startTime),
                cached: false, local: false, mock: false,
            };
        }
        catch (error) {
            clearTimeout(timer);
            if (error instanceof Error && error.name === 'AbortError')
                throw new Error(`Proxy timed out after ${timeoutMs}ms`);
            throw error instanceof Error ? error : new Error(String(error));
        }
    }
}
//# sourceMappingURL=copilot-provider.js.map