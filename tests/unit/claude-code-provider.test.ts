import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ClaudeCodeProvider } from '../../src/providers/claude-code-provider.js';

/**
 * We need to intercept the promisified execFile that the provider uses.
 * The provider calls `promisify(execFile)` at module load time, which uses
 * Node's custom promisify for execFile (returning {stdout, stderr}).
 * To mock this correctly, we provide an execFile mock with the custom
 * promisify symbol set to a controllable async function.
 *
 * NOTE: vi.mock factories are hoisted, so we use `var` for the shared mock
 * variable to avoid TDZ issues with `let`/`const`.
 */

// eslint-disable-next-line no-var
var mockExecFileAsync: ReturnType<typeof vi.fn>;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  const mockFn = vi.fn() as any;
  mockExecFileAsync = vi.fn();
  mockFn[Symbol.for('nodejs.util.promisify.custom')] = (...args: unknown[]) => mockExecFileAsync(...args);
  return {
    ...actual,
    execFile: mockFn,
  };
});

import { execFile } from 'node:child_process';

/**
 * Helper: make the mocked execFileAsync resolve/reject for the next call.
 */
function mockExecFileResult(stdout: string, stderr: string, error: Error | null = null) {
  if (error) {
    mockExecFileAsync.mockRejectedValueOnce(error);
  } else {
    mockExecFileAsync.mockResolvedValueOnce({ stdout, stderr });
  }
}

const VALID_JSON_RESPONSE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Hello from Claude',
  duration_ms: 500,
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
});

const ERROR_JSON_RESPONSE = JSON.stringify({
  type: 'result',
  is_error: true,
  result: 'Credit balance is too low',
});

const AUTH_ERROR_JSON_RESPONSE = JSON.stringify({
  type: 'result',
  is_error: true,
  result: 'Not authenticated - login required',
});

describe('ClaudeCodeProvider', () => {
  let provider: ClaudeCodeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ClaudeCodeProvider();
    // Mark provider as available (bypass initialize which checks real CLI)
    (provider as any)._available = true;
    (provider as any).useProxy = false;
  });

  describe('extractPrompts', () => {
    it('extracts system and user prompts from messages', () => {
      const result = (provider as any).extractPrompts([
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: 'Hello' },
      ]);
      expect(result.systemPrompt).toBe('Be helpful');
      expect(result.userPrompt).toBe('Hello');
    });

    it('joins multiple system messages', () => {
      const result = (provider as any).extractPrompts([
        { role: 'system', content: 'Rule 1' },
        { role: 'system', content: 'Rule 2' },
        { role: 'user', content: 'Hello' },
      ]);
      expect(result.systemPrompt).toBe('Rule 1\n\nRule 2');
    });
  });

  describe('resolveCliModel', () => {
    it('resolves standard tier to sonnet', () => {
      expect((provider as any).resolveCliModel('standard')).toBe('sonnet');
    });

    it('resolves premium tier to opus', () => {
      expect((provider as any).resolveCliModel('premium')).toBe('opus');
    });

    it('resolves fast tier to haiku 5.5', () => {
      expect((provider as any).resolveCliModel('fast')).toBe('claude-haiku-5-5');
    });
  });

  describe('complete()', () => {
    it('returns LLMCompletionResult with real token counts from json.usage', async () => {
      mockExecFileResult(VALID_JSON_RESPONSE, '');

      const result = await provider.complete({
        messages: [{ role: 'user', content: 'test prompt' }],
        tier: 'standard',
      });

      expect(result.content).toBe('Hello from Claude');
      expect(result.provider).toBe('claude-code');
      expect(result.tokens.input).toBe(10);
      expect(result.tokens.output).toBe(5);
      expect(result.tokens.total).toBe(15);
    });

    it('calls claude CLI with correct arguments', async () => {
      mockExecFileResult(VALID_JSON_RESPONSE, '');

      await provider.complete({
        messages: [{ role: 'user', content: 'test prompt' }],
        tier: 'standard',
      });

      // The promisified execFile is called with (cmd, args, opts)
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        expect.any(String), // CLI path
        expect.arrayContaining(['-p', '--output-format', 'json', '--model', 'sonnet']),
        expect.any(Object),
      );
    });

    it('throws QUOTA_EXHAUSTED when JSON response indicates credit balance error', async () => {
      mockExecFileResult(ERROR_JSON_RESPONSE, '');

      await expect(
        provider.complete({
          messages: [{ role: 'user', content: 'test' }],
          tier: 'standard',
        }),
      ).rejects.toThrow('QUOTA_EXHAUSTED');
    });

    it('throws AUTH_ERROR when JSON response indicates auth failure', async () => {
      mockExecFileResult(AUTH_ERROR_JSON_RESPONSE, '');

      await expect(
        provider.complete({
          messages: [{ role: 'user', content: 'test' }],
          tier: 'standard',
        }),
      ).rejects.toThrow('AUTH_ERROR');
    });

    it('throws on CLI error', async () => {
      const error = new Error('Something went wrong');
      mockExecFileResult('', '', error);

      await expect(
        provider.complete({
          messages: [{ role: 'user', content: 'test' }],
          tier: 'standard',
        }),
      ).rejects.toThrow();
    });

    it('handles timeout (ETIMEDOUT from execFile)', async () => {
      const error = new Error('ETIMEDOUT');
      mockExecFileResult('', '', error);

      await expect(
        provider.complete({
          messages: [{ role: 'user', content: 'test' }],
          tier: 'standard',
        }),
      ).rejects.toThrow('timed out');
    });

    it('removes ANTHROPIC_API_KEY from env', async () => {
      mockExecFileResult(VALID_JSON_RESPONSE, '');

      await provider.complete({
        messages: [{ role: 'user', content: 'test' }],
        tier: 'standard',
      });

      const callArgs = mockExecFileAsync.mock.calls[0];
      const opts = callArgs[2] as { env?: Record<string, string> };
      expect(opts.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    });
  });
});
