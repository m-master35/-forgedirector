import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const resultsDir = path.resolve(process.argv[2] || 'targeted-escalation-paid-results');
const manifestPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'corpus-manifest.json');
const paid = JSON.parse(await readFile(path.join(resultsDir, 'paid-results.json'), 'utf8'));
const gradedPath = path.join(resultsDir, 'economic-analysis.json');
const reportPath = path.join(resultsDir, 'economic-analysis.md');
const graded = JSON.parse(await readFile(gradedPath, 'utf8'));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const caseDefs = new Map((manifest.cases || []).map((item) => [item.name, item]));
const strategies = ['conservative', 'medium', 'aggressive', 'hybrid'];

let verifier = null;
try {
  verifier = JSON.parse(await readFile(path.join(resultsDir, 'verifier-overhead.json'), 'utf8'));
} catch {
  verifier = null;
}
const verifierByCase = new Map((verifier?.rows || []).map((item) => [item.case, item]));

function n(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round(n(value) * scale) / scale;
}

function percentile(values, p) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const index = Math.min(clean.length - 1, Math.max(0, Math.ceil((p / 100) * clean.length) - 1));
  return round(clean[index], 2);
}

function controlledFalsePositives(caseDef, findings, { confirmedOnly = false } = {}) {
  const negatives = new Set(caseDef?.negativeDefectTypes || []);
  if (!negatives.size) return 0;
  const seen = new Set();
  let count = 0;
  for (const finding of Array.isArray(findings) ? findings : []) {
    if (confirmedOnly && finding?.status !== 'confirmed') continue;
    const defectType = String(finding?.defectType || '');
    if (!negatives.has(defectType)) continue;
    const start = finding?.startSeconds ?? finding?.approximateStartSeconds ?? null;
    const end = finding?.endSeconds ?? finding?.approximateEndSeconds ?? null;
    const key = [finding?.sourceFindingId || '', defectType, start, end].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    count += 1;
  }
  return count;
}

function hybridMode(row) {
  const liteFindings = Array.isArray(row?.lite?.findings) ? row.lite.findings : [];
  if (!liteFindings.length) return 'no_escalation';
  if (row?.strategies?.hybrid?.mode === 'whole_video_fallback') return 'whole_video_fallback';
  return 'targeted';
}

function findingsFor(row, strategy) {
  const caseDef = caseDefs.get(row.case) || {};
  if (strategy === 'hybrid') {
    const mode = hybridMode(row);
    if (mode === 'no_escalation') return { findings: [], confirmedOnly: false, caseDef };
    if (mode === 'whole_video_fallback') {
      return { findings: row?.fullVideoPro?.findings || [], confirmedOnly: false, caseDef };
    }
    return { findings: row?.strategies?.hybrid?.proFindings || [], confirmedOnly: true, caseDef };
  }
  return {
    findings: row?.strategies?.[strategy]?.proFindings || [],
    confirmedOnly: true,
    caseDef,
  };
}

function verifierOverhead(caseName) {
  const item = verifierByCase.get(caseName);
  if (!item) {
    return {
      measured: false,
      costUsd: 0,
      latencyMs: 0,
      proVideoSeconds: 0,
      liteVideoSeconds: 0,
      calls: 0,
    };
  }
  return {
    measured: true,
    costUsd: n(item.totalEstimatedCostUsd),
    latencyMs: n(item.totalLatencyMs),
    proVideoSeconds: n(item?.pro?.videoSeconds),
    liteVideoSeconds: n(item?.lite?.videoSeconds),
    calls: 2,
    proCostUsd: n(item?.pro?.estimatedCostUsd),
    liteCostUsd: n(item?.lite?.estimatedCostUsd),
  };
}

const rows = Array.isArray(paid.rows) ? paid.rows : [];
const fullVideoFalsePositives = rows.reduce((sum, row) => {
  const caseDef = caseDefs.get(row.case) || {};
  return sum + controlledFalsePositives(caseDef, row?.fullVideoPro?.findings || []);
}, 0);

graded.fullVideoAggregate = graded.fullVideoAggregate || {};
graded.fullVideoAggregate.falsePositives = fullVideoFalsePositives;

for (const strategy of strategies) {
  const fp = rows.reduce((sum, row) => {
    const selected = findingsFor(row, strategy);
    return sum + controlledFalsePositives(
      selected.caseDef,
      selected.findings,
      { confirmedOnly: selected.confirmedOnly },
    );
  }, 0);
  if (graded.aggregate?.[strategy]) graded.aggregate[strategy].falsePositives = fp;
}

// Add the unchanged production blind-verifier cost/latency/video duration to
// both sides of each comparison. It cannot create absolute savings, but it can
// materially reduce the percentage savings of the real production-total path.
for (const caseRow of graded.perCase || []) {
  const overhead = verifierOverhead(caseRow.case);
  caseRow.productionVerifierOverhead = overhead;
  const sourceMinutes = Math.max(0.000001, n(caseRow.durationSeconds) / 60);

  for (const strategy of strategies) {
    const economics = caseRow?.strategies?.[strategy]?.economics;
    if (!economics) continue;

    const escalationStrategyCost = n(economics.totalModelCostUsd);
    const escalationBaselineCost = n(economics.baselineModelCostUsd);
    const strategyProSeconds = n(economics.proVideoSeconds);
    const baselineProSeconds = n(economics.baselineProSeconds);
    const absoluteSaving = escalationBaselineCost - escalationStrategyCost;

    economics.escalationPathModelCostUsd = round(escalationStrategyCost);
    economics.escalationBaselineModelCostUsd = round(escalationBaselineCost);
    economics.unchangedVerifierCostUsd = round(overhead.costUsd);
    economics.totalModelCostUsd = round(escalationStrategyCost + overhead.costUsd);
    economics.baselineModelCostUsd = round(escalationBaselineCost + overhead.costUsd);
    economics.absoluteSavingUsd = round(absoluteSaving);
    economics.savingPercent = economics.baselineModelCostUsd > 0
      ? round(absoluteSaving / economics.baselineModelCostUsd * 100, 2)
      : null;
    economics.costPerSourceVideoMinuteUsd = round(economics.totalModelCostUsd / sourceMinutes);
    economics.baselineCostPerSourceVideoMinuteUsd = round(economics.baselineModelCostUsd / sourceMinutes);
    economics.unchangedVerifierProSeconds = round(overhead.proVideoSeconds, 3);
    economics.productionTotalProSeconds = round(strategyProSeconds + overhead.proVideoSeconds, 3);
    economics.productionBaselineTotalProSeconds = round(baselineProSeconds + overhead.proVideoSeconds, 3);
    economics.escalationProVideoDurationReductionPercent = economics.proDurationReductionPercent;
    economics.proDurationReductionPercent = economics.productionBaselineTotalProSeconds > 0
      ? round(
          (economics.productionBaselineTotalProSeconds - economics.productionTotalProSeconds)
            / economics.productionBaselineTotalProSeconds * 100,
          2,
        )
      : null;
    economics.unchangedVerifierLatencyMs = round(overhead.latencyMs, 2);
    economics.endToEndLatencyMs = round(n(economics.endToEndLatencyMs) + overhead.latencyMs, 2);
  }
}

// Rebuild aggregate economics from corrected per-case production totals while
// retaining the quality counts generated by the primary grader.
for (const strategy of strategies) {
  const aggregate = graded.aggregate?.[strategy];
  if (!aggregate) continue;
  const entries = (graded.perCase || []).map((row) => row?.strategies?.[strategy]?.economics).filter(Boolean);
  const totalStrategyCost = entries.reduce((sum, item) => sum + n(item.totalModelCostUsd), 0);
  const totalBaselineCost = entries.reduce((sum, item) => sum + n(item.baselineModelCostUsd), 0);
  const totalSaving = totalBaselineCost - totalStrategyCost;
  const totalSourceMinutes = (graded.perCase || []).reduce((sum, row) => sum + n(row.durationSeconds) / 60, 0);
  const productionTotalProSeconds = entries.reduce((sum, item) => sum + n(item.productionTotalProSeconds), 0);
  const productionBaselineProSeconds = entries.reduce((sum, item) => sum + n(item.productionBaselineTotalProSeconds), 0);
  const verifierCost = entries.reduce((sum, item) => sum + n(item.unchangedVerifierCostUsd), 0);
  const verifierProSeconds = entries.reduce((sum, item) => sum + n(item.unchangedVerifierProSeconds), 0);

  aggregate.totalModelCostUsd = round(totalStrategyCost);
  aggregate.totalBaselineModelCostUsd = round(totalBaselineCost);
  aggregate.absoluteSavingUsd = round(totalSaving);
  aggregate.savingPercent = totalBaselineCost > 0 ? round(totalSaving / totalBaselineCost * 100, 2) : null;
  aggregate.savingPerSourceVideoMinuteUsd = totalSourceMinutes > 0 ? round(totalSaving / totalSourceMinutes) : null;
  aggregate.averageCostPerAnalysisUsd = entries.length ? round(totalStrategyCost / entries.length) : null;
  aggregate.averageSavingPerAnalysisUsd = entries.length ? round(totalSaving / entries.length) : null;
  aggregate.unchangedVerifierCostUsd = round(verifierCost);
  aggregate.unchangedVerifierProSeconds = round(verifierProSeconds, 3);
  aggregate.escalationProVideoSeconds = aggregate.proVideoSeconds;
  aggregate.escalationBaselineProSeconds = aggregate.baselineProSeconds;
  aggregate.productionTotalProSeconds = round(productionTotalProSeconds, 3);
  aggregate.productionBaselineTotalProSeconds = round(productionBaselineProSeconds, 3);
  aggregate.escalationProVideoDurationReductionPercent = aggregate.proVideoDurationReductionPercent;
  aggregate.proVideoDurationReductionPercent = productionBaselineProSeconds > 0
    ? round((productionBaselineProSeconds - productionTotalProSeconds) / productionBaselineProSeconds * 100, 2)
    : null;
  aggregate.endToEndLatencyMs = {
    p50: percentile(entries.map((item) => item.endToEndLatencyMs), 50),
    p95: percentile(entries.map((item) => item.endToEndLatencyMs), 95),
  };
}

const evidence = graded.decisionEvidence || {};
const hybrid = graded.aggregate?.hybrid || {};
const verifierMissing = verifier === null;
const verifierFailures = Array.isArray(verifier?.failures) ? verifier.failures.length : 0;
const technicalFailures = n(evidence.technicalFailures) + verifierFailures + (verifierMissing ? 1 : 0);
const criticalRegressions = n(evidence?.hybrid?.criticalDetectionRegressionsVsFullPro);
const detectionRegressions = n(evidence?.hybrid?.detectionRegressionsVsFullPro);
const localizedCriticalFailures = Array.isArray(evidence?.segmentEquivalence?.localizedCriticalFailures)
  ? evidence.segmentEquivalence.localizedCriticalFailures.length
  : 0;
const equivalenceRate = Number(evidence?.segmentEquivalence?.localizedConfirmationRate ?? 0);
const thresholds = evidence.decisionThresholds || {
  candidateMinimumCostSavingPercent: 20,
  candidateMinimumProDurationReductionPercent: 30,
  candidateMinimumLocalizedEquivalenceConfirmationPercent: 90,
};

let decision;
let decisionReasons = [];
if (
  technicalFailures > 0
  || criticalRegressions > 0
  || localizedCriticalFailures > 0
  || n(hybrid.absoluteSavingUsd) <= 0
  || n(hybrid.proVideoDurationReductionPercent) <= 0
) {
  decision = 'REJECT';
  if (technicalFailures > 0) decisionReasons.push(`${technicalFailures} technical/incomplete benchmark measurement(s), including unchanged-verifier measurement when applicable.`);
  if (criticalRegressions > 0) decisionReasons.push(`${criticalRegressions} critical detection regression(s) versus full-video Pro.`);
  if (localizedCriticalFailures > 0) decisionReasons.push(`${localizedCriticalFailures} critical localized exact-segment confirmation failure(s).`);
  if (n(hybrid.absoluteSavingUsd) <= 0) decisionReasons.push('Hybrid did not produce positive measured model-cost savings versus the production-total comparison baseline.');
  if (n(hybrid.proVideoDurationReductionPercent) <= 0) decisionReasons.push('Hybrid did not reduce production-total Pro video duration.');
} else if (
  detectionRegressions === 0
  && n(hybrid.falsePositives) <= fullVideoFalsePositives
  && n(hybrid.savingPercent) >= n(thresholds.candidateMinimumCostSavingPercent)
  && n(hybrid.proVideoDurationReductionPercent) >= n(thresholds.candidateMinimumProDurationReductionPercent)
  && equivalenceRate >= n(thresholds.candidateMinimumLocalizedEquivalenceConfirmationPercent)
) {
  decision = 'CANDIDATE FOR CONTROLLED INTEGRATION';
  decisionReasons = [
    'No full-video-Pro detection regressions were observed in hybrid mode.',
    'Controlled-negative false positives did not exceed the full-video Pro control.',
    `Production-total model-cost saving met the ${thresholds.candidateMinimumCostSavingPercent}% experiment threshold after adding unchanged blind-verifier overhead to both sides.`,
    `Production-total Pro-duration reduction met the ${thresholds.candidateMinimumProDurationReductionPercent}% experiment threshold.`,
    `Localized segment-equivalence confirmation met the ${thresholds.candidateMinimumLocalizedEquivalenceConfirmationPercent}% experiment threshold.`,
  ];
} else {
  decision = 'PROMISING';
  decisionReasons = [
    'No critical rejection condition was triggered, and hybrid produced positive production-total cost and Pro-duration savings.',
    'One or more controlled-integration thresholds still require refinement or more evidence.',
  ];
}

evidence.fullVideoControl = evidence.fullVideoControl || {};
evidence.fullVideoControl.falsePositives = fullVideoFalsePositives;
evidence.hybrid = {
  ...evidence.hybrid,
  ...hybrid,
  falsePositives: n(hybrid.falsePositives),
};
evidence.falsePositiveScoring = {
  method: 'explicit_controlled_negative_defect_classes_only',
  note: 'Reused real videos are not assumed exhaustively defect-free.',
};
evidence.unchangedVerifierMeasurement = {
  present: !verifierMissing,
  failures: verifierFailures,
  observedCostUsd: round(verifier?.ledger?.observedCostUsd),
  calls: n(verifier?.ledger?.calls),
  proVideoSeconds: round(verifier?.ledger?.proVideoSeconds, 3),
  treatment: 'added equally to baseline and targeted production-total economics; contributes zero absolute saving',
};
evidence.technicalFailures = technicalFailures;
evidence.decision = decision;
evidence.decisionReasons = decisionReasons;
graded.decisionEvidence = evidence;
graded.rateCaveat = `${graded.rateCaveat || ''} Unchanged blind-compliance verifier overhead is measured separately and added equally to both production-total paths.`.trim();

await writeFile(gradedPath, JSON.stringify(graded, null, 2) + '\n', 'utf8');

let report = await readFile(reportPath, 'utf8');
const topBlock = [
  `**Decision: ${decision}**`,
  '',
  ...decisionReasons.map((reason) => `- ${reason}`),
  '',
].join('\n');
report = report.replace(/\*\*Decision: [^\n]+\*\*[\s\S]*?(?=## 1\.)/, topBlock);
report = report.replace(
  /Full-video Pro control: TP (\d+), FP \d+, FN (\d+), critical misses (\d+)\./,
  `Full-video Pro control: TP $1, FP ${fullVideoFalsePositives}, FN $2, critical misses $3.`,
);
report = report.replace(
  /Hybrid: TP (\d+), FP \d+, FN (\d+), critical misses (\d+)\./,
  `Hybrid: TP $1, FP ${n(hybrid.falsePositives)}, FN $2, critical misses $3.`,
);
report = report.replace(
  /## 9\. Spend protections\n[^\n]*/,
  `## 9. Spend protections\nPrimary paid benchmark limits: ${JSON.stringify(paid.limits || {})}. Separate unchanged-verifier measurement limits: ${JSON.stringify(verifier?.limits || {})}. Call-count and Pro-video-second caps are pre-call guards; dollar guards use observed token usage and therefore stop after a bounded call rather than predicting its exact final charge.`,
);
report = report.replace(
  /## 16\. Full-video Pro duration\n[^\n]*/,
  `## 16. Full-video Pro duration\nEscalation comparison baseline: ${hybrid.escalationBaselineProSeconds ?? 'n/a'} seconds. Unchanged production blind-verifier Pro duration: ${hybrid.unchangedVerifierProSeconds ?? 'n/a'} seconds. Production-total baseline: ${hybrid.productionBaselineTotalProSeconds ?? 'n/a'} seconds.`,
);
report = report.replace(
  /## 17\. Targeted Pro duration\n[^\n]*/,
  `## 17. Targeted Pro duration\nHybrid escalation path: ${hybrid.escalationProVideoSeconds ?? 'n/a'} seconds. Including unchanged blind-verifier Pro media, production-total hybrid Pro duration: ${hybrid.productionTotalProSeconds ?? 'n/a'} seconds.`,
);
report = report.replace(
  /## 19\. Total inference-cost reduction\n[^\n]*/,
  `## 19. Total inference-cost reduction\nHybrid production-total model cost $${hybrid.totalModelCostUsd ?? 'n/a'} vs production-total comparison baseline $${hybrid.totalBaselineModelCostUsd ?? 'n/a'}; unchanged blind-verifier overhead $${hybrid.unchangedVerifierCostUsd ?? 'n/a'} is included equally on both sides; absolute saving $${hybrid.absoluteSavingUsd ?? 'n/a'}; ${hybrid.savingPercent ?? 'n/a'}% saving.`,
);
report = report.replace(
  /## 21\. Latency effect\n[^\n]*/,
  `## 21. Latency effect\nHybrid production-total end-to-end latency p50/p95: ${hybrid.endToEndLatencyMs?.p50 ?? 'n/a'} / ${hybrid.endToEndLatencyMs?.p95 ?? 'n/a'} ms, including measured unchanged blind-verifier latency where requirements apply.`,
);
report = report.replace(/## 24\. Decision\n\*\*[^\n]+\*\*/, `## 24. Decision\n**${decision}**`);
report = report.replace(
  '## 23. Remaining risks\n',
  '## 23. Remaining risks\nFalse positives are scored only against explicitly controlled negative defect classes; reused real-video controls are not treated as exhaustively defect-free. The blind-verifier measurement is a bounded one-pass cost/latency control and does not model rare production retries.\n\n',
);
await writeFile(reportPath, report, 'utf8');

console.log(JSON.stringify({
  decision,
  decisionReasons,
  fullVideoFalsePositives,
  hybridFalsePositives: n(hybrid.falsePositives),
  productionTotalSavingPercent: hybrid.savingPercent,
  productionTotalProDurationReductionPercent: hybrid.proVideoDurationReductionPercent,
  unchangedVerifierMeasurement: evidence.unchangedVerifierMeasurement,
}, null, 2));
