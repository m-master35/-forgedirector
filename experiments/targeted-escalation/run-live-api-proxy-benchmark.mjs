import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

const API_URL = String(process.env.API_URL || '').replace(/\/+$/, '');
const RAPIDAPI_PROXY_SECRET = String(process.env.RAPIDAPI_PROXY_SECRET || '');
const corpusDir = path.resolve(process.argv[2] || 'targeted-escalation-corpus');
const outDir = path.resolve(process.argv[3] || 'targeted-escalation-live-api-proxy-results');
const maxCases = Math.max(1, Math.min(6, Number(process.env.TARGETED_PROXY_MAX_CASES || 3)));
const maxApiAnalyzeCalls = Math.max(1, Math.min(24, Number(process.env.TARGETED_PROXY_MAX_ANALYZE_CALLS || 12)));
const maxProAnalysisSeconds = Math.max(1, Math.min(600, Number(process.env.TARGETED_PROXY_MAX_PRO_SECONDS || 180)));
const maxEstimatedUsdUpper = Math.max(0.01, Math.min(10, Number(process.env.TARGETED_PROXY_MAX_ESTIMATED_USD || 0.75)));
const manifestPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'corpus-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (!API_URL) throw new Error('API_URL is required.');
if (!RAPIDAPI_PROXY_SECRET) throw new Error('RAPIDAPI_PROXY_SECRET is required.');

const rates = {
  lite: { inputPerMillion: 0.30, outputPerMillion: 2.50 },
  pro: { inputPerMillion: 0.92, outputPerMillion: 3.68 },
};

const ledger = {
  analyzeCalls: 0,
  proAnalysisSeconds: 0,
  verifierProVideoSeconds: 0,
  verifierLiteVideoSeconds: 0,
  estimatedUsdLower: 0,
  estimatedUsdUpper: 0,
  calls: [],
};

function round(value, digits = 6) {
  if (!Number.isFinite(Number(value))) return null;
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function modelClass(modelId) {
  return String(modelId || '').toLowerCase().includes('pro') ? 'pro' : 'lite';
}

function usageCost(usage, klass) {
  const rate = rates[klass];
  const input = Math.max(0, Number(usage?.inputTokens || 0));
  const output = Math.max(0, Number(usage?.outputTokens || 0));
  return input / 1_000_000 * rate.inputPerMillion
    + output / 1_000_000 * rate.outputPerMillion;
}

function overlapSeconds(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(Number(aEnd), Number(bEnd)) - Math.max(Number(aStart), Number(bStart)));
}

function findingInterval(finding) {
  const start = Number(finding?.approximateStartSeconds ?? finding?.startSeconds);
  const end = Number(finding?.approximateEndSeconds ?? finding?.endSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function matchTruth(truth, findings) {
  return (findings || []).find((finding) => {
    if (String(finding?.defectType || '') !== String(truth?.defectType || '')) return false;
    const interval = findingInterval(finding);
    if (!interval) return false;
    return overlapSeconds(interval.start, interval.end, truth.startSeconds, truth.endSeconds) > 0
      || (interval.start === interval.end
        && interval.start >= truth.startSeconds
        && interval.start <= truth.endSeconds);
  }) || null;
}

function gradeFindings(caseDef, findings) {
  const perDefect = (caseDef.groundTruth || []).map((truth) => ({
    defectType: truth.defectType,
    critical: truth.critical === true,
    startSeconds: truth.startSeconds,
    endSeconds: truth.endSeconds,
    detected: Boolean(matchTruth(truth, findings)),
  }));
  return {
    truePositives: perDefect.filter((x) => x.detected).length,
    falseNegatives: perDefect.filter((x) => !x.detected).length,
    criticalMisses: perDefect.filter((x) => x.critical && !x.detected).length,
    perDefect,
  };
}

function forceProRequirements(requirements = {}) {
  const continuityRules = Array.isArray(requirements.continuityRules)
    ? [...requirements.continuityRules]
    : [];
  continuityRules.push('Benchmark routing control: inspect cross-frame visual consistency within this supplied clip.');
  return {
    ...requirements,
    continuityRules,
  };
}

function assertBudgetBeforeAnalyze(expectedProSeconds = 0) {
  if (ledger.analyzeCalls >= maxApiAnalyzeCalls) {
    const error = new Error(`Live API proxy analyze-call cap reached (${maxApiAnalyzeCalls}).`);
    error.code = 'PROXY_ANALYZE_CALL_CAP';
    throw error;
  }
  if (ledger.proAnalysisSeconds + expectedProSeconds > maxProAnalysisSeconds) {
    const error = new Error(`Live API proxy Pro-second cap would be exceeded (${ledger.proAnalysisSeconds + expectedProSeconds} > ${maxProAnalysisSeconds}).`);
    error.code = 'PROXY_PRO_SECONDS_CAP';
    throw error;
  }
  if (ledger.estimatedUsdUpper >= maxEstimatedUsdUpper) {
    const error = new Error(`Live API proxy conservative spend estimate reached the cap ($${ledger.estimatedUsdUpper.toFixed(6)} >= $${maxEstimatedUsdUpper}).`);
    error.code = 'PROXY_SPEND_CAP';
    throw error;
  }
}

async function responseJson(response, label) {
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok) {
    throw new Error(`${label} failed HTTP ${response.status}: ${JSON.stringify(parsed).slice(0, 1000)}`);
  }
  return parsed;
}

async function uploadAsset(filePath) {
  const body = await readFile(filePath);
  const create = await fetch(`${API_URL}/v1/uploads`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rapidapi-proxy-secret': RAPIDAPI_PROXY_SECRET,
    },
    body: JSON.stringify({ contentType: 'video/mp4', sizeBytes: body.byteLength }),
  });
  const created = await responseJson(create, 'upload reservation');
  const uploadUrl = created?.upload?.uploadUrl;
  const assetId = created?.upload?.assetId;
  if (!uploadUrl || !assetId) throw new Error('Upload reservation did not return uploadUrl and assetId.');

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'video/mp4' },
    body,
  });
  if (!put.ok) throw new Error(`Presigned upload failed HTTP ${put.status}.`);
  return assetId;
}

async function analyzeViaLiveApi({ filePath, durationSeconds, caseDef, callClass, forcePro, contextSuffix = '' }) {
  assertBudgetBeforeAnalyze(forcePro ? durationSeconds : 0);
  const assetId = await uploadAsset(filePath);
  const requirements = forcePro ? forceProRequirements(caseDef.requirements || {}) : {};
  const payload = {
    assetId,
    platform: 'General',
    objective: 'awareness',
    durationSeconds,
    context: [caseDef.context || '', contextSuffix].filter(Boolean).join('\n\n'),
    requirements,
  };

  const started = performance.now();
  const response = await fetch(`${API_URL}/v1/analyze`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rapidapi-proxy-secret': RAPIDAPI_PROXY_SECRET,
    },
    body: JSON.stringify(payload),
  });
  const json = await responseJson(response, callClass);
  const latencyMs = performance.now() - started;
  const meta = json?.meta || {};
  const analysis = json?.analysis;
  if (!analysis) throw new Error(`${callClass} returned no analysis object.`);

  const analysisClass = modelClass(meta.modelId);
  const analysisCost = usageCost(meta.usage, analysisClass);
  const verifierUsage = meta.complianceVerificationUsage || null;
  const verifierLower = verifierUsage ? usageCost(verifierUsage, 'lite') : 0;
  const verifierUpper = verifierUsage ? usageCost(verifierUsage, 'pro') : 0;
  const verifierModelIds = Array.isArray(meta.complianceVerificationModelIds)
    ? meta.complianceVerificationModelIds
    : [];

  ledger.analyzeCalls += 1;
  if (analysisClass === 'pro') ledger.proAnalysisSeconds += durationSeconds;
  for (const id of verifierModelIds) {
    if (modelClass(id) === 'pro') ledger.verifierProVideoSeconds += durationSeconds;
    else ledger.verifierLiteVideoSeconds += durationSeconds;
  }
  ledger.estimatedUsdLower += analysisCost + verifierLower;
  ledger.estimatedUsdUpper += analysisCost + verifierUpper;
  ledger.calls.push({
    callClass,
    durationSeconds: round(durationSeconds, 3),
    modelId: meta.modelId || null,
    analysisClass,
    analysisUsage: meta.usage || null,
    analysisEstimatedUsd: round(analysisCost),
    complianceVerificationUsed: meta.complianceVerificationUsed === true,
    complianceVerificationModelIds: verifierModelIds,
    complianceVerificationUsage: verifierUsage,
    verifierEstimatedUsdLower: round(verifierLower),
    verifierEstimatedUsdUpper: round(verifierUpper),
    analysisRetryUsed: meta.analysisRetryUsed === true,
    coverageRetryUsed: meta.coverageRetryUsed === true,
    latencyMs: round(latencyMs, 2),
  });

  if (ledger.estimatedUsdUpper > maxEstimatedUsdUpper) {
    const error = new Error(`Live API proxy conservative spend estimate crossed cap after ${callClass} ($${ledger.estimatedUsdUpper.toFixed(6)} > $${maxEstimatedUsdUpper}).`);
    error.code = 'PROXY_SPEND_CAP_AFTER_CALL';
    throw error;
  }

  return { json, analysis, meta, latencyMs, analysisCost, verifierLower, verifierUpper };
}

function mapSegmentFindingsToSource(findings, segment) {
  return (findings || []).map((finding) => {
    const start = Number(finding?.approximateStartSeconds);
    const end = Number(finding?.approximateEndSeconds);
    return {
      ...finding,
      approximateStartSeconds: Number.isFinite(start)
        ? round(segment.sourceStartSeconds + start, 3)
        : null,
      approximateEndSeconds: Number.isFinite(end)
        ? round(segment.sourceStartSeconds + end, 3)
        : null,
      segmentRelativeStartSeconds: Number.isFinite(start) ? round(start, 3) : null,
      segmentRelativeEndSeconds: Number.isFinite(end) ? round(end, 3) : null,
      segmentSourceStartSeconds: segment.sourceStartSeconds,
      segmentSourceEndSeconds: segment.sourceEndSeconds,
    };
  });
}

await mkdir(outDir, { recursive: true });
const workspace = await createSegmentWorkspace();
const targetableCases = manifest.cases.filter((item) => (
  !item.expectedRouting && (item.groundTruth || []).length > 0
)).slice(0, maxCases);
const rows = [];
const failures = [];

try {
  for (const caseDef of targetableCases) {
    try {
      const sourcePath = path.join(corpusDir, caseDef.file);
      const probe = await probeMedia(sourcePath);
      const durationSeconds = probe.durationSeconds;
      if (!durationSeconds) throw new Error('Could not determine source duration.');

      const lite = await analyzeViaLiveApi({
        filePath: sourcePath,
        durationSeconds,
        caseDef,
        callClass: `${caseDef.name}:lite-localization`,
        forcePro: false,
        contextSuffix: 'Localization pass: report genuine localized defects with timestamps. No requirements are being asserted in this pass.',
      });
      const liteFindings = collectSuspiciousIntervals(lite.analysis, { durationSeconds });
      const liteGrade = gradeFindings(caseDef, liteFindings);

      const fullPro = await analyzeViaLiveApi({
        filePath: sourcePath,
        durationSeconds,
        caseDef,
        callClass: `${caseDef.name}:full-pro-control`,
        forcePro: true,
        contextSuffix: 'Full-clip Nova Pro control for a bounded experiment. Inspect the entire video and timestamp the localized defect described above.',
      });
      const fullProFindings = collectSuspiciousIntervals(fullPro.analysis, { durationSeconds });
      const fullProGrade = gradeFindings(caseDef, fullProFindings);

      const config = normalizeTargetedEscalationConfig({
        experiments: {
          targetedEscalation: {
            enabled: true,
            strategy: 'medium',
            maxProCalls: 2,
            maxTotalEscalatedSeconds: Math.min(40, durationSeconds),
            maxIndividualIntervalSeconds: Math.min(30, durationSeconds),
          },
        },
      });
      const plan = buildTargetedEscalationPlan(lite.analysis, { durationSeconds, config });
      const targetedFindings = [];
      const segments = [];

      if (lite.meta?.modelId && modelClass(lite.meta.modelId) !== 'lite') {
        throw new Error(`Localization pass did not stay on Lite; observed ${lite.meta.modelId}.`);
      }

      if (plan.targetedEscalationPossible && !plan.wholeVideoFallbackRequired) {
        for (const interval of plan.mergedIntervals.slice(0, 2)) {
          const outputPath = path.join(workspace, `${caseDef.name}-${interval.intervalId}.mp4`);
          const segment = await extractMediaSegment({
            inputPath: sourcePath,
            outputPath,
            startSeconds: interval.startSeconds,
            endSeconds: interval.endSeconds,
            sourceDurationSeconds: durationSeconds,
            mode: 'accurate-transcode',
          });
          const suspicious = (interval.findings || [])
            .map((x) => `${x.defectType}: ${x.escalationReason}`)
            .join('; ');
          const pro = await analyzeViaLiveApi({
            filePath: outputPath,
            durationSeconds: segment.outputDurationSeconds || interval.durationSeconds,
            caseDef,
            callClass: `${caseDef.name}:targeted-pro:${interval.intervalId}`,
            forcePro: true,
            contextSuffix: `This is an extracted source interval from ${segment.sourceStartSeconds}s to ${segment.sourceEndSeconds}s. Lite localized these suspicions: ${suspicious || 'localized defect'}. Confirm only what is visible in this segment and timestamp it relative to the segment.`,
          });
          const segmentFindings = collectSuspiciousIntervals(pro.analysis, {
            durationSeconds: segment.outputDurationSeconds || interval.durationSeconds,
          });
          targetedFindings.push(...mapSegmentFindingsToSource(segmentFindings, segment));
          segments.push({
            intervalId: interval.intervalId,
            sourceStartSeconds: segment.sourceStartSeconds,
            sourceEndSeconds: segment.sourceEndSeconds,
            outputDurationSeconds: segment.outputDurationSeconds,
            sourceFindingIds: interval.sourceFindingIds,
            modelId: pro.meta?.modelId || null,
            usage: pro.meta?.usage || null,
            complianceVerificationUsage: pro.meta?.complianceVerificationUsage || null,
          });
        }
      }

      const targetedGrade = gradeFindings(caseDef, targetedFindings);
      rows.push({
        case: caseDef.name,
        category: caseDef.category,
        durationSeconds,
        groundTruth: caseDef.groundTruth,
        lite: {
          modelId: lite.meta?.modelId || null,
          findings: liteFindings,
          grade: liteGrade,
          usage: lite.meta?.usage || null,
        },
        fullPro: {
          modelId: fullPro.meta?.modelId || null,
          findings: fullProFindings,
          grade: fullProGrade,
          usage: fullPro.meta?.usage || null,
          complianceVerificationUsage: fullPro.meta?.complianceVerificationUsage || null,
        },
        targeted: {
          plan,
          segments,
          findings: targetedFindings,
          grade: targetedGrade,
          sourceSecondsSubmittedToPro: round(segments.reduce((sum, x) => sum + Number(x.outputDurationSeconds || 0), 0), 3),
        },
      });
    } catch (error) {
      failures.push({
        case: caseDef.name,
        code: error?.code || error?.name || 'Error',
        error: error?.message || String(error),
      });
      if (String(error?.code || '').startsWith('PROXY_')) break;
    }
  }
} finally {
  await cleanupSegmentWorkspace(workspace);
}

const fullProSeconds = rows.reduce((sum, row) => sum + Number(row.durationSeconds || 0), 0);
const targetedProSeconds = rows.reduce((sum, row) => sum + Number(row.targeted?.sourceSecondsSubmittedToPro || 0), 0);
const fullTp = rows.reduce((sum, row) => sum + Number(row.fullPro?.grade?.truePositives || 0), 0);
const fullFn = rows.reduce((sum, row) => sum + Number(row.fullPro?.grade?.falseNegatives || 0), 0);
const targetedTp = rows.reduce((sum, row) => sum + Number(row.targeted?.grade?.truePositives || 0), 0);
const targetedFn = rows.reduce((sum, row) => sum + Number(row.targeted?.grade?.falseNegatives || 0), 0);
const fullCritical = rows.reduce((sum, row) => sum + Number(row.fullPro?.grade?.criticalMisses || 0), 0);
const targetedCritical = rows.reduce((sum, row) => sum + Number(row.targeted?.grade?.criticalMisses || 0), 0);

const summary = {
  benchmarkType: 'production-live-api-proxy',
  experimentVersion: 'fd-targeted-escalation-live-api-proxy-v1',
  corpusVersion: manifest.version,
  timestamp: new Date().toISOString(),
  importantLimitation: 'This benchmark uses the deployed /v1/analyze production prompt and forces Nova Pro through the existing continuity-sensitive route. It does not execute the experiment-specific TARGETED_PRO_SYSTEM_PROMPT, so it is proxy evidence only and cannot by itself justify production promotion.',
  limits: {
    maxCases,
    maxApiAnalyzeCalls,
    maxProAnalysisSeconds,
    maxEstimatedUsdUpper,
  },
  ledger: {
    ...ledger,
    proAnalysisSeconds: round(ledger.proAnalysisSeconds, 3),
    verifierProVideoSeconds: round(ledger.verifierProVideoSeconds, 3),
    verifierLiteVideoSeconds: round(ledger.verifierLiteVideoSeconds, 3),
    estimatedUsdLower: round(ledger.estimatedUsdLower),
    estimatedUsdUpper: round(ledger.estimatedUsdUpper),
  },
  result: {
    casesCompleted: rows.length,
    casesAttempted: targetableCases.length,
    fullPro: { truePositives: fullTp, falseNegatives: fullFn, criticalMisses: fullCritical, videoSeconds: round(fullProSeconds, 3) },
    targetedMedium: { truePositives: targetedTp, falseNegatives: targetedFn, criticalMisses: targetedCritical, videoSeconds: round(targetedProSeconds, 3) },
    proDurationReductionPercent: fullProSeconds > 0
      ? round((fullProSeconds - targetedProSeconds) / fullProSeconds * 100, 2)
      : null,
  },
  failures,
  rows,
};

await writeFile(path.join(outDir, 'live-api-proxy-results.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

const md = [
  '# Targeted escalation live-API Pro proxy benchmark',
  '',
  `- Cases completed: **${rows.length}/${targetableCases.length}**`,
  `- Analyze API calls: **${ledger.analyzeCalls}/${maxApiAnalyzeCalls}**`,
  `- Pro analysis video seconds: **${round(ledger.proAnalysisSeconds, 2)}/${maxProAnalysisSeconds}**`,
  `- Conservative reported token-cost range: **$${round(ledger.estimatedUsdLower)}–$${round(ledger.estimatedUsdUpper)}** (upper guard $${maxEstimatedUsdUpper})`,
  `- Full-Pro control: **${fullTp} TP / ${fullFn} FN / ${fullCritical} critical misses**`,
  `- Targeted medium: **${targetedTp} TP / ${targetedFn} FN / ${targetedCritical} critical misses**`,
  `- Full-Pro video seconds: **${round(fullProSeconds, 2)}**`,
  `- Targeted Pro video seconds: **${round(targetedProSeconds, 2)}**`,
  `- Pro-duration reduction: **${summary.result.proDurationReductionPercent ?? 'n/a'}%**`,
  `- Failures: **${failures.length}**`,
  '',
  '## Interpretation guard',
  '',
  'This is production-path proxy evidence. It uses the deployed /v1/analyze prompt and forces Nova Pro through the existing continuity-sensitive route; it does not execute the experiment-specific targeted-Pro prompt. Treat quality/cost findings as directional until the direct isolated Bedrock harness can run under a purpose-built benchmark role or equivalent approved access.',
  '',
  '## Per-case',
  '',
  '| Case | Lite model | Full-Pro TP/FN | Targeted TP/FN | Full seconds | Targeted seconds |',
  '|---|---|---:|---:|---:|---:|',
  ...rows.map((row) => `| ${row.case} | ${row.lite.modelId || 'n/a'} | ${row.fullPro.grade.truePositives}/${row.fullPro.grade.falseNegatives} | ${row.targeted.grade.truePositives}/${row.targeted.grade.falseNegatives} | ${round(row.durationSeconds, 2)} | ${round(row.targeted.sourceSecondsSubmittedToPro, 2)} |`),
  '',
];
await writeFile(path.join(outDir, 'live-api-proxy-results.md'), `${md.join('\n')}\n`, 'utf8');
