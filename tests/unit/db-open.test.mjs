// proxy-bridge/db-open.cjs — the same calls behave the same on better-sqlite3
// and on node:sqlite (glass G1 / WP2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDb, sqliteBackend } = require('../../proxy-bridge/db-open.cjs');

function withBackend(backend, fn) {
  const prev = process.env.CODING_SQLITE_BACKEND;
  process.env.CODING_SQLITE_BACKEND = backend;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.CODING_SQLITE_BACKEND;
    else process.env.CODING_SQLITE_BACKEND = prev;
  }
}

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-open-')), 't.db');

test('default backend is better-sqlite3 where it resolves', () => {
  const prev = process.env.CODING_SQLITE_BACKEND;
  delete process.env.CODING_SQLITE_BACKEND;
  try { assert.equal(sqliteBackend(import.meta.url), 'better'); } finally {
    if (prev !== undefined) process.env.CODING_SQLITE_BACKEND = prev;
  }
});

for (const backend of ['better', 'node']) {
  test(`${backend}: prepare/run/get/all, changes, WAL pragma`, () => withBackend(backend, () => {
    const db = openDb(tmpDb());
    db.pragma('journal_mode = WAL');
    assert.equal(db.pragma('journal_mode')[0].journal_mode, 'wal');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
    assert.equal(ins.run('a').changes, 1);
    ins.run('b');
    assert.equal(db.prepare('SELECT v FROM t WHERE id = ?').get(2).v, 'b');
    assert.equal(db.prepare('SELECT v FROM t WHERE id = ?').get(9), undefined);
    assert.deepEqual(db.prepare('SELECT v FROM t ORDER BY id').all().map((r) => r.v), ['a', 'b']);
    db.close();
  }));

  test(`${backend}: constraint errors carry better-sqlite3's error code`, () => withBackend(backend, () => {
    const db = openDb(tmpDb());
    db.exec('CREATE TABLE t (a INTEGER, b INTEGER, PRIMARY KEY (a, b))');
    db.exec('CREATE UNIQUE INDEX u ON t (b) WHERE b > 100');
    const ins = db.prepare('INSERT INTO t VALUES (?, ?)');
    ins.run(1, 1);
    assert.throws(() => ins.run(1, 1), (e) => e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY');
    ins.run(1, 101);
    assert.throws(() => ins.run(2, 101), (e) => e.code === 'SQLITE_CONSTRAINT_UNIQUE');
    assert.throws(() => db.exec('INSERT INTO t VALUES (1, 1)'), (e) => e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY');
    db.close();
  }));

  test(`${backend}: busy timeout defaults to 5 s, explicit timeout wins`, () => withBackend(backend, () => {
    const file = tmpDb();
    const a = openDb(file);
    assert.equal(a.pragma('busy_timeout')[0].timeout, 5000);
    a.close();
    const b = openDb(file, { timeout: 250 });
    assert.equal(b.pragma('busy_timeout')[0].timeout, 250);
    b.close();
  }));

  test(`${backend}: transaction commits, rolls back on throw, nests`, () => withBackend(backend, () => {
    const db = openDb(tmpDb());
    db.exec('CREATE TABLE t (v INTEGER)');
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
    const many = db.transaction((vs) => { for (const v of vs) ins.run(v); return vs.length; });
    assert.equal(many([1, 2]), 2);
    assert.throws(() => db.transaction(() => { ins.run(3); throw new Error('boom'); })());
    const outer = db.transaction(() => {
      ins.run(4);
      try { db.transaction(() => { ins.run(5); throw new Error('inner'); })(); } catch { /* inner rolled back */ }
    });
    outer();
    assert.deepEqual(db.prepare('SELECT v FROM t ORDER BY v').all().map((r) => r.v), [1, 2, 4]);
    db.close();
  }));

  test(`${backend}: fileMustExist and readonly refuse a missing file, readonly refuses writes`, () => withBackend(backend, () => {
    const missing = path.join(path.dirname(tmpDb()), 'missing.db');
    assert.throws(() => openDb(missing, { fileMustExist: true }));
    assert.throws(() => openDb(missing, { readonly: true }));
    assert.equal(fs.existsSync(missing), false);
    const file = tmpDb();
    const rw = openDb(file);
    rw.exec('CREATE TABLE t (v INTEGER)');
    rw.close();
    const ro = openDb(file, { readonly: true, fileMustExist: true });
    assert.equal(ro.prepare('SELECT count(*) AS n FROM t').get().n, 0);
    assert.throws(() => ro.exec('INSERT INTO t VALUES (1)'));
    ro.close();
  }));
}
