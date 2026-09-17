import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  VIDEO_COMPLIANCE_SYSTEM_PROMPT,
  buildVideoCompliancePrompt,
} from '../../backend/video-intelligence.mjs';
import { probeMedia } from '../../backend/targeted-escalation-media.mjs';

const region = process.env.AWS_REGION || 'eu-west-1';
const bucket = String(process.env.AWS_SAM_ARTIFACT_BUCKET || '').trim();
const liteModelId = process.env.TARGETED_BENCHMARK_LITE_MODEL_ID || 'eu.amazon.nova-2-lite-v1:0';
const proModelId = process.env.TARGETED_BENCHMARK_PRO_MODEL_ID || 'eu.amazon.nova-pro-v1:0';
const maxCases = Math.max(1, Math.min(20, Number(process.env.TARGETED_BENCHMARK_MAX_CASES || 8)));
const maxCalls = Math.max(1, Math.min(20, Number(process.env.TARGETED_BENCHMARK_MAX_VERIFIER_CALLS || 8)));
const maxProSeconds = Math.max(1, Math.min(600, Number(process.env.TARGETED_BENCHMARK_MAX_VERIFIER_PRO_SECONDS || 100)));
const maxObservedUsd = Math.max(0.01, Math.min(10, Number(process.env.TARGETED_BENCHMARK_MAX_VERIFIER_USD || 0.50)));
const corpusDir = path.resolve(process.argv[2] || 'targeted-escalation-corpus');
const outDir = path.resolve(process.argv[3] || 'targeted-escalation-paid-results');
const manifestPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'corpus-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (!bucket) throw new Error('AWS_SAM_ARTIFACT_BUCKET is required.');

const rates = {
  lite: {
    input: Number(process.env.NOVA_LITE_INPUT_USD_PER_M || 0.30),
    output: Number(process.env.NOVA_LITE_OUTPUT_USD_PER_M || 2.50),
  },
  pro: {
    input: Number(process.env.NOVA_PRO_INPUT_USD_PER_M || 0.92),
    output: Number(process.env.NOVA_PRO_OUTPUT_USD_PER_M || 3.68),
  },
};
const bedrock = new BedrockRuntimeClient({ region });
const s3 = new S3Client({ region });
const runId = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
const prefix = `targeted-escalation-verifier-benchmark/${runId}`;
const uploaded = [];
const ledger = { calls: 0, proVideoSeconds: 0, observedCostUsd: 0 };

function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round(Number(value || 0) * scale) / scale;
}

function cost(usage, modelClass) {
  const rate = rates[modelClass];
  const input = Math.max(0, Number(usage?.inputTokens || 0));
  const output = Math.max(0, Number(usage?.outputTokens || 0));
  return input / 1_000_000 * rate.input + output / 1_000_000 * rate.output;
}

function assertBefore({ modelClass, videoSeconds }) {
  if (ledger.calls >= maxCalls) {
    const error = new Error(`Verifier benchmark call cap reached (${maxCalls}).`);
    error.code = 'VERIFIER_CALL_CAP';
    throw error;
  }
  if (modelClass === 'pro' && ledger.proVideoSeconds + videoSeconds > maxProSeconds) {
    const error = new Error(`Verifier Pro-seconds cap would be exceeded (${ledger.proVideoSeconds + videoSeconds} > ${maxProSeconds}).`);
    error.code = 'VERIFIER_PRO_SECONDS_CAP';
    throw error;
  }
  if (ledger.observedCostUsd >= maxObservedUsd) {
    const error = new Error(`Verifier observed-cost guard reached ($${ledger.observedCostUsd.toFixed(6)} >= $${maxObservedUsd}).`);
    error.code = 'VERIFIER_COST_GUARD';
    throw error;
  }
}

async function upload(filePath, caseName) {
  const body = await readFile(filePath);
  const key = `${prefix}/${caseName}.mp4`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'video/mp4',
    CacheControl: 'private, max-age=0, no-store',
    Metadata: { purpose: 'forgedirector-targeted-escalation-verifier-overhead' },
  }));
  uploaded.push(key);
  return `s3://${bucket}/${key}`;
}

async function invoke({ modelId, modelClass, uri, durationSeconds, prompt }) {
  assertBefore({ modelClass, videoSeconds: durationSeconds });
  const started = performance.now();
  const response = await bedrock.send(new ConverseCommand({
    modelId,
    system: [{ text: VIDEO_COMPLIANCE_SYSTEM_PROMPT }],
    messages: [{
      role: 'user',
      content: [
        { video: { format: 'mp4', source: { s3Location: { uri } } } },
        { text: prompt },
      ],
    }],
    inferenceConfig: { maxTokens: 2600, temperature: 0, topP: 0.9 },
  }));
  const latencyMs = performance.now() - started;
  const usage = response?.usage || {};
  const estimatedCostUsd = cost(usage, modelClass);
  ledger.calls += 1;
  if (modelClass === 'pro') ledger.proVideoSeconds += durationSeconds;
  ledger.observedCostUsd += estimatedCostUsd;
  return {
    modelId,
    modelClass,
    usage,
    latencyMs: round(latencyMs, 2),
    estimatedCostUsd: round(estimatedCostUsd),
    videoSeconds: round(durationSeconds, 3),
  };
}

await mkdir(outDir, { recursive: true });
const rows = [];
const failures = [];
try {
  for (const caseDef of (manifest.cases || []).slice(0, maxCases)) {
    if (!Object.keys(caseDef.requirements || {}).length) continue;
    try {
      const sourcePath = path.join(corpusDir, caseDef.file);
      const probe = await probeMedia(sourcePath);
      const durationSeconds = Number(probe.durationSeconds || 0);
      const uri = await upload(sourcePath, caseDef.name);
      const prompt = buildVideoCompliancePrompt({
        requirements: caseDef.requirements,
        declaredDurationSeconds: durationSeconds,
      });
      // Mirrors the production verifier model order: fallback/Pro, then primary/Lite.
      const pro = await invoke({
        modelId: proModelId,
        modelClass: 'pro',
        uri,
        durationSeconds,
        prompt,
      });
      const lite = await invoke({
        modelId: liteModelId,
        modelClass: 'lite',
        uri,
        durationSeconds,
        prompt,
      });
      rows.push({
        case: caseDef.name,
        durationSeconds,
        pro,
        lite,
        totalEstimatedCostUsd: round(pro.estimatedCostUsd + lite.estimatedCostUsd),
        totalLatencyMs: round(pro.latencyMs + lite.latencyMs, 2),
      });
    } catch (error) {
      failures.push({
        case: caseDef.name,
        code: error?.code || error?.name || 'Error',
        message: error?.message || String(error),
      });
      if (String(error?.code || '').startsWith('VERIFIER_')) break;
    }
  }
} finally {
  for (const key of uploaded) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (error) {
      console.warn('verifier benchmark cleanup failed', { key, message: error?.message });
    }
  }
}

const result = {
  timestamp: new Date().toISOString(),
  modelOrder: [proModelId, liteModelId],
  configuredRatesUsdPerMillionTokens: rates,
  limits: { maxCalls, maxProSeconds, maxObservedUsd },
  ledger: {
    calls: ledger.calls,
    proVideoSeconds: round(ledger.proVideoSeconds, 3),
    observedCostUsd: round(ledger.observedCostUsd),
  },
  failures,
  rows,
};
await writeFile(path.join(outDir, 'verifier-overhead.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
await writeFile(path.join(outDir, 'verifier-overhead.md'), [
  '# Unchanged production blind-verifier overhead',
  '',
  `- Cases measured: **${rows.length}**`,
  `- Calls: **${ledger.calls}/${maxCalls}**`,
  `- Pro video seconds: **${round(ledger.proVideoSeconds, 2)}/${maxProSeconds}**`,
  `- Observed token-cost estimate: **$${round(ledger.observedCostUsd)}/$${maxObservedUsd} guard**`,
  `- Failures: **${failures.length}**`,
  '',
  'This overhead is unchanged by targeted escalation. It is added to both production-total baseline and targeted economics, so it contributes zero absolute saving but lowers the percentage saving of the overall analysis.',
  '',
].join('\n'), 'utf8');
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exitCode = 2;
