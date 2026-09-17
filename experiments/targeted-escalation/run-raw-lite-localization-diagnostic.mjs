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
const outDir = path.resolve(process.argv[3] || 'targeted-escalation-raw-lite-results');
const maxAnalyzeCalls = Math.max(1, Math.min(8, Number(process.env.RAW_LITE_MAX_ANALYZE_CALLS || 8)));
const maxReportedCostLowerBoundUsd = Math.max(0.01, Math.min(1, Number(process.env.RAW_LITE_MAX_REPORTED_COST_USD || 0.40)));
const manifestPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'corpus-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const selectedNames = new Set(['visible-text-defect', 'localized-artifact']);
const cases = manifest.cases.filter((item) => selectedNames.has(item.name));

if (!API_URL) throw new Error('API_URL is required.');
if (!RAPIDAPI_PROXY_SECRET) throw new Error('RAPIDAPI_PROXY_SECRET is required.');
if (cases.length !== 2) throw new Error(`Expected two diagnostic cases, found ${cases.length}.`);

const rates = {
  lite: { inputPerMillion: 0.30, outputPerMillion: 2.50 },
  pro: { inputPerMillion: 0.92, outputPerMillion: 3.68 },
};

const ledger = { analyzeCalls: 0, reportedCostLowerBoundUsd: 0, calls: [] };

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

function intervalOf(finding) {
  const start = Number(finding?.approximateStartSeconds);
  const end = Number(finding?.approximateEndSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function grade(caseDef, findings) {
  const truth = caseDef.groundTruth?.[0];
  if (!truth) return { exactTypeHit: false, temporalHitAnyType: false, criticalMiss: false };
  const overlaps = (findings || []).filter((finding) => {
    const interval = intervalOf(finding);
    return interval && overlapSeconds(interval.start, interval.end, truth.startSeconds, truth.endSeconds) > 0;
  });
  return {
    exactTypeHit: overlaps.some((finding) => String(finding.defectType) === String(truth.defectType)),
    temporalHitAnyType: overlaps.length > 0,
    criticalMiss: truth.critical === true && overlaps.length === 0,
    overlappingFindings: overlaps.map((finding) => ({
      defectType: finding.defectType,
      startSeconds: finding.approximateStartSeconds,
      endSeconds: finding.approximateEndSeconds,
      reason: finding.escalationReason,
    })),
  };
}

async function responseJson(response, label) {
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(`${label} failed HTTP ${response.status}: ${JSON.stringify(parsed).slice(0, 1200)}`);
  return parsed;
}

async function uploadAsset(filePath) {
  const body = await readFile(filePath);
  const reservation = await fetch(`${API_URL}/v1/uploads`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rapidapi-proxy-secret': RAPIDAPI_PROXY_SECRET,
    },
    body: JSON.stringify({ contentType: 'video/mp4', sizeBytes: body.byteLength }),
  });
  const created = await responseJson(reservation, 'upload reservation');
  const assetId = created?.upload?.assetId;
  const uploadUrl = created?.upload?.uploadUrl;
  if (!assetId || !uploadUrl) throw new Error('Upload reservation missing assetId/uploadUrl.');
  const uploaded = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'video/mp4' },
    body,
  });
  if (!uploaded.ok) throw new Error(`Presigned upload failed HTTP ${uploaded.status}.`);
  return assetId;
}

async function analyze({ filePath, caseDef, durationSeconds, mode, segmentContext = '' }) {
  if (ledger.analyzeCalls >= maxAnalyzeCalls) throw new Error(`Analyze-call cap reached (${maxAnalyzeCalls}).`);
  if (ledger.reportedCostLowerBoundUsd >= maxReportedCostLowerBoundUsd) {
    throw new Error(`Reported final-call cost lower-bound cap reached ($${ledger.reportedCostLowerBoundUsd.toFixed(6)}).`);
  }

  const rawLite = mode === 'raw-lite';
  const assetId = await uploadAsset(filePath);
  const requirements = rawLite
    ? {}
    : { continuityRules: ['Benchmark routing control: inspect cross-frame visual consistency within this supplied clip.'] };
  const payload = {
    assetId,
    platform: 'General',
    objective: 'awareness',
    context: [
      caseDef.context || '',
      rawLite
        ? `RAW LITE LOCALIZATION DIAGNOSTIC: this clip is ${round(durationSeconds, 2)} seconds long. Inspect the whole supplied clip, especially the middle and end. Report genuine localized visual defects with timestamps.`,
        : segmentContext,
    ].filter(Boolean).join('\n\n'),
    requirements,
  };
  // Deliberately omit durationSeconds for raw Lite so production's full-duration
  // recovery policy cannot silently replace Lite localization with Pro.
  if (!rawLite) payload.durationSeconds = durationSeconds;

  const started = performance.now();
  const response = await fetch(`${API_URL}/v1/analyze`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rapidapi-proxy-secret': RAPIDAPI_PROXY_SECRET,
    },
    body: JSON.stringify(payload),
  });
  const json = await responseJson(response, mode);
  const meta = json?.meta || {};
  const analysis = json?.analysis;
  if (!analysis) throw new Error(`${mode} returned no analysis.`);

  const klass = modelClass(meta.modelId);
  const analysisCost = usageCost(meta.usage, klass);
  const verifierUsage = meta.complianceVerificationUsage || null;
  // Every forced-Pro diagnostic currently reports Pro as the blind verifier.
  const verifierCost = verifierUsage ? usageCost(verifierUsage, 'pro') : 0;
  ledger.analyzeCalls += 1;
  ledger.reportedCostLowerBoundUsd += analysisCost + verifierCost;
  ledger.calls.push({
    mode,
    case: caseDef.name,
    durationSeconds: rawLite ? null : round(durationSeconds, 3),
    modelId: meta.modelId || null,
    analysisRetryUsed: meta.analysisRetryUsed === true,
    coverageRetryUsed: meta.coverageRetryUsed === true,
    usage: meta.usage || null,
    complianceVerificationUsed: meta.complianceVerificationUsed === true,
    complianceVerificationModelIds: meta.complianceVerificationModelIds || [],
    complianceVerificationUsage: verifierUsage,
    reportedCostLowerBoundUsd: round(analysisCost + verifierCost),
    latencyMs: round(performance.now() - started, 2),
  });

  if (ledger.reportedCostLowerBoundUsd > maxReportedCostLowerBoundUsd) {
    throw new Error(`Reported final-call cost lower-bound cap crossed after ${mode}.`);
  }
  return { analysis, meta };
}

function mapToSource(findings, segment) {
  return (findings || []).map((finding) => ({
    ...finding,
    approximateStartSeconds: Number.isFinite(Number(finding?.approximateStartSeconds))
      ? round(segment.sourceStartSeconds + Number(finding.approximateStartSeconds), 3)
      : null,
    approximateEndSeconds: Number.isFinite(Number(finding?.approximateEndSeconds))
      ? round(segment.sourceStartSeconds + Number(finding.approximateEndSeconds), 3)
      : null,
  }));
}

await mkdir(outDir, { recursive: true });
const workspace = await createSegmentWorkspace();
const rows = [];
const failures = [];

try {
  for (const caseDef of cases) {
    try {
      const sourcePath = path.join(corpusDir, caseDef.file);
      const probe = await probeMedia(sourcePath);
      const durationSeconds = probe.durationSeconds;
      if (!durationSeconds) throw new Error('Could not probe source duration.');

      const lite = await analyze({ filePath: sourcePath, caseDef, durationSeconds, mode: 'raw-lite' });
      if (modelClass(lite.meta?.modelId) !== 'lite') {
        throw new Error(`Raw localization did not remain on Lite; observed ${lite.meta?.modelId}.`);
      }
      const liteFindings = collectSuspiciousIntervals(lite.analysis, { durationSeconds });
      const liteGrade = grade(caseDef, liteFindings);

      const config = normalizeTargetedEscalationConfig({
        experiments: { targetedEscalation: {
          enabled: true,
          strategy: 'medium',
          maxProCalls: 2,
          maxTotalEscalatedSeconds: Math.min(40, durationSeconds),
          maxIndividualIntervalSeconds: Math.min(30, durationSeconds),
        } },
      });
      const plan = buildTargetedEscalationPlan(lite.analysis, { durationSeconds, config });

      const fullPro = await analyze({
        filePath: sourcePath,
        caseDef,
        durationSeconds,
        mode: 'full-pro',
        segmentContext: 'FULL-CLIP PRO CONTROL: inspect the entire video and timestamp the localized defect described in the context.',
      });
      const fullFindings = collectSuspiciousIntervals(fullPro.analysis, { durationSeconds });
      const fullGrade = grade(caseDef, fullFindings);

      const targetedFindings = [];
      const segments = [];
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
          const pro = await analyze({
            filePath: outputPath,
            caseDef,
            durationSeconds: segment.outputDurationSeconds || interval.durationSeconds,
            mode: 'targeted-pro',
            segmentContext: `TARGETED PRO DIAGNOSTIC: this is source interval ${segment.sourceStartSeconds}-${segment.sourceEndSeconds}s selected from Lite findings. Confirm or reject the suspected localized defect using only this segment. Return segment-relative timestamps.`,
          });
          const findings = collectSuspiciousIntervals(pro.analysis, {
            durationSeconds: segment.outputDurationSeconds || interval.durationSeconds,
          });
          targetedFindings.push(...mapToSource(findings, segment));
          segments.push({
            sourceStartSeconds: segment.sourceStartSeconds,
            sourceEndSeconds: segment.sourceEndSeconds,
            outputDurationSeconds: segment.outputDurationSeconds,
            modelId: pro.meta?.modelId || null,
          });
        }
      }
      const targetedGrade = grade(caseDef, targetedFindings);

      rows.push({
        case: caseDef.name,
        category: caseDef.category,
        durationSeconds,
        truth: caseDef.groundTruth?.[0] || null,
        lite: { modelId: lite.meta?.modelId || null, grade: liteGrade, findings: liteFindings },
        plan,
        fullPro: { modelId: fullPro.meta?.modelId || null, grade: fullGrade, findings: fullFindings },
        targeted: { segments, grade: targetedGrade, findings: targetedFindings },
      });
    } catch (error) {
      failures.push({ case: caseDef.name, error: error?.message || String(error) });
    }
  }
} finally {
  await cleanupSegmentWorkspace(workspace);
}

const summary = {
  benchmarkType: 'raw-lite-localization-production-api-diagnostic',
  timestamp: new Date().toISOString(),
  corpusVersion: manifest.version,
  interpretation: 'Raw Lite requests deliberately omit declared duration to prevent the production full-duration recovery guard from replacing Lite with Pro. True duration is still stated in context. This is diagnostic evidence only; it is not a production configuration recommendation.',
  costCaveat: 'reportedCostLowerBoundUsd is based on response-reported final analysis usage plus reported verifier usage. Earlier hidden analysis recovery calls, if any, are not included by the production endpoint.',
  limits: { maxAnalyzeCalls, maxReportedCostLowerBoundUsd },
  ledger: { ...ledger, reportedCostLowerBoundUsd: round(ledger.reportedCostLowerBoundUsd) },
  failures,
  rows,
};

await writeFile(path.join(outDir, 'raw-lite-results.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
const md = [
  '# Raw Lite localization diagnostic',
  '',
  `- Cases completed: **${rows.length}/${cases.length}**`,
  `- Analyze calls: **${ledger.analyzeCalls}/${maxAnalyzeCalls}**`,
  `- Reported final-call cost lower bound: **$${round(ledger.reportedCostLowerBoundUsd)}**`,
  `- Failures: **${failures.length}**`,
  '',
  '| Case | Lite temporal hit | Lite exact-type hit | Targeting possible | Full-Pro temporal hit | Targeted-Pro temporal hit | Targeted segments |',
  '|---|---:|---:|---:|---:|---:|---:|',
  ...rows.map((row) => `| ${row.case} | ${row.lite.grade.temporalHitAnyType} | ${row.lite.grade.exactTypeHit} | ${row.plan.targetedEscalationPossible && !row.plan.wholeVideoFallbackRequired} | ${row.fullPro.grade.temporalHitAnyType} | ${row.targeted.grade.temporalHitAnyType} | ${row.targeted.segments.length} |`),
  '',
  'This intentionally bypasses only the **proxy benchmark’s declared-duration field** so that the existing production recovery guard cannot silently substitute Pro for Lite. Production code/configuration is unchanged.',
];
await writeFile(path.join(outDir, 'raw-lite-results.md'), `${md.join('\n')}\n`, 'utf8');
