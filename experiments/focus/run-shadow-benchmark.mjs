import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  FocusFrameSelector,
  HybridFrameSelector,
  UniformFrameSelector,
  selectFramesWithFallback,
} from '../../backend/frame-selection.mjs';
import { DEFECT_SELECTION_POLICY } from '../../backend/frame-selection-policy.mjs';
import { deriveFrameBudgets } from './benchmark-utils.mjs';
import { TitanMultimodalRelevanceScorer } from './titan-scorer.mjs';
import {
  buildProxyVideo,
  extractOneFpsCandidates,
  probeVideo,
} from './media.mjs';
import { runVideoBinaryQa } from './vlm.mjs';

function parseArgs(argv) {
  const args = {
    corpus: 'focus-corpus',
    manifest: 'experiments/focus/corpus-manifest.json',
    output: 'focus-benchmark-results',
    caseLimit: 0,
    caseIds: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === '--corpus' && next) {
      args.corpus = next;
      index += 1;
    } else if (value === '--manifest' && next) {
      args.manifest = next;
      index += 1;
    } else if (value === '--output' && next) {
      args.output = next;
      index += 1;
    } else if (value === '--case-limit' && next) {
      args.caseLimit = Math.max(0, Math.floor(Number(next) || 0));
      index += 1;
    } else if (value === '--case-id' && next) {
      args.caseIds.push(next);
      index += 1;
    }
  }

  return args;
}

function envNumber(name, fallback = null) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function benchmarkPricing() {
  return {
    nova: {
      inputPerMillionUsd: envNumber('NOVA_INPUT_1M_USD', 0.30),
      outputPerMillionUsd: envNumber('NOVA_OUTPUT_1M_USD', 2.50),
    },
    titan: {
      imageUsd: envNumber('TITAN_IMAGE_PRICE_USD', 0.00006),
      textPerThousandTokensUsd: envNumber('TITAN_TEXT_1K_PRICE_USD', 0.00080),
    },
    note: [
      'Nova defaults use the current public Nova 2 Lite rates cited in the experiment docs.',
      'Titan defaults use the published AWS multimodal-embedding example rate and must be rechecked against the current Bedrock price sheet when interpreting dollar results.',
    ].join(' '),
  };
}

function isInsideWindows(timestamp, windows) {
  if (!Number.isFinite(Number(timestamp)) || !Array.isArray(windows)) return null;
  if (windows.length === 0) return false;
  return windows.some(([start, end]) => (
    Number(timestamp) >= Number(start) && Number(timestamp) <= Number(end)
  ));
}

function localizationErrorSeconds(timestamp, windows) {
  if (!Number.isFinite(Number(timestamp)) || !Array.isArray(windows) || windows.length === 0) {
    return null;
  }

  const value = Number(timestamp);
  let best = Number.POSITIVE_INFINITY;
  for (const [rawStart, rawEnd] of windows) {
    const start = Number(rawStart);
    const end = Number(rawEnd);
    if (value >= start && value <= end) return 0;
    best = Math.min(best, Math.abs(value - start), Math.abs(value - end));
  }
  return Number(best.toFixed(3));
}

function confusion(expected, actual) {
  if (expected === true && actual === true) return 'true_positive';
  if (expected === true && actual === false) return 'false_negative';
  if (expected === false && actual === true) return 'false_positive';
  return 'true_negative';
}

function variantPlan(budgets) {
  return [
    {
      id: 'B_focus_conservative',
      strategy: 'focus',
      budget: budgets.conservative,
      finalArmPolicy: 'released_optimistic',
    },
    {
      id: 'C_focus_medium',
      strategy: 'focus',
      budget: budgets.medium,
      finalArmPolicy: 'released_optimistic',
    },
    {
      id: 'D_focus_aggressive',
      strategy: 'focus',
      budget: budgets.aggressive,
      finalArmPolicy: 'released_optimistic',
    },
    {
      id: 'E_hybrid_medium',
      strategy: 'hybrid',
      budget: budgets.hybrid,
      finalArmPolicy: 'released_optimistic',
    },
    {
      id: 'F_uniform_medium_control',
      strategy: 'uniform',
      budget: budgets.medium,
      finalArmPolicy: null,
    },
    {
      id: 'G_focus_medium_paper_policy',
      strategy: 'focus',
      budget: budgets.medium,
      finalArmPolicy: 'paper_empirical_mean',
    },
  ];
}

function newTitanScorer(pricing) {
  return new TitanMultimodalRelevanceScorer({
    region: process.env.AWS_REGION || 'eu-west-1',
    concurrency: envNumber('TITAN_CONCURRENCY', 4),
    pricing,
  });
}

function buildSelector(variant, scorer) {
  if (variant.strategy === 'uniform') {
    return new UniformFrameSelector({
      version: 'fd-uniform-shadow-bench-1',
    });
  }

  const focusSelector = new FocusFrameSelector({
    version: 'fd-focus-shadow-bench-1',
    scoreFrames: scorer.scoreFrames.bind(scorer),
    finalArmPolicy: variant.finalArmPolicy,
    seed: 42,
  });

  if (variant.strategy === 'hybrid') {
    return new HybridFrameSelector({
      version: 'fd-hybrid-shadow-bench-1',
      coverageRatio: 0.5,
      minCoverageFrames: 4,
      focusSelector,
    });
  }

  return focusSelector;
}

async function runSelectedVariant({
  testCase,
  variant,
  frames,
  workDirectory,
  modelId,
  pricing,
}) {
  const scorer = variant.strategy === 'uniform' ? null : newTitanScorer(pricing.titan);
  const selector = buildSelector(variant, scorer);
  const fallback = new UniformFrameSelector({ version: 'fd-uniform-benchmark-fallback-1' });

  const selectionStarted = performance.now();
  const selection = selector instanceof UniformFrameSelector
    ? await selector.select({
        frames,
        budget: variant.budget,
        query: testCase.question,
      })
    : await selectFramesWithFallback({
        primary: selector,
        fallback,
        request: {
          frames,
          budget: variant.budget,
          query: testCase.question,
        },
      });
  const selectionLatencyMs = performance.now() - selectionStarted;

  const proxyPath = join(workDirectory, variant.id + '.mp4');
  const proxy = await buildProxyVideo(selection.selectedFrames, proxyPath);
  const vlm = await runVideoBinaryQa({
    modelId,
    videoPath: proxyPath,
    question: testCase.question,
    timestampMap: proxy.timestampMap,
    pricing: pricing.nova,
  });

  const windows = testCase.defectWindowsSeconds;
  const retainedGroundTruthFrame = Array.isArray(windows) && windows.length > 0
    ? selection.selectedFrames.some((frame) => isInsideWindows(frame.timestampSeconds, windows))
    : null;

  const selectorStats = scorer ? scorer.snapshot() : {
    modelId: null,
    textCalls: 0,
    imageCalls: 0,
    textInputTokens: 0,
    imageBytes: 0,
    queryCacheHits: 0,
    imageCacheHits: 0,
    invokeLatencyMs: 0,
    scoreLatencyMs: 0,
    estimatedCostUsd: 0,
    pricing: pricing.titan,
  };

  return {
    variant: variant.id,
    strategy: variant.strategy,
    finalArmPolicy: variant.finalArmPolicy,
    requestedBudget: variant.budget,
    selectedFrameCount: selection.selectedFrames.length,
    selectedFrameIndexes: selection.selectedFrames.map((frame) => frame.index),
    selectedTimestampsSeconds: selection.selectedFrames.map((frame) => frame.timestampSeconds),
    retainedGroundTruthFrame,
    selector: {
      metadata: selection.metadata,
      stats: selectorStats,
      wallLatencyMs: Number(selectionLatencyMs.toFixed(2)),
    },
    proxy: {
      durationSeconds: proxy.probe.durationSeconds,
      sizeBytes: proxy.probe.sizeBytes,
      timestampMap: proxy.timestampMap,
    },
    vlm,
  };
}

function applyEconomicComparison(row, baseline, sourceDurationSeconds) {
  const baselineInput = Number(baseline?.vlm?.usage?.inputTokens || 0);
  const rowInput = Number(row?.vlm?.usage?.inputTokens || 0);
  const baselineCost = baseline?.vlm?.estimatedCostUsd;
  const downstreamCost = row?.vlm?.estimatedCostUsd;
  const selectionCost = row?.selector?.stats?.estimatedCostUsd ?? 0;
  const totalExperimentalCost = (
    Number.isFinite(Number(downstreamCost))
    && Number.isFinite(Number(selectionCost))
  )
    ? Number(downstreamCost) + Number(selectionCost)
    : null;

  const durationMinutes = Number(sourceDurationSeconds) > 0
    ? Number(sourceDurationSeconds) / 60
    : null;

  return {
    frameReductionRatio: row.candidateFrameCount > 0
      ? Number((1 - (row.selectedFrameCount / row.candidateFrameCount)).toFixed(4))
      : null,
    downstreamInputTokenReductionRatio: baselineInput > 0
      ? Number((1 - (rowInput / baselineInput)).toFixed(4))
      : null,
    baselineEstimatedCostUsd: baselineCost,
    selectorEstimatedCostUsd: row?.selector?.stats?.estimatedCostUsd ?? null,
    downstreamEstimatedCostUsd: downstreamCost,
    totalExperimentalEstimatedCostUsd: totalExperimentalCost === null
      ? null
      : Number(totalExperimentalCost.toFixed(8)),
    netEstimatedCostReductionUsd: (
      Number.isFinite(Number(baselineCost))
      && totalExperimentalCost !== null
    )
      ? Number((Number(baselineCost) - totalExperimentalCost).toFixed(8))
      : null,
    totalExperimentalCostPerSourceMinuteUsd: (
      totalExperimentalCost !== null
      && durationMinutes
    )
      ? Number((totalExperimentalCost / durationMinutes).toFixed(8))
      : null,
    endToEndLatencyDeltaMs: Number((
      Number(row?.selector?.wallLatencyMs || 0)
      + Number(row?.vlm?.wallLatencyMs || 0)
      - Number(baseline?.vlm?.wallLatencyMs || 0)
    ).toFixed(2)),
  };
}

function matrixFromRows(rows) {
  const matrix = {};

  for (const row of rows) {
    const category = row.defectCategory;
    const variant = row.variant;
    matrix[category] ||= {};
    matrix[category][variant] ||= {
      cases: 0,
      correct: 0,
      truePositive: 0,
      trueNegative: 0,
      falsePositive: 0,
      falseNegative: 0,
    };

    const cell = matrix[category][variant];
    cell.cases += 1;
    if (row.correct) cell.correct += 1;
    if (row.confusion === 'true_positive') cell.truePositive += 1;
    if (row.confusion === 'true_negative') cell.trueNegative += 1;
    if (row.confusion === 'false_positive') cell.falsePositive += 1;
    if (row.confusion === 'false_negative') cell.falseNegative += 1;
  }

  return matrix;
}

function missedDefectAnalysis(rows) {
  const byCase = new Map();
  for (const row of rows) {
    if (!byCase.has(row.caseId)) byCase.set(row.caseId, []);
    byCase.get(row.caseId).push(row);
  }

  const misses = [];
  for (const [caseId, caseRows] of byCase.entries()) {
    const baseline = caseRows.find((row) => row.variant === 'A_baseline');
    if (!baseline || baseline.expected !== true || baseline.correct !== true) continue;
    const hybrid = caseRows.find((row) => row.variant === 'E_hybrid_medium');

    for (const row of caseRows) {
      if (row.variant === 'A_baseline' || row.correct) continue;
      let failureClass = 'downstream_miss_unknown_localization';
      if (row.retainedGroundTruthFrame === false) {
        failureClass = 'selector_discarded_ground_truth_window';
      } else if (row.retainedGroundTruthFrame === true) {
        failureClass = 'downstream_miss_with_ground_truth_frame_retained';
      } else if (row.selector?.metadata?.fallbackUsed) {
        failureClass = 'selector_failure_used_fallback';
      }

      misses.push({
        caseId,
        defectCategory: row.defectCategory,
        variant: row.variant,
        groundTruthWindowsSeconds: row.defectWindowsSeconds,
        selectedTimestampsSeconds: row.selectedTimestampsSeconds,
        retainedGroundTruthFrame: row.retainedGroundTruthFrame,
        failureClass,
        hybridCorrect: hybrid?.correct ?? null,
        hybridRetainedGroundTruthFrame: hybrid?.retainedGroundTruthFrame ?? null,
        hybridWouldPrevent: hybrid
          ? Boolean(hybrid.correct || hybrid.retainedGroundTruthFrame === true)
          : null,
      });
    }
  }

  return misses;
}

function markdownSummary(result) {
  const lines = [
    '# ForgeDirector FOCUS shadow benchmark',
    '',
    '- Generated: ' + result.generatedAt,
    '- Model: ' + result.modelId,
    '- Cases: ' + result.caseCount,
    '- Rows: ' + result.rows.length,
    '',
    '## Variant accuracy',
    '',
    '| Variant | Correct | Cases | Accuracy | FN | FP |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ];

  const variants = {};
  for (const row of result.rows) {
    variants[row.variant] ||= { cases: 0, correct: 0, fn: 0, fp: 0 };
    const entry = variants[row.variant];
    entry.cases += 1;
    if (row.correct) entry.correct += 1;
    if (row.confusion === 'false_negative') entry.fn += 1;
    if (row.confusion === 'false_positive') entry.fp += 1;
  }

  for (const [variant, entry] of Object.entries(variants)) {
    lines.push(
      '| ' + variant
      + ' | ' + entry.correct
      + ' | ' + entry.cases
      + ' | ' + (entry.cases ? (entry.correct / entry.cases).toFixed(3) : 'n/a')
      + ' | ' + entry.fn
      + ' | ' + entry.fp
      + ' |',
    );
  }

  lines.push('', '## Baseline-detected defects missed by a smart variant', '');
  if (result.missedDefects.length === 0) {
    lines.push('None in this run.');
  } else {
    lines.push('| Case | Category | Variant | Failure class | Hybrid prevents? |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const miss of result.missedDefects) {
      lines.push(
        '| ' + miss.caseId
        + ' | ' + miss.defectCategory
        + ' | ' + miss.variant
        + ' | ' + miss.failureClass
        + ' | ' + String(miss.hybridWouldPrevent)
        + ' |',
      );
    }
  }

  lines.push(
    '',
    'Dollar estimates include selector cost when pricing inputs were supplied/defaulted.',
    'Titan image pricing is marked provisional in the result metadata and must be checked against the current Bedrock price sheet before a production decision.',
  );

  return lines.join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(resolve(args.manifest), 'utf8'));
  const corpusDirectory = resolve(args.corpus);
  const outputDirectory = resolve(args.output);
  await mkdir(outputDirectory, { recursive: true });

  let cases = Array.isArray(manifest.cases) ? manifest.cases : [];
  if (args.caseIds.length) {
    const wanted = new Set(args.caseIds);
    cases = cases.filter((item) => wanted.has(item.id));
  }
  if (args.caseLimit > 0) cases = cases.slice(0, args.caseLimit);

  const pricing = benchmarkPricing();
  const modelId = process.env.NOVA_MODEL_ID || 'eu.amazon.nova-2-lite-v1:0';
  const rows = [];

  for (const testCase of cases) {
    console.log('CASE ' + testCase.id);
    const videoPath = join(corpusDirectory, testCase.file);
    const caseDirectory = join(outputDirectory, 'work', testCase.id);
    await mkdir(caseDirectory, { recursive: true });
    const sourceProbe = await probeVideo(videoPath);
    const frames = await extractOneFpsCandidates(
      videoPath,
      join(caseDirectory, 'candidate-frames'),
    );

    if (frames.length === 0) {
      rows.push({
        caseId: testCase.id,
        defectCategory: testCase.defectCategory,
        variant: 'technical_failure',
        error: 'no_candidate_frames',
      });
      continue;
    }

    const budgets = deriveFrameBudgets(frames.length, {
      coverageRequired: Boolean(testCase.coverageRequired),
    });
    const baselineVlm = await runVideoBinaryQa({
      modelId,
      videoPath,
      question: testCase.question,
      pricing: pricing.nova,
    });
    const baseline = {
      caseId: testCase.id,
      source: testCase.source,
      defectCategory: testCase.defectCategory,
      expected: Boolean(testCase.expected),
      defectWindowsSeconds: testCase.defectWindowsSeconds,
      question: testCase.question,
      sourceDurationSeconds: sourceProbe.durationSeconds,
      candidateFrameCount: frames.length,
      policy: DEFECT_SELECTION_POLICY[testCase.defectCategory] || null,
      budgets,
      variant: 'A_baseline',
      strategy: 'provider_native_video',
      selectedFrameCount: frames.length,
      selectedFrameIndexes: frames.map((frame) => frame.index),
      selectedTimestampsSeconds: frames.map((frame) => frame.timestampSeconds),
      retainedGroundTruthFrame: Array.isArray(testCase.defectWindowsSeconds)
        && testCase.defectWindowsSeconds.length > 0
        ? frames.some((frame) => isInsideWindows(frame.timestampSeconds, testCase.defectWindowsSeconds))
        : null,
      selector: null,
      proxy: null,
      vlm: baselineVlm,
      correct: baselineVlm.answer === Boolean(testCase.expected),
      confusion: confusion(Boolean(testCase.expected), baselineVlm.answer),
      localizationErrorSeconds: localizationErrorSeconds(
        baselineVlm.sourceEvidenceTimestampSeconds,
        testCase.defectWindowsSeconds,
      ),
      economics: {
        baselineEstimatedCostUsd: baselineVlm.estimatedCostUsd,
        baselineCostPerSourceMinuteUsd: sourceProbe.durationSeconds > 0
          ? Number((
              Number(baselineVlm.estimatedCostUsd || 0)
              / (sourceProbe.durationSeconds / 60)
            ).toFixed(8))
          : null,
      },
    };
    rows.push(baseline);

    for (const variant of variantPlan(budgets)) {
      console.log('  VARIANT ' + variant.id + ' budget=' + variant.budget);
      try {
        const selected = await runSelectedVariant({
          testCase,
          variant,
          frames,
          workDirectory: caseDirectory,
          modelId,
          pricing,
        });
        const row = {
          caseId: testCase.id,
          source: testCase.source,
          defectCategory: testCase.defectCategory,
          expected: Boolean(testCase.expected),
          defectWindowsSeconds: testCase.defectWindowsSeconds,
          question: testCase.question,
          sourceDurationSeconds: sourceProbe.durationSeconds,
          candidateFrameCount: frames.length,
          policy: DEFECT_SELECTION_POLICY[testCase.defectCategory] || null,
          budgets,
          ...selected,
          correct: selected.vlm.answer === Boolean(testCase.expected),
          confusion: confusion(Boolean(testCase.expected), selected.vlm.answer),
          localizationErrorSeconds: localizationErrorSeconds(
            selected.vlm.sourceEvidenceTimestampSeconds,
            testCase.defectWindowsSeconds,
          ),
        };
        row.economics = applyEconomicComparison(row, baseline, sourceProbe.durationSeconds);
        rows.push(row);
      } catch (error) {
        rows.push({
          caseId: testCase.id,
          source: testCase.source,
          defectCategory: testCase.defectCategory,
          expected: Boolean(testCase.expected),
          defectWindowsSeconds: testCase.defectWindowsSeconds,
          question: testCase.question,
          sourceDurationSeconds: sourceProbe.durationSeconds,
          candidateFrameCount: frames.length,
          variant: variant.id,
          strategy: variant.strategy,
          finalArmPolicy: variant.finalArmPolicy,
          error: String(error?.stack || error?.message || error),
        });
      }
    }
  }

  const result = {
    schemaVersion: 'fd-focus-shadow-benchmark-1',
    generatedAt: new Date().toISOString(),
    modelId,
    region: process.env.AWS_REGION || 'eu-west-1',
    corpusSchemaVersion: manifest.schemaVersion,
    caseCount: cases.length,
    pricing,
    rows,
    perDefectMatrix: matrixFromRows(rows.filter((row) => typeof row.correct === 'boolean')),
    missedDefects: missedDefectAnalysis(rows.filter((row) => typeof row.correct === 'boolean')),
  };

  await writeFile(
    join(outputDirectory, 'results.json'),
    JSON.stringify(result, null, 2),
  );
  await writeFile(
    join(outputDirectory, 'summary.md'),
    markdownSummary(result),
  );

  console.log('WROTE ' + join(outputDirectory, 'results.json'));
  console.log('WROTE ' + join(outputDirectory, 'summary.md'));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
