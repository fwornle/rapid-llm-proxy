#!/usr/bin/env node

/**
 * CLI entry point for the LLM Proxy Bridge.
 *
 * Usage:
 *   llm-proxy                       # starts on default port 8089
 *   llm-proxy --port 9000           # custom port
 *   LLM_PROXY_PORT=9000 llm-proxy   # env-based port
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', 'proxy-bridge', 'server.mjs');

// Parse --port flag
const portIdx = process.argv.indexOf('--port');
if (portIdx !== -1 && process.argv[portIdx + 1]) {
  process.env.LLM_PROXY_PORT = process.argv[portIdx + 1];
}

const server = await import(serverPath);
