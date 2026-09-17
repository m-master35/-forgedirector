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

function n(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
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

const evidence = graded.decisionEvidence || {};
const hybrid = graded.aggregate?.hybrid || {};
const technicalFailures = n(evidence.technicalFailures);
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
  if (technicalFailures > 0) decisionReasons.push(`${technicalFailures} technical benchmark failure(s).`);
  if (criticalRegressions > 0) decisionReasons.push(`${criticalRegressions} critical detection regression(s) versus full-video Pro.`);
  if (localizedCriticalFailures > 0) decisionReasons.push(`${localizedCriticalFailures} critical localized exact-segment confirmation failure(s).`);
  if (n(hybrid.absoluteSavingUsd) <= 0) decisionReasons.push('Hybrid did not produce positive measured model-cost savings versus the escalation comparison baseline.');
  if (n(hybrid.proVideoDurationReductionPercent) <= 0) decisionReasons.push('Hybrid did not reduce effective Pro video duration.');
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
    `Measured model-cost saving met the ${thresholds.candidateMinimumCostSavingPercent}% experiment threshold.`,
    `Effective Pro-duration reduction met the ${thresholds.candidateMinimumProDurationReductionPercent}% experiment threshold.`,
    `Localized segment-equivalence confirmation met the ${thresholds.candidateMinimumLocalizedEquivalenceConfirmationPercent}% experiment threshold.`,
  ];
} else {
  decision = 'PROMISING';
  decisionReasons = [
    'No critical rejection condition was triggered, and hybrid produced positive cost and Pro-duration savings.',
    'One or more controlled-integration thresholds still require refinement or more evidence.',
  ];
}

evidence.fullVideoControl = evidence.fullVideoControl || {};
evidence.fullVideoControl.falsePositives = fullVideoFalsePositives;
evidence.hybrid = evidence.hybrid || {};
evidence.hybrid.falsePositives = n(hybrid.falsePositives);
evidence.falsePositiveScoring = {
  method: 'explicit_controlled_negative_defect_classes_only',
  note: 'Reused real videos are not assumed exhaustively defect-free.',
};
evidence.decision = decision;
evidence.decisionReasons = decisionReasons;
graded.decisionEvidence = evidence;

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
report = report.replace(/## 24\. Decision\n\*\*[^\n]+\*\*/, `## 24. Decision\n**${decision}**`);
report = report.replace(
  '## 23. Remaining risks\n',
  '## 23. Remaining risks\nFalse positives are scored only against explicitly controlled negative defect classes; reused real-video controls are not treated as exhaustively defect-free.\n\n',
);
await writeFile(reportPath, report, 'utf8');

console.log(JSON.stringify({
  decision,
  decisionReasons,
  fullVideoFalsePositives,
  hybridFalsePositives: n(hybrid.falsePositives),
}, null, 2));
