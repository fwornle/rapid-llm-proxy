/**
 * RED unit suite for the Claude worker pool (Phase 62 — Worker Pool Core).
 *
 * These tests encode the behavioral contracts that Plans 02 (ClaudeWorker) and
 * 03 (WorkerPool dispatcher wiring) MUST satisfy. They are RED until
 * `../../proxy-bridge/worker-pool.mjs` exists — importing it currently throws
 * ERR_MODULE_NOT_FOUND, which `node --test` reports as a failing run. That RED
 * state is EXPECTED and required (Nyquist validation Dimension 8: every
 * requirement has a named automated test BEFORE implementation).
 *
 * Coverage (62-RESEARCH.md § Phase Requirements -> Test Map):
 *   - POOL-01  : {type:"result"} parsed -> {content,model,tokens}
 *   - POOL-02  : per-model keying; sonnet request never handed a haiku worker
 *   - POOL-03  : concurrency-1; second write does not interleave on one worker
 *   - POOL-03/D-06 : all-workers-busy -> overflowFn (completeClaudeCodeViaCLI spy)
 *
 * Determinism: stdio is dependency-INJECTED via the mock helper — NO real
 * `claude` subprocess is spawned in this file.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeWorker, WorkerPool } from '../../proxy-bridge/worker-pool.mjs';

// The worker's timeout and deferral timers are unref()'d (they must never keep the
// proxy alive), and the mock stdio holds no handle either. With nothing else on the
// event loop, Node 22's test runner ends a test whose only pending work is such a
// timer: "Promise resolution is still pending but the event loop has already
// resolved". One referenced handle for the life of the file keeps the loop open.
const keepAlive = setInterval(() => {}, 60_000);
after(() => clearInterval(keepAlive));
import {
  makeMockWorkerStdio,
  makeMockErrorWorkerStdio,
  makeMockEarlyExitStdio,
} from '../helpers/mock-claude-stdio.mjs';

// Build an injected-deps object a ClaudeWorker constructor can consume so it
// reads from the mock stdout instead of spawning a real CLI. Plan 02 defines
// the exact dependency-injection seam; the contract asserted here is only that
// SOME injection makes the worker consume mock stdio (no live spawn).
function workerWithMock(model, systemPrompt, mock, deps = {}) {
  return new ClaudeWorker(model, systemPrompt, {
    spawn: () => ({
      pid: 4242,
      stdout: mock.stdout,
      stdin: mock.stdin,
      stderr: makeMockWorkerStdio().stdout, // drained, never written
      kill: () => {},
      on: () => {},
    }),
    ...deps,
  });
}

// Variant whose mock subprocess wires the proc 'exit' handler AND fires it on
// kill('SIGTERM'). This lets idle/dispose tests observe the real reap path:
// dispose() -> SIGTERM -> proc 'exit' -> ClaudeWorker._onExit -> emit('exit'),
// exactly as a live subprocess would, without spawning a real CLI.
function workerWithKillableMock(model, systemPrompt, mock, deps = {}) {
  const procListeners = {};
  return new ClaudeWorker(model, systemPrompt, {
    spawn: () => ({
      pid: 4242,
      stdout: mock.stdout,
      stdin: mock.stdin,
      stderr: makeMockWorkerStdio().stdout,
      kill: () => {
        // Simulate the subprocess actually exiting on SIGTERM (fires once).
        const cb = procListeners.exit;
        if (cb) { procListeners.exit = null; cb(143, 'SIGTERM'); }
      },
      on: (ev, cb) => { procListeners[ev] = cb; },
    }),
    ...deps,
  });
}

// D-07 / WLIFE-03 seam: a worker whose `stdin.write` throws an EPIPE (the pipe
// to a crashed subprocess closed mid-write). Lets the EPIPE-as-crash guard be
// observed without a live subprocess. `throwOnWrite` makes the synchronous write
// throw `{code:'EPIPE'}`; the worker must funnel that into _onExit, not let it
// escape out of the dispatch path.
function workerWithEpipeMock(model, systemPrompt, mock, deps = {}) {
  const epipeStdin = {
    write() {
      const err = new Error('write EPIPE');
      err.code = 'EPIPE';
      throw err;
    },
    end() {},
  };
  return new ClaudeWorker(model, systemPrompt, {
    spawn: () => ({
      pid: 4242,
      stdout: mock.stdout,
      stdin: epipeStdin,
      stderr: makeMockWorkerStdio().stdout,
      kill: () => {},
      on: () => {},
    }),
    ...deps,
  });
}

describe('Worker pool — unit (mock stdio, no live CLI)', () => {
  // ---- POOL-01: result parsing -> {content,model,tokens} ----
  it('POOL-01 parsing: a {type:"result"} line resolves write() to {content,model,tokens}', async () => {
    const model = 'claude-sonnet-4-6';
    const mock = makeMockWorkerStdio({
      model,
      resultText: 'PONG',
      inputTokens: 100,
      outputTokens: 7,
      cacheRead: 38,
    });
    const worker = workerWithMock('sonnet', 'You are a helpful assistant.', mock);

    const p = worker.write('say PONG');
    mock.emitResponse();
    const out = await p;

    assert.equal(out.content, 'PONG');
    assert.equal(out.model, model);
    // server.mjs:1165 summation — input + cacheRead + cacheCreation(0):
    assert.equal(out.tokens.input, 100 + 38 + 0);
    assert.equal(out.tokens.output, 7);
    assert.equal(out.tokens.total, out.tokens.input + out.tokens.output);
  });

  it('POOL-01 parsing: tolerates a result line split across chunk boundaries (Pitfall 3)', async () => {
    const mock = makeMockWorkerStdio({ resultText: 'SPLIT-OK', inputTokens: 10, outputTokens: 2 });
    const worker = workerWithMock('sonnet', 'You are a helpful assistant.', mock);

    const p = worker.write('hi');
    mock.emitResponseSplit();
    const out = await p;

    assert.equal(out.content, 'SPLIT-OK');
  });

  it('POOL-01 parsing: an is_error result maps to a thrown QUOTA/AUTH error', async () => {
    const mock = makeMockErrorWorkerStdio({ resultText: 'rate limit exceeded' });
    const worker = workerWithMock('sonnet', 'You are a helpful assistant.', mock);

    const p = worker.write('hi');
    mock.emitErrorResult();
    await assert.rejects(p, /QUOTA_EXHAUSTED|rate limit/i);
  });

  // ---- POOL-02: per-model keying ----
  it('POOL-02 keying: sonnet and haiku requests produce distinct (model::promptHash) keys', () => {
    const pool = new WorkerPool();
    const sp = 'You are a helpful assistant.';
    const sonnetKey = pool.keyFor({ model: 'sonnet', messages: [{ role: 'system', content: sp }] });
    const haikuKey = pool.keyFor({ model: 'haiku', messages: [{ role: 'system', content: sp }] });

    assert.notEqual(sonnetKey, haikuKey);
    assert.match(sonnetKey, /::[0-9a-f]+$/); // model::promphash shape (RESEARCH Pattern 2)
    assert.ok(sonnetKey.startsWith('sonnet') || sonnetKey.includes('sonnet'));
    assert.ok(haikuKey.startsWith('haiku') || haikuKey.includes('haiku'));
  });

  it('POOL-02 keying: a sonnet request is never served by a haiku-booted worker', async () => {
    const pool = new WorkerPool();
    const sp = 'You are a helpful assistant.';
    // Seed a haiku worker into the pool; a sonnet request must NOT reuse it.
    const haikuMock = makeMockWorkerStdio({ model: 'claude-haiku-4-6' });
    const haikuWorker = workerWithMock('haiku', sp, haikuMock);
    const haikuKey = pool.keyFor({ model: 'haiku', messages: [{ role: 'system', content: sp }] });
    pool.workersByKey.set(haikuKey, [haikuWorker]);

    const sonnetKey = pool.keyFor({ model: 'sonnet', messages: [{ role: 'system', content: sp }] });
    assert.notEqual(sonnetKey, haikuKey);
    assert.notEqual(pool.workersByKey.get(sonnetKey), pool.workersByKey.get(haikuKey));
    // No sonnet worker exists yet — the haiku list must never be returned for sonnet.
    const sonnetWorkers = pool.workersByKey.get(sonnetKey) || [];
    assert.ok(!sonnetWorkers.includes(haikuWorker));
  });

  // ---- POOL-03: concurrency-1 ----
  it('POOL-03 concurrency-1: a second write on a busy worker waits for the first result', async () => {
    const mock = makeMockWorkerStdio({ resultText: 'FIRST', inputTokens: 10, outputTokens: 1 });
    const worker = workerWithMock('sonnet', 'You are a helpful assistant.', mock);

    const order = [];
    const p1 = worker.write('first').then((r) => { order.push('first:' + r.content); });
    // Second write must not resolve before the first result arrives.
    const p2 = worker.write('second').then(() => { order.push('second'); });

    // Drive only the first response.
    mock.emitResponse();
    await p1;
    assert.deepEqual(order, ['first:FIRST']); // second still pending — no interleave

    // Now satisfy the second request.
    const mock2 = makeMockWorkerStdio({ resultText: 'SECOND' });
    // Re-drive the same stdout for the queued second request.
    mock.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'SECOND',
      usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: { 'claude-sonnet-4-6': { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    }) + '\n');
    void mock2;
    await p2;
    assert.deepEqual(order, ['first:FIRST', 'second']);
  });

  // ---- POOL-03 / D-06: all-workers-busy overflow ----
  it('POOL-03/D-06 overflow: when all workers for a key are busy, pool.complete calls overflowFn once', async () => {
    const pool = new WorkerPool({ size: 1 });
    const sp = 'You are a helpful assistant.';
    const body = { model: 'sonnet', messages: [{ role: 'system', content: sp }, { role: 'user', content: 'hi' }] };

    // Make the single worker permanently busy so the next request overflows.
    const key = pool.keyFor(body);
    const busyMock = makeMockWorkerStdio();
    const busyWorker = workerWithMock('sonnet', sp, busyMock);
    busyWorker.write('occupying'); // never resolved -> stays busy
    pool.workersByKey.set(key, [busyWorker]);

    let overflowCalls = 0;
    const overflowFn = async () => {
      overflowCalls += 1;
      return { content: 'VIA-CLI', model: 'claude-sonnet-4-6', tokens: { input: 1, output: 1, total: 2 } };
    };

    const out = await pool.complete(body, undefined, overflowFn);
    assert.equal(overflowCalls, 1);
    assert.equal(out.content, 'VIA-CLI');
  });

  // ---- CR-01: per-request timeout (a silent/hung worker must not hang) ----
  it('CR-01 timeout: a worker that never emits a result REJECTS write() within the timeout window', async () => {
    const mock = makeMockWorkerStdio();
    // 50ms injected timeout so this runs fast; the mock never emits a response.
    const worker = workerWithMock('sonnet', 'You are a helpful assistant.', mock, { requestTimeoutMs: 50 });

    const start = Date.now();
    const err = await worker.write('this will hang').then(
      () => { throw new Error('expected timeout rejection, got resolve'); },
      (e) => e,
    );
    const elapsed = Date.now() - start;

    assert.match(err.message, /timed out after 50ms/i, 'rejects with a timeout error');
    assert.equal(err.retryable, true, 'timeout error is RETRYABLE-shaped');
    assert.equal(err.code, 'WORKER_RETRYABLE');
    assert.ok(elapsed < 5000, `settled fast (within window), took ${elapsed}ms`);
    // Worker is flagged for recycle so the pool replaces (never reuses) it.
    assert.equal(worker.needsRecycle, true, 'timed-out worker flagged needsRecycle');
    assert.equal(worker.busy, false, 'worker no longer busy after timeout');
  });

  it('CR-01 timeout: a queued/next request behind a timed-out worker does not hang', async () => {
    const mock = makeMockWorkerStdio();
    const worker = workerWithMock('sonnet', 'You are a helpful assistant.', mock, { requestTimeoutMs: 50 });

    // First request hangs (no response) -> will time out.
    const p1 = worker.write('first-hangs');
    // Second request queues behind the busy worker.
    const p2 = worker.write('second-queued');

    const e1 = await p1.then(() => null, (e) => e);
    assert.match(e1.message, /timed out after 50ms/i, 'first request times out');

    // The queued second request must settle (rejected, not hang). dispose() on
    // timeout SIGTERMs the (mock) proc; with the real proc its 'exit' would drain
    // the queue as RETRYABLE. Here the mock's kill is a no-op, so we assert the
    // queued promise does not hang indefinitely by racing it against a deadline.
    const e2 = await Promise.race([
      p2.then(() => ({ resolved: true }), (e) => ({ rejected: e })),
      new Promise((res) => setTimeout(() => res({ timedOutWaiting: true }), 200)),
    ]);
    // Either it rejected (queue drained) OR it is still pending — but it MUST NOT
    // have resolved with a bogus payload. The key contract: no silent hang of the
    // CALLER of the timed-out request (p1), which we already proved above.
    assert.ok(!e2.resolved, 'queued request never resolves with a stale payload after timeout');
  });

  it('CR-01 timeout: clears the timer on normal settle (no spurious late reject)', async () => {
    const mock = makeMockWorkerStdio({ resultText: 'FAST', inputTokens: 10, outputTokens: 1 });
    // Generous timeout; the result arrives immediately so the timer must be cleared.
    const worker = workerWithMock('sonnet', 'You are a helpful assistant.', mock, { requestTimeoutMs: 1000 });

    const p = worker.write('respond now');
    mock.emitResponse();
    const out = await p;
    assert.equal(out.content, 'FAST');
    assert.equal(worker.needsRecycle, false, 'normal settle does not flag recycle via timeout');
    // Wait past the timeout window to confirm the cleared timer does not fire.
    await new Promise((res) => setTimeout(res, 30));
    assert.equal(worker.busy, false);
  });

  // ---- D-07 / WLIFE-03: EPIPE on stdin.write treated as a crash ----
  it('D-07 in-flight EPIPE: a write error rejects the in-flight promise RETRYABLE', async () => {
    const mock = makeMockWorkerStdio();
    const worker = workerWithEpipeMock('sonnet', 'You are a helpful assistant.', mock);

    const err = await worker.write('x').then(
      () => { throw new Error('expected EPIPE rejection, got resolve'); },
      (e) => e,
    );
    assert.equal(err.retryable, true, 'EPIPE write error is RETRYABLE-shaped');
    assert.equal(err.code, 'WORKER_RETRYABLE');
  });

  it('D-07 drains queue: an EPIPE rejects BOTH the in-flight AND the queued job RETRYABLE', async () => {
    const mock = makeMockWorkerStdio();
    const worker = workerWithEpipeMock('sonnet', 'You are a helpful assistant.', mock);

    // First write dispatches and the EPIPE fires synchronously inside _dispatch;
    // the second write must already be queued so the reap drains it too. To
    // guarantee the queued job exists, issue both before the microtask turn.
    const p1 = worker.write('first');
    const p2 = worker.write('second-queued');

    const e1 = await p1.then(() => null, (e) => e);
    const e2 = await p2.then(() => null, (e) => e);

    assert.ok(e1 && e1.retryable === true && e1.code === 'WORKER_RETRYABLE', 'in-flight rejects RETRYABLE');
    assert.ok(e2 && e2.retryable === true && e2.code === 'WORKER_RETRYABLE', 'queued job rejects RETRYABLE (the throw used to lose this)');
  });

  it('D-07 marks dead + emits exit: after an EPIPE the worker is recyclable, not busy, and emitted exit', async () => {
    const mock = makeMockWorkerStdio();
    const worker = workerWithEpipeMock('sonnet', 'You are a helpful assistant.', mock);

    let exitEv = null;
    worker.once('exit', (ev) => { exitEv = ev; });

    await worker.write('x').then(() => null, () => null);

    assert.equal(worker.needsRecycle, true, 'EPIPE-crashed worker flagged needsRecycle');
    assert.equal(worker.busy, false, 'worker no longer busy after EPIPE crash');
    assert.ok(exitEv !== null, "EPIPE funnelled into the 'exit' reap path");
    assert.equal(exitEv.signal, 'EPIPE', "exit carries the diagnostic 'EPIPE' signal label");
  });

  // ---- D-02 / WLIFE-04: monotonic request-generation guard (stray-result safety) ----
  // Push a raw result line straight onto mock.stdout (the technique POOL-03 uses
  // at lines ~164-168) to simulate a STRAY/late result from a prior turn.
  // `gen` (optional) stamps the worker-internal request generation the result
  // belongs to: a STALE result carries a PRIOR generation; a real result carries
  // the live one. Real CLI results carry NO generation and fall through to the
  // `_pending === null` primary defense — the generation echo is purely the
  // internal belt-and-suspenders for the narrow in-flight window (D-02).
  const rawResultLine = (model, text, gen) => JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: text,
    ...(gen !== undefined ? { _gen: gen } : {}),
    usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { [model]: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
  }) + '\n';

  it('D-02 stray-after-settle: a stray result with no pending request resolves nothing and does not throw', async () => {
    const model = 'claude-sonnet-4-6';
    const mock = makeMockWorkerStdio({ model, resultText: 'A' });
    const worker = workerWithMock('sonnet', 'You are a helpful assistant.', mock);

    const pA = worker.write('A');
    mock.emitResponse();
    const a = await pA;
    assert.equal(a.content, 'A');
    assert.equal(worker.busy, false, '_pending nulled after settle');

    // No request in flight — a stray result must be a harmless no-op
    // (primary defense: _pending === null).
    assert.doesNotThrow(() => mock.stdout.write(rawResultLine(model, 'STRAY')));
    // Give the stdout reader a turn; nothing should change.
    await new Promise((res) => setTimeout(res, 10));
    assert.equal(worker.busy, false, 'stray result did not flip the worker busy or resolve anything');
  });

  it('D-02 stray does not resolve the NEXT request: only B\'s own result settles B', async () => {
    const model = 'claude-sonnet-4-6';
    const mock = makeMockWorkerStdio({ model, resultText: 'A' });
    const worker = workerWithMock('sonnet', 'You are a helpful assistant.', mock);

    // Settle request A (its dispatch bumped _generation to the value below).
    const genA = worker._generation; // generation A will run under once dispatched
    const pA = worker.write('A');
    mock.emitResponse();
    await pA;

    // Issue request B; a NEW _pending now exists with a HIGHER generation.
    let bResolved = false;
    const pB = worker.write('B').then((r) => { bResolved = true; return r; });
    const genB = worker._generation; // B's live generation (strictly > genA)
    assert.ok(genB > genA, 'B runs under a higher generation than A');

    // A STRAY late result from A's (already-settled) generation lands while B is
    // in-flight. The generation guard must DROP it — it must NOT resolve B.
    mock.stdout.write(rawResultLine(model, 'STRAY-FOR-A', genA));
    await new Promise((res) => setTimeout(res, 10));
    assert.equal(bResolved, false, 'stray late result (gen A) did NOT resolve the next request B');
    assert.equal(worker.busy, true, 'B still in-flight after the stray was dropped');

    // B's own real result (live generation) resolves it with B's content.
    mock.stdout.write(rawResultLine(model, 'REAL-B', genB));
    const b = await pB;
    assert.equal(b.content, 'REAL-B', 'B resolved by its own result, never the stray');
    assert.equal(bResolved, true);
  });

  it('D-02 normal settle unaffected: the generation guard does not break the happy path', async () => {
    const mock = makeMockWorkerStdio({ resultText: 'HAPPY', inputTokens: 10, outputTokens: 2 });
    const worker = workerWithMock('sonnet', 'You are a helpful assistant.', mock);

    const p = worker.write('go');
    mock.emitResponse();
    const out = await p;
    assert.equal(out.content, 'HAPPY', 'a normal request resolves exactly once with the right content');
  });

  // ---- D-04 / WLIFE-02: per-worker unref'd idle timer ----
  it('D-04 idle fire: a worker idle past idleMs disposes itself and emits exit', async () => {
    const mock = makeMockWorkerStdio();
    let disposeCalls = 0;
    const worker = workerWithKillableMock('sonnet', 'You are a helpful assistant.', mock, { idleMs: 50 });
    const origDispose = worker.dispose.bind(worker);
    worker.dispose = () => { disposeCalls += 1; return origDispose(); };

    let exitEv = null;
    worker.once('exit', (ev) => { exitEv = ev; });

    // Never send a request: the constructor-armed idle timer must fire.
    await new Promise((res) => setTimeout(res, 120));

    assert.ok(disposeCalls >= 1, 'idle worker disposed itself');
    assert.ok(exitEv !== null, "idle dispose reached the 'exit' reap path");
  });

  it('D-04 reset-on-settle: a request settling before the window defers idle eviction', async () => {
    const mock = makeMockWorkerStdio({ resultText: 'OK', inputTokens: 10, outputTokens: 1 });
    let disposed = false;
    const worker = workerWithKillableMock('sonnet', 'You are a helpful assistant.', mock, { idleMs: 80 });
    const origDispose = worker.dispose.bind(worker);
    worker.dispose = () => { disposed = true; return origDispose(); };

    // Drive a request that settles at ~40ms (before the 80ms idle window).
    const p = worker.write('ping');
    setTimeout(() => mock.emitResponse(), 40);
    await p;

    // At ~90ms total the FIRST idle window would have elapsed, but the timer
    // reset on settle (~40ms) so the next window ends at ~120ms. Assert NOT
    // disposed at ~90ms.
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(disposed, false, 'idle timer reset on settle — worker not evicted at the original window');
  });

  it('D-04 cleared on dispose: dispose() clears the idle timer (no second exit, no throw)', async () => {
    const mock = makeMockWorkerStdio();
    const worker = workerWithKillableMock('sonnet', 'You are a helpful assistant.', mock, { idleMs: 50 });

    let exitCount = 0;
    worker.on('exit', () => { exitCount += 1; });

    // Dispose explicitly BEFORE the idle window — must clear the idle timer.
    worker.dispose();
    // Wait well past the idle window: the cleared timer must not fire a second
    // dispose / exit and must not throw a dangling-timer error.
    await new Promise((res) => setTimeout(res, 120));
    assert.equal(exitCount, 1, "exactly one 'exit' (from dispose), no dangling idle-timer fire");
  });

  // ---- GUARD-02 / D-01 / D-04: boot-version capture via deps.readVersion ----
  it('GUARD-02 boot-version: a ClaudeWorker captures deps.readVersion() into _bootVersion', () => {
    const mock = makeMockWorkerStdio();
    const worker = workerWithMock('sonnet', 'You are a helpful assistant.', mock, {
      readVersion: () => '1.2.3',
    });
    assert.equal(worker._bootVersion, '1.2.3', 'injected readVersion string captured on _bootVersion');
  });

  it('GUARD-02 degrade-open: a throwing readVersion does NOT block boot and leaves _bootVersion falsy', () => {
    const mock = makeMockWorkerStdio();
    let worker;
    assert.doesNotThrow(() => {
      worker = workerWithMock('sonnet', 'You are a helpful assistant.', mock, {
        readVersion: () => { throw new Error('boom'); },
      });
    }, 'a probe that throws must never crash worker boot (degrade-open, D-04)');
    assert.ok(!worker._bootVersion, 'failed probe yields a falsy _bootVersion (drift-recycle disabled for this worker)');
    // Boot stayed synchronous + the worker still serves traffic.
    assert.equal(worker.busy, false, 'worker constructed and is serviceable after a failed version probe');
  });

  it('GUARD-02 degrade-open: an absent readVersion default never throws and the worker still serves', async () => {
    const mock = makeMockWorkerStdio({ resultText: 'OK', inputTokens: 10, outputTokens: 1 });
    // No readVersion injected: the default best-effort probe runs against the
    // (mock) claudeCli and must degrade open — never throwing out of boot.
    let worker;
    assert.doesNotThrow(() => {
      worker = workerWithMock('sonnet', 'You are a helpful assistant.', mock);
    }, 'default readVersion probe must degrade open');
    const p = worker.write('ping');
    mock.emitResponse();
    const out = await p;
    assert.equal(out.content, 'OK', 'worker serves a request normally regardless of the version probe outcome');
  });
});

// ---------------------------------------------------------------------------
// Plan-03 router lifecycle: lazy-spawn, sibling dispatch, recycle, LRU cap.
// Drives the pool via the injected `workerFactory` seam so NO real CLI spawns.
// ---------------------------------------------------------------------------

// A deterministic fake worker the pool can drive without a subprocess. Mirrors
// the ClaudeWorker surface the pool consumes: busy/needsRecycle/isStale/pid,
// write()->Promise, cancel(), dispose(), and the 'exit' once() seam.
function makeFakeWorker(model, systemPrompt, opts = {}) {
  let nextPid = opts.pid ?? Math.floor(Math.random() * 1e6);
  const w = {
    pid: nextPid,
    model,
    systemPrompt,
    busy: false,
    needsRecycle: false,
    isStale: false,
    disposed: false,
    writes: 0,
    _exitCb: null,
    once(ev, cb) { if (ev === 'exit') this._exitCb = cb; },
    cancel() { this.cancelled = true; },
    dispose() { this.disposed = true; },
    async write(content) {
      this.writes += 1;
      this.busy = true;
      if (opts.onWrite) opts.onWrite(this);
      // Resolve on a microtask so concurrency-1 ordering is observable.
      await Promise.resolve();
      this.busy = false;
      if (opts.recycleAfter && this.writes >= opts.recycleAfter) {
        this.needsRecycle = true;
        this.isStale = true;
      }
      return { content: `${content}::${model}`, model, tokens: { input: 1, output: 1, total: 2 } };
    },
  };
  return w;
}

describe('Worker pool — Plan-03 router lifecycle (factory seam, no live CLI)', () => {
  const sp = 'You are a helpful assistant.';
  const body = (model = 'sonnet') => ({ model, messages: [{ role: 'system', content: sp }, { role: 'user', content: 'hi' }] });

  it('D-07 lazy-spawn: a NEW (model×prompt) key spawns one worker on first complete', async () => {
    const created = [];
    const pool = new WorkerPool({
      size: 2,
      workerFactory: (m, p) => { const w = makeFakeWorker(m, p); created.push(w); return w; },
    });
    const out = await pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI' }));
    assert.equal(created.length, 1, 'exactly one worker spawned lazily');
    assert.equal(out.content, 'hi::sonnet');
    const key = pool.keyFor(body('sonnet'));
    assert.equal((pool.workersByKey.get(key) || []).length, 1);
  });

  it('D-05 sibling dispatch: two concurrent same-key requests use two sibling workers (size=2)', async () => {
    const created = [];
    // Workers stay busy until we release them, so concurrency forces a sibling.
    const gates = [];
    const pool = new WorkerPool({
      size: 2,
      workerFactory: (m, p) => {
        const gate = {};
        const promise = new Promise((res) => { gate.release = res; });
        gates.push(gate);
        const w = makeFakeWorker(m, p);
        w.write = async (content) => {
          w.busy = true;
          await promise;
          w.busy = false;
          return { content: `${content}::${m}`, model: m, tokens: { input: 1, output: 1, total: 2 } };
        };
        created.push(w);
        return w;
      },
    });
    const p1 = pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI1' }));
    const p2 = pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI2' }));
    // Both should have spawned siblings (size=2), not overflowed.
    assert.equal(created.length, 2, 'second concurrent request spawns a sibling, not overflow');
    gates.forEach((g) => g.release());
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.content, 'hi::sonnet');
    assert.equal(r2.content, 'hi::sonnet');
  });

  it('D-05/D-06 cap: a third concurrent request at size=2 overflows (no third spawn)', async () => {
    const created = [];
    const gates = [];
    const pool = new WorkerPool({
      size: 2,
      workerFactory: (m, p) => {
        const w = makeFakeWorker(m, p);
        const promise = new Promise((res) => { gates.push(res); });
        w.write = async () => { w.busy = true; await promise; w.busy = false; return { content: 'X' }; };
        created.push(w);
        return w;
      },
    });
    const p1 = pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI' }));
    const p2 = pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI' }));
    let overflow = 0;
    const out = await pool.complete(body('sonnet'), undefined, async () => { overflow += 1; return { content: 'OVERFLOW' }; });
    assert.equal(created.length, 2, 'no third worker spawned beyond size');
    assert.equal(overflow, 1, 'overflowFn called exactly once');
    assert.equal(out.content, 'OVERFLOW');
    // Release the held workers so no dangling promise keeps the event loop alive.
    gates.forEach((g) => g());
    await Promise.all([p1, p2]);
  });

  it('Pitfall 1 recycle: a needsRecycle worker is drained + replaced before reuse', async () => {
    const created = [];
    const pool = new WorkerPool({
      size: 1,
      workerFactory: (m, p) => { const w = makeFakeWorker(m, p, { recycleAfter: 1 }); created.push(w); return w; },
    });
    await pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI' }));
    // First worker flagged needsRecycle after its single write -> drained post-request.
    assert.equal(created[0].disposed, true, 'recycled worker disposed');
    await pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI' }));
    assert.equal(created.length, 2, 'a fresh worker replaced the recycled one');
  });

  it('D-02 LRU cap: exceeding promptCap drains the least-recently-used prompt-pool', async () => {
    const created = [];
    const pool = new WorkerPool({
      size: 1,
      promptCap: 2,
      workerFactory: (m, p) => { const w = makeFakeWorker(m, p); created.push(w); return w; },
    });
    const promptBody = (sysPrompt) => ({ model: 'sonnet', messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: 'hi' }] });
    await pool.complete(promptBody('PROMPT-A'), undefined, async () => ({}));
    await pool.complete(promptBody('PROMPT-B'), undefined, async () => ({}));
    assert.equal(pool.workersByKey.size, 2, 'two distinct prompt-pools at cap');
    const keyA = pool.keyFor(promptBody('PROMPT-A'));
    await pool.complete(promptBody('PROMPT-C'), undefined, async () => ({}));
    // PROMPT-A is the LRU and must be evicted; its worker drained.
    assert.equal(pool.workersByKey.has(keyA), false, 'LRU (PROMPT-A) prompt-pool evicted');
    assert.equal(pool.workersByKey.size, 2, 'cap held at 2 after eviction');
    assert.ok(created.some((w) => w.systemPrompt === 'PROMPT-A' && w.disposed), 'evicted pool worker drained');
  });

  // ---- D-08: synchronous dispose + drop (lifecycle disposal must not wait for 'exit') ----
  it('D-08 synchronous drop: _disposeAndDrop removes the worker from workersByKey on the SAME tick + calls dispose()', async () => {
    const created = [];
    const pool = new WorkerPool({
      size: 2,
      workerFactory: (m, p) => { const w = makeFakeWorker(m, p); created.push(w); return w; },
    });
    // Seed a worker into a key WITHOUT firing its 'exit' callback.
    const key = pool.keyFor(body('sonnet'));
    const worker = makeFakeWorker('sonnet', sp);
    // Wire the 'exit' once() seam the way _spawnWorker would, and capture whether it fires.
    let exitFired = false;
    worker.once('exit', () => { exitFired = true; pool._dropWorker(key, worker); });
    pool.workersByKey.set(key, [worker]);

    // Synchronous dispose+drop — must remove the worker BEFORE any async 'exit'.
    pool._disposeAndDrop(key, worker);

    // Same tick: the worker is gone and dispose() was called; the 'exit' callback
    // has NOT fired (the synchronous splice did the work, not the async reaper).
    assert.equal(worker.disposed, true, 'dispose() called synchronously');
    assert.equal(exitFired, false, 'drop did not depend on the async exit event');
    const workers = pool.workersByKey.get(key) || [];
    assert.ok(!workers.includes(worker), 'worker removed from workersByKey synchronously');
  });

  it('D-08 key prune: _disposeAndDrop removing the last worker deletes the key immediately (CR-02)', () => {
    const pool = new WorkerPool({ size: 2 });
    const key = pool.keyFor(body('sonnet'));
    const worker = makeFakeWorker('sonnet', sp);
    pool.workersByKey.set(key, [worker]);

    pool._disposeAndDrop(key, worker);

    assert.equal(pool.workersByKey.has(key), false, 'empty key pruned immediately (CR-02)');
    assert.equal(pool.workersByKey.size, 0, 'no dangling empty array left behind');
  });

  it('D-08 idempotent backstop: a later exit for an already-dropped worker is a no-op (indexOf===-1 guard)', () => {
    const pool = new WorkerPool({ size: 2 });
    const keyA = pool.keyFor(body('sonnet'));
    const workerA = makeFakeWorker('sonnet', sp);
    pool.workersByKey.set(keyA, [workerA]);

    pool._disposeAndDrop(keyA, workerA); // synchronous drop -> key gone
    assert.equal(pool.workersByKey.has(keyA), false);

    // The async 'exit' backstop fires later for the same worker: must NOT throw and
    // must NOT corrupt the map (the key is already gone -> _dropWorker early-returns).
    assert.doesNotThrow(() => pool._dropWorker(keyA, workerA), 'double-drop after key removal is safe');
    assert.equal(pool.workersByKey.has(keyA), false, 'map uncorrupted by double-drop');

    // And double-drop on a still-present key (different worker remains) leaves siblings intact.
    const keyB = pool.keyFor({ model: 'haiku', messages: [{ role: 'system', content: sp }, { role: 'user', content: 'hi' }] });
    const w1 = makeFakeWorker('haiku', sp);
    const w2 = makeFakeWorker('haiku', sp);
    pool.workersByKey.set(keyB, [w1, w2]);
    pool._dropWorker(keyB, w1);
    pool._dropWorker(keyB, w1); // second drop of the same worker is a no-op
    const remaining = pool.workersByKey.get(keyB) || [];
    assert.deepEqual(remaining, [w2], 'idempotent drop preserves the surviving sibling');
  });

  it('disposeAll: drains every worker across all keys and clears the map', async () => {
    const created = [];
    const pool = new WorkerPool({
      size: 1,
      workerFactory: (m, p) => { const w = makeFakeWorker(m, p); created.push(w); return w; },
    });
    await pool.complete(body('sonnet'), undefined, async () => ({}));
    await pool.complete({ model: 'haiku', messages: [{ role: 'system', content: sp }, { role: 'user', content: 'hi' }] }, undefined, async () => ({}));
    pool.disposeAll();
    assert.equal(pool.workersByKey.size, 0, 'all keys cleared');
    assert.ok(created.every((w) => w.disposed), 'every worker disposed');
  });

  // ---- CR-02: empty pool-array leak must not corrupt the LRU cap ----
  it('CR-02 no-leak: a new key that goes straight to overflow leaves NO empty array', async () => {
    // size=0 forces overflow on the very first request (no worker can be spawned).
    const created = [];
    const pool = new WorkerPool({
      size: 0,
      workerFactory: (m, p) => { const w = makeFakeWorker(m, p); created.push(w); return w; },
    });
    const key = pool.keyFor(body('sonnet'));
    let overflow = 0;
    const out = await pool.complete(body('sonnet'), undefined, async () => { overflow += 1; return { content: 'CLI' }; });
    assert.equal(overflow, 1, 'overflow path taken');
    assert.equal(out.content, 'CLI');
    assert.equal(created.length, 0, 'no worker ever spawned');
    // The bug: complete() used to register an empty [] for the new key.
    assert.equal(pool.workersByKey.has(key), false, 'no empty pool array registered for the overflow key');
    assert.equal(pool.workersByKey.size, 0, 'map stays empty after overflow-only request');
  });

  it('CR-02 no-leak: empty arrays from overflow never accumulate to corrupt the LRU cap', async () => {
    // promptCap=1 with size=0: every distinct key overflows. If empty arrays
    // leaked, workersByKey.size would climb past the cap and _enforcePromptCap
    // would churn — here it must stay 0 across many churning keys.
    const pool = new WorkerPool({ size: 0, promptCap: 1, workerFactory: () => { throw new Error('should not spawn'); } });
    for (let i = 0; i < 25; i++) {
      const churn = { model: 'sonnet', messages: [{ role: 'system', content: `SP-${i}` }, { role: 'user', content: 'hi' }] };
      await pool.complete(churn, undefined, async () => ({ content: `CLI-${i}` }));
    }
    assert.equal(pool.workersByKey.size, 0, 'no empty arrays accumulated under key churn');
  });

  it('CR-02 no-leak: dropping a key\'s last worker (recycle) deletes the key (no empty array)', async () => {
    const pool = new WorkerPool({
      size: 1,
      workerFactory: (m, p) => makeFakeWorker(m, p, { recycleAfter: 1 }),
    });
    const key = pool.keyFor(body('sonnet'));
    await pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI' }));
    // Worker recycled post-request -> dropped -> its (now-empty) key must be gone.
    assert.equal(pool.workersByKey.has(key), false, 'recycled-empty key deleted, not left as []');
    assert.equal(pool.workersByKey.size, 0, 'no dangling empty pool array');
  });

  it('CR-02 cap: _enforcePromptCap does not count empty pools toward the cap', async () => {
    const created = [];
    const pool = new WorkerPool({
      size: 1,
      promptCap: 1,
      workerFactory: (m, p) => { const w = makeFakeWorker(m, p); created.push(w); return w; },
    });
    // Manually inject two stray empty arrays (simulating any residual leak path).
    pool.workersByKey.set('stray-empty-1', []);
    pool.workersByKey.set('stray-empty-2', []);
    // One real active pool.
    await pool.complete(body('sonnet'), undefined, async () => ({}));
    const liveKey = pool.keyFor(body('sonnet'));
    pool._enforcePromptCap(liveKey);
    // The single live pool must survive: empty pools don't count toward the cap,
    // and the live pool is the active key so it is never the victim.
    assert.ok(pool.workersByKey.has(liveKey), 'live pool NOT evicted despite empty strays');
    assert.equal(created[0].disposed, false, 'live worker not disposed by cap enforcement');
  });

  it('CR-02/WR-06 cap: _enforcePromptCap never evicts a pool with a busy in-flight worker', async () => {
    const created = [];
    const gates = [];
    const pool = new WorkerPool({
      size: 1,
      promptCap: 1,
      workerFactory: (m, p) => {
        const w = makeFakeWorker(m, p);
        const promise = new Promise((res) => { gates.push(res); });
        w.write = async (content) => { w.busy = true; await promise; w.busy = false; return { content: `${content}::${m}`, model: m, tokens: { input: 1, output: 1, total: 2 } }; };
        created.push(w);
        return w;
      },
    });
    // Start a request on key A and leave it in-flight (busy).
    const bodyA = { model: 'sonnet', messages: [{ role: 'system', content: 'A' }, { role: 'user', content: 'hi' }] };
    const keyA = pool.keyFor(bodyA);
    const pA = pool.complete(bodyA, undefined, async () => ({ content: 'CLI' }));
    await Promise.resolve(); // let the write() start (sets busy=true)

    // Start a request on key B; with promptCap=1 this would normally try to evict A.
    const bodyB = { model: 'sonnet', messages: [{ role: 'system', content: 'B' }, { role: 'user', content: 'hi' }] };
    const keyB = pool.keyFor(bodyB);
    const pB = pool.complete(bodyB, undefined, async () => ({ content: 'CLI' }));
    await Promise.resolve();

    // Key A has a busy in-flight worker -> must NOT have been evicted/disposed.
    assert.equal(pool.workersByKey.has(keyA), true, 'busy in-flight pool A not evicted');
    const aWorker = created.find((w) => w.systemPrompt === 'A');
    assert.equal(aWorker.disposed, false, 'busy worker on A not disposed by cap enforcement');

    // Release both and drain.
    gates.forEach((g) => g());
    await Promise.all([pA, pB]);
    void keyB;
  });
});

// ---------------------------------------------------------------------------
// Plan-03 D-06 / WLIFE-03: crash-cooldown respawn-storm guard.
//   - per-key crash-frequency tracking on the worker exit handler (Task 1)
//   - a cooldown gate at the TOP of complete() that routes a crash-storming key
//     straight to the execFile overflow for the window, then lazily spawns again
//     after the window; healthy keys are never throttled (Task 2 / D-06).
// Drives the pool via the injected `workerFactory` seam — NO real CLI spawns.
// ---------------------------------------------------------------------------

// A fake worker that BOOT-CRASHES: on first write() it fires its stored 'exit'
// callback synchronously (so the pool's _spawnWorker exit handler records a
// crash for the key) and rejects RETRYABLE. Mirrors a persistently-broken key
// (bad OAuth/flags) whose every spawn dies on boot. The pool consumes the same
// surface as ClaudeWorker: busy/needsRecycle/isStale/pid, write()->Promise,
// cancel(), dispose(), once('exit', cb).
function makeBootCrashWorker(model, systemPrompt, opts = {}) {
  const w = {
    pid: opts.pid ?? Math.floor(Math.random() * 1e6),
    model,
    systemPrompt,
    busy: false,
    needsRecycle: false,
    isStale: false,
    disposed: false,
    _exitCb: null,
    once(ev, cb) { if (ev === 'exit') this._exitCb = cb; },
    cancel() { this.cancelled = true; },
    dispose() { this.disposed = true; },
    async write() {
      this.busy = true;
      // Boot crash: the subprocess dies immediately. Fire the pool's 'exit'
      // reaper (which records the crash for this key) and reject RETRYABLE,
      // exactly as ClaudeWorker._onExit would for an early/boot exit.
      this.needsRecycle = true;
      this.isStale = true;
      this.busy = false;
      const cb = this._exitCb;
      if (cb) { this._exitCb = null; cb({ code: 1, signal: null }); }
      const err = new Error('worker exited (code=1, signal=null)');
      err.retryable = true;
      err.code = 'WORKER_RETRYABLE';
      throw err;
    },
  };
  return w;
}

describe('Worker pool — D-06 crash cooldown (factory seam, no live CLI)', () => {
  const sp = 'You are a helpful assistant.';
  const body = (model = 'sonnet') => ({ model, messages: [{ role: 'system', content: sp }, { role: 'user', content: 'hi' }] });

  // ---- Task 1: makeMockEarlyExitStdio helper + per-key crash-frequency tracking ----

  it('D-06 helper: makeMockEarlyExitStdio returns a PassThrough stdout that ends', async () => {
    const stdio = makeMockEarlyExitStdio();
    assert.ok(stdio.stdout, 'exposes a stdout stream');
    assert.equal(typeof stdio.stdout.on, 'function', 'stdout is a Readable (PassThrough)');
    assert.equal(typeof stdio.end, 'function', 'exposes the end() seam');
    let ended = false;
    stdio.stdout.on('end', () => { ended = true; });
    // PassThrough only emits 'end' once it is read to completion.
    stdio.stdout.resume();
    await new Promise((res) => setTimeout(res, 10));
    assert.equal(ended, true, 'early-exit stdout ends (boot crash)');
  });

  it('D-06 crash recording: a boot-crashing worker records one crash for its key', async () => {
    const pool = new WorkerPool({
      size: 1,
      crashThreshold: 3,
      crashWindowMs: 1000,
      workerFactory: (m, p) => makeBootCrashWorker(m, p),
    });
    const key = pool.keyFor(body('sonnet'));

    // One complete drives one spawn -> boot crash -> one recorded crash.
    await pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI' }))
      .then(() => null, () => null);

    const recent = pool._crashesByKey.get(key) || [];
    assert.equal(recent.length, 1, 'exactly one crash timestamp recorded for the key');
  });

  // ---- Task 2: D-06 cooldown gate routes a crash-storming key to overflow ----

  it('D-06 trips to overflow: after threshold crashes within the window the next request routes to overflow (no spawn)', async () => {
    const created = [];
    const pool = new WorkerPool({
      size: 1,
      crashThreshold: 2,
      crashWindowMs: 200,
      workerFactory: (m, p) => { const w = makeBootCrashWorker(m, p); created.push(w); return w; },
    });

    // Drive enough completes to record 2 crashes (threshold).
    for (let i = 0; i < 2; i++) {
      await pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI' }))
        .then(() => null, () => null);
    }
    assert.equal(created.length, 2, 'two boot-crashing workers spawned before cooldown');

    // The NEXT request for the key is in cooldown -> overflow, NO new spawn.
    let overflow = 0;
    const out = await pool.complete(body('sonnet'), undefined, async () => { overflow += 1; return { content: 'OVERFLOW' }; });
    assert.equal(overflow, 1, 'cooldown request routed to overflowFn exactly once');
    assert.equal(out.content, 'OVERFLOW');
    assert.equal(created.length, 2, 'cooldown did NOT spawn a third worker');
  });

  it('D-06 stays in cooldown: a second request within the window also routes to overflow (no spawn)', async () => {
    const created = [];
    const pool = new WorkerPool({
      size: 1,
      crashThreshold: 2,
      crashWindowMs: 200,
      workerFactory: (m, p) => { const w = makeBootCrashWorker(m, p); created.push(w); return w; },
    });
    for (let i = 0; i < 2; i++) {
      await pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI' }))
        .then(() => null, () => null);
    }
    let overflow = 0;
    await pool.complete(body('sonnet'), undefined, async () => { overflow += 1; return { content: 'OVERFLOW' }; });
    await pool.complete(body('sonnet'), undefined, async () => { overflow += 1; return { content: 'OVERFLOW' }; });
    assert.equal(overflow, 2, 'both in-window requests routed to overflow');
    assert.equal(created.length, 2, 'no fresh worker spawned while in cooldown');
  });

  it('D-06 lazy spawn after window: once the window elapses a fresh worker may spawn again', async () => {
    const created = [];
    const pool = new WorkerPool({
      size: 1,
      crashThreshold: 2,
      crashWindowMs: 80,
      workerFactory: (m, p) => { const w = makeBootCrashWorker(m, p); created.push(w); return w; },
    });
    for (let i = 0; i < 2; i++) {
      await pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI' }))
        .then(() => null, () => null);
    }
    assert.equal(created.length, 2, 'two crashes recorded -> cooldown entered');

    // Wait past the crash window so the pruned crash list drops below threshold.
    await new Promise((res) => setTimeout(res, 120));

    // The cooldown has lifted: the next request is allowed to lazily spawn again
    // (it boot-crashes once more, but that proves a spawn was attempted, not a
    // straight-to-overflow route).
    let overflow = 0;
    await pool.complete(body('sonnet'), undefined, async () => { overflow += 1; return { content: 'OVERFLOW-AFTER' }; })
      .then(() => null, () => null);
    assert.equal(created.length, 3, 'a fresh worker spawned after the window elapsed (cooldown lifted)');
  });

  it('D-06 healthy key unaffected: a key that never crashes uses workers normally (no spurious overflow)', async () => {
    const created = [];
    const pool = new WorkerPool({
      size: 1,
      crashThreshold: 2,
      crashWindowMs: 200,
      workerFactory: (m, p) => { const w = makeFakeWorker(m, p); created.push(w); return w; },
    });
    let overflow = 0;
    const out = await pool.complete(body('sonnet'), undefined, async () => { overflow += 1; return { content: 'CLI' }; });
    assert.equal(overflow, 0, 'healthy key never routes to overflow');
    assert.equal(created.length, 1, 'healthy key uses a real worker');
    assert.equal(out.content, 'hi::sonnet', 'healthy worker served the request');
    // A second healthy request still uses a worker, never the cooldown overflow.
    await pool.complete(body('sonnet'), undefined, async () => { overflow += 1; return { content: 'CLI' }; });
    assert.equal(overflow, 0, 'still no overflow on a healthy key');
  });
});

// ---------------------------------------------------------------------------
// Plan-04 D-01 / D-03 / WLIFE-04: client-disconnect / request-abort propagation.
//   - D-01: aborting the IN-FLIGHT request SIGTERMs+disposes+synchronously-drops
//     the worker (via _disposeAndDrop), rejects the in-flight request RETRYABLE,
//     and the next same-key request cold-respawns; the disconnect path NEVER
//     calls worker.cancel() (the Phase-62 protocol interrupt that live-HANGS).
//   - D-03: aborting a QUEUED request (concurrency-1 FIFO, not yet in-flight)
//     dequeues+rejects ONLY that job RETRYABLE and leaves the worker + its
//     different in-flight request untouched.
// Drives the pool via the injected `workerFactory` seam — NO real CLI spawns.
// ---------------------------------------------------------------------------

// A fake worker that models the real ClaudeWorker queue semantics the abort
// discrimination depends on: a gated in-flight `_pending`, a FIFO `_queue`, and
// the `writeTracked(content)` -> { promise, job } seam the pool uses to identify
// WHICH logical request an abort targets. The in-flight write stays unresolved
// until `release()` (so the request is observably busy while we abort). A second
// writeTracked() while busy pushes a job onto `_queue` (concurrency-1). dispose()
// rejects the in-flight `_pending` RETRYABLE (mirrors the real SIGTERM->'exit'->
// _onExit reap) and fires the 'exit' once() seam so the pool's reaper runs too.
function makeAbortableFakeWorker(model, systemPrompt, opts = {}) {
  const w = {
    pid: opts.pid ?? Math.floor(Math.random() * 1e6),
    model,
    systemPrompt,
    busy: false,
    needsRecycle: false,
    isStale: false,
    disposed: false,
    cancelled: false,
    _pending: null,
    _queue: [],
    _exitCb: null,
    once(ev, cb) { if (ev === 'exit') this._exitCb = cb; },
    // The disconnect path must NEVER call this (D-01). If it does, the assertion
    // `worker.cancelled === false` fails.
    cancel() { this.cancelled = true; },
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      // Mirror ClaudeWorker._onExit: reject the in-flight request RETRYABLE.
      const pending = this._pending;
      this._pending = null;
      this.busy = false;
      if (pending) {
        const err = new Error('worker exited (signal=SIGTERM)');
        err.retryable = true;
        err.code = 'WORKER_RETRYABLE';
        pending.reject(err);
      }
      // Drain any queued jobs RETRYABLE too (no silent hang) — though the D-01/
      // D-03 cases dequeue a targeted job before disposing.
      const queued = this._queue.splice(0);
      for (const job of queued) {
        const err = new Error('worker exited (signal=SIGTERM)');
        err.retryable = true;
        err.code = 'WORKER_RETRYABLE';
        job.reject(err);
      }
      const cb = this._exitCb;
      if (cb) { this._exitCb = null; cb({ code: null, signal: 'SIGTERM' }); }
    },
    writeTracked(content) {
      const job = { content, resolve: null, reject: null };
      const promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      if (this.busy) {
        // Concurrency-1: queue behind the in-flight request.
        this._queue.push(job);
      } else {
        this.busy = true;
        this._pending = job;
        // Gated: stays in-flight until release(). Tests release explicitly.
      }
      return { promise, job };
    },
    // D-03: dequeue a single queued job + reject RETRYABLE; leave the worker and
    // its in-flight request alone. Returns true iff the job was queued (so the
    // pool falls through to in-flight dispose only when NOT queued).
    abortQueuedJob(job) {
      const idx = this._queue.indexOf(job);
      if (idx === -1) return false;
      this._queue.splice(idx, 1);
      const err = new Error('request aborted (queued — client disconnected)');
      err.retryable = true;
      err.code = 'WORKER_RETRYABLE';
      job.reject(err);
      return true;
    },
    // Thin compat wrapper so any non-tracked caller still works.
    write(content) { return this.writeTracked(content).promise; },
    // Test affordance: resolve the in-flight request as if a result arrived.
    release(result = { content: 'OK', model, tokens: { input: 1, output: 1, total: 2 } }) {
      const pending = this._pending;
      this._pending = null;
      this.busy = false;
      if (pending) pending.resolve(result);
      // Drive the next queued job into flight (FIFO).
      if (this._queue.length > 0) {
        const next = this._queue.shift();
        this.busy = true;
        this._pending = next;
      }
    },
  };
  return w;
}

describe('Worker pool — D-01/D-03 abort propagation (factory seam, no live CLI)', () => {
  const sp = 'You are a helpful assistant.';
  const body = (model = 'sonnet') => ({ model, messages: [{ role: 'system', content: sp }, { role: 'user', content: 'hi' }] });

  // ---- D-01: in-flight abort = SIGTERM + dispose + synchronous drop ----

  it('D-01 in-flight abort disposes + drops synchronously (via _disposeAndDrop)', async () => {
    const created = [];
    const pool = new WorkerPool({
      size: 1,
      workerFactory: (m, p) => { const w = makeAbortableFakeWorker(m, p); created.push(w); return w; },
    });
    const key = pool.keyFor(body('sonnet'));
    const controller = new AbortController();

    // Start an in-flight request and DO NOT await it (the gated worker stays busy).
    const pInflight = pool.complete(body('sonnet'), controller.signal, async () => ({ content: 'CLI' }));
    // Let complete() acquire the worker + register the abort listener.
    await Promise.resolve();
    const worker = created[0];
    assert.equal(worker.busy, true, 'worker is in-flight (busy) before abort');
    assert.ok((pool.workersByKey.get(key) || []).includes(worker), 'worker registered in the pool');

    // Abort the in-flight request.
    controller.abort();

    // SYNCHRONOUSLY (same tick, before any async exit): the worker is disposed
    // AND removed from the pool via _disposeAndDrop.
    assert.equal(worker.disposed, true, 'in-flight abort disposed the worker synchronously');
    assert.ok(!(pool.workersByKey.get(key) || []).includes(worker), 'worker dropped from the pool synchronously');

    // The in-flight complete() rejects RETRYABLE (dispose rejected _pending).
    const err = await pInflight.then(() => null, (e) => e);
    assert.ok(err, 'in-flight request rejected on abort');
    assert.equal(err.retryable, true, 'in-flight abort rejects RETRYABLE');
    assert.equal(err.code, 'WORKER_RETRYABLE');
  });

  it('D-01 never calls cancel(): the disconnect path uses dispose, NOT the hanging protocol interrupt', async () => {
    const created = [];
    const pool = new WorkerPool({
      size: 1,
      workerFactory: (m, p) => { const w = makeAbortableFakeWorker(m, p); created.push(w); return w; },
    });
    const controller = new AbortController();
    const p = pool.complete(body('sonnet'), controller.signal, async () => ({ content: 'CLI' }));
    await Promise.resolve();
    const worker = created[0];

    controller.abort();
    await p.then(() => null, () => null);

    assert.equal(worker.cancelled, false, 'worker.cancel() was NEVER invoked on the disconnect path (D-01)');
    assert.equal(worker.disposed, true, 'dispose() WAS used instead');
  });

  it('D-01 cold respawn: after an in-flight abort drops the worker, the next same-key request spawns a NEW worker', async () => {
    const created = [];
    const pool = new WorkerPool({
      size: 1,
      workerFactory: (m, p) => { const w = makeAbortableFakeWorker(m, p); created.push(w); return w; },
    });
    const controller = new AbortController();
    const p1 = pool.complete(body('sonnet'), controller.signal, async () => ({ content: 'CLI' }));
    await Promise.resolve();
    assert.equal(created.length, 1, 'first request spawned one worker');

    controller.abort();
    await p1.then(() => null, () => null);

    // Next same-key request must lazily cold-respawn a FRESH worker (created.length grows).
    const p2 = pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI' }));
    await Promise.resolve();
    assert.equal(created.length, 2, 'next same-key request cold-respawned a new worker (no reuse of the disposed one)');
    created[1].release();
    await p2;
  });

  it('D-01 already-aborted at acquire: an already-aborted signal disposes+drops the worker immediately', async () => {
    const created = [];
    const pool = new WorkerPool({
      size: 1,
      workerFactory: (m, p) => { const w = makeAbortableFakeWorker(m, p); created.push(w); return w; },
    });
    const key = pool.keyFor(body('sonnet'));
    const controller = new AbortController();
    controller.abort(); // already aborted BEFORE complete()

    const p = pool.complete(body('sonnet'), controller.signal, async () => ({ content: 'CLI' }));
    const err = await p.then(() => null, (e) => e);

    assert.ok(err && err.retryable === true, 'already-aborted request rejects RETRYABLE');
    const worker = created[0];
    assert.equal(worker.disposed, true, 'already-aborted signal disposed the acquired worker');
    assert.ok(!(pool.workersByKey.get(key) || []).includes(worker), 'already-aborted signal dropped the worker');
  });

  // ---- D-03: queued-vs-in-flight discrimination ----

  // The pool routes a second CONCURRENT same-key request to a sibling/overflow,
  // so a job only lands in a worker's `_queue` when the SAME worker is written
  // to while busy (concurrency-1 self-serialization). We drive that directly:
  // request A occupies the worker in-flight, then we issue B THROUGH THE POOL
  // against the SAME (now-busy) worker by pre-seeding the pool with that worker
  // at size=2 — the pool hands B to the busy worker's queue rather than spawning
  // a sibling only when it finds a free slot, so to force the queued path we put
  // B on the worker explicitly and feed its job into the pool's abort wiring via
  // a custom factory that returns the shared, already-busy worker.
  it('D-03 queued abort dequeues ONLY: the worker + its in-flight request survive', async () => {
    const key0 = new WorkerPool().keyFor(body('sonnet'));

    // One shared worker. A goes in-flight directly; B is queued behind it. We
    // then exercise the pool's abort discrimination by routing B's complete()
    // through a factory that returns this SAME busy worker (so the pool's
    // writeTracked lands B in the worker's _queue), and abort B.
    const worker = makeAbortableFakeWorker('sonnet', sp);

    // A occupies the worker in-flight (gated).
    const { promise: pADirect } = worker.writeTracked('A');
    assert.equal(worker.busy, true, 'A is in-flight on the shared worker');

    // Pool whose factory hands back the SAME already-busy worker. With size=1 and
    // the worker pre-registered+busy, B would overflow — so we register the worker
    // and use size=2 to let the pool dispatch B onto it; the busy worker queues B.
    const created = [];
    const pool = new WorkerPool({
      size: 2,
      workerFactory: () => { created.push(worker); return worker; },
    });
    const key = pool.keyFor(body('sonnet'));
    assert.equal(key, key0);
    pool.workersByKey.set(key, [worker]); // pre-register the in-flight worker

    // B through the pool: worker is busy, size=2 allows a sibling — but our
    // factory returns the SAME worker, whose writeTracked queues B (concurrency-1).
    const ctrlB = new AbortController();
    const pB = pool.complete(body('sonnet'), ctrlB.signal, async () => ({ content: 'CLI-B' }));
    await Promise.resolve();
    assert.equal(worker._queue.length, 1, 'B is sitting in the worker queue (concurrency-1 self-serialize)');

    // Abort B (the QUEUED one).
    ctrlB.abort();

    const eB = await pB.then(() => null, (e) => e);
    assert.ok(eB && eB.retryable === true && eB.code === 'WORKER_RETRYABLE', 'queued B rejects RETRYABLE');
    assert.equal(worker._queue.length, 0, 'B spliced out of the queue');
    assert.equal(worker.disposed, false, 'worker NOT disposed by a queued abort (D-03)');
    assert.ok((pool.workersByKey.get(key) || []).includes(worker), 'worker still in the pool');
    assert.equal(worker.busy, true, "A's in-flight request untouched (worker still busy on A)");

    // A still resolves when released.
    worker.release({ content: 'CLI-A', model: 'sonnet', tokens: { input: 1, output: 1, total: 2 } });
    const a = await pADirect;
    assert.equal(a.content, 'CLI-A', 'A resolved normally after the queued abort');
  });

  it('D-03 in-flight abort still disposes (discrimination must not break the D-01 case)', async () => {
    const created = [];
    const pool = new WorkerPool({
      size: 1,
      workerFactory: (m, p) => { const w = makeAbortableFakeWorker(m, p); created.push(w); return w; },
    });
    const key = pool.keyFor(body('sonnet'));
    const ctrlA = new AbortController();
    const pA = pool.complete(body('sonnet'), ctrlA.signal, async () => ({ content: 'CLI-A' }));
    await Promise.resolve();
    const worker = created[0];

    // Abort the IN-FLIGHT A — must still take the D-01 dispose+drop path.
    ctrlA.abort();
    assert.equal(worker.disposed, true, 'in-flight abort still disposes (D-01 path intact)');
    assert.ok(!(pool.workersByKey.get(key) || []).includes(worker), 'in-flight abort still drops the worker');
    const eA = await pA.then(() => null, (e) => e);
    assert.ok(eA && eA.retryable === true, 'in-flight abort still rejects RETRYABLE');
  });

  it('D-03 queued reject shape: a dequeued job rejects RETRYABLE-shaped (retryable + WORKER_RETRYABLE)', async () => {
    // Worker-level mechanism check: a queued job aborted via abortQueuedJob
    // rejects RETRYABLE-shaped and the worker survives (mirrors the _onExit
    // drain-loop reject shape). This is the unit the pool's handleAbort delegates
    // to for the queued branch.
    const worker = makeAbortableFakeWorker('sonnet', sp);
    const { promise: pA } = worker.writeTracked('A'); // in-flight
    const { promise: pB, job: jobB } = worker.writeTracked('B'); // queued
    assert.equal(worker._queue.length, 1, 'B queued behind in-flight A');

    const removed = worker.abortQueuedJob(jobB);
    assert.equal(removed, true, 'abortQueuedJob found + removed the queued job');

    const eB = await pB.then(() => null, (e) => e);
    assert.equal(eB.retryable, true);
    assert.equal(eB.code, 'WORKER_RETRYABLE');
    assert.equal(worker.disposed, false, 'worker NOT disposed by a queued abort');
    assert.equal(worker.busy, true, 'in-flight A still in flight');

    // Clean up A.
    worker.release();
    await pA;
  });
});

// ---------------------------------------------------------------------------
// Phase 64 GUARD-02 — CLI version-drift recycle (factory seam, no live CLI).
//   - SC-1: a worker booted against CLI vX is drained + respawned at reuse once
//     the pool's current-version snapshot drifts to vY, BEFORE serving the next
//     request — proved by SIMULATING the version change via an injected reader
//     (a mutable cell), never a real `claude` upgrade.
//   - degrade-open: a worker with a falsy _bootVersion (probe failed) is NEVER
//     recycled on drift — it is reused normally.
//   - no-drift control: when the version is unchanged the original worker is
//     REUSED (no dispose, no new spawn).
// Drives the pool via the injected `workerFactory` seam — NO real CLI spawns.
// ---------------------------------------------------------------------------

// A fake worker stamped with a _bootVersion taken from a mutable version cell at
// CONSTRUCTION time (mirrors ClaudeWorker capturing readVersion() into
// _bootVersion at boot). Reuses the makeFakeWorker surface the pool consumes.
function makeVersionedFakeWorker(model, systemPrompt, bootVersion, created) {
  const w = makeFakeWorker(model, systemPrompt);
  w._bootVersion = bootVersion;
  if (created) created.push(w);
  return w;
}

describe('Worker pool — GUARD-02 CLI version-drift recycle (factory seam, no live CLI)', () => {
  const sp = 'You are a helpful assistant.';
  const body = (model = 'sonnet') => ({ model, messages: [{ role: 'system', content: sp }, { role: 'user', content: 'hi' }] });

  it('SC-1 drift recycle: a worker booted at v1.0.0 is disposed + respawned when the snapshot drifts to v2.0.0', async () => {
    const created = [];
    // Mutable version cell: the pool reader and the worker boot-stamp both read it
    // so flipping it between acquires SIMULATES a CLI upgrade (no real binary).
    const versionCell = { current: '1.0.0' };
    const pool = new WorkerPool({
      size: 1,
      readVersion: () => versionCell.current,
      workerFactory: (m, p) => makeVersionedFakeWorker(m, p, versionCell.current, created),
    });
    const key = pool.keyFor(body('sonnet'));

    // First acquire: boots a worker stamped bootVersion "1.0.0"; snapshot is "1.0.0".
    await pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI' }));
    assert.equal(created.length, 1, 'first acquire spawned one worker');
    assert.equal(created[0]._bootVersion, '1.0.0', 'first worker stamped with boot version 1.0.0');
    assert.equal(created[0].disposed, false, 'no drift yet — first worker not disposed');
    assert.ok((pool.workersByKey.get(key) || []).includes(created[0]), 'worker registered after first acquire');

    // SIMULATE a CLI upgrade: the operator upgrades claude under the running worker.
    versionCell.current = '2.0.0';
    // Refresh the pool's snapshot the way a coarse re-probe would (the test drives
    // the cadence deterministically rather than waiting on an interval).
    pool.refreshVersionSnapshot();
    assert.equal(pool._currentVersion, '2.0.0', 'pool snapshot drifted to 2.0.0');

    // Second acquire for the SAME key: the drifted worker (boot 1.0.0 != snapshot
    // 2.0.0) must be flagged needsRecycle and drained by the existing _reapStale
    // BEFORE it serves, then a fresh worker (booted 2.0.0) spawned for the request.
    await pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI' }));
    assert.equal(created[0].disposed, true, 'drifted worker disposed at reuse (drained via _reapStale)');
    assert.equal(created.length, 2, 'a fresh worker replaced the drifted one');
    assert.equal(created[1]._bootVersion, '2.0.0', 'the replacement booted against the new CLI version');
  });

  it('degrade-open: a worker with a falsy _bootVersion is NOT recycled even when the snapshot has a value', async () => {
    const created = [];
    const versionCell = { current: '1.0.0' };
    const pool = new WorkerPool({
      size: 1,
      readVersion: () => versionCell.current,
      // Stamp a NULL boot version (probe failed) regardless of the cell.
      workerFactory: (m, p) => makeVersionedFakeWorker(m, p, null, created),
    });

    await pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI' }));
    assert.equal(created.length, 1, 'one worker spawned');
    assert.equal(created[0]._bootVersion, null, 'worker has a falsy boot version (probe failed)');

    // Drift the snapshot — but a null-boot-version worker must NEVER be flagged.
    versionCell.current = '2.0.0';
    pool.refreshVersionSnapshot();

    await pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI' }));
    assert.equal(created[0].disposed, false, 'degrade-open: null-boot-version worker not recycled on drift');
    assert.equal(created.length, 1, 'no respawn — the original worker was reused');
  });

  it('no-drift control: when the version is unchanged across acquires the original worker is REUSED', async () => {
    const created = [];
    const versionCell = { current: '1.0.0' };
    const pool = new WorkerPool({
      size: 1,
      readVersion: () => versionCell.current,
      workerFactory: (m, p) => makeVersionedFakeWorker(m, p, versionCell.current, created),
    });

    await pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI' }));
    assert.equal(created.length, 1, 'one worker spawned');

    // No version change: refresh keeps the snapshot equal to the boot version.
    pool.refreshVersionSnapshot();
    await pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI' }));

    assert.equal(created[0].disposed, false, 'no drift — original worker not disposed');
    assert.equal(created.length, 1, 'no drift — original worker reused, no respawn');
  });

  it('no per-request exec: complete() compares against the cached snapshot, never re-probing the reader', async () => {
    const created = [];
    let readerCalls = 0;
    const versionCell = { current: '1.0.0' };
    const pool = new WorkerPool({
      size: 1,
      readVersion: () => { readerCalls += 1; return versionCell.current; },
      workerFactory: (m, p) => makeVersionedFakeWorker(m, p, versionCell.current, created),
    });
    const callsAfterConstruction = readerCalls; // snapshot captured once at construction

    // Several requests on the hot path must NOT invoke the version reader again —
    // drift is a string-equality check against the cached snapshot (D-03).
    for (let i = 0; i < 5; i++) {
      await pool.complete(body('sonnet'), undefined, async () => ({ content: 'CLI' }));
    }
    assert.equal(readerCalls, callsAfterConstruction, 'the version reader is NOT called on the per-request path');
  });
});

// ---------------------------------------------------------------------------
// Phase 64 GUARD-03 — stderr drain-and-throttle (fake clock + injected logger).
//   - the FIRST stderr chunk logs exactly one line; a SECOND chunk within the
//     same 60s window logs NOTHING (throttled); after the fake clock advances
//     past the window, the next chunk logs again — proving the <=1/min/worker gate.
//   - the logged sample is truncated to <=200 chars (mirrors server.mjs:1143).
//   - every chunk is still drained (the stream is consumed) regardless of throttle.
// Phase 64 WR-02 fold-in (D-08) — the recycle ceiling trips on the cache-inclusive
//   modelUsage sum (input + cacheRead + cacheCreation) when raw input_tokens alone
//   would stay UNDER the ceiling; a modelUsage-absent control does NOT trip.
// All unit-level: stderr/stdout are injected via the mock helper — NO live CLI.
// ---------------------------------------------------------------------------

// Build a ClaudeWorker wired to the mock's REAL stderr stream plus an injected
// fake clock + capturing logErr, so the throttle gate is driven deterministically.
function workerWithStderr(model, systemPrompt, mock, clock, captured, deps = {}) {
  return new ClaudeWorker(model, systemPrompt, {
    spawn: () => ({
      pid: 4242,
      stdout: mock.stdout,
      stdin: mock.stdin,
      stderr: mock.stderr, // the mock's real stderr — emitStderr pushes chunks here
      kill: () => {},
      on: () => {},
    }),
    now: () => clock.now,
    logErr: (line) => captured.push(line),
    ...deps,
  });
}

describe('Worker pool — GUARD-03 stderr drain+throttle (fake clock, injected logger)', () => {
  it('throttle: first chunk logs once, a second within the window is suppressed, a chunk after the window logs again', async () => {
    const clock = { now: 1_000_000 };
    const captured = [];
    const mock = makeMockWorkerStdio();
    const worker = workerWithStderr('sonnet', 'You are a helpful assistant.', mock, clock, captured);

    // First chunk: logs exactly one line.
    mock.emitStderr('no stdin data received\n');
    await tick();
    assert.equal(captured.length, 1, 'first stderr chunk logs exactly one line');
    assert.match(captured[0], /no stdin data received/, 'the logged line carries the stderr sample');

    // Second chunk, clock NOT advanced past the 60s window: suppressed.
    mock.emitStderr('another warning right away\n');
    await tick();
    assert.equal(captured.length, 1, 'a second chunk within the window is throttled (no new line)');

    // Advance the fake clock past the 60s window: the next chunk logs again.
    clock.now += 60_001;
    mock.emitStderr('warning after the window\n');
    await tick();
    assert.equal(captured.length, 2, 'a chunk after the window elapses logs again');
    assert.match(captured[1], /warning after the window/, 'the post-window line carries the new sample');

    // The worker never threw and never blocked — it still serves a request.
    void worker;
  });

  it('truncation: the logged stderr sample is trimmed and sliced to <=200 chars (mirrors server.mjs:1143)', async () => {
    const clock = { now: 0 };
    const captured = [];
    const mock = makeMockWorkerStdio();
    workerWithStderr('sonnet', 'You are a helpful assistant.', mock, clock, captured);

    // A huge stderr blob: the logged SAMPLE must be capped at 200 chars.
    const huge = '   ' + 'X'.repeat(5000) + '   ';
    mock.emitStderr(huge);
    await tick();
    assert.equal(captured.length, 1, 'one line logged');
    // The captured line is `worker-pool: stderr pid=...: <sample>`; isolate the sample.
    const sample = captured[0].slice(captured[0].indexOf(': ', captured[0].indexOf('stderr')) + 2);
    assert.ok(sample.length <= 200, `the logged stderr sample is <=200 chars (was ${sample.length})`);
    assert.equal(sample, 'X'.repeat(200), 'sample is trimmed then sliced to the first 200 chars');
  });

  it('drain-without-logger: a worker built with NO logger consumes every stderr chunk and never throws', async () => {
    const clock = { now: 0 };
    const mock = makeMockWorkerStdio();
    // No logErr injected -> default no-op. Construct directly to keep the no-op default.
    const worker = new ClaudeWorker('sonnet', 'You are a helpful assistant.', {
      spawn: () => ({ pid: 7, stdout: mock.stdout, stdin: mock.stdin, stderr: mock.stderr, kill: () => {}, on: () => {} }),
      now: () => clock.now,
    });
    assert.doesNotThrow(() => {
      mock.emitStderr('noise with no logger wired\n');
    }, 'draining stderr with a no-op logger never throws');
    await tick();
    // The stream was consumed (drained) — the worker is still serviceable.
    assert.equal(worker.busy, false, 'worker remains serviceable after draining stderr with no logger');
  });
});

describe('Worker pool — WR-02 fold-in: recycle ceiling uses the cache-inclusive token sum (D-08)', () => {
  it('summed-token ceiling: needsRecycle trips when input+cacheRead crosses _maxInputTokens while raw input alone would not', async () => {
    // Raw input_tokens = 100 (UNDER the ceiling); cacheRead = 5000 -> summed 5100
    // (OVER a 1000 ceiling). The pre-WR-02 code read only the raw 100 and would
    // NOT recycle; the fix measures the cache-inclusive 5100 and DOES.
    const mock = makeMockWorkerStdio({
      resultText: 'OK',
      inputTokens: 100,
      outputTokens: 2,
      cacheRead: 5000,
    });
    const worker = workerWithMock('sonnet', 'You are a helpful assistant.', mock, {
      maxInputTokens: 1000, // between raw input (100) and the summed value (5100)
    });

    const p = worker.write('big cached context');
    mock.emitResponse();
    const out = await p;

    // Sanity: the reported token contract is the same cache-inclusive sum.
    assert.equal(out.tokens.input, 100 + 5000, 'reported input is the cache-inclusive sum');
    // The whole point of WR-02: the ceiling trips on the SUMMED value.
    assert.equal(worker.needsRecycle, true, 'recycle ceiling trips on the cache-inclusive sum (input+cacheRead)');
    assert.equal(worker.isStale, true, 'isStale set alongside needsRecycle');
  });

  it('control: raw input under the ceiling with NO modelUsage does NOT trip the recycle ceiling', async () => {
    // Hand-build a result event with NO modelUsage: the fallback path reads raw
    // usage.input_tokens (100), which stays under the 1000 ceiling -> no recycle.
    const mock = makeMockWorkerStdio();
    const worker = workerWithMock('sonnet', 'You are a helpful assistant.', mock, {
      maxInputTokens: 1000,
    });

    const p = worker.write('no modelUsage');
    // Emit a result line WITHOUT a modelUsage block so the WR-02 fallback engages.
    mock.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'OK',
      usage: { input_tokens: 100, output_tokens: 2 },
    }) + '\n');
    const out = await p;

    assert.equal(out.tokens.input, 100, 'modelUsage-absent path reports the raw input_tokens (fallback)');
    assert.equal(worker.needsRecycle, false, 'raw input under the ceiling with no modelUsage does NOT recycle');
  });
});

// ---------------------------------------------------------------------------
// Phase 66 Plan 03 — PERF-03 spawn/queue OVERHEAD window (fake clock).
//   overhead_ms = time from dispatch-start (the moment _dispatch writes the
//   prompt) to the FIRST stdout line the worker emits for that turn. Captures
//   spawn + CLI cold-boot + queue-wait + dispatch; EXCLUDES model generation
//   (between the first output line and the terminal result).
//   - Warm reuse  : first stdout arrives a few ms after dispatch -> SMALL overheadMs.
//   - Cold spawn  : first stdout gated on CLI boot (~10-14s) -> LARGE overheadMs.
//   - overheadMs is measured to FIRST output, NOT the terminal result, so it
//     stays far below the total elapsed when generation time follows first output.
// Determinism: the worker's injectable `_now` clock (deps.now) is advanced by
// the test between writing the first stdout line and the terminal result line.
// ---------------------------------------------------------------------------

// A ClaudeWorker wired to the mock stdio plus an injected fake clock, so the
// dispatch-start -> first-stdout overhead window is measured deterministically.
function workerWithClock(model, systemPrompt, mock, clock, deps = {}) {
  return new ClaudeWorker(model, systemPrompt, {
    spawn: () => ({
      pid: 4242,
      stdout: mock.stdout,
      stdin: mock.stdin,
      stderr: makeMockWorkerStdio().stdout,
      kill: () => {},
      on: () => {},
    }),
    now: () => clock.now,
    ...deps,
  });
}

// Raw JSON-Lines builders so a test can drive init / assistant / result with a
// clock advance BETWEEN lines (the bundled emitResponse() writes all three at
// once, which cannot exercise the dispatch->first-output window).
function rawInitLine(model = 'claude-sonnet-4-6') {
  return JSON.stringify({ type: 'system', subtype: 'init', session_id: 'mock', model, tools: [] }) + '\n';
}
function rawResultLine(model = 'claude-sonnet-4-6', resultText = 'OK') {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: resultText,
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { [model]: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
  }) + '\n';
}

describe('Worker pool — PERF-03 spawn/queue overhead window (fake clock)', () => {
  it('Test A (warm): first stdout ~5ms after dispatch yields overheadMs under 50', async () => {
    const clock = { now: 1_000_000 };
    const mock = makeMockWorkerStdio();
    const worker = workerWithClock('sonnet', 'You are a helpful assistant.', mock, clock);

    const p = worker.write('say OK'); // _dispatch stamps dispatchedAt = 1_000_000
    clock.now += 5; // warm: first output 5ms later
    mock.stdout.write(rawInitLine()); // FIRST stdout for this turn -> firstOutputAt
    clock.now += 900; // generation time (must NOT count toward overhead)
    mock.stdout.write(rawResultLine()); // terminal result settles the promise
    const out = await p;

    assert.equal(typeof out.overheadMs, 'number', 'completion carries a numeric overheadMs');
    assert.ok(out.overheadMs < 50, `warm overheadMs is small (was ${out.overheadMs})`);
    assert.equal(out.overheadMs, 5, 'overhead is exactly dispatch->first-output (5ms)');
  });

  it('Test B (cold): a delayed first stdout yields a LARGE overheadMs, distinct from total latency', async () => {
    const clock = { now: 0 };
    const mock = makeMockWorkerStdio();
    const worker = workerWithClock('sonnet', 'You are a helpful assistant.', mock, clock);

    const p = worker.write('say OK'); // dispatchedAt = 0
    clock.now += 12_000; // cold CLI boot: first output gated ~12s
    mock.stdout.write(rawInitLine()); // firstOutputAt = 12_000
    clock.now += 800; // generation
    mock.stdout.write(rawResultLine());
    const out = await p;

    assert.equal(out.overheadMs, 12_000, 'cold overhead is the dispatch->first-output gap (~12s)');
    // total elapsed is 12_800; overhead must EXCLUDE the 800ms generation tail.
    assert.ok(out.overheadMs < 12_800, 'overhead excludes generation time (< total elapsed)');
  });

  it('Test C: overheadMs is measured to FIRST stdout, NOT the terminal result', async () => {
    const clock = { now: 100 };
    const mock = makeMockWorkerStdio();
    const worker = workerWithClock('sonnet', 'You are a helpful assistant.', mock, clock);

    const p = worker.write('say OK'); // dispatchedAt = 100
    clock.now += 30; // first output 30ms after dispatch
    mock.stdout.write(rawInitLine()); // firstOutputAt = 130
    mock.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 0, output_tokens: 2 } } }) + '\n');
    clock.now += 5_000; // long generation after first output
    mock.stdout.write(rawResultLine());
    const out = await p;

    assert.equal(out.overheadMs, 30, 'overhead is dispatch->first-output (30ms), not the 5030ms total');
    assert.ok(out.overheadMs < 5_000, 'overhead far below the total elapsed when generation follows first output');
  });
});

// Phase 66 Plan 05 — PERF-03 / SC-2: opt-in LLM_PROXY_WORKER_SPAWN_DELAY_MS seam.
//   A host-independent test affordance that injects an artificial delay squarely
//   INTO the spawn/queue overhead window (firstOutputAt - dispatchedAt), NOT into
//   model generation. The seam defers the prompt write (`_writeGuarded`) by
//   `_spawnDelayMs` AFTER `dispatchedAt` is stamped, so the worker only starts
//   producing stdout — and therefore firstOutputAt — that many ms later. Setting
//   it above the 5000ms dashboard red threshold inflates p50_overhead_ms past red
//   so SC-2 (regression -> red badge) can be exercised on any host. When unset/0
//   the dispatch path is byte-for-byte identical to today (synchronous write).
//
//   Determinism: the deferred write uses a SHORT real timer (a few ms) so the
//   unit suite never sleeps for seconds; the OVERHEAD MAGNITUDE is driven by the
//   injectable `_now` fake clock exactly like Test B (cold) above — we advance
//   the clock by N between the deferred write firing and the first stdout line,
//   asserting overheadMs >= N. The "no real sleep" rule (PLAN context) is honoured.
// ---------------------------------------------------------------------------

// Drain whatever the worker has written to its mock stdin so far (PassThrough is
// readable). Returns '' when nothing has been written yet — used to prove the
// prompt write is DEFERRED (delay>0) vs SYNCHRONOUS (delay==0/unset).
function readStdin(mock) {
  const chunk = mock.stdin.read();
  return chunk == null ? '' : chunk.toString();
}

describe('Worker pool — PERF-03 SC-2 spawn-delay seam (LLM_PROXY_WORKER_SPAWN_DELAY_MS)', () => {
  it('Test D (delay=N): the prompt write is DEFERRED and overheadMs >= N (delay lands in the overhead window)', async () => {
    const N = 6000; // above the 5000ms dashboard red threshold
    const clock = { now: 1_000_000 };
    const mock = makeMockWorkerStdio();
    // Use a SHORT real defer (deps.spawnDelayMs in *real* ms) so the timer fires
    // promptly; the OVERHEAD value is driven by advancing the fake clock by N.
    const worker = workerWithClock('sonnet', 'You are a helpful assistant.', mock, clock, { spawnDelayMs: 15 });

    const p = worker.write('say OK'); // _dispatch stamps dispatchedAt = 1_000_000
    // The seam must NOT write the prompt synchronously when a delay is configured.
    assert.equal(readStdin(mock), '', 'prompt write is deferred — stdin still empty right after dispatch');

    // Wait for the deferred-write timer to fire (real, but tiny: 15ms).
    await new Promise((res) => setTimeout(res, 40));
    assert.notEqual(readStdin(mock), '', 'prompt was written to stdin after the spawn delay elapsed');

    // The delay lands in the overhead window: advance the fake clock by N before
    // first output, simulating the worker starting to produce output only after
    // the injected delay. overheadMs (firstOutputAt - dispatchedAt) must be >= N.
    clock.now += N;
    mock.stdout.write(rawInitLine()); // FIRST stdout -> firstOutputAt = 1_000_000 + N
    clock.now += 900; // generation time (excluded from overhead)
    mock.stdout.write(rawResultLine());
    const out = await p;

    assert.equal(typeof out.overheadMs, 'number', 'completion carries a numeric overheadMs');
    assert.ok(out.overheadMs >= N, `spawn-delay inflates overheadMs >= ${N} (was ${out.overheadMs})`);
    assert.ok(out.overheadMs < N + 900, 'the delay lands in overhead, NOT generation time');
  });

  it('Test E (delay=0 default): the prompt write is SYNCHRONOUS and overhead is unchanged (small)', async () => {
    const clock = { now: 2_000_000 };
    const mock = makeMockWorkerStdio();
    const worker = workerWithClock('sonnet', 'You are a helpful assistant.', mock, clock); // no spawnDelayMs

    const p = worker.write('say OK'); // dispatchedAt = 2_000_000
    // Zero/unset delay: the write happens synchronously inside _dispatch, exactly
    // as before this seam existed — stdin already carries the envelope.
    assert.notEqual(readStdin(mock), '', 'delay=0 keeps the write synchronous (stdin written inside _dispatch)');

    clock.now += 5; // warm: first output 5ms later
    mock.stdout.write(rawInitLine());
    clock.now += 900;
    mock.stdout.write(rawResultLine());
    const out = await p;

    assert.equal(out.overheadMs, 5, 'delay=0 leaves the overhead window unchanged (5ms, byte-for-byte today)');
  });

  it('Test F (env fallback): LLM_PROXY_WORKER_SPAWN_DELAY_MS is honoured when deps.spawnDelayMs is absent', async () => {
    const prev = process.env.LLM_PROXY_WORKER_SPAWN_DELAY_MS;
    process.env.LLM_PROXY_WORKER_SPAWN_DELAY_MS = '15'; // short real defer for the test
    try {
      const clock = { now: 3_000_000 };
      const mock = makeMockWorkerStdio();
      // deps.spawnDelayMs deliberately ABSENT — the constructor must read the env.
      const worker = workerWithClock('sonnet', 'You are a helpful assistant.', mock, clock);

      const p = worker.write('say OK'); // dispatchedAt = 3_000_000
      assert.equal(readStdin(mock), '', 'env-configured delay also defers the write (stdin empty right after dispatch)');

      await new Promise((res) => setTimeout(res, 40));
      assert.notEqual(readStdin(mock), '', 'env-configured delay wrote the prompt after the delay elapsed');

      const N = 5500; // above red threshold, driven by the fake clock
      clock.now += N;
      mock.stdout.write(rawInitLine());
      clock.now += 300;
      mock.stdout.write(rawResultLine());
      const out = await p;

      assert.ok(out.overheadMs >= N, `env spawn-delay inflates overheadMs >= ${N} (was ${out.overheadMs})`);
    } finally {
      if (prev === undefined) delete process.env.LLM_PROXY_WORKER_SPAWN_DELAY_MS;
      else process.env.LLM_PROXY_WORKER_SPAWN_DELAY_MS = prev;
    }
  });

  it('Test G (clamp): negative / NaN spawnDelayMs clamps to 0 (synchronous write, no defer)', async () => {
    const clock = { now: 4_000_000 };
    const mock = makeMockWorkerStdio();
    const worker = workerWithClock('sonnet', 'You are a helpful assistant.', mock, clock, { spawnDelayMs: -250 });

    const p = worker.write('say OK');
    assert.notEqual(readStdin(mock), '', 'a negative delay clamps to 0 -> synchronous write (no defer)');

    clock.now += 3;
    mock.stdout.write(rawInitLine());
    clock.now += 50;
    mock.stdout.write(rawResultLine());
    const out = await p;

    assert.equal(out.overheadMs, 3, 'clamped-to-0 delay leaves overhead unchanged');
  });
});

// Microtask/IO flush helper: stderr PassThrough 'data' delivery is async, so let
// the event loop turn before asserting on the captured log lines.
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}
