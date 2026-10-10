/**
 * RED live integration suite for the Claude worker pool (Phase 62 — Worker Pool Core).
 *
 * Gated like tests/integration-bridge.test.mjs: the live describe-block runs ONLY
 * when explicitly requested. Two equivalent ways to request it:
 *   - direct run (mirrors the house analog): `node tests/integration/worker-pool-live.test.mjs --live`
 *   - via the node test runner (argv is NOT forwarded to the child, so use the env var):
 *     `LLM_PROXY_LIVE=1 node --test tests/integration/worker-pool-live.test.mjs`
 * NOTE: `node --test <file> --live` does NOT work — under the test runner each file
 * runs in a child process whose process.argv does not include trailing `--live`, so the
 * argv check silently falls through to mock/skip mode. Use a direct run OR the env var.
 * In DEFAULT (mock) mode the live block is skipped entirely, so CI without Max
 * OAuth + network is green (exit 0).
 *
 * This suite is RED under `--live` until Plans 02/03 implement
 * `../../proxy-bridge/worker-pool.mjs`. The `--live` path additionally requires:
 *   - Max OAuth via keychain (buildClaudeEnv strips API keys to force it)
 *   - network access to the Anthropic API
 *   - the installed `claude` CLI (2.1.170 at research time)
 *
 * Coverage (62-RESEARCH.md § Phase Requirements -> Test Map):
 *   - POOL-01  : persistent worker, stable .pid across >=2 sequential requests
 *   - POOL-04  : a direct-path (haiku) request never spawns a worker subprocess
 *   - GUARD-01 : LLM_PROXY_DISABLE_WORKER_POOL=1 -> execFile path, no spawn,
 *                response shape == baseline {content,model,tokens}
 *   - warm     : 2nd request wall-time < 3s after a warm-up (Pitfall 4 — cold
 *                excluded; formal gate is PERF-01/Phase 65)
 *
 * Phase 63 — `--live` lifecycle verification suite (this plan, 63-05). The four
 * ROADMAP success criteria proved against a real `claude -p` worker subprocess
 * via a `ps`-based `countClaudeWorkers()` helper and an `afterEach` teardown that
 * disposes the pool/worker and asserts zero orphaned workers (T-63-11):
 *   - SC-1 (WLIFE-01) : zero `claude -p` workers at start, exactly one after the
 *                       first sonnet fallback (lazy spawn — verify-only; closes
 *                       the Phase-62 PARTIAL cold-start probe gap, D-09).
 *   - SC-2 (WLIFE-02) : with a tiny injected idle window a worker disappears from
 *                       `ps` after idle, and the next same-key request respawns a
 *                       fresh worker (new pid) — Plan 63-01's idle timer end-to-end.
 *   - SC-3 (WLIFE-03) : killing a worker mid-request surfaces RETRYABLE, `ps`
 *                       sampling shows NO respawn-storm, and the next request lazily
 *                       respawns one fresh worker — Plans 63-02/63-03 end-to-end.
 *   - SC-4 (WLIFE-04) : aborting an in-flight request SIGTERMs+disposes the worker
 *                       (gone from `ps`) and the next same-key request spawns a NEW
 *                       pid — the Phase-62 cancel test that HUNG (62-HUMAN-UAT test
 *                       6) now PASSES instead of hanging (Plan 63-04's D-01).
 * This REPLACES the Phase-62 cancel-seam SAME-pid case: the D-01 SIGTERM+respawn
 * behaviour INVERTS the old same-pid-survives-the-interrupt expectation (the worker
 * is now SIGTERMed and the next request gets a NEW pid).
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// --- Run-mode header (mirror integration-bridge.test.mjs:35) ---
// Honor BOTH argv (direct run) and env vars (node --test runner strips trailing argv
// in the per-file child process, so argv-only gating is unreachable under `node --test`).
const LIVE = process.argv.includes('--live') || process.env.LLM_PROXY_LIVE === '1';
const SMOKE = process.argv.includes('--smoke') || process.env.LLM_PROXY_SMOKE === '1';
const MODE = LIVE ? 'live' : SMOKE ? 'smoke' : 'mock';

if (MODE !== 'live') {
  // Default/mock mode: live work requires Max OAuth + network. No-op so CI is green.
  describe('Worker pool — live integration (skipped without --live)', () => {
    it('is skipped in default mode (run directly with --live, or LLM_PROXY_LIVE=1 under node --test)', () => {
      assert.ok(true);
    });
  });
} else {
  describe('Worker pool — live integration (--live; requires Max OAuth + network)', () => {
    // RED until Plans 02/03 land proxy-bridge/worker-pool.mjs. Imported lazily
    // inside the live block so default mode never touches the missing module.
    let ClaudeWorker, WorkerPool;
    it('loads the worker module (RED until Plans 02/03)', async () => {
      ({ ClaudeWorker, WorkerPool } = await import('../../proxy-bridge/worker-pool.mjs'));
      assert.ok(ClaudeWorker && WorkerPool);
    });

    // --- Phase 63 (63-05): `ps`-based live worker-count helper + teardown ---

    /**
     * Count live `claude -p` worker subprocesses on the host process table.
     * The real worker subprocess is launched as
     *   `claude -p --input-format stream-json --output-format stream-json --verbose ... --model <m>`
     * (proxy-bridge/worker-pool.mjs:workerBootArgs), so a match on the literal
     * substring `claude -p` counts live worker subprocesses. We prefer `pgrep -f`
     * and fall back to `ps -ax` + a JS-side grep for portability; either way we
     * NEVER count the matcher's own process (pgrep does not return its own pid;
     * the ps fallback filters the literal `ps -ax` line and any helper invocation
     * so the matcher line itself is excluded — T-63-13: this is a coarse liveness
     * signal for a DEDICATED live-test run with no competing `claude -p` session).
     */
    function countClaudeWorkers() {
      const NEEDLE = 'claude -p';
      try {
        // pgrep -f matches the full command line; it never lists its own pid, and
        // an empty match exits non-zero (caught below -> 0). One pid per line.
        const out = execFileSync('pgrep', ['-f', NEEDLE], { encoding: 'utf8' });
        return out.split('\n').filter((l) => l.trim().length > 0).length;
      } catch (err) {
        // pgrep exit code 1 == "no matches" -> zero workers (not an error).
        if (err && err.status === 1) return 0;
        // pgrep missing/other failure -> ps fallback.
        try {
          const ps = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
          return ps
            .split('\n')
            .filter((line) => line.includes(NEEDLE))
            // Exclude the matcher itself: the `ps -ax` line and any grep/pgrep helper.
            .filter((line) => !/\bps\b\s+-ax/.test(line))
            .filter((line) => !/\b(pgrep|grep)\b/.test(line))
            .filter((line) => line.trim().length > 0).length;
        } catch {
          return 0;
        }
      }
    }

    const settle = (ms) => new Promise((r) => setTimeout(r, ms));

    // Per-case lifecycle handles a test may register so the shared teardown can
    // reap them even if the case throws mid-flight (T-63-11 resource exhaustion).
    let pool = null;
    let worker = null;

    // T-63-11 — dispose any pool/worker the case created AND assert no orphaned
    // `claude -p` worker survives the case. A leak fails LOUDLY here rather than
    // silently accumulating real subprocesses (RAM exhaustion) across runs.
    afterEach(async () => {
      try { pool?.disposeAll?.(); } catch { /* best-effort */ }
      try { worker?.dispose?.(); } catch { /* best-effort */ }
      pool = null;
      worker = null;
      // Give SIGTERM'd subprocesses a moment to leave the process table.
      await settle(750);
      assert.equal(
        countClaudeWorkers(),
        0,
        'teardown: no orphaned `claude -p` worker subprocess may survive a case',
      );
    });

    // SC-1 / WLIFE-01 — cold-start lazy spawn (verify-only; closes the Phase-62
    // PARTIAL cold-start probe gap, D-09). Zero `claude -p` workers before any
    // fallback request; exactly one after the first sonnet claude-code fallback.
    it('SC-1 WLIFE-01 cold-start: zero `claude -p` workers at start, exactly one after first sonnet fallback', async () => {
      // (1) Cold pool: no worker subprocess exists before any fallback request.
      assert.equal(countClaudeWorkers(), 0, 'cold start: zero workers before first fallback');

      pool = new WorkerPool();
      const body = { model: 'sonnet', messages: [{ role: 'user', content: 'say OK' }] };
      // The overflow function is only reached when all workers are busy at cap;
      // on a cold pool the FIRST request lazily spawns a real worker, so it is
      // never invoked here (asserted below). It exists so the pool never throws
      // on an unexpected overflow.
      let overflowCalled = false;
      const overflowFn = async () => {
        overflowCalled = true;
        return { content: 'OK', model: 'claude-sonnet-4-6', tokens: { input: 1, output: 1, total: 2 } };
      };

      // (2) One sonnet claude-code fallback request — lazily spawns the worker.
      const out = await pool.complete(body, undefined, overflowFn);
      assert.ok('content' in out && out.content && out.content.length > 0, 'fallback returned content');
      assert.equal(overflowCalled, false, 'cold start spawned a worker, did NOT route to overflow');

      // (3) Exactly one worker now exists — in `ps` and in the pool's key map.
      await settle(250);
      assert.equal(countClaudeWorkers(), 1, 'exactly one `claude -p` worker after the first fallback');
      const key = pool.keyFor(body);
      assert.equal(
        (pool.workersByKey.get(key) || []).length,
        1,
        'exactly one worker registered for the sonnet key',
      );
    });

    // POOL-01 — persistent worker reuse: stable PID across two sequential requests.
    it('POOL-01 stable-PID: same worker .pid serves two sequential requests', async () => {
      // Register on the module-level handle so the shared teardown reaps it via
      // dispose() (SIGTERM); cancel() does not terminate the subprocess.
      worker = new ClaudeWorker('sonnet', 'You are a helpful assistant.');
      const r1 = await worker.write('say OK');
      const pid1 = worker.pid;
      const r2 = await worker.write('say OK again');
      const pid2 = worker.pid;
      assert.equal(pid1, pid2, 'worker must NOT respawn between requests');
      assert.ok(r1.content && r1.content.length > 0);
      assert.ok(r2.content && r2.content.length > 0);
    });

    // POOL-04 — direct (haiku) path must not spawn a worker subprocess.
    it('POOL-04 no-spawn-on-direct: a haiku/direct request spawns zero workers', async () => {
      const pool = new WorkerPool();
      const body = { model: 'haiku', messages: [{ role: 'user', content: 'say OK' }] };
      const key = pool.keyFor(body);
      // The direct OAuth path handles haiku; the pool must remain disengaged.
      const workers = pool.workersByKey.get(key) || [];
      assert.equal(workers.length, 0, 'no worker may be spawned for the direct haiku path');
    });

    // GUARD-01 — escape hatch reverts to execFile; no spawn; baseline shape.
    it('GUARD-01 escape hatch: LLM_PROXY_DISABLE_WORKER_POOL=1 -> no worker spawned, baseline shape', async () => {
      const prev = process.env.LLM_PROXY_DISABLE_WORKER_POOL;
      process.env.LLM_PROXY_DISABLE_WORKER_POOL = '1';
      try {
        const pool = new WorkerPool();
        const body = { model: 'sonnet', messages: [{ role: 'user', content: 'say OK' }] };
        let overflowCalled = false;
        const overflowFn = async () => {
          overflowCalled = true;
          return { content: 'OK', model: 'claude-sonnet-4-6', tokens: { input: 1, output: 1, total: 2 } };
        };
        const out = await pool.complete(body, undefined, overflowFn);
        assert.ok(overflowCalled, 'disabled pool must route to the execFile overflow path');
        const key = pool.keyFor(body);
        assert.equal((pool.workersByKey.get(key) || []).length, 0, 'no worker spawned when disabled');
        assert.ok('content' in out && 'model' in out && 'tokens' in out, 'baseline {content,model,tokens} shape');
      } finally {
        if (prev === undefined) delete process.env.LLM_PROXY_DISABLE_WORKER_POOL;
        else process.env.LLM_PROXY_DISABLE_WORKER_POOL = prev;
      }
    });

    // SC-2 / WLIFE-02 — idle-evict: a worker idle past a TINY injected idle window
    // disappears from `ps`, and the next same-key request respawns a fresh worker
    // (new pid). Exercises Plan 63-01's idle timer end-to-end against a real CLI.
    it('SC-2 WLIFE-02 idle-evict: worker disappears from ps after idle window, respawns fresh on next request', async () => {
      const IDLE_MS = 1500; // tiny injected window — seconds, not 30 min (deps.idleMs seam, Plan 01)
      // First worker: drive one request to spawn it, capture its pid.
      const w1 = new ClaudeWorker('sonnet', 'You are a helpful assistant.', { idleMs: IDLE_MS });
      worker = w1; // register for teardown in case of mid-case failure
      const r1 = await w1.write('say OK');
      assert.ok(r1.content && r1.content.length > 0, 'first request returned content');
      const pidBefore = w1.pid;
      await settle(250);
      assert.equal(countClaudeWorkers(), 1, 'exactly one worker after the first request');

      // Wait past the idle window: the idle timer disposes -> SIGTERM -> 'exit'.
      await settle(IDLE_MS + 1000);
      assert.equal(countClaudeWorkers(), 0, 'worker gone from ps after the idle window elapsed');

      // Next same-(model×prompt) request lazily respawns a FRESH worker (new pid).
      const w2 = new ClaudeWorker('sonnet', 'You are a helpful assistant.', { idleMs: IDLE_MS });
      worker = w2; // the live handle the teardown must reap is now w2
      const r2 = await w2.write('say OK again');
      assert.ok(r2.content && r2.content.length > 0, 'respawned request returned content');
      assert.notEqual(w2.pid, pidBefore, 'respawn produced a NEW pid (fresh cold worker)');
      await settle(250);
      assert.equal(countClaudeWorkers(), 1, 'exactly one (fresh) worker after respawn');
    });

    // SC-3 / WLIFE-03 — crash: killing a worker subprocess mid-request surfaces the
    // in-flight request as RETRYABLE; `ps` sampling shows NO respawn-storm (no tight
    // spawn->crash loop — respawn is lazy-on-next-request only, D-06); the next
    // request lazily respawns ONE fresh worker. Exercises Plans 63-02/63-03.
    it('SC-3 WLIFE-03 crash: kill worker mid-request -> RETRYABLE, no respawn-storm, lazy respawn on next request', async () => {
      const w1 = new ClaudeWorker('sonnet', 'You are a helpful assistant.');
      worker = w1; // register for teardown
      // Start a longer in-flight request so we can kill mid-stream.
      const inflight = w1.write('count slowly to one hundred, one number per line');
      // Let the request genuinely start against the real stream, then SIGKILL the
      // subprocess by the pid read DIRECTLY from the just-spawned worker handle
      // (T-63-12: no stale/stored pid is signaled).
      await settle(1200);
      assert.equal(countClaudeWorkers(), 1, 'exactly one worker is live before the kill');
      const killedPid = w1.pid;
      process.kill(killedPid, 'SIGKILL');

      // The in-flight promise rejects RETRYABLE (the _onExit reap, Plan 02).
      await assert.rejects(
        inflight,
        (e) => e && e.retryable === true && e.code === 'WORKER_RETRYABLE',
        'in-flight request rejects RETRYABLE on worker crash',
      );

      // No respawn-storm: sample `ps` over a short window WITHOUT issuing a new
      // request. The count must never exceed 1 (the killed worker, reaping) and
      // settle to 0 — the worker is NOT auto-restarted in a tight loop (D-06).
      let maxSeen = 0;
      for (let i = 0; i < 6; i++) {
        maxSeen = Math.max(maxSeen, countClaudeWorkers());
        await settle(250);
      }
      assert.ok(maxSeen <= 1, `no respawn-storm: at most 1 worker during reap window (saw ${maxSeen})`);
      assert.equal(countClaudeWorkers(), 0, 'crashed worker reaped, no auto-restart');

      // Lazy respawn: ONE new same-key request spawns exactly one fresh worker.
      const w2 = new ClaudeWorker('sonnet', 'You are a helpful assistant.');
      worker = w2; // the live handle the teardown must reap is now w2
      const r2 = await w2.write('say OK');
      assert.ok(r2.content && r2.content.length > 0, 'lazy respawn returned content');
      assert.notEqual(w2.pid, killedPid, 'lazy respawn produced a NEW pid');
      await settle(250);
      assert.equal(countClaudeWorkers(), 1, 'exactly one fresh worker after lazy respawn');
    });

    // ===================================================================
    // Phase 65 — FORMAL acceptance cases (PERF-02 / SC-3 / SC-4 bound + baseline).
    // These ADD the milestone acceptance assertions on top of the Phase-62/63 live
    // mechanisms; NO production worker-pool.mjs change. All reuse countClaudeWorkers()
    // and register their live handle on the module-level pool/worker teardown handle.
    // ===================================================================

    // PERF-02 / SC-2 — crash SURVIVAL acceptance (D-04/D-05). The acceptance DELTA
    // over the Phase-63 SC-3 crash case (which proved the in-flight rejects
    // RETRYABLE + no respawn-storm): here we prove the NEXT same-key request is
    // actually SERVED and returns a VALID non-empty completion from a NEW pid.
    it('PERF-02 SC-2 crash-survival: SIGKILL a worker pid, next same-key request returns a VALID completion from a NEW pid', async () => {
      pool = new WorkerPool();
      const body = { model: 'sonnet', messages: [{ role: 'user', content: 'say OK' }] };
      const overflowFn = async () => ({ content: 'OK', model: 'claude-sonnet-4-6', tokens: { input: 1, output: 1, total: 2 } });

      // (1) Lazily spawn a worker for the key with one fallback request.
      const r1 = await pool.complete(body, undefined, overflowFn);
      assert.ok('content' in r1 && r1.content && r1.content.length > 0, 'initial fallback returned content');
      const key = pool.keyFor(body);
      // Read pidBefore DIRECTLY off the live handle (T-63-12 — never a stored/stale pid).
      const liveBefore = pool.workersByKey.get(key) || [];
      assert.equal(liveBefore.length, 1, 'exactly one worker registered for the key before the kill');
      const pidBefore = liveBefore[0].pid;
      await settle(250);
      assert.equal(countClaudeWorkers(), 1, 'exactly one live worker before the kill');

      // (2) SIGKILL the worker subprocess by the pid read off the live handle.
      process.kill(pidBefore, 'SIGKILL');

      // No respawn-storm during the reap window (consistent with the Phase-63 crash
      // case): sample without issuing a new request — the count must never exceed 1.
      let maxSeen = 0;
      for (let i = 0; i < 4; i++) {
        maxSeen = Math.max(maxSeen, countClaudeWorkers());
        await settle(250);
      }
      assert.ok(maxSeen <= 1, `no respawn-storm during reap window (saw ${maxSeen})`);

      // (3) ACCEPTANCE DELTA: the NEXT same-(model×prompt) request is SERVED and
      // returns a VALID non-empty completion from a NEW pid (lazy respawn).
      const r2 = await pool.complete(body, undefined, overflowFn);
      assert.ok('content' in r2 && r2.content.length > 0, 'post-crash request returned a VALID non-empty completion');
      const liveAfter = pool.workersByKey.get(key) || [];
      assert.equal(liveAfter.length, 1, 'exactly one worker registered after the post-crash request');
      assert.notEqual(liveAfter[0].pid, pidBefore, 'post-crash completion served by a NEW pid (not the SIGKILLed one)');
      await settle(250);
      assert.equal(countClaudeWorkers(), 1, 'exactly one (fresh) worker in ps after the post-crash request');
    });

    // SC-3 — idle-evict BOUND acceptance (D-06). Reuses the Phase-63 SC-2 idle
    // mechanics (the tiny injected deps.idleMs window — NO new idle mechanism) and
    // frames the acceptance bound: gone-from-ps after the idle window, then a fresh
    // same-key request respawns a NEW pid WITHIN a single bounded settle (not an
    // open-ended poll).
    it('SC-3 idle-evict bound: worker gone from ps after idle window, fresh request respawns a NEW pid within bound', async () => {
      const IDLE_MS = 1500; // tiny injected window (deps.idleMs seam, Plan 63-01) — seconds, not 30 min
      const sys = 'You are a helpful assistant.';
      // (1) Spawn a worker with the tiny idle window; capture its pid.
      const w1 = new ClaudeWorker('sonnet', sys, { idleMs: IDLE_MS });
      worker = w1; // register for teardown
      const r1 = await w1.write('say OK');
      assert.ok(r1.content && r1.content.length > 0, 'first request returned content');
      const pidBefore = w1.pid;
      await settle(250);
      assert.equal(countClaudeWorkers(), 1, 'exactly one worker after the first request');

      // (2) Wait past the idle window: the idle timer disposes -> SIGTERM -> exit.
      await settle(IDLE_MS + 1000);
      assert.equal(countClaudeWorkers(), 0, 'worker gone from ps after the idle window elapsed');

      // (3) Fresh same-key request respawns a NEW pid WITHIN a single bounded settle.
      const w2 = new ClaudeWorker('sonnet', sys, { idleMs: IDLE_MS });
      worker = w2; // the live handle the teardown must reap is now w2
      const r2 = await w2.write('say OK again');
      assert.ok(r2.content && r2.content.length > 0, 'respawned request returned content');
      assert.notEqual(w2.pid, pidBefore, 'respawn produced a NEW pid (fresh cold worker)');
      await settle(250); // single bounded settle — NOT an open-ended poll (D-06 bound)
      assert.equal(countClaudeWorkers(), 1, 'exactly one (fresh) worker after the bounded respawn');
    });

    // SC-4 — escape-hatch acceptance (D-07). EXTENDS the GUARD-01 case: with
    // LLM_PROXY_DISABLE_WORKER_POOL=1 the request routes through the execFile
    // overflow, asserts countClaudeWorkers() === 0 (the ps-level check D-07 adds on
    // top of the GUARD-01 workersByKey check) AND records the restored baseline
    // execFile per-call latency (a single observed sample; baseline is "the slow
    // path is back" — NOT a tight upper bound, so NO upper-bound assertion). The
    // env var is saved/restored in a try/finally exactly as GUARD-01 does.
    it('SC-4 escape hatch: LLM_PROXY_DISABLE_WORKER_POOL=1 -> zero workers in ps AND restored baseline execFile latency', async () => {
      const prev = process.env.LLM_PROXY_DISABLE_WORKER_POOL;
      process.env.LLM_PROXY_DISABLE_WORKER_POOL = '1';
      try {
        const p = new WorkerPool();
        pool = p; // register for teardown
        const body = { model: 'sonnet', messages: [{ role: 'user', content: 'say OK' }] };
        let overflowCalled = false;
        const overflowFn = async () => {
          overflowCalled = true;
          return { content: 'OK', model: 'claude-sonnet-4-6', tokens: { input: 1, output: 1, total: 2 } };
        };
        // Time a single complete() call so the restored baseline execFile latency is
        // OBSERVED and recorded (no upper bound asserted — D-07).
        const t0 = Date.now();
        const out = await p.complete(body, undefined, overflowFn);
        const baselineMs = Date.now() - t0;
        assert.ok(overflowCalled, 'disabled pool must route to the execFile overflow path');
        assert.ok('content' in out && 'model' in out && 'tokens' in out, 'baseline {content,model,tokens} shape');
        const key = p.keyFor(body);
        assert.equal((p.workersByKey.get(key) || []).length, 0, 'no worker registered for the key when disabled');
        await settle(250);
        // D-07 ps-level check on top of the GUARD-01 workersByKey check.
        assert.equal(countClaudeWorkers(), 0, `escape hatch: zero claude -p workers in ps when disabled (baseline execFile latency=${baselineMs}ms)`);
      } finally {
        if (prev === undefined) delete process.env.LLM_PROXY_DISABLE_WORKER_POOL;
        else process.env.LLM_PROXY_DISABLE_WORKER_POOL = prev;
      }
    });

    // SC-4 / WLIFE-04 — cancel: aborting an in-flight request through the REAL
    // abort path (controller.abort() -> WorkerPool _disposeAndDrop, Plan 04 D-01)
    // SIGTERMs+disposes the worker (gone from `ps`) and the next same-key request
    // spawns a NEW pid. This is the LIVE inverse of the Phase-62 cancel-seam case
    // (62-HUMAN-UAT test 6) that HUNG: it must PASS, not hang. We drive the cancel
    // via the abort signal — NEVER `worker.cancel()` (the dead protocol interrupt).
    it('SC-4 WLIFE-04 cancel: abort in-flight -> worker SIGTERMed+gone from ps, next request spawns NEW pid (Phase-62 hang now passes)', async () => {
      pool = new WorkerPool();
      const body = { model: 'sonnet', messages: [{ role: 'user', content: 'count slowly to one hundred, one number per line' }] };
      const overflowFn = async () => ({ content: 'OK', model: 'claude-sonnet-4-6', tokens: { input: 1, output: 1, total: 2 } });

      // Start the in-flight request WITHOUT awaiting it; abort drives the cancel.
      const controller = new AbortController();
      const inflight = pool.complete(body, controller.signal, overflowFn);
      // Swallow the eventual rejection so an unhandled rejection never trips the
      // suite; we assert on the BOUNDED settle below, not on this catch.
      inflight.catch(() => {});

      // Let the request genuinely start against the real stream.
      await settle(1500);
      const key = pool.keyFor(body);
      const workersForKey = pool.workersByKey.get(key) || [];
      assert.equal(workersForKey.length, 1, 'one worker is in-flight for the key before abort');
      const pidBefore = workersForKey[0].pid;
      assert.equal(countClaudeWorkers(), 1, 'exactly one live worker before abort');

      // Drive the cancel through the REAL abort path (NOT worker.cancel()).
      controller.abort();

      // (a) The aborted `complete` settles PROMPTLY — it must NOT hang. A regression
      // to the Phase-62 protocol-interrupt hang FAILS this case (bounded race)
      // instead of hanging the whole suite.
      const TIMEOUT_MS = 10_000;
      let timer;
      const guard = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`SC-4 regression: aborted complete() did not settle within ${TIMEOUT_MS}ms (Phase-62 hang)`)),
          TIMEOUT_MS,
        );
      });
      try {
        // inflight rejects RETRYABLE on the SIGTERM reap; either settle (resolve or
        // reject) is acceptable — what matters is it does NOT hang past the guard.
        await Promise.race([inflight.catch(() => 'settled'), guard]);
      } finally {
        clearTimeout(timer);
      }

      // (b) The worker is SIGTERMed and GONE: not in `ps`, not in the key's array.
      await settle(750);
      assert.equal(countClaudeWorkers(), 0, 'aborted worker is SIGTERMed and gone from ps');
      const afterWorkers = pool.workersByKey.get(key) || [];
      assert.ok(
        !afterWorkers.some((w) => w.pid === pidBefore),
        'the SIGTERMed worker (pidBefore) is dropped from the key (D-01 dispose+drop)',
      );

      // (c) Next same-key request cold-respawns a NEW pid (D-01 guarantee).
      const out = await pool.complete(body, undefined, overflowFn);
      assert.ok('content' in out && out.content && out.content.length > 0, 'respawned request returned content');
      await settle(250);
      assert.equal(countClaudeWorkers(), 1, 'exactly one fresh worker after respawn');
      const respawned = pool.workersByKey.get(key) || [];
      assert.equal(respawned.length, 1, 'exactly one worker registered after respawn');
      assert.notEqual(respawned[0].pid, pidBefore, 'cold respawn produced a NEW pid (worker did not survive the abort)');
    });

    // PERF-01 / SC-1 — FORMAL steady-state warm-latency gate (D-01..D-03). Replaces
    // the informal single-sample warm-sanity case the Phase-63 suite explicitly
    // deferred as the not-yet-formal warm probe. Warm the prompt cache
    // (cold spawn EXCLUDED, Pitfall 4), then measure N>=5 SEQUENTIAL identical
    // `say OK` turns on the SAME warm worker and assert the MEDIAN wall-time
    // <=3000ms as a HARD gate (D-03 honest hard gate — NOT downgraded to a
    // warning; a miss is the expected honest RED that hands off to a separate
    // optimization phase, NOT relaxed here). max is also recorded in the message.
    it('PERF-01 SC-1 steady-state warm latency: median of N>=5 warm `say OK` requests <=3000ms (cache-hit confirmed)', async () => {
      // Register on the module-level handle so the shared teardown reaps it via
      // dispose() (SIGTERM) — the non-terminating cancel() seam would leave the
      // subprocess alive and trip the teardown's zero-orphans assertion.
      worker = new ClaudeWorker('sonnet', 'You are a helpful assistant.');

      // (1) Warm-up: exclude the cold spawn from the measured steady-state turns
      // (Pitfall 4). The warm-up wall-time is NOT counted.
      await worker.write('say OK');
      const warmPid = worker.pid; // the warm pid all measured turns must reuse

      // (2) Measure N>=5 sequential identical turns on the SAME warm worker.
      const N = 5;
      const samples = [];
      const inputTokens = [];
      for (let i = 0; i < N; i++) {
        const t0 = Date.now();
        const out = await worker.write('say OK');
        samples.push(Date.now() - t0);
        // D-02 cache-presence: the worker does NOT surface a dedicated
        // `cacheReadInputTokens` split on the completion (it is folded into the
        // SUMMED `tokens.input` = input + cacheRead + cacheCreation via
        // inputTokensFromEvent/toCompletion, worker-pool.mjs:191-231) and emits no
        // 'result' event carrying the raw modelUsage. Surfacing the split would be
        // an OUT-OF-SCOPE production worker-pool.mjs change for this verify-only
        // phase, so the in-scope cache-presence signal is the summed-input floor +
        // the recorded value (a genuine warm turn re-reads the cached prompt, so
        // input is in the hundreds/thousands; a degenerate ~1 = NOT cache-hitting).
        inputTokens.push(out.tokens.input);
        // The warm worker must NOT respawn across the measured turns (stable pid).
        assert.equal(worker.pid, warmPid, `worker pid must be stable across the measured warm turns (turn ${i})`);
      }

      // (3) Steady-state statistic: assert the MEDIAN <=3000ms (PERF-01 bar) as a
      // HARD gate; record median + max + the per-turn samples in the message so
      // the operator can transcribe the numbers even on a FAIL.
      const sorted = [...samples].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const max = Math.max(...samples);
      const minInput = Math.min(...inputTokens);
      // D-02: confirm the measured turns were served off the cached prompt — the
      // summed input-token figure must clear a conservative context floor.
      assert.ok(
        minInput > 50,
        `cache-presence (D-02): every measured warm turn must re-read the cached prompt — summed tokens.input must clear the context floor (min input=${minInput}, per-turn=${JSON.stringify(inputTokens)})`,
      );
      // D-03 honest HARD gate — assert.ok, NOT a console warning, so the suite goes
      // RED on a miss (the last informal run was 3.9s). The bar is NOT relaxed.
      assert.ok(
        median <= 3000,
        `PERF-01 steady-state warm latency: median=${median}ms max=${max}ms samples=${JSON.stringify(samples)} cacheInputMin=${minInput} (expected median <=3000ms)`,
      );
    });
  });
}
