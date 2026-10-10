import { describe, it, expect } from 'vitest';
import { LLMService } from '../../src/llm-service.js';

describe('LLMService', () => {
  it('exports LLMService class (LLM-06)', () => {
    expect(LLMService).toBeDefined();
    expect(typeof LLMService).toBe('function');
  });

  it('LLMService instance has complete method', () => {
    const service = new LLMService();
    expect(typeof service.complete).toBe('function');
  });

  it('LLMService instance has initialize method', () => {
    const service = new LLMService();
    expect(typeof service.initialize).toBe('function');
  });
});
