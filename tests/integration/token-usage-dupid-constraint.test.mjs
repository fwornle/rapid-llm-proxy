/**
 * Phase 83-02 Task 2 (D-11) — duplicate-id constraint / coordinated allocation.
 *
 * Proves, against the SHIPPED compiled code (../../dist/token-usage.js — run
 * AFTER `npm run build`), the D-11 fix for the tap-writer vs adapter-writer id
 * collision:
 *
 *   Test 1 — the migration is idempotent: initTokenDb on the SAME DB twice
 *            builds the request-id dedup index once and the second open is a
 *            no-op (no throw, index still present, schema identical).
 *   Test 2 — two INSERTs that would previously collide on (user_hash, id) for
 *            the SAME user_hash both survive: a pre-existing adapter row at
 *            id=1 under 'cladpt' no longer shadows a proxy-tap logCall for a
 *            DISTINCT request under the same hash — the coordinated allocator
 *            gives it a fresh id.
 *   Test 3 — a genuine duplicate (same user_hash, same tool_call_id) is still
 *            deduped: a second logCall for the same request-id does not
 *            double-count.
 *
 * Pure local SQLite (no live network), so nothing is gated on LLM_PROXY_LIVE.
 * Each test isolates its DB via the LLM_PROXY_TOKEN_DB_PATH env seam. Built-in
 * node:test + node:assert/strict only; no external test deps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { initTokenDb, logCall } from '../../dist/token-usage.js';

const REQID_INDEX = 'idx_token_usage_reqid';

function freshDbPath(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tu-dupid-${label}-`));
  return path.join(dir, 'token-usage.db');
}

function resetEnv() {
  delete process.env.LLM_PROXY_TOKEN_DB_PATH;
  delete process.env.LLM_PROXY_DATA_DIR;
  delete process.env.LLM_PROXY_TOKEN_EXPORT_DIR;
}

/** Minimal valid TokenUsageRow. */
function baseRow(overrides = {}) {
  return {
    timestamp: new Date().toISOString(),
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    process: 'unknown',
    subscription: 'max-oauth-passthrough',
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    latency_ms: 100,
    prompt_preview: '',
    tokens_estimated: 0,
    ...overrides,
  };
}

function indexNames(handle) {
  return handle.db
    .prepare(`PRAGMA index_list(token_usage)`)
    .all()
    .map((i) => i.name)
    .sort();
}

test('(1) migration builds the request-id dedup index once; re-open is idempotent', () => {
  resetEnv();
  const dbPath = freshDbPath('idem');
  process.env.LLM_PROXY_TOKEN_DB_PATH = dbPath;
  try {
    const h1 = initTokenDb();
    const idx1 = indexNames(h1);
    assert.ok(idx1.includes(REQID_INDEX), `first init should build ${REQID_INDEX}`);
    h1.db.close();

    // Second open on the SAME file — must not throw and must be a no-op.
    const h2 = initTokenDb();
    const idx2 = indexNames(h2);
    assert.ok(idx2.includes(REQID_INDEX), `re-open should retain ${REQID_INDEX}`);
    assert.deepEqual(idx2, idx1, 'index set identical across re-open (idempotent)');
    h2.db.close();
  } finally {
    resetEnv();
  }
});

test('(2) an actual (user_hash, id) PK collision is retried; the distinct row survives', () => {
  resetEnv();
  const dbPath = freshDbPath('collide');
  process.env.LLM_PROXY_TOKEN_DB_PATH = dbPath;
  try {
    const h = initTokenDb();
    // Discover the machine USER_HASH the module resolved at import (default
    // 'unknown' in this test env). logCall with NO user_hash override lands here
    // and takes the FAST in-process-counter path — the exact path where a stale
    // counter historically collided with a row inserted by another connection.
    const seed = h.db
      .prepare(`INSERT INTO token_usage (id, timestamp, provider, model, tool_call_id) VALUES (?, ?, ?, ?, ?)`);
    // The fresh DB seeded the local id counter to 1. Occupy (USER_HASH, id=1)
    // directly so the cached counter is now STALE — logCall's first attempt
    // (nextLocalId()=1) will collide on the composite PK, which SQLite reports as
    // SQLITE_CONSTRAINT_UNIQUE (NOT _PRIMARYKEY). Under the pre-fix code that was
    // mistaken for a request-id dedup and the distinct row was DROPPED.
    seed.run(1, new Date().toISOString(), 'anthropic', 'claude', 'seed-A'); // user_hash defaults to USER_HASH

    // A DISTINCT row (different request-id) that first tries the now-taken id=1.
    logCall(h, baseRow({ tool_call_id: 'seed-B' })); // user_hash omitted → USER_HASH

    const userHash = h.db
      .prepare(`SELECT user_hash FROM token_usage WHERE tool_call_id = 'seed-A'`)
      .get().user_hash;
    const rows = h.db
      .prepare(`SELECT id, tool_call_id FROM token_usage WHERE user_hash = ? ORDER BY id`)
      .all(userHash);
    assert.equal(rows.length, 2, 'the id collision was retried — both distinct rows survive');
    assert.equal(new Set(rows.map((r) => r.id)).size, 2, 'the two rows carry DISTINCT ids');
    assert.deepEqual(rows.map((r) => r.tool_call_id).sort(), ['seed-A', 'seed-B']);

    // And a DISTINCT row under a separate ADAPTER hash also survives (DB-authoritative
    // allocation from the row's own hash space, not the machine counter).
    logCall(h, baseRow({ user_hash: 'cladpt', tool_call_id: 'req-A' }));
    logCall(h, baseRow({ user_hash: 'cladpt', tool_call_id: 'req-B' }));
    const adapterRows = h.db
      .prepare(`SELECT id FROM token_usage WHERE user_hash = 'cladpt' ORDER BY id`)
      .all();
    assert.equal(adapterRows.length, 2, 'two distinct adapter-hash rows both survive');
    assert.equal(new Set(adapterRows.map((r) => r.id)).size, 2, 'distinct ids');
    h.db.close();
  } finally {
    resetEnv();
  }
});

test('(3) a genuine (user_hash, tool_call_id) duplicate is still deduped', () => {
  resetEnv();
  const dbPath = freshDbPath('dedup');
  process.env.LLM_PROXY_TOKEN_DB_PATH = dbPath;
  try {
    const h = initTokenDb();
    logCall(h, baseRow({ user_hash: 'cladpt', tool_call_id: 'req-C' }));
    // Exact same request-id under the same hash → genuine duplicate.
    logCall(h, baseRow({ user_hash: 'cladpt', tool_call_id: 'req-C', output_tokens: 999 }));

    const n = h.db
      .prepare(
        `SELECT COUNT(*) AS c FROM token_usage WHERE user_hash = 'cladpt' AND tool_call_id = 'req-C'`
      )
      .get().c;
    assert.equal(n, 1, 'the genuine duplicate must not double-count');

    // An EMPTY tool_call_id is NOT an identity — such rows must NOT be deduped.
    logCall(h, baseRow({ user_hash: 'cladpt', tool_call_id: '' }));
    logCall(h, baseRow({ user_hash: 'cladpt', tool_call_id: '' }));
    const empties = h.db
      .prepare(`SELECT COUNT(*) AS c FROM token_usage WHERE user_hash = 'cladpt' AND tool_call_id = ''`)
      .get().c;
    assert.equal(empties, 2, 'empty-request-id rows are never deduped');
    h.db.close();
  } finally {
    resetEnv();
  }
});

test('(4) WR-03: a dedup hit on a cache-less row merges the richer duplicate cache/reasoning in place', () => {
  resetEnv();
  const dbPath = freshDbPath('merge');
  process.env.LLM_PROXY_TOKEN_DB_PATH = dbPath;
  try {
    const h = initTokenDb();
    // A stop-time transcript row lands FIRST (proxy restart mid-session):
    // cache-less, no reasoning.
    logCall(h, baseRow({ user_hash: 'cladpt', tool_call_id: 'req-M' }));
    // The tap write arrives LATER with the real cache split + reasoning. Pre-fix
    // it was silently discarded (first-writer-wins); it must now ENRICH the
    // existing row in place — mirroring the coding-side insertTokenRowDeduped.
    logCall(h, baseRow({
      user_hash: 'cladpt',
      tool_call_id: 'req-M',
      cache_read_tokens: 111,
      cache_write_tokens: 222,
      reasoning_tokens: 33,
    }));

    const merged = h.db
      .prepare(
        `SELECT COUNT(*) AS c,
                MAX(cache_read_tokens) AS cr, MAX(cache_write_tokens) AS cw,
                MAX(reasoning_tokens) AS rt
           FROM token_usage WHERE user_hash = 'cladpt' AND tool_call_id = 'req-M'`
      )
      .get();
    assert.equal(merged.c, 1, 'still exactly ONE row (never double-counts)');
    assert.equal(merged.cr, 111, 'cache_read merged into the cache-less existing row');
    assert.equal(merged.cw, 222, 'cache_write merged');
    assert.equal(merged.rt, 33, 'reasoning merged (MAX)');

    // An ALREADY-CACHED existing row is authoritative — a later duplicate must
    // NOT overwrite it (overwrite-once, never additive).
    logCall(h, baseRow({ user_hash: 'cladpt', tool_call_id: 'req-N', cache_read_tokens: 500 }));
    logCall(h, baseRow({ user_hash: 'cladpt', tool_call_id: 'req-N', cache_read_tokens: 7, cache_write_tokens: 7 }));
    const kept = h.db
      .prepare(
        `SELECT COUNT(*) AS c, MAX(cache_read_tokens) AS cr, MAX(cache_write_tokens) AS cw
           FROM token_usage WHERE user_hash = 'cladpt' AND tool_call_id = 'req-N'`
      )
      .get();
    assert.equal(kept.c, 1);
    assert.equal(kept.cr, 500, 'already-cached row never overwritten');
    assert.equal(kept.cw, 0);
    h.db.close();
  } finally {
    resetEnv();
  }
});

test('(5) WR-04: the one-shot dup repair gap-fills the survivor before deleting the cache-bearing duplicate', () => {
  resetEnv();
  const dbPath = freshDbPath('repair-merge');
  process.env.LLM_PROXY_TOKEN_DB_PATH = dbPath;
  try {
    // (a) Build a LEGACY-shaped DB: init once (creates schema + index), then
    //     drop the index and seed a duplicate pair the pre-index era allowed —
    //     earliest rowid cache-LESS (transcript-first), later rowid carrying
    //     the real cache split + reasoning (the tap row).
    const h1 = initTokenDb();
    h1.db.exec(`DROP INDEX ${REQID_INDEX}`);
    const seed = h1.db.prepare(`
      INSERT INTO token_usage (id, timestamp, provider, model, user_hash, tool_call_id,
                               cache_read_tokens, cache_write_tokens, reasoning_tokens)
      VALUES (?, ?, 'anthropic', 'claude', 'cladpt', 'req-legacy-dup', ?, ?, ?)
    `);
    seed.run(101, new Date().toISOString(), 0, 0, 0);      // survivor (earliest rowid, cache-less)
    seed.run(102, new Date().toISOString(), 314, 42, 27);  // doomed duplicate (cache-bearing)
    h1.db.close();

    // (b) Re-open: index absent → the one-shot repair runs. Pre-fix the DELETE
    //     unconditionally destroyed the cache split on the later rowid.
    const h2 = initTokenDb();
    const rows = h2.db
      .prepare(`SELECT id, cache_read_tokens, cache_write_tokens, reasoning_tokens
                  FROM token_usage WHERE user_hash = 'cladpt' AND tool_call_id = 'req-legacy-dup'`)
      .all();
    assert.equal(rows.length, 1, 'duplicates collapsed to the single earliest-rowid survivor');
    assert.equal(rows[0].id, 101, 'the earliest rowid survives (reconcile-matcher preference)');
    assert.equal(rows[0].cache_read_tokens, 314, 'cache split gap-filled from the doomed duplicate');
    assert.equal(rows[0].cache_write_tokens, 42);
    assert.equal(rows[0].reasoning_tokens, 27, 'reasoning gap-filled (MAX across the group)');
    assert.ok(indexNames(h2).includes(REQID_INDEX), 'index rebuilt after the repair');
    h2.db.close();
  } finally {
    resetEnv();
  }
});

test('(6) WR-08: the machine-hash id counter resyncs after a collision retry', () => {
  resetEnv();
  const dbPath = freshDbPath('resync');
  process.env.LLM_PROXY_TOKEN_DB_PATH = dbPath;
  try {
    const h = initTokenDb(); // fresh DB → _localIdSeq = 1
    // Occupy (USER_HASH, id=1) behind the counter's back (test (2) pattern) so
    // logCall's fast attempt-0 (nextLocalId()=1) collides and the retry
    // allocates id=2 straight from the DB.
    h.db
      .prepare(`INSERT INTO token_usage (id, timestamp, provider, model, tool_call_id) VALUES (?, ?, 'anthropic', 'claude', 'resync-A')`)
      .run(1, new Date().toISOString());
    logCall(h, baseRow({ tool_call_id: 'resync-B' })); // machine hash, collides then retries → id=2

    // Pre-fix the counter stayed permanently behind (next would be 2 — already
    // taken, so EVERY future machine-hash insert paid a failed INSERT + probe).
    // Post-fix bumpLocalId resynced it past the DB-allocated id.
    assert.equal(h.nextLocalId(), 3, 'counter resynced to MAX(id)+1 after the DB-authoritative retry');
    h.db.close();
  } finally {
    resetEnv();
  }
});
