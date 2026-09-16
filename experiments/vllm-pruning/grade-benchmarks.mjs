#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.env.VLLM_BENCH_OUT || process.argv[2] || 'benchmark-vllm');
const threshold = Number(process.env.VLLM_MEANINGFUL_REDUCTION || 0.10);
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json') && name !== 'decision.json') : [];
const reports = new Map();
for (const file of files) {
  const value = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  if (value?.profile?.name) reports.set(value.profile.name, value);
}
const baseline = reports.get('baseline');
if (!baseline) throw new Error(`Missing ${path.join(dir, 'baseline.json')}; a same-model no-prune control is mandatory.`);

function reduction(base, value) {
  const b = Number(base), v = Number(value);
  if (!Number.isFinite(b) || !Number.isFinite(v) || b <= 0) return null;
  return (b - v) / b;
}
function percent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'n/a';
}
function checkKey(item) { return `${item.type}\u0000${item.rule}`; }
function timestampDrift(baseReport, candidateReport) {
  const baselineRows = new Map((baseReport.rows || []).map((row) => [row.name, row]));
  const deltas = [];
  for (const row of candidateReport.rows || []) {
    const baseRow = baselineRows.get(row.name);
    if (!baseRow) continue;
    const baseChecks = new Map((baseRow.checkResults || []).map((item) => [checkKey(item), item]));
    for (const item of row.checkResults || []) {
      const prior = baseChecks.get(checkKey(item));
      const a = Number(prior?.timestampSeconds), b = Number(item?.timestampSeconds);
      if (Number.isFinite(a) && Number.isFinite(b)) deltas.push(Math.abs(a - b));
    }
  }
  return {
    comparableChecks: deltas.length,
    meanAbsoluteSeconds: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null,
    maxAbsoluteSeconds: deltas.length ? Math.max(...deltas) : null,
  };
}

const baselineQualityClean = baseline.summary?.technicalFailures === 0
  && baseline.summary?.incorrectChecks === 0
  && baseline.summary?.falseNegatives === 0
  && baseline.summary?.coverageFailures === 0
  && baseline.summary?.noSpeechFailures === 0
  && baseline.summary?.gateFailures === 0;

const decisions = [];
for (const [name, report] of reports) {
  if (name === 'baseline') continue;
  const s = report.summary || {};
  const bs = baseline.summary || {};
  const inputTokenReduction = reduction(bs.totalInputTokens, s.totalInputTokens);
  const latencyReduction = reduction(bs.totalWallMs, s.totalWallMs);
  const kvReduction = reduction(bs.peakKvCacheUsagePerc, s.peakKvCacheUsagePerc);
  const gpuMemoryReduction = reduction(bs.peakGpuMemoryMiB, s.peakGpuMemoryMiB);
  const costReduction = reduction(bs.estimatedInferenceCostUsd, s.estimatedInferenceCostUsd);
  const newFalseNegatives = Math.max(0, Number(s.falseNegatives || 0) - Number(bs.falseNegatives || 0));
  const qualityClean = baselineQualityClean
    && Number(s.technicalFailures || 0) === 0
    && Number(s.incorrectChecks || 0) === 0
    && Number(s.falseNegatives || 0) === 0
    && Number(s.coverageFailures || 0) === 0
    && Number(s.noSpeechFailures || 0) === 0
    && Number(s.gateFailures || 0) === 0;
  const meaningfulResourceGain = [inputTokenReduction, latencyReduction, kvReduction]
    .some((value) => Number.isFinite(value) && value >= threshold);

  let decision = 'no_material_resource_gain';
  if (!qualityClean || newFalseNegatives > 0) decision = 'reject_quality';
  else if (meaningfulResourceGain) decision = 'eligible_for_larger_controlled_validation';

  decisions.push({
    profile: name,
    decision,
    quality: {
      baselineQualityClean,
      technicalFailures: s.technicalFailures,
      incorrectChecks: s.incorrectChecks,
      falseNegatives: s.falseNegatives,
      newFalseNegatives,
      falsePositives: s.falsePositives,
      coverageFailures: s.coverageFailures,
      noSpeechFailures: s.noSpeechFailures,
      gateFailures: s.gateFailures,
    },
    reductions: {
      inputTokens: inputTokenReduction,
      wallLatency: latencyReduction,
      peakKvCacheUsage: kvReduction,
      peakGpuMemory: gpuMemoryReduction,
      estimatedCost: costReduction,
    },
    timestampDrift: timestampDrift(baseline, report),
    meaningfulReductionThreshold: threshold,
    operationalComplexity: 'manual_review_required',
    productionPromotion: false,
  });
}

const output = {
  generatedAt: new Date().toISOString(),
  baseline: baseline.profile,
  baselineQualityClean,
  threshold,
  decisions,
  note: 'This gate never promotes a profile to production. Eligible profiles require a larger controlled validation and manual operational review.',
};
fs.writeFileSync(path.join(dir, 'decision.json'), `${JSON.stringify(output, null, 2)}\n`);

const md = [
  '# ForgeDirector vLLM pruning decision gate',
  '',
  `- Baseline quality clean: **${baselineQualityClean ? 'yes' : 'NO'}**`,
  `- Meaningful resource reduction threshold: **${percent(threshold)}**`,
  '',
  '| Profile | Decision | False negatives | Input-token reduction | Latency reduction | Peak-KV reduction | Timestamp MAE |',
  '|---|---|---:|---:|---:|---:|---:|',
  ...decisions.map((item) => `| ${item.profile} | ${item.decision} | ${item.quality.falseNegatives} | ${percent(item.reductions.inputTokens)} | ${percent(item.reductions.wallLatency)} | ${percent(item.reductions.peakKvCacheUsage)} | ${Number.isFinite(item.timestampDrift.meanAbsoluteSeconds) ? `${item.timestampDrift.meanAbsoluteSeconds.toFixed(2)}s` : 'n/a'} |`),
  '',
  'No result in this report authorizes production promotion.',
  '',
];
fs.writeFileSync(path.join(dir, 'decision.md'), `${md.join('\n')}\n`);
console.log(md.join('\n'));
