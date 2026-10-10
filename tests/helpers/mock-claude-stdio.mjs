/**
 * Mock `claude` worker stdio stream (Phase 62 — Worker Pool Core).
 *
 * Reproduces the stream-JSON JSON-Lines stdout sequence that a real
 * `claude -p --input-format stream-json --output-format stream-json --verbose`
 * worker emits for a single request, so the unit suite can drive a ClaudeWorker
 * deterministically WITHOUT spawning a real CLI subprocess.
 *
 * Authoritative I/O contract: 62-RESEARCH.md § "Response event sequence" and
 * § "Token + content extraction". Per request the worker emits, in order:
 *   1. {"type":"system","subtype":"init",...}          — session/model echo
 *   2. {"type":"assistant","message":{content:[{type:"text",text}],usage}}
 *   3. {"type":"result","subtype":"success","is_error":false,
 *       "result":<text>,"usage":{...},
 *       "modelUsage":{<model>:{inputTokens,outputTokens,
 *                              cacheReadInputTokens,cacheCreationInputTokens}}}
 *
 * --- CHOSEN SHAPE (for Plan 02 to wire the worker's stdout reader against) ---
 * Each factory returns an object exposing:
 *   - `stdout`  : a node:stream PassThrough (Readable). The worker code does its
 *                 OWN `\n`-split buffering on this — the helper does NOT pre-parse.
 *   - `stdin`   : a PassThrough the worker writes request envelopes to (the
 *                 helper drives `emit*()` in response; it does not parse stdin).
 *   - `stderr`  : a PassThrough the worker's GUARD-03 drain-and-throttle handler
 *                 binds to; push chunks via `emitStderr(text)` (Phase 64).
 *   - `emitStderr(text)`    : pushes one raw stderr chunk for the throttle test.
 *   - `emitResponse()`      : pushes the full init -> assistant -> result sequence.
 *   - `emitResponseSplit()` : pushes the SAME sequence but splits the terminal
 *                             `result` line across >=2 chunks (exercises Plan 02
 *                             Pitfall-3 partial-line buffering).
 *   - `emitErrorResult()`   : pushes init -> assistant -> an is_error result line
 *                             (subtype "error_during_execution") for the
 *                             cancel/interrupt and QUOTA/AUTH mapping tests.
 *   - `end()`               : ends the stdout stream (simulates worker exit).
 *
 * Transport-agnostic by design: the worker owns framing; this helper only
 * produces raw `\n`-terminated bytes on `stdout`.
 */

import { PassThrough } from 'node:stream';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

function systemInitLine(model) {
  return JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'mock-session',
    model,
    tools: [],
  }) + '\n';
}

function assistantLine(model, resultText, outputTokens) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      model,
      content: [{ type: 'text', text: resultText }],
      usage: { input_tokens: 0, output_tokens: outputTokens },
    },
  }) + '\n';
}

function resultLine(model, resultText, inputTokens, outputTokens, cacheRead) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 900,
    result: resultText,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {
      [model]: {
        inputTokens,
        outputTokens,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: 0,
      },
    },
  }) + '\n';
}

function errorResultLine(model, resultText) {
  return JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    duration_ms: 100,
    result: resultText || '',
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {
      [model]: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  }) + '\n';
}

/**
 * Build a mock worker stdio source.
 *
 * @param {object} opts
 * @param {string} [opts.model='claude-sonnet-4-6'] — keys the modelUsage block.
 * @param {string} [opts.resultText='OK']           — assistant text + result.result.
 * @param {number} [opts.inputTokens=138]           — usage.input_tokens.
 * @param {number} [opts.outputTokens=4]            — usage.output_tokens.
 * @param {number} [opts.cacheRead=0]               — cacheReadInputTokens.
 */
export function makeMockWorkerStdio(opts = {}) {
  const {
    model = DEFAULT_MODEL,
    resultText = 'OK',
    inputTokens = 138,
    outputTokens = 4,
    cacheRead = 0,
  } = opts;

  const stdout = new PassThrough();
  const stdin = new PassThrough();
  // GUARD-03 / Phase 64 — a stderr PassThrough so a ClaudeWorker's drain-and-
  // throttle handler (`this._proc.stderr.on('data', ...)`) binds to a real stream.
  // `emitStderr(text)` pushes one raw stderr chunk the worker's handler consumes.
  const stderr = new PassThrough();
  const emitStderr = (text) => stderr.write(String(text));

  const emitResponse = () => {
    stdout.write(systemInitLine(model));
    stdout.write(assistantLine(model, resultText, outputTokens));
    stdout.write(resultLine(model, resultText, inputTokens, outputTokens, cacheRead));
  };

  // Same sequence, but the terminal result line is delivered as >=2 chunks so a
  // single logical JSON line spans chunk boundaries (Pitfall-3 buffering test).
  const emitResponseSplit = () => {
    stdout.write(systemInitLine(model));
    stdout.write(assistantLine(model, resultText, outputTokens));
    const line = resultLine(model, resultText, inputTokens, outputTokens, cacheRead);
    const mid = Math.floor(line.length / 2);
    stdout.write(line.slice(0, mid));
    stdout.write(line.slice(mid));
  };

  return {
    model,
    stdout,
    stdin,
    stderr,
    emitStderr,
    emitResponse,
    emitResponseSplit,
    end: () => stdout.end(),
  };
}

/**
 * Build a mock worker stdio source whose request terminates with an
 * is_error result (subtype "error_during_execution") — drives the
 * cancel/interrupt seam and the QUOTA_EXHAUSTED / AUTH_ERROR mapping tests.
 *
 * @param {object} opts
 * @param {string} [opts.model='claude-sonnet-4-6']
 * @param {string} [opts.resultText='']  — set to a quota/auth string to exercise mapping.
 */
export function makeMockErrorWorkerStdio(opts = {}) {
  const { model = DEFAULT_MODEL, resultText = '' } = opts;

  const stdout = new PassThrough();
  const stdin = new PassThrough();

  const emitErrorResult = () => {
    stdout.write(systemInitLine(model));
    stdout.write(assistantLine(model, '', 0));
    stdout.write(errorResultLine(model, resultText));
  };

  return {
    model,
    stdout,
    stdin,
    emitErrorResult,
    end: () => stdout.end(),
  };
}

/**
 * Build a mock worker stdio source that simulates a `claude` BOOT CRASH
 * (D-06 / WLIFE-03): the stdout PassThrough ends immediately (on the next tick),
 * so a ClaudeWorker built on it never serves a successful request — its
 * `_proc.on('exit'/'close')` reaches `_onExit` right after construction. This is
 * the early-exit worker the crash-cooldown unit case uses to trip the per-key
 * crash-frequency threshold. Reuses the same PassThrough + `end()` seam the
 * other factories expose; the existing factories are left unchanged.
 *
 * @param {object} opts
 * @param {string} [opts.model='claude-sonnet-4-6'] — keys the (unused) modelUsage block.
 */
export function makeMockEarlyExitStdio(opts = {}) {
  const { model = DEFAULT_MODEL } = opts;

  const stdout = new PassThrough();
  const stdin = new PassThrough();

  // EarlyExit: end stdout on the next tick so the worker's stdout reader sees an
  // immediate end-of-stream (boot crash). No init/assistant/result is ever
  // emitted, so any in-flight write reaps as RETRYABLE via the exit path.
  const end = () => stdout.end();
  process.nextTick(end);

  return {
    model,
    stdout,
    stdin,
    end,
  };
}
