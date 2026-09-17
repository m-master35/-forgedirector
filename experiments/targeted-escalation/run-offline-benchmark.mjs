import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildTargetedEscalationPlan,
  normalizeTargetedEscalationConfig,
} from '../../backend/targeted-escalation.mjs';
import {
  extractMediaSegment,
  probeMedia,
} from '../../backend/targeted-escalation-media.mjs';
import {
  effectiveEscalationMetrics,
  summarizeLatency,
} from './benchmark-utils.mjs';

const corpusDir = path.resolve(process.argv[2] || 'targeted-escalation-corpus');
const outDir = path.resolve(process.argv[3] || 'targeted-escalation-offline-results');
const manifestPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'corpus-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

const strategies = ['conservative', 'medium', 'aggressive', 'hybrid'];

function midpoint(item) {
  return (Number(item.startSeconds) + Number(item.endSeconds)) / 2;
}

function issueText(defectType) {
  switch (defectType) {
    case 'visible_text_defect':
      return 'Visible text contains a spelling typo and wording defect.';
    case 'object_product_mismatch':
      return 'Product label/object mismatch appears in this scene.';
    case 'localized_visual_artifact':
      return 'Localized visual artifact, distortion and rendering glitch are visible.';
    case 'transition_issue':
      return 'Transition contains a black flash and cut defect.';
    case 'global_continuity':
      return 'Continuity changes across earlier and later scenes and requires global comparison.';
    case 'global_pacing':
      return 'Pacing is too slow across the whole video.';
    default:
      return 'Unlocalized issue.';
  }
}

function structuralLiteFixture(caseDef, durationSeconds) {
  const timeline = [];
  const checks = [];

  for (const expected of caseDef.expectedChecks || []) {
    const matchingTruth = (caseDef.groundTruth || []).find((item) => (
      expected.type === 'mustNotShow' && item.defectType === 'forbidden_content_presence'
    ));

    checks.push({
      type: expected.type,
      rule: expected.rule,
      status: expected.status,
      evidence: expected.status === 'fail'
        ? 'Structural benchmark expected failure.'
        : 'Structural benchmark expected pass.',
      timestampSeconds: matchingTruth ? midpoint(matchingTruth) : null,
    });
  }

  for (const truth of caseDef.groundTruth || []) {
    timeline.push({
      startSeconds: truth.startSeconds,
      endSeconds: truth.endSeconds,
      purpose: truth.defectType === 'transition_issue' ? 'transition' : 'other',
      visual: 'Timestamp-controlled structural defect fixture.',
      issues: truth.defectType === 'forbidden_content_presence'
        ? []
        : [issueText(truth.defectType)],
      recommendations: [],
    });
  }

  // Preserve a full-duration evidence window without adding a finding.
  timeline.push({
    startSeconds: 0,
    endSeconds: durationSeconds,
    purpose: 'other',
    visual: 'Structural benchmark full-video coverage fixture.',
    issues: [],
    recommendations: [],
  });

  return {
    timeline,
    compliance: { checks },
    regenerationPrompts: [],
    retentionRisks: [],
  };
}

await mkdir(outDir, { recursive: true });

const rows = [];
const extractionLatencies = [];
const failures = [];

for (const caseDef of manifest.cases) {
  const sourcePath = path.join(corpusDir, caseDef.file);

  let sourceProbe;
  try {
    sourceProbe = await probeMedia(sourcePath);
  } catch (error) {
    failures.push({ case: caseDef.name, stage: 'probe', error: error.message });
    continue;
  }

  const durationSeconds = sourceProbe.durationSeconds;
  const analysis = structuralLiteFixture(caseDef, durationSeconds);

  for (const strategy of strategies) {
    const config = normalizeTargetedEscalationConfig({
      experiments: {
        targetedEscalation: {
          enabled: true,
          strategy,
          maxProCalls: 6,
          maxTotalEscalatedSeconds: Math.max(60, durationSeconds * 2),
          maxIndividualIntervalSeconds: Math.max(30, durationSeconds),
        },
      },
    });

    const plan = buildTargetedEscalationPlan(analysis, { durationSeconds, config });
    const mediaEconomics = effectiveEscalationMetrics(durationSeconds, plan);

    const segmentDir = path.join(outDir, 'segments', caseDef.name, strategy);
    if (plan.mergedIntervals.length) await mkdir(segmentDir, { recursive: true });

    const extracted = [];
    for (const interval of plan.mergedIntervals) {
      const outputPath = path.join(segmentDir, `${interval.intervalId}.mp4`);
      const started = performance.now();
      try {
        const result = await extractMediaSegment({
          inputPath: sourcePath,
          outputPath,
          startSeconds: interval.startSeconds,
          endSeconds: interval.endSeconds,
          sourceDurationSeconds: durationSeconds,
          mode: 'accurate-transcode',
        });
        const latencyMs = performance.now() - started;
        extractionLatencies.push(latencyMs);
        extracted.push({
          intervalId: interval.intervalId,
          sourceStartSeconds: interval.startSeconds,
          sourceEndSeconds: interval.endSeconds,
          requestedDurationSeconds: interval.durationSeconds,
          outputDurationSeconds: result.outputDurationSeconds,
          outputBytes: result.outputBytes,
          latencyMs: Math.round(latencyMs * 100) / 100,
          mappingPrecision: result.mappingPrecision,
        });
      } catch (error) {
        failures.push({
          case: caseDef.name,
          strategy,
          intervalId: interval.intervalId,
          stage: 'extract',
          error: error.message,
        });
      }
    }

    const expectedWholeVideo = caseDef.expectedRouting === 'whole_video';
    const routingExpectationMet = expectedWholeVideo
      ? plan.wholeVideoFindings.length > 0
      : plan.wholeVideoFindings.length === 0;

    rows.push({
      case: caseDef.name,
      category: caseDef.category,
      strategy,
      durationSeconds,
      findings: plan.findings.length,
      eligibleFindings: plan.eligibleFindings.length,
      wholeVideoFindings: plan.wholeVideoFindings.length,
      mergedIntervals: plan.mergedIntervals.length,
      proCallsAvoidedByMerging: plan.mergeStats.proCallsAvoidedByMerging,
      targetedEscalationPossible: plan.targetedEscalationPossible,
      wholeVideoFallbackRequired: plan.wholeVideoFallbackRequired,
      routingExpectationMet,
      budget: plan.budget,
      mediaEconomics,
      extracted,
    });
  }

  // Exact-ground-truth segment-equivalence control. This isolates the question:
  // can Pro detect the defect when localization is perfect?
  for (const [index, truth] of (caseDef.groundTruth || []).entries()) {
    const eqDir = path.join(outDir, 'equivalence', caseDef.name);
    await mkdir(eqDir, { recursive: true });
    const outputPath = path.join(eqDir, `truth-${index + 1}.mp4`);
    const started = performance.now();
    try {
      const result = await extractMediaSegment({
        inputPath: sourcePath,
        outputPath,
        startSeconds: truth.startSeconds,
        endSeconds: truth.endSeconds,
        sourceDurationSeconds: durationSeconds,
        mode: 'accurate-transcode',
      });
      const latencyMs = performance.now() - started;
      extractionLatencies.push(latencyMs);
      rows.push({
        case: caseDef.name,
        category: caseDef.category,
        strategy: 'segment_equivalence_control',
        durationSeconds,
        defectType: truth.defectType,
        critical: truth.critical === true,
        sourceStartSeconds: truth.startSeconds,
        sourceEndSeconds: truth.endSeconds,
        outputDurationSeconds: result.outputDurationSeconds,
        outputBytes: result.outputBytes,
        extractionLatencyMs: Math.round(latencyMs * 100) / 100,
        mappingPrecision: result.mappingPrecision,
      });
    } catch (error) {
      failures.push({
        case: caseDef.name,
        strategy: 'segment_equivalence_control',
        stage: 'extract',
        error: error.message,
      });
    }
  }
}

const strategyRows = rows.filter((row) => strategies.includes(row.strategy));
const latency = summarizeLatency(extractionLatencies);
const routingExpectationFailures = strategyRows
  .filter((row) => row.routingExpectationMet === false)
  .map((row) => ({ case: row.case, strategy: row.strategy }));

const byStrategy = Object.fromEntries(strategies.map((strategy) => {
  const selected = strategyRows.filter((row) => row.strategy === strategy);
  const baselineSeconds = selected.reduce((sum, row) => sum + (row.mediaEconomics.baselineProSeconds || 0), 0);
  const effectiveSeconds = selected.reduce((sum, row) => sum + (row.mediaEconomics.effectiveProSeconds || 0), 0);
  const reductionSeconds = Math.max(0, baselineSeconds - effectiveSeconds);
  return [strategy, {
    cases: selected.length,
    baselineProSeconds: Math.round(baselineSeconds * 1000) / 1000,
    effectiveProSeconds: Math.round(effectiveSeconds * 1000) / 1000,
    reductionSeconds: Math.round(reductionSeconds * 1000) / 1000,
    reductionPercent: baselineSeconds > 0
      ? Math.round((reductionSeconds / baselineSeconds) * 10000) / 100
      : null,
  }];
}));

const summary = {
  corpusVersion: manifest.version,
  casesAttempted: manifest.cases.length,
  structuralRows: strategyRows.length,
  failures,
  extractionLatencyMs: latency,
  routingExpectationFailures,
  byStrategy,
  rows,
};

await Promise.all([
  writeFile(
    path.join(outDir, 'offline-results.json'),
    JSON.stringify(summary, null, 2) + '\n',
    'utf8',
  ),
  writeFile(
    path.join(outDir, 'offline-results.md'),
    [
      '# ForgeDirector targeted escalation offline structural benchmark',
      '',
      `- Corpus: **${manifest.version}**`,
      `- Cases attempted: **${manifest.cases.length}**`,
      `- Structural strategy rows: **${strategyRows.length}**`,
      `- Extraction failures: **${failures.length}**`,
      `- Routing expectation failures: **${routingExpectationFailures.length}**`,
      `- Extraction latency p50/p95: **${latency.p50 ?? 'n/a'} / ${latency.p95 ?? 'n/a'} ms**`,
      '',
      '## Effective Pro-media comparison',
      '',
      '| Strategy | Baseline Pro seconds | Effective Pro seconds | Reduction |',
      '|---|---:|---:|---:|',
      ...strategies.map((strategy) => {
        const item = byStrategy[strategy];
        return `| ${strategy} | ${item.baselineProSeconds} | ${item.effectiveProSeconds} | ${item.reductionPercent ?? 'n/a'}% |`;
      }),
      '',
      '| Case | Category | Strategy | Eligible | Whole-video | Targeted segment seconds | Effective route | Effective Pro seconds | Effective reduction |',
      '|---|---|---|---:|---:|---:|---|---:|---:|',
      ...strategyRows.map((row) => (
        `| ${row.case} | ${row.category} | ${row.strategy} | ${row.eligibleFindings} | ${row.wholeVideoFindings} | ${row.mediaEconomics.targetedSegmentSeconds} | ${row.mediaEconomics.effectiveRoute} | ${row.mediaEconomics.effectiveProSeconds} | ${row.mediaEconomics.reductionPercent ?? 'n/a'}% |`
      )),
      '',
      'The baseline/effective seconds above model the escalation-confirmation call only. The existing blind compliance verifier is deliberately excluded here and must be reported separately in the paid benchmark; this prevents targeted savings from hiding an unchanged full-video Pro verifier call.',
      '',
      'This is a structural benchmark only. It validates routing, padding, merging, extraction, source-time mapping assumptions and potential Pro-duration reduction. It does **not** claim model-quality preservation or monetary savings until a paid model benchmark is run.',
      '',
    ].join('\n'),
    'utf8',
  ),
]);

if (failures.length || routingExpectationFailures.length) {
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 2;
} else {
  console.log(JSON.stringify(summary, null, 2));
}
