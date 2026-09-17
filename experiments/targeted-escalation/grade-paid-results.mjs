import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const resultsDir = path.resolve(process.argv[2] || 'targeted-escalation-paid-results');
const inputPath = path.join(resultsDir, 'paid-results.json');
const manifestPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'corpus-manifest.json');
const result = JSON.parse(await readFile(inputPath, 'utf8'));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const rows = Array.isArray(result.rows) ? result.rows : [];
const caseDefs = new Map((manifest.cases || []).map((item) => [item.name, item]));
const strategies = ['conservative', 'medium', 'aggressive', 'hybrid'];
const targetableTypes = new Set([
  'forbidden_content_presence',
  'visible_text_defect',
  'localized_visual_artifact',
  'object_product_mismatch',
  'transition_issue',
]);
const trackedTypes = new Set(
  (manifest.cases || []).flatMap((item) => (item.groundTruth || []).map((truth) => truth.defectType)),
);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 6) {
  if (!Number.isFinite(Number(value))) return null;
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function percentile(values, p) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const index = Math.min(clean.length - 1, Math.max(0, Math.ceil((p / 100) * clean.length) - 1));
  return round(clean[index], 2);
}

function overlapSeconds(aStart, aEnd, bStart, bEnd) {
  const start = Math.max(num(aStart), num(bStart));
  const end = Math.min(num(aEnd), num(bEnd));
  return Math.max(0, end - start);
}

function findingInterval(finding) {
  const start = finite(finding?.startSeconds ?? finding?.approximateStartSeconds);
  const end = finite(finding?.endSeconds ?? finding?.approximateEndSeconds);
  if (start === null || end === null) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function findingKey(finding, index) {
  const interval = findingInterval(finding);
  return [
    finding?.sourceFindingId || `finding-${index}`,
    finding?.defectType || '',
    interval?.start ?? '',
    interval?.end ?? '',
  ].join('|');
}

function truthMatchesFinding(truth, finding) {
  if (String(finding?.defectType || '') !== String(truth?.defectType || '')) return false;
  const interval = findingInterval(finding);
  if (!interval) return false;
  return overlapSeconds(interval.start, interval.end, truth.startSeconds, truth.endSeconds) > 0
    || (interval.start === interval.end
      && interval.start >= num(truth.startSeconds)
      && interval.start <= num(truth.endSeconds));
}

function gradeFindings(caseDef, findings, { confirmedOnly = false } = {}) {
  const truth = caseDef?.groundTruth || [];
  const candidates = (Array.isArray(findings) ? findings : [])
    .filter((finding) => !confirmedOnly || finding?.status === 'confirmed')
    .filter((finding) => trackedTypes.has(String(finding?.defectType || '')));
  const uniqueCandidates = [];
  const seen = new Set();
  candidates.forEach((finding, index) => {
    const key = findingKey(finding, index);
    if (seen.has(key)) return;
    seen.add(key);
    uniqueCandidates.push(finding);
  });

  const matchedCandidateIndexes = new Set();
  const perDefect = truth.map((item) => {
    const matchIndex = uniqueCandidates.findIndex((finding) => truthMatchesFinding(item, finding));
    if (matchIndex >= 0) matchedCandidateIndexes.add(matchIndex);
    const match = matchIndex >= 0 ? uniqueCandidates[matchIndex] : null;
    return {
      defectType: item.defectType,
      critical: item.critical === true,
      truthStartSeconds: item.startSeconds,
      truthEndSeconds: item.endSeconds,
      detected: Boolean(match),
      matchedFindingId: match?.sourceFindingId || null,
    };
  });

  const falsePositiveFindings = uniqueCandidates
    .filter((finding, index) => {
      if (matchedCandidateIndexes.has(index)) return false;
      return !truth.some((item) => truthMatchesFinding(item, finding));
    })
    .map((finding) => ({
      sourceFindingId: finding?.sourceFindingId || null,
      defectType: finding?.defectType || null,
      interval: findingInterval(finding),
      status: finding?.status || null,
    }));

  return {
    truePositives: perDefect.filter((item) => item.detected).length,
    falsePositives: falsePositiveFindings.length,
    falseNegatives: perDefect.filter((item) => !item.detected).length,
    criticalMisses: perDefect.filter((item) => item.critical && !item.detected).length,
    perDefect,
    falsePositiveFindings,
  };
}

function targetedProCost(item) {
  return (item?.calls || []).reduce((sum, call) => sum + num(call?.estimatedCostUsd), 0);
}

function targetedProSeconds(item) {
  return (item?.extraction || []).reduce((sum, segment) => sum + num(segment?.outputDurationSeconds), 0);
}

function extractionLatency(item) {
  return (item?.extraction || []).reduce((sum, segment) => sum + num(segment?.extractionLatencyMs), 0);
}

function targetedLatencyMs(row, item) {
  const extraction = extractionLatency(item);
  const pro = (item?.calls || []).reduce((sum, call) => sum + num(call?.latencyMs), 0);
  return num(row?.lite?.latencyMs) + extraction + pro;
}

function strategyMode(row, strategy) {
  const item = row?.strategies?.[strategy] || {};
  if (strategy !== 'hybrid') return item?.mode || 'targeted';
  const liteFindings = Array.isArray(row?.lite?.findings) ? row.lite.findings : [];
  if (liteFindings.length === 0) return 'no_escalation';
  if (item?.mode === 'whole_video_fallback') return 'whole_video_fallback';
  return 'targeted';
}

function strategyFindings(row, strategy, mode) {
  if (mode === 'no_escalation') return [];
  if (mode === 'whole_video_fallback') return row?.fullVideoPro?.findings || [];
  return row?.strategies?.[strategy]?.proFindings || [];
}

function strategyQuality(row, strategy) {
  const caseDef = caseDefs.get(row.case) || { groundTruth: [] };
  const mode = strategyMode(row, strategy);
  return {
    mode,
    grade: gradeFindings(caseDef, strategyFindings(row, strategy, mode), {
      confirmedOnly: mode === 'targeted',
    }),
  };
}

function baselineEscalationExpected(row) {
  const caseDef = caseDefs.get(row.case);
  return Boolean((caseDef?.groundTruth || []).length);
}

function strategyEconomics(row, strategy) {
  const liteCost = num(row?.lite?.estimatedCostUsd);
  const fullProCost = num(row?.fullVideoPro?.estimatedCostUsd);
  const comparisonNeedsPro = baselineEscalationExpected(row);
  const baselineProCost = comparisonNeedsPro ? fullProCost : 0;
  const baselineCost = liteCost + baselineProCost;
  const baselineProSeconds = comparisonNeedsPro ? num(row?.fullVideoPro?.videoSeconds) : 0;
  const sourceMinutes = Math.max(0.000001, num(row?.durationSeconds) / 60);
  const item = row?.strategies?.[strategy] || {};
  const mode = strategyMode(row, strategy);

  let proCost = 0;
  let proSeconds = 0;
  let proCalls = 0;
  let endToEndLatencyMs = num(row?.lite?.latencyMs);

  if (mode === 'whole_video_fallback') {
    proCost = fullProCost;
    proSeconds = num(row?.fullVideoPro?.videoSeconds);
    proCalls = 1;
    endToEndLatencyMs += num(row?.fullVideoPro?.latencyMs);
  } else if (mode === 'targeted') {
    proCost = targetedProCost(item);
    proSeconds = targetedProSeconds(item);
    proCalls = (item?.calls || []).length;
    endToEndLatencyMs = targetedLatencyMs(row, item);
  }

  const totalCost = liteCost + proCost;
  const savingUsd = baselineCost - totalCost;
  const savingPercent = baselineCost > 0 ? savingUsd / baselineCost * 100 : null;
  const proDurationReductionPercent = baselineProSeconds > 0
    ? (baselineProSeconds - proSeconds) / baselineProSeconds * 100
    : null;

  return {
    comparisonNeedsPro,
    mode,
    liteCostUsd: round(liteCost),
    proCostUsd: round(proCost),
    totalModelCostUsd: round(totalCost),
    baselineModelCostUsd: round(baselineCost),
    absoluteSavingUsd: round(savingUsd),
    savingPercent: savingPercent === null ? null : round(savingPercent, 2),
    costPerSourceVideoMinuteUsd: round(totalCost / sourceMinutes),
    baselineCostPerSourceVideoMinuteUsd: round(baselineCost / sourceMinutes),
    proVideoSeconds: round(proSeconds, 3),
    baselineProSeconds: round(baselineProSeconds, 3),
    proDurationReductionPercent: proDurationReductionPercent === null
      ? null
      : round(proDurationReductionPercent, 2),
    proCalls,
    endToEndLatencyMs: round(endToEndLatencyMs, 2),
    extractionLatencyMs: round(extractionLatency(item), 2),
    extractionComputeCostUsd: null,
  };
}

const perCase = rows.map((row) => {
  const caseDef = caseDefs.get(row.case) || { groundTruth: [] };
  const liteGrade = gradeFindings(caseDef, row?.lite?.findings || []);
  const fullProGrade = gradeFindings(caseDef, row?.fullVideoPro?.findings || []);
  const strategyData = Object.fromEntries(strategies.map((strategy) => {
    const quality = strategyQuality(row, strategy);
    return [strategy, {
      quality: quality.grade,
      economics: strategyEconomics(row, strategy),
      falseNegativeCauses: row?.strategies?.[strategy]?.falseNegativeCauses || [],
    }];
  }));

  return {
    case: row.case,
    category: row.category,
    durationSeconds: row.durationSeconds,
    expectedRouting: caseDef.expectedRouting || null,
    groundTruth: caseDef.groundTruth || [],
    lite: {
      quality: liteGrade,
      costUsd: round(row?.lite?.estimatedCostUsd),
      latencyMs: round(row?.lite?.latencyMs, 2),
    },
    fullVideoControl: {
      quality: fullProGrade,
      costUsd: round(row?.fullVideoPro?.estimatedCostUsd),
      latencyMs: round(row?.fullVideoPro?.latencyMs, 2),
      proVideoSeconds: round(row?.fullVideoPro?.videoSeconds, 3),
    },
    strategies: strategyData,
  };
});

const aggregate = {};
for (const strategy of strategies) {
  const entries = perCase.map((row) => row.strategies[strategy]);
  const totalStrategyCost = entries.reduce((sum, item) => sum + num(item.economics.totalModelCostUsd), 0);
  const totalBaselineCost = entries.reduce((sum, item) => sum + num(item.economics.baselineModelCostUsd), 0);
  const totalSaving = totalBaselineCost - totalStrategyCost;
  const baselineProSeconds = entries.reduce((sum, item) => sum + num(item.economics.baselineProSeconds), 0);
  const proSeconds = entries.reduce((sum, item) => sum + num(item.economics.proVideoSeconds), 0);
  const totalSourceMinutes = rows.reduce((sum, row) => sum + num(row.durationSeconds) / 60, 0);
  const latencies = entries.map((item) => item.economics.endToEndLatencyMs);
  const extractionLatencies = entries.map((item) => item.economics.extractionLatencyMs);

  aggregate[strategy] = {
    totalModelCostUsd: round(totalStrategyCost),
    totalBaselineModelCostUsd: round(totalBaselineCost),
    absoluteSavingUsd: round(totalSaving),
    savingPercent: totalBaselineCost > 0 ? round(totalSaving / totalBaselineCost * 100, 2) : null,
    savingPerSourceVideoMinuteUsd: totalSourceMinutes > 0 ? round(totalSaving / totalSourceMinutes) : null,
    averageCostPerAnalysisUsd: rows.length ? round(totalStrategyCost / rows.length) : null,
    averageSavingPerAnalysisUsd: rows.length ? round(totalSaving / rows.length) : null,
    proVideoSeconds: round(proSeconds, 3),
    baselineProSeconds: round(baselineProSeconds, 3),
    proVideoDurationReductionPercent: baselineProSeconds > 0
      ? round((baselineProSeconds - proSeconds) / baselineProSeconds * 100, 2)
      : null,
    truePositives: entries.reduce((sum, item) => sum + num(item.quality.truePositives), 0),
    falsePositives: entries.reduce((sum, item) => sum + num(item.quality.falsePositives), 0),
    falseNegatives: entries.reduce((sum, item) => sum + num(item.quality.falseNegatives), 0),
    criticalMisses: entries.reduce((sum, item) => sum + num(item.quality.criticalMisses), 0),
    proCalls: entries.reduce((sum, item) => sum + num(item.economics.proCalls), 0),
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

const fullVideoAggregate = {
  truePositives: perCase.reduce((sum, row) => sum + num(row.fullVideoControl.quality.truePositives), 0),
  falsePositives: perCase.reduce((sum, row) => sum + num(row.fullVideoControl.quality.falsePositives), 0),
  falseNegatives: perCase.reduce((sum, row) => sum + num(row.fullVideoControl.quality.falseNegatives), 0),
  criticalMisses: perCase.reduce((sum, row) => sum + num(row.fullVideoControl.quality.criticalMisses), 0),
};

const hybridRegressionDetails = [];
for (const row of perCase) {
  for (const baselineDefect of row.fullVideoControl.quality.perDefect || []) {
    if (!baselineDefect.detected) continue;
    const hybridDefect = (row.strategies.hybrid.quality.perDefect || []).find((item) => (
      item.defectType === baselineDefect.defectType
      && item.truthStartSeconds === baselineDefect.truthStartSeconds
      && item.truthEndSeconds === baselineDefect.truthEndSeconds
    ));
    if (hybridDefect?.detected) continue;
    hybridRegressionDetails.push({
      case: row.case,
      defectType: baselineDefect.defectType,
      critical: baselineDefect.critical === true,
      truthStartSeconds: baselineDefect.truthStartSeconds,
      truthEndSeconds: baselineDefect.truthEndSeconds,
    });
  }
}

const equivalenceControls = rows.flatMap((row) => (
  (row.equivalence || []).map((item) => ({ case: row.case, ...item }))
));
const localizedEquivalence = equivalenceControls.filter((item) => targetableTypes.has(item?.truth?.defectType));
const localizedEquivalenceConfirmed = localizedEquivalence.filter((item) => item?.verdict?.status === 'confirmed').length;
const localizedCriticalEquivalence = localizedEquivalence.filter((item) => item?.truth?.critical === true);
const localizedCriticalEquivalenceFailures = localizedCriticalEquivalence.filter((item) => item?.verdict?.status !== 'confirmed');

const rootCauseCounts = {};
for (const row of rows) {
  for (const strategy of ['conservative', 'medium', 'aggressive']) {
    for (const item of row?.strategies?.[strategy]?.falseNegativeCauses || []) {
      const cause = String(item?.cause || 'unclassified');
      rootCauseCounts[cause] = (rootCauseCounts[cause] || 0) + 1;
    }
  }
}
for (const regression of hybridRegressionDetails) {
  const source = rows.find((row) => row.case === regression.case);
  const liteMatch = (source?.lite?.findings || []).some((finding) => truthMatchesFinding(regression, finding));
  const cause = liteMatch ? 'hybrid_confirmation_or_routing_failure' : 'localization_miss';
  rootCauseCounts[cause] = (rootCauseCounts[cause] || 0) + 1;
}

const hybrid = aggregate.hybrid;
const technicalFailures = Array.isArray(result.failures) ? result.failures.length : 0;
const criticalRegressions = hybridRegressionDetails.filter((item) => item.critical).length;
const localizedEquivalenceRate = localizedEquivalence.length
  ? round(localizedEquivalenceConfirmed / localizedEquivalence.length * 100, 2)
  : null;

const decisionThresholds = {
  candidateMinimumCostSavingPercent: 20,
  candidateMinimumProDurationReductionPercent: 30,
  candidateMinimumLocalizedEquivalenceConfirmationPercent: 90,
};

let decision;
let decisionReasons = [];
if (
  technicalFailures > 0
  || criticalRegressions > 0
  || localizedCriticalEquivalenceFailures.length > 0
  || num(hybrid.absoluteSavingUsd) <= 0
  || num(hybrid.proVideoDurationReductionPercent) <= 0
) {
  decision = 'REJECT';
  if (technicalFailures > 0) decisionReasons.push(`${technicalFailures} technical benchmark failure(s).`);
  if (criticalRegressions > 0) decisionReasons.push(`${criticalRegressions} critical detection regression(s) versus full-video Pro.`);
  if (localizedCriticalEquivalenceFailures.length > 0) decisionReasons.push(`${localizedCriticalEquivalenceFailures.length} critical localized defect(s) were not confirmed even with exact intervals.`);
  if (num(hybrid.absoluteSavingUsd) <= 0) decisionReasons.push('Hybrid did not produce positive measured model-cost savings versus the escalation comparison baseline.');
  if (num(hybrid.proVideoDurationReductionPercent) <= 0) decisionReasons.push('Hybrid did not reduce effective Pro video duration.');
} else if (
  hybridRegressionDetails.length === 0
  && hybrid.falsePositives <= fullVideoAggregate.falsePositives
  && num(hybrid.savingPercent) >= decisionThresholds.candidateMinimumCostSavingPercent
  && num(hybrid.proVideoDurationReductionPercent) >= decisionThresholds.candidateMinimumProDurationReductionPercent
  && (localizedEquivalenceRate ?? 0) >= decisionThresholds.candidateMinimumLocalizedEquivalenceConfirmationPercent
) {
  decision = 'CANDIDATE FOR CONTROLLED INTEGRATION';
  decisionReasons = [
    'No full-video-Pro detection regressions were observed in hybrid mode.',
    'Hybrid false positives did not exceed the full-video Pro control.',
    `Measured model-cost saving met the ${decisionThresholds.candidateMinimumCostSavingPercent}% experiment threshold.`,
    `Effective Pro-duration reduction met the ${decisionThresholds.candidateMinimumProDurationReductionPercent}% experiment threshold.`,
    `Localized segment-equivalence confirmation met the ${decisionThresholds.candidateMinimumLocalizedEquivalenceConfirmationPercent}% experiment threshold.`,
  ];
} else {
  decision = 'PROMISING';
  decisionReasons = [
    'No critical rejection condition was triggered, and hybrid produced positive cost and Pro-duration savings.',
    'One or more controlled-integration thresholds still require refinement or more evidence.',
  ];
}

function nextExperimentRecommendation() {
  if (decision === 'REJECT' && (num(hybrid.absoluteSavingUsd) <= 0 || num(hybrid.proVideoDurationReductionPercent) <= 0)) {
    return 'no further work in this direction';
  }
  if (num(rootCauseCounts.localization_miss) > 0) return 'TimePLE temporal localization';
  if (num(rootCauseCounts.context_dependency) > 0 || num(rootCauseCounts.model_variance_or_context) > 0) {
    return 'paired-context escalation';
  }
  if (decision === 'CANDIDATE FOR CONTROLLED INTEGRATION') {
    return 'native vLLM pruning + targeted escalation';
  }
  if (num(hybrid.proVideoDurationReductionPercent) < decisionThresholds.candidateMinimumProDurationReductionPercent) {
    return 'TimePLE temporal localization';
  }
  return 'FOCUS + targeted escalation';
}

const nextExperiment = nextExperimentRecommendation();
const decisionEvidence = {
  fullVideoControl: fullVideoAggregate,
  hybrid: {
    ...hybrid,
    detectionRegressionsVsFullPro: hybridRegressionDetails.length,
    criticalDetectionRegressionsVsFullPro: criticalRegressions,
  },
  segmentEquivalence: {
    localizedConfirmed: localizedEquivalenceConfirmed,
    localizedTotal: localizedEquivalence.length,
    localizedConfirmationRate: localizedEquivalenceRate,
    localizedCriticalFailures: localizedCriticalEquivalenceFailures,
  },
  rootCauseCounts,
  technicalFailures,
  decisionThresholds,
  decision,
  decisionReasons,
  nextExperiment,
};

const graded = {
  experimentVersion: result.experimentVersion,
  corpusVersion: result.corpusVersion,
  timestamp: result.timestamp,
  configuredRatesUsdPerMillionTokens: result.configuredRatesUsdPerMillionTokens,
  rateCaveat: 'Model-cost values use observed Bedrock token usage and the configured benchmark rate snapshot; ffmpeg compute cost is not assumed to be zero.',
  perCase,
  fullVideoAggregate,
  aggregate,
  decisionEvidence,
};

await writeFile(path.join(resultsDir, 'economic-analysis.json'), JSON.stringify(graded, null, 2) + '\n', 'utf8');

const perDefectRows = perCase.flatMap((row) => (row.groundTruth || []).map((truth) => {
  const baseline = (row.fullVideoControl.quality.perDefect || []).find((item) => (
    item.defectType === truth.defectType && item.truthStartSeconds === truth.startSeconds && item.truthEndSeconds === truth.endSeconds
  ));
  const h = (row.strategies.hybrid.quality.perDefect || []).find((item) => (
    item.defectType === truth.defectType && item.truthStartSeconds === truth.startSeconds && item.truthEndSeconds === truth.endSeconds
  ));
  return `| ${row.case} | ${truth.defectType} | ${truth.critical ? 'yes' : 'no'} | ${baseline?.detected ? 'detected' : 'missed'} | ${h?.detected ? 'detected' : 'missed'} |`;
}));

const recommendedConfig = decision === 'REJECT'
  ? 'None. Do not integrate the targeted path.'
  : 'Hybrid routing policy v1; medium context (±5s) as the default experimental window; whole-video fallback for global/context-sensitive findings and any unsafe extraction/budget condition.';

const md = [
  '# ForgeDirector targeted escalation final experiment report',
  '',
  `**Decision: ${decision}**`,
  '',
  ...decisionReasons.map((reason) => `- ${reason}`),
  '',
  '## 1. Current Lite→Pro fallback architecture',
  'Production analyzes the native private-S3 video with the primary Nova model. Existing fallback/recovery changes the model and/or prompt but not the media representation.',
  '',
  '## 2. Exact current Pro media behavior',
  'When production analysis falls back to Nova Pro, Pro receives the same original full-video S3 URI. Requirement-bearing requests also have a separate full-video blind compliance-verification path; this experiment does not hide that overhead inside claimed savings.',
  '',
  '## 3. Proposed insertion seam',
  'After a successful, substantive, full-duration Lite result and before an optional Pro confirmation. The production default remains unchanged; the experiment requires both environment and request opt-in.',
  '',
  '## 4. Defect-routing policy',
  'Localized forbidden content, visible-text defects, localized visual artifacts, object/product mismatch and transition defects may use targeted Pro when temporal evidence is usable. Global pacing, repetition, full-duration coverage, global consistency, A/V synchronization, missing global content, global continuity, character inconsistency and unlocalized findings remain on the whole-video route.',
  '',
  '## 5. Implementation changes',
  'Versioned routing/planning, opt-in gates, interval normalization, isolated media extraction, targeted-Pro prompt/result contract, source-time mapping, runtime orchestration, benchmark harnesses and manual-only paid workflow were added on the experiment branch. `/v1/analyze` default behavior was not changed.',
  '',
  '## 6. Interval/padding design',
  'Conservative ±10s, medium ±5s and aggressive ±2s are benchmarked. Intervals are clamped and deterministically merged using strategy-specific gap thresholds.',
  '',
  '## 7. Extraction design',
  'An isolated ffmpeg adapter preserves audio where present. Accurate-transcode is the primary benchmark representation; stream-copy remains explicitly keyframe-approximate. Temporary media is cleaned after use.',
  '',
  '## 8. Cache-isolation design',
  'Experimental identity includes experiment/policy/media versions, strategy, padding, merge gap, limits, model IDs, prompt versions, source fingerprint and merged intervals. Baseline cache identity is unchanged.',
  '',
  '## 9. Spend protections',
  `Paid benchmark caps: ${JSON.stringify(result.limits || {})}. Runtime planning also limits Pro calls, total escalated duration and individual interval duration.`,
  '',
  '## 10. Tests added',
  'Unit coverage includes gating, routing, interval padding/merging, spend limits, cache isolation, source-time mapping, target-Pro normalization, runtime fallback semantics, malformed/short media, extraction and benchmark economics. Normal CI contains no paid inference.',
  '',
  '## 11. Benchmark corpus',
  `Corpus ${manifest.version}; ${rows.length} paid case(s) completed. It contains timestamp-controlled localized defects, global/context-sensitive controls, no-defect controls and reused real-video controls when included by the selected case limit.`,
  '',
  '## 12. Baseline accuracy',
  `Full-video Pro control: TP ${fullVideoAggregate.truePositives}, FP ${fullVideoAggregate.falsePositives}, FN ${fullVideoAggregate.falseNegatives}, critical misses ${fullVideoAggregate.criticalMisses}.`,
  '',
  '## 13. Targeted accuracy',
  `Hybrid: TP ${hybrid.truePositives}, FP ${hybrid.falsePositives}, FN ${hybrid.falseNegatives}, critical misses ${hybrid.criticalMisses}.`,
  '',
  '## 14. Per-defect results',
  '| Case | Defect | Critical | Full-video Pro | Hybrid |',
  '|---|---|---|---|---|',
  ...(perDefectRows.length ? perDefectRows : ['| none | none | - | - | - |']),
  '',
  '## 15. False-negative/root-cause analysis',
  `Root-cause counts: ${JSON.stringify(rootCauseCounts)}. Hybrid detection regressions versus full-video Pro: ${hybridRegressionDetails.length}; critical regressions: ${criticalRegressions}.`,
  '',
  '## 16. Full-video Pro duration',
  `${hybrid.baselineProSeconds} seconds in the escalation comparison baseline. Clean controls that do not require escalation are not falsely charged a fallback call.`,
  '',
  '## 17. Targeted Pro duration',
  `${hybrid.proVideoSeconds} effective Pro seconds in hybrid mode.`,
  '',
  '## 18. Total Pro-call reduction',
  `Hybrid made ${hybrid.proCalls} effective Pro call(s) across the graded corpus. Baseline fallback comparison uses one full-Pro call only for cases with benchmark ground-truth defects.`,
  '',
  '## 19. Total inference-cost reduction',
  `Hybrid model cost $${hybrid.totalModelCostUsd} vs comparison baseline $${hybrid.totalBaselineModelCostUsd}; absolute saving $${hybrid.absoluteSavingUsd}; ${hybrid.savingPercent ?? 'n/a'}% saving.`,
  '',
  '## 20. Extraction overhead',
  `Hybrid extraction latency p50/p95: ${hybrid.extractionLatencyMs.p50 ?? 'n/a'} / ${hybrid.extractionLatencyMs.p95 ?? 'n/a'} ms. Extraction compute cost is not assumed to be zero and is not fabricated from token telemetry.`,
  '',
  '## 21. Latency effect',
  `Hybrid end-to-end latency p50/p95: ${hybrid.endToEndLatencyMs.p50 ?? 'n/a'} / ${hybrid.endToEndLatencyMs.p95 ?? 'n/a'} ms. Per-case baseline/strategy latency is retained in economic-analysis.json.`,
  '',
  '## 22. Recommended padding/routing configuration',
  recommendedConfig,
  '',
  '## 23. Remaining risks',
  'Lite localization error, context-dependent defects, media re-encoding effects, provider variance, ffmpeg operational overhead, and the unchanged full-video blind compliance verifier remain explicit risks. Cost estimates depend on the configured price snapshot.',
  '',
  '## 24. Decision',
  `**${decision}**`,
  '',
  '## 25. Recommended next experiment',
  `**${nextExperiment}**`,
  '',
  '### Decision-gate thresholds used for this experiment',
  `- Candidate minimum measured model-cost saving: ${decisionThresholds.candidateMinimumCostSavingPercent}%`,
  `- Candidate minimum effective Pro-duration reduction: ${decisionThresholds.candidateMinimumProDurationReductionPercent}%`,
  `- Candidate minimum localized segment-equivalence confirmation: ${decisionThresholds.candidateMinimumLocalizedEquivalenceConfirmationPercent}%`,
  '- Any critical detection regression versus full-video Pro is a rejection condition.',
  '',
  'These thresholds are experiment gates, not universal claims about acceptable production quality.',
  '',
];

await writeFile(path.join(resultsDir, 'economic-analysis.md'), md.join('\n') + '\n', 'utf8');
console.log(JSON.stringify(decisionEvidence, null, 2));
