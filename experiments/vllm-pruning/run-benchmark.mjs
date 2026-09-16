#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  VLLM_PRUNING_PROFILES,
  analyzeWithExperimentalVllm,
} from '../../backend/experimental-vllm.mjs';

const root = process.cwd();
const profileName = process.env.VLLM_BENCH_PROFILE || process.argv[2] || 'baseline';
const profile = VLLM_PRUNING_PROFILES[profileName];
if (!profile) throw new Error(`Unknown VLLM_BENCH_PROFILE: ${profileName}`);

const corpusDir = path.resolve(process.env.VLLM_BENCH_CORPUS || 'benchmark-results');
const videosDir = path.join(corpusDir, 'videos');
const expectationsPath = path.join(corpusDir, 'expectations.json');
const sourceHarness = path.resolve('tests/run-live-video-benchmark.sh');
const outDir = path.resolve(process.env.VLLM_BENCH_OUT || 'benchmark-vllm');
const baseUrl = String(process.env.VLLM_BASE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const model = process.env.VLLM_MODEL || 'Qwen/Qwen3-VL-8B-Instruct';
const vllmVersion = process.env.VLLM_VERSION || '0.29.0';
const modelRevision = String(process.env.VLLM_MODEL_REVISION || '').trim() || null;
const skipWarmup = String(process.env.VLLM_BENCH_SKIP_WARMUP || '').toLowerCase() === 'true';
const gpuHourlyUsd = Number(process.env.VLLM_GPU_HOURLY_USD || 0);
const localGpuSampling = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(baseUrl)
  && String(process.env.VLLM_SAMPLE_LOCAL_GPU || 'true').toLowerCase() !== 'false';

fs.mkdirSync(outDir, { recursive: true });
if (!fs.existsSync(expectationsPath)) {
  throw new Error(`Missing ${expectationsPath}. Build the shared corpus first with FORGEDIRECTOR_CORPUS_ONLY=1 tests/run-live-video-benchmark.sh ${corpusDir}`);
}

const expectations = JSON.parse(fs.readFileSync(expectationsPath, 'utf8'));
const harnessText = fs.readFileSync(sourceHarness, 'utf8');
const payloadByName = new Map();
const callPattern = /analyze_case\s+"([^"]+)"\s+"\$VID\/([^"]+)"\s+'([^']+)'/g;
for (const match of harnessText.matchAll(callPattern)) {
  payloadByName.set(match[1], { file: match[2], payload: JSON.parse(match[3]) });
}

function measuredDuration(file) {
  return Number(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ], { encoding: 'utf8' }).trim());
}

function dataVideoUrl(file) {
  return `data:video/mp4;base64,${fs.readFileSync(file).toString('base64')}`;
}

function parsePrometheus(text) {
  const values = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{[^}]*\})?\s+([-+0-9.eE]+)(?:\s+\d+)?$/);
    if (!match) continue;
    const number = Number(match[2]);
    if (!Number.isFinite(number)) continue;
    const name = match[1];
    if (name === 'vllm:kv_cache_usage_perc') {
      values.set(name, Math.max(values.get(name) ?? -Infinity, number));
    } else {
      values.set(name, (values.get(name) || 0) + number);
    }
  }
  return Object.fromEntries(values);
}

async function readMetrics() {
  try {
    const response = await fetch(`${baseUrl}/metrics`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    return parsePrometheus(await response.text());
  } catch {
    return null;
  }
}

function localServerCommand() {
  if (!localGpuSampling) return null;
  try {
    const text = execFileSync('pgrep', ['-af', 'vllm serve'], {
      encoding: 'utf8',
      timeout: 2500,
    }).trim();
    return text || null;
  } catch {
    return null;
  }
}

function validateLocalServerProfile(command) {
  if (!command) return { verified: false, reason: 'local vLLM process command unavailable' };
  const rateMatch = command.match(/--video-pruning-rate(?:=|\s+)([0-9.]+)/);
  const methodMatch = command.match(/--video-pruning-method(?:=|\s+)(\S+)/);
  const actualRate = rateMatch ? Number(rateMatch[1]) : 0;
  const actualMethod = methodMatch ? String(methodMatch[1]).trim() : 'evs';
  const expectedRate = Number(profile.pruningRate || 0);
  const expectedMethod = String(profile.pruningMethod || 'evs');
  if (actualRate !== expectedRate || (expectedRate > 0 && actualMethod !== expectedMethod)) {
    throw new Error(
      `Local vLLM process flags do not match profile ${profileName}: expected rate=${expectedRate}, method=${expectedMethod}; observed rate=${actualRate}, method=${actualMethod}.`,
    );
  }
  return {
    verified: true,
    pruningRate: actualRate,
    pruningMethod: actualMethod,
  };
}

function gpuMemoryMiB() {
  if (!localGpuSampling) return null;
  try {
    const text = execFileSync('nvidia-smi', [
      '--query-compute-apps=used_memory', '--format=csv,noheader,nounits',
    ], { encoding: 'utf8', timeout: 2500 });
    const numbers = text.split(/\r?\n/).map((x) => Number(x.trim())).filter(Number.isFinite);
    return numbers.length ? numbers.reduce((a, b) => a + b, 0) : 0;
  } catch {
    return null;
  }
}

function metricDelta(before, after, name) {
  const a = Number(before?.[name]);
  const b = Number(after?.[name]);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
}

function metricDeltaAny(before, after, names) {
  for (const name of names) {
    const value = metricDelta(before, after, name);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

async function observeDuring(work) {
  const before = await readMetrics();
  let peakKv = Number(before?.['vllm:kv_cache_usage_perc']);
  if (!Number.isFinite(peakKv)) peakKv = null;
  let peakGpu = gpuMemoryMiB();
  let running = true;
  let busy = false;
  const timer = setInterval(async () => {
    if (!running || busy) return;
    busy = true;
    try {
      const [metrics, gpu] = await Promise.all([readMetrics(), Promise.resolve(gpuMemoryMiB())]);
      const kv = Number(metrics?.['vllm:kv_cache_usage_perc']);
      if (Number.isFinite(kv)) peakKv = peakKv == null ? kv : Math.max(peakKv, kv);
      if (Number.isFinite(gpu)) peakGpu = peakGpu == null ? gpu : Math.max(peakGpu, gpu);
    } finally {
      busy = false;
    }
  }, 150);

  const started = performance.now();
  try {
    const value = await work();
    return { value, elapsedMs: performance.now() - started, before, peakKv, peakGpu };
  } finally {
    running = false;
    clearInterval(timer);
  }
}

function findActualCheck(analysis, expected) {
  return (analysis?.compliance?.checks || []).find((check) => (
    check?.type === expected.type && check?.rule === expected.rule
  )) || null;
}

function gradeCase(expected, analysis) {
  const checkResults = (expected.checks || []).map((wanted) => {
    const actual = findActualCheck(analysis, wanted);
    const actualStatus = actual?.status || 'missing';
    return {
      type: wanted.type,
      rule: wanted.rule,
      expected: wanted.status,
      actual: actualStatus,
      correct: actualStatus === wanted.status,
      falseNegative: wanted.status === 'fail' && actualStatus !== 'fail',
      falsePositive: wanted.status === 'pass' && actualStatus === 'fail',
      timestampSeconds: Number.isFinite(Number(actual?.timestampSeconds)) ? Number(actual.timestampSeconds) : null,
    };
  });
  const speechClean = !(analysis?.hook?.spokenHook)
    && !(analysis?.timeline || []).some((item) => item?.speech);
  const noSpeechOk = expected.expectNoSpeechHallucination === true ? speechClean : true;
  const coverageOk = analysis?.coverage?.fullDurationReviewed === true;
  const gate = analysis?.qualityGate?.action || null;
  const gateOk = expected.gate === 'not_accept' ? gate !== 'accept' : true;
  return { checkResults, noSpeechOk, coverageOk, gate, gateOk };
}

const endpoint = {
  profileName,
  ...profile,
  baseUrl,
  model,
  vllmVersion,
  apiKey: process.env.VLLM_API_KEY || '',
};

// Smoke test the server identity before consuming the corpus.
const modelsResponse = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
if (!modelsResponse.ok) throw new Error(`vLLM /v1/models failed with HTTP ${modelsResponse.status}`);
const servedModels = await modelsResponse.json();
const servedIds = (servedModels?.data || []).map((item) => item?.id).filter(Boolean);
const observedServerCommand = localServerCommand();
const localProfileVerification = validateLocalServerProfile(observedServerCommand);
if (!servedIds.includes(model)) {
  throw new Error(`Configured model ${model} is not reported by ${baseUrl}/v1/models (${servedIds.join(', ') || 'none'})`);
}

if (!skipWarmup) {
  const warmupFile = path.join(outDir, '.warmup.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x101828:s=320x320:d=2:r=8',
    '-vf', 'drawbox=x=80:y=80:w=160:h=160:color=white@1:t=fill',
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    warmupFile,
  ]);
  await analyzeWithExperimentalVllm({
    payload: {
      platform: 'General',
      objective: 'awareness',
      durationSeconds: 2,
      context: 'Benchmark warm-up clip. Judge visible facts only.',
    },
    videoUrl: dataVideoUrl(warmupFile),
    endpoint,
  });
  fs.rmSync(warmupFile, { force: true });
}

const rows = [];
for (const expected of expectations.cases || []) {
  const call = payloadByName.get(expected.name);
  if (!call) {
    rows.push({ name: expected.name, technicalFailure: 'request payload not found in shared benchmark harness' });
    continue;
  }
  const file = path.join(videosDir, call.file);
  if (!fs.existsSync(file)) {
    rows.push({ name: expected.name, technicalFailure: `video missing: ${file}` });
    continue;
  }
  const payload = structuredClone(call.payload);
  if (payload.durationSeconds == null) payload.durationSeconds = measuredDuration(file);
  const videoUrl = dataVideoUrl(file);
  const before = await readMetrics();
  try {
    const observed = await observeDuring(() => analyzeWithExperimentalVllm({
      payload,
      videoUrl,
      endpoint,
    }));
    const after = await readMetrics();
    const result = observed.value;
    const graded = gradeCase(expected, result.analysis);
    const cost = gpuHourlyUsd > 0 ? (observed.elapsedMs / 3600000) * gpuHourlyUsd : null;
    rows.push({
      name: expected.name,
      durationSeconds: payload.durationSeconds,
      ...graded,
      usage: result.usage,
      performance: result.performance,
      wallLatencyMs: Math.round(observed.elapsedMs * 100) / 100,
      metrics: {
        promptTokensCounterDelta: metricDeltaAny(before, after, ['vllm:prompt_tokens_total', 'vllm:prompt_tokens']),
        generationTokensCounterDelta: metricDeltaAny(before, after, ['vllm:generation_tokens_total', 'vllm:generation_tokens']),
        requestSuccessCounterDelta: metricDeltaAny(before, after, ['vllm:request_success_total', 'vllm:request_success']),
        kvCacheUsageBefore: Number.isFinite(Number(before?.['vllm:kv_cache_usage_perc'])) ? Number(before['vllm:kv_cache_usage_perc']) : null,
        kvCacheUsagePeak: observed.peakKv,
        kvCacheUsageAfter: Number.isFinite(Number(after?.['vllm:kv_cache_usage_perc'])) ? Number(after['vllm:kv_cache_usage_perc']) : null,
        gpuMemoryPeakMiB: observed.peakGpu,
      },
      estimatedInferenceCostUsd: cost,
      experiment: result.experiment,
    });
  } catch (error) {
    rows.push({ name: expected.name, technicalFailure: String(error?.message || error) });
  }
}

const checkResults = rows.flatMap((row) => row.checkResults || []);
const successful = rows.filter((row) => !row.technicalFailure);
const technicalFailures = rows.length - successful.length;
const falseNegatives = checkResults.filter((x) => x.falseNegative).length;
const falsePositives = checkResults.filter((x) => x.falsePositive).length;
const incorrectChecks = checkResults.filter((x) => !x.correct).length;
const coverageFailures = successful.filter((x) => !x.coverageOk).length;
const noSpeechFailures = successful.filter((x) => !x.noSpeechOk).length;
const gateFailures = successful.filter((x) => !x.gateOk).length;
const totalWallMs = successful.reduce((sum, row) => sum + Number(row.wallLatencyMs || 0), 0);
const totalInputTokens = successful.reduce((sum, row) => sum + Number(row.usage?.inputTokens || 0), 0);
const totalOutputTokens = successful.reduce((sum, row) => sum + Number(row.usage?.outputTokens || 0), 0);
const peakKvValues = successful.map((row) => row.metrics?.kvCacheUsagePeak).filter(Number.isFinite);
const peakGpuValues = successful.map((row) => row.metrics?.gpuMemoryPeakMiB).filter(Number.isFinite);
const totalCost = successful.map((row) => row.estimatedInferenceCostUsd).filter(Number.isFinite).reduce((a, b) => a + b, 0);

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  profile: { name: profileName, ...profile },
  runtime: {
    baseUrl,
    model,
    modelRevision,
    vllmVersion,
    gpuHourlyUsd: gpuHourlyUsd || null,
    warmupPerformed: !skipWarmup,
    localServerCommand: observedServerCommand,
    localProfileVerification,
  },
  corpus: { directory: corpusDir, cases: rows.length },
  summary: {
    successfulCases: successful.length,
    technicalFailures,
    labeledChecks: checkResults.length,
    correctChecks: checkResults.length - incorrectChecks,
    incorrectChecks,
    falseNegatives,
    falsePositives,
    coverageFailures,
    noSpeechFailures,
    gateFailures,
    totalInputTokens,
    totalOutputTokens,
    totalWallMs: Math.round(totalWallMs * 100) / 100,
    sequentialThroughputCasesPerSecond: totalWallMs > 0 ? Math.round((successful.length / (totalWallMs / 1000)) * 10000) / 10000 : null,
    peakKvCacheUsagePerc: peakKvValues.length ? Math.max(...peakKvValues) : null,
    peakGpuMemoryMiB: peakGpuValues.length ? Math.max(...peakGpuValues) : null,
    estimatedInferenceCostUsd: gpuHourlyUsd > 0 ? Math.round(totalCost * 1e6) / 1e6 : null,
    directVideoTokenCount: null,
    directVideoTokenCountNote: 'Not exposed separately by the OpenAI-compatible response; prompt/input tokens are not relabeled as video tokens.',
  },
  rows,
};

const outPath = path.join(outDir, `${profileName}.json`);
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outPath, profile: profileName, summary: report.summary }, null, 2));
if (technicalFailures) process.exitCode = 2;
