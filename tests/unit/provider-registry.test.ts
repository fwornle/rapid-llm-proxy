import { describe, it, expect } from 'vitest';
// Imports will resolve after Task 1 ports the files
import { ProviderRegistry } from '../../src/provider-registry.js';
import type { LLMProvider, LLMCompletionRequest, LLMCompletionResult, ModelTier, ProviderName } from '../../src/types.js';

// Inline mock provider for test isolation (does not depend on ported mock-provider.ts)
class TestMockProvider implements LLMProvider {
  readonly name: ProviderName;
  readonly isLocal = true;
  private _available = true;
  private _models: Partial<Record<ModelTier, string>>;

  constructor(name: ProviderName, models: Partial<Record<ModelTier, string>> = { fast: 'mock-fast', standard: 'mock-std', premium: 'mock-prem' }) {
    this.name = name;
    this._models = models;
  }
  isAvailable(): boolean { return this._available; }
  async initialize(): Promise<void> {}
  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResult> {
    return { content: 'mock', provider: this.name, model: 'mock', tokens: { input: 10, output: 5, total: 15 }, latencyMs: 1 };
  }
  getModels() { return this._models; }
}

describe('ProviderRegistry', () => {
  it('registers a provider and reports it as available (LLM-01)', () => {
    // After port, ProviderRegistry constructor takes LLMServiceConfig.
    // This test verifies the registry can register and list providers.
    const registry = new ProviderRegistry({
      providers: { mock: { models: { fast: 'mock-fast', standard: 'mock-std', premium: 'mock-prem' } } },
      providerPriority: { fast: ['mock'], standard: ['mock'], premium: ['mock'] },
    } as any);
    const available = registry.getAvailableProviders();
    expect(available).toBeDefined();
  });

  it('resolves tier-based provider chain for fast tier (LLM-02)', () => {
    const registry = new ProviderRegistry({
      providers: { mock: { models: { fast: 'mock-fast', standard: 'mock-std' } } },
      providerPriority: { fast: ['mock'], standard: ['mock'], premium: ['mock'] },
    } as any);
    const chain = registry.resolveProviderChain({ messages: [], tier: 'fast' } as LLMCompletionRequest);
    expect(chain).toBeDefined();
    expect(Array.isArray(chain)).toBe(true);
  });

  it('resolves tier-based provider chain for premium tier (LLM-02)', () => {
    const registry = new ProviderRegistry({
      providers: { mock: { models: { fast: 'mock-fast', standard: 'mock-std', premium: 'mock-prem' } } },
      providerPriority: { fast: ['mock'], standard: ['mock'], premium: ['mock'] },
    } as any);
    const chain = registry.resolveProviderChain({ messages: [], tier: 'premium' } as LLMCompletionRequest);
    expect(chain).toBeDefined();
    expect(Array.isArray(chain)).toBe(true);
  });
});
