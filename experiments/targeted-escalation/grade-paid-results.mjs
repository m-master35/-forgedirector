import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const resultsDir = path.resolve(process.argv[2] || 'targeted-escalation-paid-results');
const inputPath = path.join(resultsDir, 'paid-results.json');
const result = JSON.parse(await readFile(inputPath, 'utf8'));
const rows = Array.isArray(result.rows) ? result.rows : [];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round(num(value) * scale) / scale;
}

function percentile(values, p) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const index = Math.min(clean.length - 1, Math.max(0, Math.ceil((p / 100) * clean.length) - 1));
  return round(clean[index], 2);
}

function targetedProCost(item) {
  return (item?.calls || []).reduce((sum, call) => sum + num(call?.estimatedCostUsd), 0);
}

function targetedProSeconds(item) {
  return (item?.extraction || []).reduce((sum, segment) => sum + num(segment?.outputDurationSeconds), 0);
}

function targetedLatencyMs(row, item) {
  const extraction = (item?.extraction || []).reduce((sum, segment) => sum + num(segment?.extractionLatencyMs), 0);
  const pro = (item?.calls || []).reduce((sum, call) => sum + num(call?.latencyMs), 0);
  return num(row?.lite?.latencyMs) + extraction + pro;
}

function strategyEconomics(row, strategy) {
  const liteCost = num(row?.lite?.estimatedCostUsd);
  const fullProCost = num(row?.fullVideoPro?.estimatedCostUsd);
  const baselineCost = liteCost + fullProCost;
  const sourceMinutes = Math.max(0.000001, num(row?.durationSeconds) / 60);
  const item = row?.strategies?.[strategy] || {};

  let mode = item?.mode || 'targeted';
  let proCost;
  let proSeconds;
  let endToEndLatencyMs;

  if (strategy === 'hybrid' && mode === 'whole_video_fallback') {
    proCost = fullProCost;
    proSeconds = num(row?.fullVideoPro?.videoSeconds);
    endToEndLatencyMs = num(row?.lite?.latencyMs) + num(row?.fullVideoPro?.latencyMs);
  } else {
    proCost = targetedProCost(item);
    proSeconds = targetedProSeconds(item);
    endToEndLatencyMs = targetedLatencyMs(row, item);
  }

  const totalCost = liteCost + proCost;
  const savingUsd = baselineCost - totalCost;
  const savingPercent = baselineCost > 0 ? savingUsd / baselineCost * 100 : null;

  return {
    mode,
    liteCostUsd: round(liteCost),
    proCostUsd: round(proCost),
    totalModelCostUsd: round(totalCost),
    fullVideoBaselineCostUsd: round(baselineCost),
    absoluteSavingUsd: round(savingUsd),
    savingPercent: savingPercent === null ? null : round(savingPercent, 2),
    costPerSourceVideoMinuteUsd: round(totalCost / sourceMinutes),
    fullVideoBaselineCostPerSourceVideoMinuteUsd: round(baselineCost / sourceMinutes),
    proVideoSeconds: round(proSeconds, 3),
    fullVideoProSeconds: round(row?.fullVideoPro?.videoSeconds, 3),
    endToEndLatencyMs: round(endToEndLatencyMs, 2),
    extractionLatencyMs: round((item?.extraction || []).reduce((sum, x) => sum + num(x?.extractionLatencyMs), 0), 2),
  };
}

const strategies = ['conservative', 'medium', 'aggressive', 'hybrid'];
const perCase = rows.map((row) => ({
  case: row.case,
  category: row.category,
  durationSeconds: row.durationSeconds,
  fullVideoControl: {
    litePlusFullProCostUsd: round(num(row?.lite?.estimatedCostUsd) + num(row?.fullVideoPro?.estimatedCostUsd)),
    litePlusFullProLatencyMs: round(num(row?.lite?.latencyMs) + num(row?.fullVideoPro?.latencyMs), 2),
    proVideoSeconds: round(row?.fullVideoPro?.videoSeconds, 3),
  },
  strategies: Object.fromEntries(strategies.map((strategy) => [strategy, strategyEconomics(row, strategy)])),
}));

const aggregate = {};
for (const strategy of strategies) {
  const entries = perCase.map((row) => row.strategies[strategy]);
  const totalStrategyCost = entries.reduce((sum, item) => sum + num(item.totalModelCostUsd), 0);
  const totalBaselineCost = entries.reduce((sum, item) => sum + num(item.fullVideoBaselineCostUsd), 0);
  const totalSaving = totalBaselineCost - totalStrategyCost;
  const totalSourceMinutes = rows.reduce((sum, row) => sum + num(row.durationSeconds) / 60, 0);
  const latencies = entries.map((item) => item.endToEndLatencyMs);
  const extractionLatencies = entries.map((item) => item.extractionLatencyMs);
  const summary = result?.strategySummary?.[strategy] || {};

  aggregate[strategy] = {
    totalModelCostUsd: round(totalStrategyCost),
    totalFullVideoBaselineCostUsd: round(totalBaselineCost),
    absoluteSavingUsd: round(totalSaving),
    savingPercent: totalBaselineCost > 0 ? round(totalSaving / totalBaselineCost * 100, 2) : null,
    savingPerSourceVideoMinuteUsd: totalSourceMinutes > 0 ? round(totalSaving / totalSourceMinutes) : null,
    averageCostPerAnalysisUsd: rows.length ? round(totalStrategyCost / rows.length) : null,
    averageSavingPerAnalysisUsd: rows.length ? round(totalSaving / rows.length) : null,
    proVideoSeconds: round(entries.reduce((sum, item) => sum + num(item.proVideoSeconds), 0), 3),
    fullVideoProSeconds: round(entries.reduce((sum, item) => sum + num(item.fullVideoProSeconds), 0), 3),
    proVideoDurationReductionPercent: num(summary?.fullVideoProControlSeconds) > 0
      ? round((num(summary.fullVideoProControlSeconds) - num(summary.targetedProSeconds)) / num(summary.fullVideoProControlSeconds) * 100, 2)
      : summary?.proVideoDurationReductionPercent ?? null,
    truePositives: num(summary?.truePositives),
    falseNegatives: num(summary?.falseNegatives),
    criticalMisses: num(summary?.criticalMisses),
    proCalls: num(summary?.proCalls),
    endToEndLatencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
    },
    extractionLatencyMs: {
      p50: percentile(extractionLatencies, 50),
      p95: percentile(extractionLatencies, 95),
    },
  };
}

const hybrid = aggregate.hybrid || {};
const fullVideoTp = rows.reduce((sum, row) => sum + num(row?.fullVideoPro?.grade?.truePositives), 0);
const fullVideoFn = rows.reduce((sum, row) => sum + num(row?.fullVideoPro?.grade?.falseNegatives), 0);
const fullVideoCriticalMisses = rows.reduce((sum, row) => sum + num(row?.fullVideoPro?.grade?.criticalMisses), 0);
const equivalenceControls = rows.flatMap((row) => (row.equivalence || []).map((item) => ({ case: row.case, ...item })));
const equivalenceConfirmed = equivalenceControls.filter((item) => item?.verdict?.status === 'confirmed').length;

const decisionEvidence = {
  fullVideoControl: {
    truePositives: fullVideoTp,
    falseNegatives: fullVideoFn,
    criticalMisses: fullVideoCriticalMisses,
  },
  hybrid: {
    truePositives: num(hybrid.truePositives),
    falseNegatives: num(hybrid.falseNegatives),
    criticalMisses: num(hybrid.criticalMisses),
    costSavingPercent: hybrid.savingPercent ?? null,
    proVideoDurationReductionPercent: hybrid.proVideoDurationReductionPercent ?? null,
  },
  segmentEquivalence: {
    confirmed: equivalenceConfirmed,
    total: equivalenceControls.length,
    confirmationRate: equivalenceControls.length ? round(equivalenceConfirmed / equivalenceControls.length * 100, 2) : null,
  },
  technicalFailures: Array.isArray(result.failures) ? result.failures.length : 0,
};

const graded = {
  experimentVersion: result.experimentVersion,
  corpusVersion: result.corpusVersion,
  timestamp: result.timestamp,
  configuredRatesUsdPerMillionTokens: result.configuredRatesUsdPerMillionTokens,
  perCase,
  aggregate,
  decisionEvidence,
};

await writeFile(path.join(resultsDir, 'economic-analysis.json'), JSON.stringify(graded, null, 2) + '\n', 'utf8');

const md = [
  '# Targeted escalation economic and latency analysis',
  '',
  '| Strategy | Model cost | Full-Pro baseline | Saving | Saving % | Pro seconds | TP | FN | Critical misses | p50 / p95 E2E latency |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...strategies.map((strategy) => {
    const item = aggregate[strategy];
    return `| ${strategy} | $${item.totalModelCostUsd} | $${item.totalFullVideoBaselineCostUsd} | $${item.absoluteSavingUsd} | ${item.savingPercent ?? 'n/a'}% | ${item.proVideoSeconds} | ${item.truePositives} | ${item.falseNegatives} | ${item.criticalMisses} | ${item.endToEndLatencyMs.p50 ?? 'n/a'} / ${item.endToEndLatencyMs.p95 ?? 'n/a'} ms |`;
  }),
  '',
  `- Exact segment-equivalence confirmations: **${decisionEvidence.segmentEquivalence.confirmed}/${decisionEvidence.segmentEquivalence.total}** (${decisionEvidence.segmentEquivalence.confirmationRate ?? 'n/a'}%).`,
  `- Full-video Pro control: **TP ${fullVideoTp}, FN ${fullVideoFn}, critical misses ${fullVideoCriticalMisses}**.`,
  `- Hybrid: **TP ${decisionEvidence.hybrid.truePositives}, FN ${decisionEvidence.hybrid.falseNegatives}, critical misses ${decisionEvidence.hybrid.criticalMisses}**.`,
  '',
  'Cost values are estimates from observed Bedrock usage and the benchmark rate snapshot. Extraction latency is reported separately; production compute cost for ffmpeg is not assumed to be literally zero.',
  '',
];
await writeFile(path.join(resultsDir, 'economic-analysis.md'), md.join('\n'), 'utf8');

console.log(JSON.stringify(decisionEvidence, null, 2));
