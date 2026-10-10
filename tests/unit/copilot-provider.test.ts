import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { CopilotProvider as CopilotProviderType } from '../../src/providers/copilot-provider.js';

/**
 * CopilotProvider unit tests for the direct HTTP implementation.
 *
 * The provider reads an OAuth token from ~/.local/share/opencode/auth.json
 * and calls the Copilot API directly via fetch(). Tests mock global fetch
 * and fs.readFileSync to avoid real I/O.
 */

// Mock fs module
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    default: {
      ...(actual.default as Record<string, unknown>),
      readFileSync: vi.fn(),
    },
    readFileSync: vi.fn(),
  };
});

import fs from 'node:fs';

const MOCK_AUTH_JSON = JSON.stringify({
  'github-copilot-enterprise': {
    refresh: 'test-token-123',
    enterpriseUrl: 'ghe.example.com',
  },
});

const VALID_COMPLETION_RESPONSE = {
  choices: [{ message: { content: 'Hello from Copilot' } }],
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  model: 'claude-sonnet-4.6',
};

describe('CopilotProvider', () => {
  let provider: CopilotProviderType;
  let originalFetch: typeof globalThis.fetch;

  // The provider memoizes its fetch implementation in a module-level
  // `_proxyFetch` (copilot-provider.ts) the first time it sends anything.
  // With a single module instance that cache outlives the test, so only the
  // FIRST test's globalThis.fetch mock was ever used and every later one
  // recorded zero calls while the assertions saw the first test's response.
  // Resetting the registry and re-importing per test is what makes the mock
  // in each test the one the provider actually calls.
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    originalFetch = globalThis.fetch;

    // Default: auth file returns valid token
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(MOCK_AUTH_JSON);

    const { CopilotProvider } = await import('../../src/providers/copilot-provider.js');
    provider = new CopilotProvider();
    (provider as any)._available = true;
    (provider as any).useProxy = false;
    // Pre-load auth state so tests don't depend on fs timing
    (provider as any).auth = {
      token: 'test-token-123',
      apiBaseUrl: 'https://copilot-api.ghe.example.com',
      lastLoaded: Date.now(),
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('has name "copilot" and isLocal false', () => {
    expect(provider.name).toBe('copilot');
    expect(provider.isLocal).toBe(false);
  });

  it('resolves model tiers correctly', () => {
    const models = provider.getModels();
    expect(models.fast).toBe('claude-haiku-4.5');
    expect(models.standard).toBe('claude-sonnet-4.6');
    expect(models.premium).toBe('claude-opus-5');
  });

  describe('complete() - direct HTTP', () => {
    it('returns LLMCompletionResult with provider=copilot', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(VALID_COMPLETION_RESPONSE),
      });

      const result = await provider.complete({
        messages: [{ role: 'user', content: 'test prompt' }],
        tier: 'standard',
      });

      expect(result.provider).toBe('copilot');
      expect(result.content).toBe('Hello from Copilot');
      expect(result.tokens.input).toBe(12);
      expect(result.tokens.output).toBe(8);
      expect(result.model).toBe('claude-sonnet-4.6');
      expect(result.mock).toBe(false);
    });

    it('sends correct request to Copilot API', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(VALID_COMPLETION_RESPONSE),
      });
      globalThis.fetch = mockFetch;

      await provider.complete({
        messages: [{ role: 'user', content: 'Hello' }],
        tier: 'standard',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://copilot-api.ghe.example.com/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token-123',
            'Content-Type': 'application/json',
          }),
        }),
      );

      // Verify request body
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.model).toBe('claude-sonnet-4.6');
      expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
      expect(body.stream).toBe(false);
    });

    it('throws AUTH_ERROR on 401 response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      await expect(
        provider.complete({
          messages: [{ role: 'user', content: 'test' }],
          tier: 'standard',
        }),
      ).rejects.toThrow('AUTH_ERROR');
    });

    it('throws AUTH_ERROR on 403 response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve('Forbidden'),
      });

      await expect(
        provider.complete({
          messages: [{ role: 'user', content: 'test' }],
          tier: 'standard',
        }),
      ).rejects.toThrow('AUTH_ERROR');
    });

    it('throws QUOTA_EXHAUSTED on 429 response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve('Rate limited'),
      });

      await expect(
        provider.complete({
          messages: [{ role: 'user', content: 'test' }],
          tier: 'standard',
        }),
      ).rejects.toThrow('QUOTA_EXHAUSTED');
    });

    it('throws AUTH_ERROR when no token available', async () => {
      // Override auth to null AND make the auth file return no token
      (provider as any).auth = { token: null, apiBaseUrl: null, lastLoaded: 0 };
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify({}));

      await expect(
        provider.complete({
          messages: [{ role: 'user', content: 'test' }],
          tier: 'standard',
        }),
      ).rejects.toThrow('AUTH_ERROR');
    });

    it('passes temperature when provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(VALID_COMPLETION_RESPONSE),
      });
      globalThis.fetch = mockFetch;

      await provider.complete({
        messages: [{ role: 'user', content: 'test' }],
        tier: 'standard',
        temperature: 0.5,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.5);
    });
  });
});
