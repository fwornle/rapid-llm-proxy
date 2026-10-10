#!/usr/bin/env node
//
// Reconstruct the routing decision for token_usage rows written before the
// routing columns existed.
//
//   node scripts/backfill-routing-decisions.mjs --dry-run
//   node scripts/backfill-routing-decisions.mjs
//
// ── What this can and cannot know ────────────────────────────────────────────
// Only two things are genuinely derivable from a historic row, and the script
// writes nothing else:
//
//   route_key / route_step   Deterministic. The lookup is a pure function of the
//                            job id, which is reconstructable from `process` and
//                            `agent` exactly as server.mjs builds it.
//
//   route_band               Exact when the route declares a fixed band. When the
//                            route says `from-caller`, the band came from a
//                            request field that was never stored — so instead of
//                            guessing, we reverse-map the row's OWN model against
//                            the provider's band table. A unique hit is a fact; an
//                            ambiguous one (a provider using the same model for
//                            two bands) is left blank.
//
// Deliberately NOT reconstructed: offloaded_from, chain_position, attempt_trail.
// Those describe what happened at dispatch and are unrecoverable. Writing a
// plausible-looking chain_position of 0 would assert "no fallback happened" when
// the truth is "nobody recorded whether one did" — the exact false certainty
// these columns were added to remove.
//
// ── The caveat the operator agreed to ────────────────────────────────────────
// This resolves against TODAY's config. Wherever routing has changed since a row
// was written, its reconstruction describes present-day policy, not what actually
// happened. That is why every touched row is stamped routing_source='backfill'
// and the dashboard badges it: the reconstruction is never allowed to pass for an
// observation. Rows already stamped 'live' are never touched, so re-running is
// safe and idempotent.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { loadRoutingConfig, resolveRoute, FROM_CALLER } from '../proxy-bridge/routing-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry-run');

// Same resolution order as bin/start-llm-proxy.sh.
const dataDir = process.env.LLM_PROXY_DATA_DIR
  || path.resolve(__dirname, '..', '.data');
const dbPath = process.env.LLM_PROXY_DB
  || path.join(dataDir, 'llm-proxy', 'token-usage.db');

if (!fs.existsSync(dbPath)) {
  console.error(`No token-usage DB at ${dbPath}. Set LLM_PROXY_DATA_DIR or LLM_PROXY_DB.`);
  process.exit(2);
}
console.log(`db:      ${dbPath}`);
console.log(`mode:    ${DRY ? 'DRY RUN — nothing will be written' : 'WRITE'}`);

const cfg = loadRoutingConfig({ force: true });
console.log(`config:  ${cfg.paths.routing}`);

// Mirrors server.mjs FOREGROUND_AGENTS / agentIsForeground. Duplicated rather
// than imported because server.mjs boots an HTTP listener on import; the set is
// four literals and a drift here shows up as a wrong route_key, not silently.
const FOREGROUND_AGENTS = new Set(['claude', 'copilot', 'opencode', 'pi']);

/** The job id server.mjs would have built for this row. */
function jobFor(row) {
  if (row.agent && FOREGROUND_AGENTS.has(row.agent)) {
    return { job: 'fg-chat', agent: row.agent };
  }
  const proc = row.process && row.process !== 'unknown' ? row.process : '';
  return { job: proc ? `bg-${proc}` : 'bg-unknown', agent: '' };
}

/**
 * Which band a provider's table maps to this model. Returns '' when the answer
 * is not unique — a provider serving one model for two bands cannot tell us
 * which one the caller asked for, and a coin flip is not a reconstruction.
 */
function bandFromModel(providerId, model) {
  const p = cfg.providers[providerId];
  if (!p || !model) return '';
  const hits = Object.entries(p.models).filter(([, m]) => m === model).map(([band]) => band);
  return hits.length === 1 ? hits[0] : '';
}

const db = new Database(dbPath);
const pending = db.prepare(`
  SELECT rowid AS rid, process, agent, provider, model, routing_source
  FROM token_usage
  WHERE routing_source = ''
`).all();

console.log(`rows:    ${pending.length} unstamped (already-stamped rows are never touched)`);
if (pending.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

const update = db.prepare(`
  UPDATE token_usage
  SET route_key = ?, route_band = ?, route_step = ?, routing_source = 'backfill'
  WHERE rowid = ?
`);

const stats = { updated: 0, bandExact: 0, bandFromModel: 0, bandUnknown: 0, failed: 0 };
const byRoute = new Map();

const run = db.transaction((rows) => {
  for (const row of rows) {
    let decided;
    try {
      const { job, agent } = jobFor(row);
      decided = resolveRoute(cfg, { job, agent });
    } catch {
      // A row naming a process whose route has since been deleted resolves to
      // defaults; anything that still throws is left alone rather than guessed.
      stats.failed += 1;
      continue;
    }

    // The band the ROUTE declares, before the caller had any say.
    const declared = decided.step === 3
      ? cfg.defaults[decided.class]?.complexity
      : (cfg.routes[decided.matchedKey]?.complexity ?? decided.complexity);

    let band;
    if (declared && declared !== FROM_CALLER) {
      band = declared;
      stats.bandExact += 1;
    } else {
      band = bandFromModel(row.provider, row.model);
      if (band) stats.bandFromModel += 1;
      else stats.bandUnknown += 1;
    }

    byRoute.set(decided.matchedKey, (byRoute.get(decided.matchedKey) || 0) + 1);
    if (!DRY) update.run(decided.matchedKey, band, decided.step, row.rid);
    stats.updated += 1;
  }
});

run(pending);

console.log('');
console.log(`reconstructed:        ${stats.updated}`);
console.log(`  band from route:    ${stats.bandExact}      (exact — the route declares it)`);
console.log(`  band from model:    ${stats.bandFromModel}      (reverse-mapped, unique hit)`);
console.log(`  band left blank:    ${stats.bandUnknown}      (from-caller + ambiguous model — not guessed)`);
console.log(`  unresolvable:       ${stats.failed}`);
console.log('');
console.log('by route:');
for (const [k, n] of [...byRoute.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${String(n).padStart(7)}  ${k}`);
}
if (DRY) {
  console.log('\nDRY RUN — no rows were modified. Re-run without --dry-run to apply.');
} else {
  console.log('\nDone. Every touched row is stamped routing_source=\'backfill\' and shows as');
  console.log('reconstructed in the dashboard — it resolves against TODAY\'s config, so it is');
  console.log('wrong wherever routing has changed since.');
}
db.close();
