import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  VIDEO_ANALYSIS_SYSTEM_PROMPT,
  buildVideoAnalysisPrompt,
  normalizeVideoAnalysis,
} from '../../backend/video-intelligence.mjs';
import {
  buildTargetedEscalationPlan,
  collectSuspiciousIntervals,
  normalizeTargetedEscalationConfig,
} from '../../backend/targeted-escalation.mjs';
import {
  createSegmentWorkspace,
  cleanupSegmentWorkspace,
  extractMediaSegment,
  probeMedia,
} from '../../backend/targeted-escalation-media.mjs';
import {
  TARGETED_PRO_SYSTEM_PROMPT,
  buildTargetedProPrompt,
  normalizeTargetedProResult,
  parseTargetedProJson,
} from '../../backend/targeted-escalation-pro.mjs';

const region = process.env.AWS_REGION || 'eu-west-1';
const bucket = String(process.env.AWS_SAM_ARTIFACT_BUCKET || '').trim();
const liteModelId = process.env.TARGETED_BENCHMARK_LITE_MODEL_ID || 'eu.amazon.nova-2-lite-v1:0';
const proModelId = process.env.TARGETED_BENCHMARK_PRO_MODEL_ID || 'eu.amazon.nova-pro-v1:0';
const maxCases = Math.max(1, Math.min(20, Number(process.env.TARGETED_BENCHMARK_MAX_CASES || 8)));
const maxModelCalls = Math.max(1, Math.min(100, Number(process.env.TARGETED_BENCHMARK_MAX_MODEL_CALLS || 40)));
const maxProVideoSeconds = Math.max(1, Math.min(3600, Number(process.env.TARGETED_BENCHMARK_MAX_PRO_VIDEO_SECONDS || 360)));
const maxEstimatedSpendUsd = Math.max(0.01, Math.min(50, Number(process.env.TARGETED_BENCHMARK_MAX_ESTIMATED_USD || 1.5)));
const corpusDir = path.resolve(process.argv[2] || 'targeted-escalation-corpus');
const outDir = path.resolve(process.argv[3] || 'targeted-escalation-paid-results');
const manifestPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'corpus-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (!bucket) throw new Error('AWS_SAM_ARTIFACT_BUCKET is required for the paid benchmark.');

const bedrock = new BedrockRuntimeClient({ region });
const s3 = new S3Client({ region });
const runId = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
const objectPrefix = `targeted-escalation-benchmark/${runId}`;
const uploadedKeys = new Set();

const rates = {
  lite: {
    inputPerMillion: Number(process.env.NOVA_LITE_INPUT_USD_PER_M || 0.30),
    outputPerMillion: Number(process.env.NOVA_LITE_OUTPUT_USD_PER_M || 2.50),
  },
  pro: {
    inputPerMillion: Number(process.env.NOVA_PRO_INPUT_USD_PER_M || 0.92),
    outputPerMillion: Number(process.env.NOVA_PRO_OUTPUT_USD_PER_M || 3.68),
  },
};

const ledger = {
  modelCalls: 0,
  proVideoSeconds: 0,
  estimatedSpendUsd: 0,
  calls: [],
};

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 6) {
  if (!Number.isFinite(Number(value))) return null;
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function usageCost(usage, modelClass) {
  const rate = rates[modelClass];
  const input = Math.max(0, Number(usage?.inputTokens || 0));
  const output = Math.max(0, Number(usage?.outputTokens || 0));
  return input / 1_000_000 * rate.inputPerMillion
    + output / 1_000_000 * rate.outputPerMillion;
}

function assertBudgetBeforeCall({ modelClass, videoSeconds }) {
  if (ledger.modelCalls >= maxModelCalls) {
    const error = new Error(`Paid benchmark model-call cap reached (${maxModelCalls}).`);
    error.code = 'BENCHMARK_MODEL_CALL_CAP';
    throw error;
  }
  if (modelClass === 'pro') {
    const nextSeconds = ledger.proVideoSeconds + Math.max(0, Number(videoSeconds || 0));
    if (nextSeconds > maxProVideoSeconds) {
      const error = new Error(`Paid benchmark Pro video-second cap would be exceeded (${nextSeconds} > ${maxProVideoSeconds}).`);
      error.code = 'BENCHMARK_PRO_SECONDS_CAP';
      throw error;
    }
  }
  if (ledger.estimatedSpendUsd >= maxEstimatedSpendUsd) {
    const error = new Error(`Paid benchmark estimated-spend cap reached ($${ledger.estimatedSpendUsd.toFixed(6)} >= $${maxEstimatedSpendUsd}).`);
    error.code = 'BENCHMARK_SPEND_CAP';
    throw error;
  }
}

async function invokeModel({
  modelId,
  modelClass,
  callClass,
  videoUri,
  format,
  systemPrompt,
  prompt,
  videoSeconds,
  maxTokens,
  temperature = 0,
}) {
  assertBudgetBeforeCall({ modelClass, videoSeconds });
  const started = performance.now();
  const result = await bedrock.send(new ConverseCommand({
    modelId,
    system: [{ text: systemPrompt }],
    messages: [{
      role: 'user',
      content: [
        {
          video: {
            format,
            source: {
              s3Location: { uri: videoUri },
            },
          },
        },
        { text: prompt },
      ],
    }],
    inferenceConfig: {
      maxTokens,
      temperature,
      topP: 0.9,
    },
  }));
  const latencyMs = performance.now() - started;
  const usage = result?.usage || {};
  const costUsd = usageCost(usage, modelClass);

  ledger.modelCalls += 1;
  if (modelClass === 'pro') ledger.proVideoSeconds += Math.max(0, Number(videoSeconds || 0));
  ledger.estimatedSpendUsd += costUsd;
  ledger.calls.push({
    modelId,
    modelClass,
    callClass,
    videoSeconds: round(videoSeconds, 3),
    latencyMs: round(latencyMs, 2),
    usage,
    estimatedCostUsd: round(costUsd),
  });

  if (ledger.estimatedSpendUsd > maxEstimatedSpendUsd) {
    const error = new Error(`Paid benchmark estimated spend crossed cap after the latest bounded call ($${ledger.estimatedSpendUsd.toFixed(6)} > $${maxEstimatedSpendUsd}).`);
    error.code = 'BENCHMARK_SPEND_CAP_AFTER_CALL';
    throw error;
  }

  const text = (result?.output?.message?.content || [])
    .map((item) => item?.text || '')
    .join('\n')
    .trim();

  return { result, text, latencyMs, usage, costUsd };
}

async function uploadVideo(filePath, keySuffix) {
  const body = await readFile(filePath);
  const key = `${objectPrefix}/${keySuffix}`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'video/mp4',
    CacheControl: 'private, max-age=0, no-store',
    Metadata: { purpose: 'forgedirector-targeted-escalation-benchmark' },
  }));
  uploadedKeys.add(key);
  return `s3://${bucket}/${key}`;
}

async function deleteUploadedObjects() {
  for (const key of uploadedKeys) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (error) {
      console.warn('benchmark cleanup failed', { key, message: error?.message });
    }
  }
}

function parseJson(text) {
  const targeted = parseTargetedProJson(text);
  if (targeted) return targeted;
  return null;
}

async function runFullVideoAnalysis({ caseDef, videoUri, durationSeconds, modelId, modelClass, callClass }) {
  const prompt = buildVideoAnalysisPrompt({
    platform: 'General',
    objective: 'awareness',
    context: caseDef.context || '',
    transcript: '',
    declaredDurationSeconds: durationSeconds,
    requirements: caseDef.requirements || {},
  });
  const call = await invokeModel({
    modelId,
    modelClass,
    callClass,
    videoUri,
    format: 'mp4',
    systemPrompt: VIDEO_ANALYSIS_SYSTEM_PROMPT,
    prompt,
    videoSeconds: durationSeconds,
    maxTokens: 5000,
    temperature: 0.1,
  });
  const parsed = parseJson(call.text);
  if (!parsed) throw new Error(`${callClass} returned invalid JSON.`);
  const analysis = normalizeVideoAnalysis(parsed, {
    objective: 'awareness',
    requirements: caseDef.requirements || {},
    hasTranscript: false,
    declaredDurationSeconds: durationSeconds,
  });
  return { ...call, parsed, analysis };
}

function overlapSeconds(aStart, aEnd, bStart, bEnd) {
  const start = Math.max(Number(aStart), Number(bStart));
  const end = Math.min(Number(aEnd), Number(bEnd));
  return Math.max(0, end - start);
}

function findingInterval(finding) {
  const start = finite(finding?.startSeconds ?? finding?.approximateStartSeconds);
  const end = finite(finding?.endSeconds ?? finding?.approximateEndSeconds);
  if (start === null || end === null) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function matchTruth(truth, findings) {
  return findings.find((finding) => {
    if (String(finding?.defectType || '') !== String(truth?.defectType || '')) return false;
    const interval = findingInterval(finding);
    if (!interval) return false;
    return overlapSeconds(interval.start, interval.end, truth.startSeconds, truth.endSeconds) > 0
      || (interval.start === interval.end
        && interval.start >= truth.startSeconds
        && interval.start <= truth.endSeconds);
  }) || null;
}

function gradeFindings(caseDef, findings, { confirmedOnly = false } = {}) {
  const truth = caseDef.groundTruth || [];
  const candidates = (findings || []).filter((finding) => (
    !confirmedOnly || finding?.status === 'confirmed'
  ));
  const perDefect = truth.map((item) => {
    const match = matchTruth(item, candidates);
    return {
      defectType: item.defectType,
      critical: item.critical === true,
      truthStartSeconds: item.startSeconds,
      truthEndSeconds: item.endSeconds,
      detected: Boolean(match),
      matchedFindingId: match?.sourceFindingId || null,
    };
  });
  return {
    truePositives: perDefect.filter((item) => item.detected).length,
    falseNegatives: perDefect.filter((item) => !item.detected).length,
    criticalMisses: perDefect.filter((item) => item.critical && !item.detected).length,
    perDefect,
  };
}

function classifyTargetedFalseNegative({ truth, liteFindings, plan, proFindings, extractionFailed = false }) {
  if (extractionFailed) return 'extraction_failure';
  const localized = matchTruth(truth, liteFindings);
  if (!localized) return 'localization_miss';
  if (localized.routing?.targetedEligible !== true) return 'routing_failure';
  const containingWindow = (plan?.mergedIntervals || []).find((interval) => (
    overlapSeconds(interval.startSeconds, interval.endSeconds, truth.startSeconds, truth.endSeconds) > 0
  ));
  if (!containingWindow) return 'window_too_narrow';
  const related = (proFindings || []).find((finding) => finding.sourceFindingId === localized.sourceFindingId);
  if (related?.contextRequired === true) return 'context_dependency';
  if (related?.status === 'not_confirmed' || related?.status === 'uncertain') return 'model_variance_or_context';
  return 'unclassified';
}

async function runTargetedStrategy({ caseDef, sourcePath, liteAnalysis, durationSeconds, strategy, workspace }) {
  const config = normalizeTargetedEscalationConfig({
    experiments: {
      targetedEscalation: {
        enabled: true,
        strategy,
        maxProCalls: 6,
        maxTotalEscalatedSeconds: Math.min(maxProVideoSeconds, Math.max(60, durationSeconds * 2)),
        maxIndividualIntervalSeconds: Math.max(30, durationSeconds),
      },
    },
  });
  const plan = buildTargetedEscalationPlan(liteAnalysis, { durationSeconds, config });
  const proFindings = [];
  const calls = [];
  const extraction = [];
  let extractionFailed = false;

  for (const interval of plan.mergedIntervals) {
    const outputPath = path.join(workspace, `${caseDef.name}-${strategy}-${interval.intervalId}.mp4`);
    const extractionStarted = performance.now();
    let segment;
    try {
      segment = await extractMediaSegment({
        inputPath: sourcePath,
        outputPath,
        startSeconds: interval.startSeconds,
        endSeconds: interval.endSeconds,
        sourceDurationSeconds: durationSeconds,
        mode: 'accurate-transcode',
      });
    } catch (error) {
      extractionFailed = true;
      extraction.push({ intervalId: interval.intervalId, error: error.message });
      continue;
    }
    const extractionLatencyMs = performance.now() - extractionStarted;
    const segmentUri = await uploadVideo(outputPath, `${caseDef.name}/${strategy}/${interval.intervalId}.mp4`);
    const expectedFindings = interval.findings || [];
    const prompt = buildTargetedProPrompt({ segment, findings: expectedFindings });
    const call = await invokeModel({
      modelId: proModelId,
      modelClass: 'pro',
      callClass: `targeted_${strategy}`,
      videoUri: segmentUri,
      format: 'mp4',
      systemPrompt: TARGETED_PRO_SYSTEM_PROMPT,
      prompt,
      videoSeconds: segment.outputDurationSeconds ?? interval.durationSeconds,
      maxTokens: 1800,
      temperature: 0,
    });
    const parsed = parseTargetedProJson(call.text);
    const normalized = normalizeTargetedProResult(parsed || {}, {
      expectedFindings,
      segment,
    });
    proFindings.push(...normalized.findings);
    calls.push({
      intervalId: interval.intervalId,
      latencyMs: round(call.latencyMs, 2),
      usage: call.usage,
      estimatedCostUsd: round(call.costUsd),
    });
    extraction.push({
      intervalId: interval.intervalId,
      startSeconds: interval.startSeconds,
      endSeconds: interval.endSeconds,
      outputDurationSeconds: segment.outputDurationSeconds,
      extractionLatencyMs: round(extractionLatencyMs, 2),
      outputBytes: segment.outputBytes,
      mappingPrecision: segment.mappingPrecision,
    });
  }

  const grade = gradeFindings(caseDef, proFindings, { confirmedOnly: true });
  const liteFindings = collectSuspiciousIntervals(liteAnalysis, { durationSeconds });
  const falseNegativeCauses = [];
  for (const defect of grade.perDefect.filter((item) => !item.detected)) {
    const truth = (caseDef.groundTruth || []).find((item) => (
      item.defectType === defect.defectType
      && item.startSeconds === defect.truthStartSeconds
      && item.endSeconds === defect.truthEndSeconds
    ));
    if (!truth) continue;
    falseNegativeCauses.push({
      defectType: truth.defectType,
      cause: classifyTargetedFalseNegative({
        truth,
        liteFindings,
        plan,
        proFindings,
        extractionFailed,
      }),
    });
  }

  return { strategy, config, plan, proFindings, grade, calls, extraction, extractionFailed, falseNegativeCauses };
}

async function runEquivalenceControls({ caseDef, sourcePath, durationSeconds, workspace }) {
  const controls = [];
  for (const [index, truth] of (caseDef.groundTruth || []).entries()) {
    const outputPath = path.join(workspace, `${caseDef.name}-equivalence-${index + 1}.mp4`);
    const segment = await extractMediaSegment({
      inputPath: sourcePath,
      outputPath,
      startSeconds: truth.startSeconds,
      endSeconds: truth.endSeconds,
      sourceDurationSeconds: durationSeconds,
      mode: 'accurate-transcode',
    });
    const uri = await uploadVideo(outputPath, `${caseDef.name}/equivalence-${index + 1}.mp4`);
    const candidate = {
      sourceFindingId: truth.sourceFindingId || `groundtruth:${caseDef.name}:${index}`,
      defectType: truth.defectType,
      escalationReason: `Known timestamp-controlled ${truth.defectType} defect.`,
      metadata: {},
    };
    const prompt = buildTargetedProPrompt({ segment, findings: [candidate] });
    const call = await invokeModel({
      modelId: proModelId,
      modelClass: 'pro',
      callClass: 'segment_equivalence_control',
      videoUri: uri,
      format: 'mp4',
      systemPrompt: TARGETED_PRO_SYSTEM_PROMPT,
      prompt,
      videoSeconds: segment.outputDurationSeconds ?? (truth.endSeconds - truth.startSeconds),
      maxTokens: 1200,
      temperature: 0,
    });
    const parsed = parseTargetedProJson(call.text);
    const normalized = normalizeTargetedProResult(parsed || {}, {
      expectedFindings: [candidate],
      segment,
    });
    controls.push({
      truth,
      verdict: normalized.findings[0] || null,
      usage: call.usage,
      latencyMs: round(call.latencyMs, 2),
      estimatedCostUsd: round(call.costUsd),
    });
  }
  return controls;
}

function aggregateStrategy(rows, strategy) {
  const selected = rows.map((row) => row.strategies?.[strategy]).filter(Boolean);
  const tp = selected.reduce((sum, item) => sum + Number(item.grade?.truePositives || 0), 0);
  const fn = selected.reduce((sum, item) => sum + Number(item.grade?.falseNegatives || 0), 0);
  const criticalMisses = selected.reduce((sum, item) => sum + Number(item.grade?.criticalMisses || 0), 0);
  const proCalls = selected.reduce((sum, item) => sum + Number(item.calls?.length || 0), 0);
  const targetedSeconds = selected.reduce((sum, item) => sum + (item.extraction || []).reduce((inner, x) => inner + Number(x.outputDurationSeconds || 0), 0), 0);
  const extractionMs = selected.flatMap((item) => (item.extraction || []).map((x) => Number(x.extractionLatencyMs || 0)));
  return {
    truePositives: tp,
    falseNegatives: fn,
    criticalMisses,
    proCalls,
    targetedProSeconds: round(targetedSeconds, 3),
    extractionLatencyMsTotal: round(extractionMs.reduce((a, b) => a + b, 0), 2),
  };
}

await mkdir(outDir, { recursive: true });
const workspace = await createSegmentWorkspace();
const cases = manifest.cases.slice(0, maxCases);
const rows = [];
const failures = [];

try {
  for (const caseDef of cases) {
    const sourcePath = path.join(corpusDir, caseDef.file);
    try {
      const sourceProbe = await probeMedia(sourcePath);
      const durationSeconds = sourceProbe.durationSeconds;
      const sourceUri = await uploadVideo(sourcePath, `${caseDef.name}/source.mp4`);
      const ledgerStart = ledger.calls.length;

      const lite = await runFullVideoAnalysis({
        caseDef,
        videoUri: sourceUri,
        durationSeconds,
        modelId: liteModelId,
        modelClass: 'lite',
        callClass: 'lite_full_video',
      });
      const liteFindings = collectSuspiciousIntervals(lite.analysis, { durationSeconds });
      const liteGrade = gradeFindings(caseDef, liteFindings);

      const fullPro = await runFullVideoAnalysis({
        caseDef,
        videoUri: sourceUri,
        durationSeconds,
        modelId: proModelId,
        modelClass: 'pro',
        callClass: 'full_video_pro_control',
      });
      const fullProFindings = collectSuspiciousIntervals(fullPro.analysis, { durationSeconds });
      const fullProGrade = gradeFindings(caseDef, fullProFindings);

      const strategies = {};
      for (const strategy of ['conservative', 'medium', 'aggressive']) {
        strategies[strategy] = await runTargetedStrategy({
          caseDef,
          sourcePath,
          liteAnalysis: lite.analysis,
          durationSeconds,
          strategy,
          workspace,
        });
      }

      const medium = strategies.medium;
      const hybridUsesFullVideo = medium.plan.wholeVideoFallbackRequired || !medium.plan.targetedEscalationPossible;
      strategies.hybrid = hybridUsesFullVideo
        ? {
            strategy: 'hybrid',
            mode: 'whole_video_fallback',
            grade: fullProGrade,
            calls: [{ reusedFullVideoControl: true }],
            extraction: [],
            falseNegativeCauses: [],
            plan: medium.plan,
          }
        : {
            ...medium,
            strategy: 'hybrid',
            mode: 'targeted',
          };

      const equivalence = await runEquivalenceControls({
        caseDef,
        sourcePath,
        durationSeconds,
        workspace,
      });

      const currentAnalysisRoute = Array.isArray(caseDef.requirements?.continuityRules)
        && caseDef.requirements.continuityRules.length > 0
        ? 'pro_full_video_direct'
        : 'lite_full_video_no_analysis_fallback_if_substantive_and_coverage_valid';

      rows.push({
        case: caseDef.name,
        category: caseDef.category,
        durationSeconds,
        expectedRouting: caseDef.expectedRouting || null,
        currentProductionAnalysisRoute: currentAnalysisRoute,
        note: Object.keys(caseDef.requirements || {}).length > 0
          ? 'Production also runs separate full-video blind compliance verification; benchmark cost is reported separately from that existing verifier overhead.'
          : null,
        lite: {
          modelId: liteModelId,
          grade: liteGrade,
          findings: liteFindings,
          usage: lite.usage,
          latencyMs: round(lite.latencyMs, 2),
          estimatedCostUsd: round(lite.costUsd),
        },
        fullVideoPro: {
          modelId: proModelId,
          grade: fullProGrade,
          findings: fullProFindings,
          usage: fullPro.usage,
          latencyMs: round(fullPro.latencyMs, 2),
          estimatedCostUsd: round(fullPro.costUsd),
          videoSeconds: durationSeconds,
        },
        strategies,
        equivalence,
        ledgerCalls: ledger.calls.slice(ledgerStart),
      });
    } catch (error) {
      failures.push({
        case: caseDef.name,
        code: error?.code || error?.name || 'Error',
        error: error?.message || String(error),
      });
      if (String(error?.code || '').startsWith('BENCHMARK_')) break;
    }
  }
} finally {
  await cleanupSegmentWorkspace(workspace);
  await deleteUploadedObjects();
}

const strategySummary = Object.fromEntries(
  ['conservative', 'medium', 'aggressive', 'hybrid'].map((strategy) => [
    strategy,
    aggregateStrategy(rows, strategy),
  ]),
);
const baselineProSeconds = rows.reduce((sum, row) => sum + Number(row.fullVideoPro?.videoSeconds || 0), 0);
for (const summary of Object.values(strategySummary)) {
  summary.fullVideoProControlSeconds = round(baselineProSeconds, 3);
  summary.proVideoDurationReductionPercent = baselineProSeconds > 0
    ? round((baselineProSeconds - summary.targetedProSeconds) / baselineProSeconds * 100, 2)
    : null;
}

const result = {
  experimentVersion: 'fd-targeted-escalation-v1',
  corpusVersion: manifest.version,
  timestamp: new Date().toISOString(),
  region,
  liteModelId,
  proModelId,
  configuredRatesUsdPerMillionTokens: rates,
  limits: {
    maxCases,
    maxModelCalls,
    maxProVideoSeconds,
    maxEstimatedSpendUsd,
  },
  ledger: {
    ...ledger,
    proVideoSeconds: round(ledger.proVideoSeconds, 3),
    estimatedSpendUsd: round(ledger.estimatedSpendUsd),
  },
  failures,
  strategySummary,
  rows,
};

await writeFile(path.join(outDir, 'paid-results.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');

const md = [
  '# ForgeDirector targeted escalation paid benchmark',
  '',
  `- Corpus: **${manifest.version}**`,
  `- Cases completed: **${rows.length}/${cases.length}**`,
  `- Model calls: **${ledger.modelCalls}/${maxModelCalls}**`,
  `- Pro video seconds consumed: **${round(ledger.proVideoSeconds, 2)}/${maxProVideoSeconds}**`,
  `- Estimated model spend: **$${round(ledger.estimatedSpendUsd)}/$${maxEstimatedSpendUsd} cap**`,
  `- Failures: **${failures.length}**`,
  '',
  '| Strategy | TP | FN | Critical misses | Pro calls | Pro seconds | Reduction vs full-Pro control |',
  '|---|---:|---:|---:|---:|---:|---:|',
  ...Object.entries(strategySummary).map(([strategy, item]) => (
    `| ${strategy} | ${item.truePositives} | ${item.falseNegatives} | ${item.criticalMisses} | ${item.proCalls} | ${item.targetedProSeconds} | ${item.proVideoDurationReductionPercent ?? 'n/a'}% |`
  )),
  '',
  '## Important interpretation',
  '',
  '- Full-video Pro is an explicit control, not a claim that production always escalates every case.',
  '- Production analysis fallback currently sends the full original source to Pro when fallback occurs.',
  '- Requirement-bearing production analyses also have separate full-video blind compliance verification. The targeted experiment does not silently count that existing verifier overhead as a saving.',
  '- Cost values are estimates from observed Bedrock token usage and the configured rate snapshot; update rate environment variables if AWS pricing changes.',
  '',
  '## False-negative causes',
  '',
  ...rows.flatMap((row) => ['conservative', 'medium', 'aggressive'].flatMap((strategy) => (
    (row.strategies?.[strategy]?.falseNegativeCauses || []).map((item) => `- ${row.case} / ${strategy} / ${item.defectType}: ${item.cause}`)
  ))),
  '',
];
if (!rows.some((row) => ['conservative', 'medium', 'aggressive'].some((strategy) => (row.strategies?.[strategy]?.falseNegativeCauses || []).length))) {
  md.push('- None recorded.');
}
if (failures.length) {
  md.push('', '## Technical failures', '');
  md.push(...failures.map((item) => `- ${item.case}: ${item.code} — ${item.error}`));
}
await writeFile(path.join(outDir, 'paid-results.md'), md.join('\n') + '\n', 'utf8');

console.log(JSON.stringify({
  completedCases: rows.length,
  failures,
  ledger: result.ledger,
  strategySummary,
}, null, 2));

if (!rows.length || failures.some((item) => String(item.code).startsWith('BENCHMARK_'))) {
  process.exitCode = 2;
}
