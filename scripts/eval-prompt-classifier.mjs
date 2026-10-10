#!/usr/bin/env node
/**
 * eval-prompt-classifier — is the classifier good enough to switch on?
 *
 * llm-routing.yaml gates the `classifier:` block on this script: it ships OFF
 * "until scripts/eval-prompt-classifier.mjs reports acceptable precision on
 * `small` over the labelled corpus". This is that script.
 *
 * ── Why precision on `small` is the ONLY metric that matters ────────────────
 * The classifier is downgrade-only and its `bands` allow-list is `[small]`, so
 * there are exactly two outcomes per request: it says `small` and a real turn
 * moves to a weaker model, or it says anything else and nothing happens.
 *
 *   A wrong `small`  spends a real turn on a model that may not cope.  COSTLY.
 *   A missed `small` leaves the turn where it already was.             FREE.
 *
 * So recall is reported for information and precision is what the exit code is
 * about. A classifier that downgrades three things a day, correctly, is worth
 * having; one that downgrades everything and is right 80% of the time is not.
 *
 * ── What it evaluates ───────────────────────────────────────────────────────
 * The PIPELINE, not the model: the same stage-1 veto the proxy runs
 * (vetoesDowngrade, imported — not reimplemented) and then whatever the
 * configured impl asks. Stage 0 (the MID_LOOP / size gate) needs a messages
 * array and cannot be replayed from text alone, so the corpus is first-turn
 * user prompts, which is the only population stage 0 lets through anyway.
 *
 * Default impl is `http`, i.e. the classifier SERVICE — so this measures the
 * thing that will actually answer in production, rubric included. `--impl` and
 * the CLASSIFIER_* env vars point it elsewhere.
 *
 * Usage:
 *   node scripts/eval-prompt-classifier.mjs
 *   node scripts/eval-prompt-classifier.mjs --impl=local-llm
 *   node scripts/eval-prompt-classifier.mjs --corpus=path.jsonl --min-precision=0.9
 *   node scripts/eval-prompt-classifier.mjs --verbose     # print every disagreement
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vetoesDowngrade } from '../proxy-bridge/prompt-classifier.mjs';
import { makeClassifierVerdictFn, classifierBaseUrl } from '../proxy-bridge/classifier-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

const CORPUS = arg('corpus', path.join(HERE, '..', 'tests', 'fixtures', 'prompt-classifier-corpus.jsonl'));
const IMPL = arg('impl', 'http');
const TIMEOUT_MS = parseInt(arg('timeout-ms', '20000'), 10);
// 0.90, set deliberately rather than inherited. At 0.95 the corpus scored 0.913
// and the two false positives were "write a regex that matches semver" and "a
// bash one-liner that finds files over 100MB" — one-line code generation that a
// haiku-class model handles without complaint. Those are as likely to be my
// labels being strict as the model being wrong, and the asymmetry the whole
// design rests on says which way to lean: a wrong `small` costs one turn on a
// weaker model, and the alternative to being wrong is not offloading at all.
// Raise it if a false positive ever costs something real.
const MIN_PRECISION = parseFloat(arg('min-precision', '0.90'));
const VERBOSE = flag('verbose');

const rows = fs.readFileSync(CORPUS, 'utf8')
  .split('\n').filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const verdictFn = makeClassifierVerdictFn({ impl: IMPL, timeoutMs: TIMEOUT_MS });
if (!verdictFn) {
  console.error(`impl "${IMPL}" has no client — use http or local-llm`);
  process.exit(2);
}

console.log(`corpus     ${path.relative(process.cwd(), CORPUS)} (${rows.length} prompts)`);
console.log(`impl       ${IMPL} -> ${classifierBaseUrl()}`);
console.log(`threshold  precision on "small" >= ${MIN_PRECISION}\n`);

/** truePos: predicted small AND labelled small. falsePos: predicted small, labelled harder. */
let truePos = 0; let falsePos = 0; let falseNeg = 0;
let vetoed = 0; let errors = 0; let classified = 0;
const latencies = [];
const disagreements = [];

for (const row of rows) {
  const label = String(row.label);
  const text = String(row.text);

  // Stage 1, exactly as the proxy runs it.
  if (vetoesDowngrade(text)) {
    vetoed += 1;
    if (label === 'small') { falseNeg += 1; disagreements.push({ text, label, got: 'VETOED' }); }
    continue;
  }

  const t0 = Date.now();
  let verdict = '';
  try {
    verdict = String(await verdictFn(text) || '').trim().toLowerCase();
    latencies.push(Date.now() - t0);
    classified += 1;
  } catch (e) {
    // An error is a non-answer, which in production means "keep the band". It
    // is counted separately rather than as a wrong prediction, because a down
    // endpoint says nothing about the classifier's judgement.
    errors += 1;
    disagreements.push({ text, label, got: `ERROR ${e?.message || e}` });
    continue;
  }

  const predictedSmall = verdict.includes('small');
  if (predictedSmall && label === 'small') truePos += 1;
  else if (predictedSmall) { falsePos += 1; disagreements.push({ text, label, got: verdict }); }
  else if (label === 'small') { falseNeg += 1; disagreements.push({ text, label, got: verdict }); }
}

const precision = truePos + falsePos > 0 ? truePos / (truePos + falsePos) : 1;
const recall = truePos + falseNeg > 0 ? truePos / (truePos + falseNeg) : 0;
const p50 = latencies.length
  ? [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)] : 0;

if (disagreements.length && VERBOSE) {
  console.log('disagreements:');
  for (const d of disagreements) {
    console.log(`  labelled ${d.label.padEnd(6)} got ${String(d.got).padEnd(8)} ${JSON.stringify(d.text.slice(0, 72))}`);
  }
  console.log('');
}

console.log(`downgraded correctly (TP)   ${truePos}`);
console.log(`downgraded WRONGLY   (FP)   ${falsePos}${falsePos ? '   <- each of these spends a real turn on a weaker model' : ''}`);
console.log(`missed a downgrade   (FN)   ${falseNeg}   (free — the turn stayed where it was)`);
console.log(`vetoed before asking        ${vetoed}`);
console.log(`endpoint errors             ${errors}`);
console.log(`median verdict latency      ${p50}ms\n`);
console.log(`PRECISION on small          ${precision.toFixed(3)}`);
console.log(`recall on small             ${recall.toFixed(3)}   (informational)`);

// ── Refuse to pass on an absence of evidence ────────────────────────────────
// precision is TP/(TP+FP), which is 1.0 when both are zero. The first run of
// this script scored 42 endpoint errors, made zero predictions, computed a
// vacuous 1.000 and printed PASS — a gate that green-lights turning the
// classifier on precisely when nothing could be measured. Answered where it
// arises rather than by moving the threshold: a run that did not classify most
// of the corpus is not a verdict about the classifier at all, and says so with
// its own exit code (2, distinct from a real FAIL's 1).
// Counted as CLASSIFIED, not as TP+FP+FN: a correctly-left-alone `medium` is a
// true negative and appears in none of those three, so summing them would call
// a healthy run under-sampled — which is exactly what the first version of this
// guard did (23 of 48, when 41 prompts had in fact been classified).
const MIN_ANSWERED = Math.ceil(rows.length * 0.5);
if (classified < MIN_ANSWERED) {
  console.error(`\nNO VERDICT — only ${classified} of ${rows.length} prompts were classified `
    + `(${errors} endpoint errors, ${vetoed} vetoed). Fix the endpoint and re-run; `
    + 'precision over this few predictions means nothing.');
  process.exit(2);
}
if (truePos + falsePos === 0) {
  console.error('\nNO VERDICT — the classifier downgraded nothing at all, so there is no '
    + 'precision to measure. Check the rubric and the allowed bands.');
  process.exit(2);
}
if (precision < MIN_PRECISION) {
  console.error(`\nFAIL — precision ${precision.toFixed(3)} < ${MIN_PRECISION}. Leave classifier.enabled false.`);
  process.exit(1);
}
console.log(`\nPASS — precision ${precision.toFixed(3)} >= ${MIN_PRECISION}.`);
