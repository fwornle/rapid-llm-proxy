/**
 * CLI Provider Base
 *
 * Abstract base class for providers that invoke external CLI tools
 * (claude, gh copilot, etc.) via child process spawning.
 *
 * Subscription-based providers that wrap CLI commands.
 */
import { BaseProvider } from './base-provider.js';
import type { LLMCompletionRequest, LLMCompletionResult, LLMMessage } from '../types.js';
export declare abstract class CLIProviderBase extends BaseProvider {
    /**
     * The CLI command to execute (e.g., 'claude', 'gh')
     */
    protected abstract readonly cliCommand: string;
    /**
     * Optional subcommand (e.g., 'copilot' for gh CLI)
     */
    protected readonly cliSubcommand?: string;
    /**
     * Whether this provider is using the HTTP proxy bridge instead of local CLI
     */
    protected _useProxy: boolean;
    /**
     * Build command-line arguments for the request
     */
    protected abstract buildArgs(request: LLMCompletionRequest): string[];
    /**
     * Parse CLI stdout to extract completion text
     */
    protected abstract parseResponse(stdout: string): string;
    /**
     * Check if CLI is installed and available
     */
    protected checkCLIAvailable(): Promise<boolean>;
    /**
     * Check if CLI is authenticated
     */
    protected checkCLIAuthenticated(): Promise<boolean>;
    /**
     * Spawn CLI process with timeout and error handling
     */
    protected spawnCLI(args: string[], input?: string, timeoutMs?: number): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>;
    /**
     * Estimate token count from text (rough: ~4 chars per token)
     */
    protected estimateTokens(text: string): number;
    /**
     * Detect quota exhaustion from stderr
     */
    protected isQuotaError(stderr: string): boolean;
    /**
     * Detect authentication failures from stderr
     */
    protected isAuthError(stderr: string): boolean;
    /**
     * Format messages array into a single prompt string
     */
    protected formatPrompt(messages: LLMMessage[]): string;
    /**
     * Check if the HTTP proxy bridge is available for this provider.
     * Uses native fetch() (Node 22+). Returns true if proxy reports
     * this provider as available.
     */
    protected checkProxyAvailable(): Promise<boolean>;
    /**
     * Complete a request via the HTTP proxy bridge.
     * POSTs to LLM_CLI_PROXY_URL/api/complete and maps HTTP errors
     * back to error types the circuit breaker understands.
     */
    protected completeViaProxy(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
    /**
     * Abstract complete method - subclasses implement the full flow
     */
    abstract complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
}
//# sourceMappingURL=cli-provider-base.d.ts.map