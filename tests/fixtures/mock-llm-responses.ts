import type { ExtractionResult } from '../../src/ingestion/schemas.js';

/**
 * Mock LLM extraction response matching the sample-learn-section.txt content.
 * Contains 6 entities (mix of evidence + pattern) and 5 relationships.
 */
export const mockExtractionResponse: ExtractionResult = {
  entities: [
    {
      name: 'OOM Crash 2024-01-15',
      ontologyClass: 'Incident',
      layer: 'evidence',
      description: 'Out-of-Memory crash during high-volume RPU processing batch in Argo workflow',
      confidence: 0.95,
      metadata: { severity: 'high', occurredAt: '2024-01-15T14:32:00Z' },
    },
    {
      name: 'RPU v2.4.1',
      ontologyClass: 'RPU',
      layer: 'evidence',
      description: 'Rendering Processing Unit version 2.4.1 with memory leak in batch aggregation',
      confidence: 0.92,
      metadata: { rpuId: 'rpu-2.4.1' },
    },
    {
      name: 'worker-node-3',
      ontologyClass: 'Node',
      layer: 'evidence',
      description: 'Worker node that exhausted 8GB memory allocation',
      confidence: 0.88,
    },
    {
      name: 'daily-rendering-pipeline',
      ontologyClass: 'ArgoWorkflow',
      layer: 'evidence',
      description: 'Argo workflow orchestrating the rendering jobs that failed',
      confidence: 0.90,
    },
    {
      name: 'Memory Leak in Batch Aggregation',
      ontologyClass: 'RootCause',
      layer: 'pattern',
      description: 'RPU 2.4.1 retains intermediate buffers in memory instead of streaming to disk for large data assets',
      confidence: 0.85,
    },
    {
      name: 'RPU Version Rollback',
      ontologyClass: 'Resolution',
      layer: 'pattern',
      description: 'Rolled back RPU to version 2.3.9 which uses streaming I/O for large data assets',
      confidence: 0.88,
    },
  ],
  relationships: [
    {
      source: 'OOM Crash 2024-01-15',
      target: 'Memory Leak in Batch Aggregation',
      type: 'HAS_ROOT_CAUSE',
    },
    {
      source: 'OOM Crash 2024-01-15',
      target: 'RPU v2.4.1',
      type: 'AFFECTS',
    },
    {
      source: 'OOM Crash 2024-01-15',
      target: 'RPU Version Rollback',
      type: 'RESOLVED_BY',
    },
    {
      source: 'RPU v2.4.1',
      target: 'worker-node-3',
      type: 'RUNS_ON',
    },
    {
      source: 'daily-rendering-pipeline',
      target: 'RPU v2.4.1',
      type: 'CONTAINS',
    },
  ],
};

/**
 * Mock LLM extraction response WITH sourceParagraphs citations.
 * Same entities as mockExtractionResponse but with paragraph indices
 * matching the sample-learn-section.txt when split by double-newline.
 */
export const mockExtractionWithCitationsResponse: ExtractionResult = {
  entities: [
    {
      name: 'OOM Crash 2024-01-15',
      ontologyClass: 'Incident',
      layer: 'evidence',
      description: 'Out-of-Memory crash during high-volume RPU processing batch in Argo workflow',
      confidence: 0.95,
      metadata: { severity: 'high', occurredAt: '2024-01-15T14:32:00Z' },
      sourceParagraphs: [1, 2],
    },
    {
      name: 'RPU v2.4.1',
      ontologyClass: 'RPU',
      layer: 'evidence',
      description: 'Rendering Processing Unit version 2.4.1 with memory leak in batch aggregation',
      confidence: 0.92,
      metadata: { rpuId: 'rpu-2.4.1' },
      sourceParagraphs: [3, 5],
    },
    {
      name: 'worker-node-3',
      ontologyClass: 'Node',
      layer: 'evidence',
      description: 'Worker node that exhausted 8GB memory allocation',
      confidence: 0.88,
      sourceParagraphs: [2],
    },
    {
      name: 'daily-rendering-pipeline',
      ontologyClass: 'ArgoWorkflow',
      layer: 'evidence',
      description: 'Argo workflow orchestrating the rendering jobs that failed',
      confidence: 0.90,
      sourceParagraphs: [1, 5],
    },
    {
      name: 'Memory Leak in Batch Aggregation',
      ontologyClass: 'RootCause',
      layer: 'pattern',
      description: 'RPU 2.4.1 retains intermediate buffers in memory instead of streaming to disk for large data assets',
      confidence: 0.85,
      sourceParagraphs: [3],
    },
    {
      name: 'RPU Version Rollback',
      ontologyClass: 'Resolution',
      layer: 'pattern',
      description: 'Rolled back RPU to version 2.3.9 which uses streaming I/O for large data assets',
      confidence: 0.88,
      sourceParagraphs: [4],
    },
  ],
  relationships: [
    {
      source: 'OOM Crash 2024-01-15',
      target: 'Memory Leak in Batch Aggregation',
      type: 'HAS_ROOT_CAUSE',
    },
    {
      source: 'OOM Crash 2024-01-15',
      target: 'RPU v2.4.1',
      type: 'AFFECTS',
    },
    {
      source: 'OOM Crash 2024-01-15',
      target: 'RPU Version Rollback',
      type: 'RESOLVED_BY',
    },
    {
      source: 'RPU v2.4.1',
      target: 'worker-node-3',
      type: 'RUNS_ON',
    },
    {
      source: 'daily-rendering-pipeline',
      target: 'RPU v2.4.1',
      type: 'CONTAINS',
    },
  ],
};

/**
 * Empty extraction response - no entities found.
 */
export const mockEmptyResponse: ExtractionResult = {
  entities: [],
  relationships: [],
};

/**
 * Partial extraction - some entities but no relationships.
 */
export const mockPartialResponse: ExtractionResult = {
  entities: [
    {
      name: 'Unknown Issue',
      ontologyClass: 'Incident',
      layer: 'evidence',
      description: 'An unspecified incident occurred',
      confidence: 0.5,
    },
  ],
  relationships: [],
};
