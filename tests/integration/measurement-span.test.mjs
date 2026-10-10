/**
 * Integration suite for the Phase 68-02 measurement-span lifecycle (TELEM-02).
 *
 * Proves, against the SHIPPED compiled code (../../dist/measurement-span.js —
 * run AFTER `npm run build`), the span contract behind Success Criteria 3 & 4:
 *   (a) full lifecycle: start → getActiveMeasurement returns the span → stop →
 *       active file gone AND archive file present with a non-empty ended_at.
 *   (b) getActiveMeasurement returns null when the active file is absent.
 *   (c) a corrupt/non-JSON active file → null + no throw (proxy hot-path guard).
 *   (d) a >24h-old started_at → the span is still returned AND a `stale span`
 *       stderr line is emitted (captured by swapping process.stderr.write).
 *   (e) the single-parser invariant: stopMeasurement archives the span without
 *       independently parsing the active file.
 *   (f) path-traversal: startMeasurement({task_id:'../../etc/passwd'}) throws and
 *       writes no file outside the temp data dir.
 *
 * Each test isolates state in a fresh tmpdir passed as overrideDataDir, so no
 * env var leaks across tests. Built-in node:test + node:assert/strict only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import {
  getActiveMeasurement,
  startMeasurement,
  stopMeasurement,
  resolveMeasurementPaths,
  resolveLiveTaskId,
  resolveAgentSpanTaskId,
  listActiveMeasurements,
  sanitizeAgent,
  clearAgentSpan,
} from '../../dist/measurement-span.js';

/** Fresh isolated temp data dir; returned as overrideDataDir. */
function freshDataDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `meas-${label}-`));
}

function cleanup(dataDir) {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Run fn with process.stderr.write captured; returns { result, stderr }. */
function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  let buf = '';
  process.stderr.write = (chunk, ...rest) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString();
    // Swallow during capture; do not echo (keeps test output clean).
    if (typeof rest[rest.length - 1] === 'function') rest[rest.length - 1]();
    return true;
  };
  try {
    const result = fn();
    return { result, stderr: buf };
  } finally {
    process.stderr.write = original;
  }
}

test('(a) full lifecycle: start → read → stop → archive', () => {
  const dataDir = freshDataDir('a');
  try {
    const { activePath, archiveDir } = resolveMeasurementPaths(dataDir);

    const started = startMeasurement({ task_id: 'demo-123', goal_sentence: 'do the thing' }, dataDir);
    assert.equal(started.task_id, 'demo-123');
    assert.ok(started.started_at, 'started_at should be set');
    assert.equal(started.ended_at, undefined, 'open span has no ended_at');
    assert.ok(fs.existsSync(activePath), 'active file should exist after start');

    const active = getActiveMeasurement(dataDir);
    assert.ok(active, 'getActiveMeasurement returns the open span');
    assert.equal(active.task_id, 'demo-123');
    assert.equal(active.goal_sentence, 'do the thing');

    const archived = stopMeasurement(dataDir);
    assert.ok(archived, 'stopMeasurement returns the archived span');
    assert.ok(archived.ended_at, 'archived span has a non-empty ended_at');

    // active file gone, archive present with ended_at
    assert.equal(fs.existsSync(activePath), false, 'active file removed after stop');
    const archiveFile = path.join(archiveDir, 'demo-123.json');
    assert.ok(fs.existsSync(archiveFile), 'archive file exists after stop');
    const onDisk = JSON.parse(fs.readFileSync(archiveFile, 'utf-8'));
    assert.equal(onDisk.task_id, 'demo-123');
    assert.ok(onDisk.ended_at, 'archived JSON carries a non-empty ended_at');

    // getActiveMeasurement now null
    assert.equal(getActiveMeasurement(dataDir), null, 'no active span after stop');
  } finally {
    cleanup(dataDir);
  }
});

test('(b) getActiveMeasurement returns null when absent', () => {
  const dataDir = freshDataDir('b');
  try {
    assert.equal(getActiveMeasurement(dataDir), null);
  } finally {
    cleanup(dataDir);
  }
});

test('(c) corrupt active file → null + no throw', () => {
  const dataDir = freshDataDir('c');
  try {
    const { activePath } = resolveMeasurementPaths(dataDir);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(activePath, '{ this is not valid json ]');
    const { result, stderr } = captureStderr(() => getActiveMeasurement(dataDir));
    assert.equal(result, null, 'corrupt span yields null, never throws');
    assert.match(stderr, /unreadable \(non-fatal\)/, 'emits a non-fatal stderr warning');
  } finally {
    cleanup(dataDir);
  }
});

test('(d) >24h started_at → span returned + stale-span stderr line', () => {
  const dataDir = freshDataDir('d');
  try {
    const { activePath } = resolveMeasurementPaths(dataDir);
    fs.mkdirSync(dataDir, { recursive: true });
    const stale = {
      task_id: 'old-span',
      started_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };
    fs.writeFileSync(activePath, JSON.stringify(stale, null, 2));

    const { result, stderr } = captureStderr(() => getActiveMeasurement(dataDir));
    assert.ok(result, 'a >24h span is still returned');
    assert.equal(result.task_id, 'old-span');
    assert.match(stderr, /stale span \(>24h\)/, 'emits a stale-span stderr line');
    assert.match(stderr, /task_id=old-span/);
  } finally {
    cleanup(dataDir);
  }
});

test('(e) single-parser invariant: stop archives without an independent parse', () => {
  // Guards against a corrupt active file silently producing a bogus archive.
  // stopMeasurement routes through getActiveMeasurement (the single parser), so
  // a corrupt active file means stop returns null and writes no archive.
  const dataDir = freshDataDir('e');
  try {
    const { activePath, archiveDir } = resolveMeasurementPaths(dataDir);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(activePath, '{ corrupt');
    const { result } = captureStderr(() => stopMeasurement(dataDir));
    assert.equal(result, null, 'stop returns null on a corrupt active file');
    assert.equal(
      fs.existsSync(archiveDir), false,
      'no archive directory/file created from an unparseable active span',
    );
    // active file remains (nothing valid to archive/remove)
    assert.ok(fs.existsSync(activePath), 'corrupt active file is left in place');
  } finally {
    cleanup(dataDir);
  }
});

test('(f) path-traversal task_id is neutralized to a safe basename — no file escapes the data dir', () => {
  // The plan permits EITHER a throw OR collapse to a sanitized basename. The
  // implementation uses path.basename, so '../../etc/passwd' → 'passwd': a safe
  // id INSIDE the data dir. The load-bearing invariant is that no file is ever
  // created outside the data dir / archive dir.
  const dataDir = freshDataDir('f');
  try {
    const { activePath, archiveDir } = resolveMeasurementPaths(dataDir);

    const span = startMeasurement({ task_id: '../../etc/passwd' }, dataDir);
    assert.equal(span.task_id, 'passwd', 'traversal collapses to a safe basename');

    // Active file is the only thing written, and it lives inside the data dir.
    assert.ok(fs.existsSync(activePath), 'active file written inside the data dir');
    assert.equal(fs.existsSync(path.join(dataDir, 'etc')), false, 'no etc/ tree under data dir');

    // Archive stays inside archiveDir too.
    const archived = stopMeasurement(dataDir);
    assert.equal(archived.task_id, 'passwd');
    const archiveFile = path.join(archiveDir, 'passwd.json');
    assert.ok(fs.existsSync(archiveFile), 'archive written inside archiveDir');
    // Nothing escaped above the data dir.
    assert.equal(fs.existsSync(path.resolve(dataDir, '../../etc/passwd.json')), false);

    // A genuinely unsanitizable id (only separators / dots) DOES throw.
    assert.throws(
      () => startMeasurement({ task_id: '../..' }, dataDir),
      /unsafe path segment|illegal characters/,
      'an id that resolves to a pure traversal segment is rejected',
    );
  } finally {
    cleanup(dataDir);
  }
});

// ---------------------------------------------------------------------------
// Phase 85 (Plan-B): per-agent measurement slots.
// Each coding agent (claude/opencode/copilot/mastra) owns its own
// active-measurement.<agent>.json; the shared active-measurement.json remains
// the manual/experiment fallback. resolveLiveTaskId is agent-aware:
// per-agent span wins when present, else the global span, else ''.
// ---------------------------------------------------------------------------

test('Plan-B (a) per-agent span writes active-measurement.<agent>.json and is isolated', () => {
  const dataDir = freshDataDir('pa-a');
  try {
    startMeasurement({ task_id: 'ses_oc', goal_sentence: 'oc work', agent: 'opencode' }, dataDir);
    startMeasurement({ task_id: 'ses_cl', goal_sentence: 'cl work', agent: 'claude' }, dataDir);

    // Distinct files, distinct contents; the global file is untouched.
    assert.ok(fs.existsSync(path.join(dataDir, 'active-measurement.opencode.json')));
    assert.ok(fs.existsSync(path.join(dataDir, 'active-measurement.claude.json')));
    assert.equal(fs.existsSync(path.join(dataDir, 'active-measurement.json')), false);

    assert.equal(getActiveMeasurement(dataDir, 'opencode').task_id, 'ses_oc');
    assert.equal(getActiveMeasurement(dataDir, 'claude').task_id, 'ses_cl');
    assert.equal(getActiveMeasurement(dataDir, 'opencode').agent, 'opencode');
  } finally {
    cleanup(dataDir);
  }
});

test('Plan-B (b) resolveLiveTaskId precedence: per-agent wins, global is the fallback', () => {
  const dataDir = freshDataDir('pa-b');
  try {
    // Global manual span only → every agent resolves to it (backward compatible).
    startMeasurement({ task_id: 'ses_global' }, dataDir);
    assert.equal(resolveLiveTaskId(dataDir), 'ses_global');
    assert.equal(resolveLiveTaskId(dataDir, 'opencode'), 'ses_global');

    // Add a per-agent span for opencode → opencode now wins; claude still global.
    startMeasurement({ task_id: 'ses_oc', agent: 'opencode' }, dataDir);
    assert.equal(resolveLiveTaskId(dataDir, 'opencode'), 'ses_oc');
    assert.equal(resolveLiveTaskId(dataDir, 'claude'), 'ses_global');
    // No-agent resolve still returns the global span.
    assert.equal(resolveLiveTaskId(dataDir), 'ses_global');
  } finally {
    cleanup(dataDir);
  }
});

test('Plan-B (b2) deliberate global span outranks an AUTO per-agent slot (experiment-shadowing regression)', () => {
  const dataDir = freshDataDir('pa-b2');
  try {
    // The always-on reconciler owns opencode's ambient slot (meta.auto=true),
    // stamped with the live foreground session id.
    startMeasurement(
      { task_id: 'ses_foreground', agent: 'opencode', meta: { auto: true, source: 'reconciler' } },
      dataDir,
    );
    // An experiment/comparison harness opens the deliberate global span for a cell.
    startMeasurement({ task_id: 'exp-abc--opencode-rapid-proxy--r0' }, dataDir);

    // BUG (pre-fix): opencode's shim request resolved to 'ses_foreground' (auto
    // slot shadowed the experiment), so the capture landed under the wrong id
    // and the run rendered the illustrative band. The deliberate global span
    // must now win for opencode.
    assert.equal(
      resolveLiveTaskId(dataDir, 'opencode'),
      'exp-abc--opencode-rapid-proxy--r0',
      'deliberate experiment span must outrank the ambient auto per-agent slot',
    );

    // A DELIBERATE per-agent span is still the most specific match and wins.
    startMeasurement({ task_id: 'ses_manual_oc', agent: 'opencode' }, dataDir);
    assert.equal(resolveLiveTaskId(dataDir, 'opencode'), 'ses_manual_oc');
  } finally {
    cleanup(dataDir);
  }
});

test('Plan-B (b3) no deliberate span → ambient AUTO per-agent slot still resolves (interactive capture unbroken)', () => {
  const dataDir = freshDataDir('pa-b3');
  try {
    // Only the ambient auto slot exists (no experiment, no manual global).
    startMeasurement(
      { task_id: 'ses_live', agent: 'opencode', meta: { auto: true, source: 'reconciler' } },
      dataDir,
    );
    assert.equal(resolveLiveTaskId(dataDir, 'opencode'), 'ses_live');
  } finally {
    cleanup(dataDir);
  }
});

test('Plan-B (c) per-agent stop archives only that agent; others survive', () => {
  const dataDir = freshDataDir('pa-c');
  try {
    startMeasurement({ task_id: 'ses_oc', agent: 'opencode' }, dataDir);
    startMeasurement({ task_id: 'ses_cl', agent: 'claude' }, dataDir);

    const archived = stopMeasurement(dataDir, 'opencode');
    assert.equal(archived.task_id, 'ses_oc');
    assert.equal(getActiveMeasurement(dataDir, 'opencode'), null, 'opencode slot cleared');
    assert.equal(getActiveMeasurement(dataDir, 'claude').task_id, 'ses_cl', 'claude slot intact');
  } finally {
    cleanup(dataDir);
  }
});

test('Plan-B (d) listActiveMeasurements enumerates global + per-agent slots', () => {
  const dataDir = freshDataDir('pa-d');
  try {
    startMeasurement({ task_id: 'ses_global' }, dataDir);
    startMeasurement({ task_id: 'ses_oc', agent: 'opencode' }, dataDir);
    startMeasurement({ task_id: 'ses_cl', agent: 'claude' }, dataDir);

    const all = listActiveMeasurements(dataDir);
    const byAgent = new Map(all.map((e) => [e.agent ?? '', e.span.task_id]));
    assert.equal(byAgent.get(''), 'ses_global');
    assert.equal(byAgent.get('opencode'), 'ses_oc');
    assert.equal(byAgent.get('claude'), 'ses_cl');
    assert.equal(all.length, 3);
  } finally {
    cleanup(dataDir);
  }
});

test('Plan-B (e) sanitizeAgent normalizes/rejects labels (filename safety)', () => {
  assert.equal(sanitizeAgent('OpenCode'), 'opencode');
  assert.equal(sanitizeAgent('copilot'), 'copilot');
  assert.equal(sanitizeAgent(''), '');
  assert.equal(sanitizeAgent(undefined), '');
  // Path separators can never escape: basename() collapses them to a safe leaf.
  assert.equal(sanitizeAgent('../etc'), 'etc', 'traversal collapses to a safe basename');
  assert.equal(sanitizeAgent('a/b'), 'b');
  // Genuinely unsafe leaves throw rather than silently truncating.
  assert.throws(() => sanitizeAgent('a'.repeat(64)), /illegal characters/, 'over-long rejected');
  assert.throws(() => sanitizeAgent('open code'), /illegal characters/, 'whitespace rejected');
});

test('Plan-B (f) resolveAgentSpanTaskId binds ONLY the agent span, never global (D-08)', () => {
  const dataDir = freshDataDir('pa-f');
  try {
    // A live GLOBAL span (e.g. a concurrent experiment cell or a manual span).
    startMeasurement({ task_id: 'ses_global' }, dataDir);

    // With no per-agent span, the interactive tap must stay NEUTRAL — it must
    // NOT inherit the global span (the exact D-08/WR-01 leak). This is the
    // byte-identical successor to the old `taskId = ''` stamp.
    assert.equal(
      resolveAgentSpanTaskId('claude', dataDir),
      '',
      'no per-agent span → neutral, global is NOT inherited',
    );

    // Open claude's own per-agent auto span → the tap binds to it (and only it).
    startMeasurement({ task_id: 'ses_cl', agent: 'claude' }, dataDir);
    assert.equal(resolveAgentSpanTaskId('claude', dataDir), 'ses_cl', 'binds own agent span');

    // A different agent with no span still stays neutral — never adopts claude's
    // span nor the global span.
    assert.equal(
      resolveAgentSpanTaskId('opencode', dataDir),
      '',
      'other agent stays neutral, no cross-agent/global bleed',
    );

    // Empty/undefined agent → neutral (never falls back to global).
    assert.equal(resolveAgentSpanTaskId('', dataDir), '', 'empty agent → neutral');
    assert.equal(resolveAgentSpanTaskId(undefined, dataDir), '', 'undefined agent → neutral');
  } finally {
    cleanup(dataDir);
  }
});

test('clearAgentSpan removes a per-agent slot without archiving, and never touches the global slot', () => {
  const dataDir = freshDataDir('clear');
  try {
    // Global (manual/experiment) span + a per-agent auto span coexist.
    startMeasurement({ task_id: 'ses_global' }, dataDir);
    startMeasurement({ task_id: 'ses_cl', agent: 'claude' }, dataDir);

    // Clearing claude's slot drops ONLY the per-agent binding.
    assert.equal(clearAgentSpan('claude', dataDir), true, 'removed the claude slot');
    assert.equal(resolveAgentSpanTaskId('claude', dataDir), '', 'claude slot gone');
    assert.equal(getActiveMeasurement(dataDir)?.task_id, 'ses_global', 'global slot untouched');

    // No archive was written (ambient spans must not pollute measurements/).
    const archiveDir = path.join(dataDir, 'measurements');
    const archived = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : [];
    assert.deepEqual(archived, [], 'clearAgentSpan does not archive');

    // Idempotent: clearing again is a no-op.
    assert.equal(clearAgentSpan('claude', dataDir), false, 'second clear is a no-op');

    // Refuses to clear the global slot (empty agent).
    assert.equal(clearAgentSpan('', dataDir), false, 'refuses empty agent');
    assert.equal(getActiveMeasurement(dataDir)?.task_id, 'ses_global', 'global still present');
  } finally {
    cleanup(dataDir);
  }
});
