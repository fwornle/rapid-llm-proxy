import { defineConfig } from 'vitest/config';

/**
 * Two runners, split by which test API a file uses — not by taste.
 *
 * `tests/**\/*.test.mjs` and tests/cli-provider-proxy.test.ts are written
 * against node:test + node:assert and are run by `node --test` (see the
 * `test` script). Everything below is written against vitest's describe/it/
 * expect + vi mocking, which node:test cannot provide.
 *
 * Both halves were unrunnable until 2026-09-04: `npm test` invoked
 * node_modules/.bin/jest, jest was not a dependency, and every TS test still
 * imported from `src/llm/…`, a layout that had been flattened to `src/…`.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // node:test file — same extension, different API. Run by `node --test`.
    exclude: ['tests/cli-provider-proxy.test.ts', '**/node_modules/**'],
    env: {
      // A unit test must not inherit the developer's corporate proxy. The
      // copilot provider takes a raw http/tls CONNECT path when HTTPS_PROXY
      // is set, which bypasses the mocked globalThis.fetch entirely and
      // reaches 127.0.0.1:3128 for real — six tests failed with ECONNRESET
      // rather than with anything about the code under test.
      HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '',
    },
  },
});
