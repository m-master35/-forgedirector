import { createHash } from 'node:crypto';
import {
  readAnalysisCache,
  writeAnalysisCache,
} from './storage.mjs';
import {
  VIDEO_ANALYSIS_SYSTEM_PROMPT,
  VIDEO_COMPLIANCE_SYSTEM_PROMPT,
  buildVideoAnalysisPrompt,
  buildVideoCompliancePrompt,
  normalizeVideoAnalysis,
  normalizeVideoCompliance,
  consensusVideoCompliance,
  applyVerifiedVideoCompliance,
  assessVideoAnalysisCoverage,
  isAuthoritativeVerifierCoverage,
} from './video-intelligence.mjs';

export const VLLM_EXPERIMENT_VERSION = 'fd-vllm-video-pruning-v1|vllm-0.29.0|qwen3-vl';
export const VLLM_EXPERIMENT_DEFAULT_MODEL = 'Qwen/Qwen3-VL-8B-Instruct';

export const VLLM_PRUNING_PROFILES = Object.freeze({
  baseline: Object.freeze({
    id: 'baseline',
    level: 'baseline',
    method: 'evs',
    pruningRate: 0,
    pruningEnabled: false,
  }),
  'evs-conservative': Object.freeze({
    id: 'evs-conservative',
    level: 'conservative',
    method: 'evs',
    pruningRate: 0.25,
    pruningEnabled: true,
  }),
  'evs-medium': Object.freeze({
    id: 'evs-medium',
    level: 'medium',
    method: 'evs',
    pruningRate: 0.50,
    pruningEnabled: true,
  }),
  'evs-aggressive': Object.freeze({
    id: 'evs-aggressive',
    level: 'aggressive',
    method: 'evs',
    pruningRate: 0.75,
    pruningEnabled: true,
  }),
  'vidcom2-conservative': Object.freeze({
    id: 'vidcom2-conservative',
    level: 'conservative',
    method: 'vidcom2',
    pruningRate: 0.25,
    pruningEnabled: true,
    requiresQwen3Vl: true,
  }),
  'vidcom2-medium': Object.freeze({
    id: 'vidcom2-medium',
    level: 'medium',
    method: 'vidcom2',
    pruningRate: 0.50,
    pruningEnabled: true,
    requiresQwen3Vl: true,
  }),
  'vidcom2-aggressive': Object.freeze({
    id: 'vidcom2-aggressive',
    level: 'aggressive',
    method: 'vidcom2',
    pruningRate: 0.75,
    pruningEnabled: true,
    requiresQwen3Vl: true,
  }),
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function booleanEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

export function vllmExperimentEnabled() {
  return booleanEnv('VLLM_EXPERIMENT_ENABLED', false);
}

function configuredModel() {
  return String(process.env.VLLM_EXPERIMENT_MODEL || VLLM_EXPERIMENT_DEFAULT_MODEL).trim();
}

function parseEndpointMap() {
  const raw = String(process.env.VLLM_EXPERIMENT_ENDPOINTS_JSON || '').trim();
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const error = new Error('VLLM_EXPERIMENT_ENDPOINTS_JSON must be valid JSON.');
    error.statusCode = 503;
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('VLLM_EXPERIMENT_ENDPOINTS_JSON must be a JSON object keyed by experiment profile.');
    error.statusCode = 503;
    throw error;
  }
  const result = {};
  for (const [key, value] of Object.entries(parsed)) {
    const url = String(value || '').trim().replace(/\/+$/, '');
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) {
      const error = new Error(`vLLM endpoint for profile ${key} must use http:// or https://.`);
      error.statusCode = 503;
      throw error;
    }
    result[key] = url;
  }
  return result;
}

export function resolveVllmProfile(profileId) {
  const id = String(profileId || '').trim();
  if (!id) {
    const error = new Error('profile is required for the vLLM pruning experiment.');
    error.statusCode = 400;
    throw error;
  }
  const profile = VLLM_PRUNING_PROFILES[id];
  if (!profile) {
    const error = new Error(`Unsupported vLLM pruning profile. Use one of: ${Object.keys(VLLM_PRUNING_PROFILES).join(', ')}.`);
    error.statusCode = 400;
    throw error;
  }
  const endpoints = parseEndpointMap();
  const baseUrl = endpoints[id];
  if (!baseUrl) {
    const error = new Error(`No vLLM endpoint is configured for experiment profile ${id}.`);
    error.statusCode = 503;
    throw error;
  }
  const model = configuredModel();
  if (profile.requiresQwen3Vl && !/qwen3[-_. ]?vl/i.test(model)) {
    const error = new Error(`Profile ${id} uses VidCom2, which vLLM currently supports only for Qwen3-VL. Configured model: ${model || '(empty)'}.`);
    error.statusCode = 503;
    throw error;
  }
  return {
    ...profile,
    baseUrl,
    model,
    vllmVersion: '0.29.0',
  };
}

export function buildVllmChatRequest({
  profile,
  videoUrl,
  mediaUuid,
  systemPrompt,
  userPrompt,
  maxTokens,
  temperature,
}) {
  return {
    model: profile.model,
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: [
          {
            type: 'video_url',
            video_url: { url: videoUrl },
            ...(mediaUuid ? { uuid: mediaUuid } : {}),
          },
          {
            type: 'text',
            text: userPrompt,
          },
        ],
      },
    ],
    max_completion_tokens: maxTokens,
    temperature,
    top_p: 0.9,
  };
}

function extractAssistantText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function parseModelJson(text) {
  const cleaned = String(text || '')
    .replace(/^\`\`\`(?:json)?\s*/i, '')
    .replace(/\s*\`\`\`$/i, '')
    .trim();
  if (!cleaned) return null;
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasSubstantiveVideoAnalysis(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (String(value.summary || '').trim()) return true;
  if (Array.isArray(value.timeline) && value.timeline.length > 0) return true;
  const scores = value.scores && typeof value.scores === 'object' ? value.scores : {};
  return Object.values(scores).some((score) => Number.isFinite(Number(score)) && Number(score) > 0);
}

function vllmChatUrl(baseUrl) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  return root.endsWith('/v1') ? `${root}/chat/completions` : `${root}/v1/chat/completions`;
}

function normalizedUsage(raw = {}) {
  const inputTokens = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0);
  const outputTokens = Number(raw.completion_tokens ?? raw.output_tokens ?? 0);
  const totalTokens = Number(raw.total_tokens ?? (inputTokens + outputTokens));
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    raw,
  };
}

async function invokeVllm({
  profile,
  videoUrl,
  mediaUuid,
  systemPrompt,
  userPrompt,
  maxTokens,
  temperature,
  kind,
}) {
  const body = buildVllmChatRequest({
    profile,
    videoUrl,
    mediaUuid,
    systemPrompt,
    userPrompt,
    maxTokens,
    temperature,
  });
  const apiKey = String(process.env.VLLM_EXPERIMENT_API_KEY || '').trim();
  const timeoutMs = Math.max(1000, Number(process.env.VLLM_EXPERIMENT_TIMEOUT_MS || 180000));
  const maxAttempts = Math.max(1, Math.min(3, Number(process.env.VLLM_EXPERIMENT_MAX_ATTEMPTS || 2)));

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const response = await fetch(vllmChatUrl(profile.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const elapsedMs = Date.now() - started;
      const text = await response.text();
      let parsedBody = null;
      try {
        parsedBody = text ? JSON.parse(text) : {};
      } catch {
        parsedBody = null;
      }

      if (!response.ok) {
        const error = new Error(
          `vLLM experiment request failed with HTTP ${response.status}: ${String(parsedBody?.error?.message || parsedBody?.error || text || 'unknown error').slice(0, 500)}`,
        );
        error.statusCode = response.status >= 500 || response.status === 429 ? 502 : response.status;
        error.upstreamStatus = response.status;
        throw error;
      }

      const assistantText = extractAssistantText(parsedBody);
      return {
        kind,
        assistantText,
        elapsedMs,
        usage: normalizedUsage(parsedBody?.usage || {}),
        finishReason: parsedBody?.choices?.[0]?.finish_reason ?? null,
        requestId: response.headers.get('x-request-id') || response.headers.get('x-vllm-request-id') || null,
      };
    } catch (error) {
      lastError = error;
      const retryable = error?.name === 'AbortError'
        || Number(error?.upstreamStatus || 0) === 429
        || Number(error?.upstreamStatus || 0) >= 500;
      if (!retryable || attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (2 ** (attempt - 1))));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function aggregateUsage(calls) {
  return calls.reduce((total, call) => ({
    inputTokens: total.inputTokens + Number(call?.usage?.inputTokens || 0),
    outputTokens: total.outputTokens + Number(call?.usage?.outputTokens || 0),
    totalTokens: total.totalTokens + Number(call?.usage?.totalTokens || 0),
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
}

export function buildVllmExperimentCacheKey({ asset, request, profile }) {
  const fingerprint = String(asset?.contentFingerprint || '').trim();
  if (!fingerprint) return null;
  const material = stableJson({
    version: VLLM_EXPERIMENT_VERSION,
    contentFingerprint: fingerprint,
    sizeBytes: Number(asset?.sizeBytes || 0),
    contentType: String(asset?.contentType || ''),
    profile: {
      id: profile.id,
      method: profile.method,
      pruningRate: profile.pruningRate,
      model: profile.model,
      vllmVersion: profile.vllmVersion,
    },
    request: {
      platform: request.platform,
      objective: request.objective,
      audience: request.audience,
      context: request.context,
      transcript: request.transcript,
      declaredDurationSeconds: request.declaredDurationSeconds,
      requirements: request.requirements,
    },
  });
  return createHash('sha256').update(material).digest('hex');
}

function cacheSafeResult(result) {
  return {
    analysis: result.analysis,
    profile: result.profile,
    modelId: result.modelId,
    experimentVersion: result.experimentVersion,
  };
}

export async function runVllmPruningExperiment({
  asset,
  videoUrl,
  request,
}) {
  if (!vllmExperimentEnabled()) {
    const error = new Error('The vLLM pruning experiment is disabled.');
    error.statusCode = 404;
    throw error;
  }
  if (!videoUrl) {
    const error = new Error('A private video read URL is required for the vLLM experiment.');
    error.statusCode = 500;
    throw error;
  }

  const profile = resolveVllmProfile(request?.profile);
  const cacheKey = buildVllmExperimentCacheKey({ asset, request, profile });

  if (cacheKey) {
    const cached = await readAnalysisCache(cacheKey);
    if (cached?.value?.analysis) {
      return {
        ...cached.value,
        calls: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        analysisCacheHit: true,
        analysisCacheAgeSeconds: cached.ageSeconds,
        analysisCacheVersion: VLLM_EXPERIMENT_VERSION,
      };
    }
  }

  const prompt = buildVideoAnalysisPrompt({
    platform: request.platform,
    objective: request.objective,
    audience: request.audience,
    context: request.context,
    transcript: request.transcript,
    declaredDurationSeconds: request.declaredDurationSeconds,
    requirements: request.requirements,
  });

  const mediaUuid = `fd-${String(asset?.contentFingerprint || asset?.assetId || 'video').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80)}`;
  const calls = [];

  const analyze = async (promptText, kind = 'primary_analysis') => {
    const call = await invokeVllm({
      profile,
      videoUrl,
      mediaUuid,
      systemPrompt: VIDEO_ANALYSIS_SYSTEM_PROMPT,
      userPrompt: promptText,
      maxTokens: 5000,
      temperature: 0.1,
      kind,
    });
    calls.push(call);
    return call;
  };

  let primary = await analyze(prompt);
  let parsed = parseModelJson(primary.assistantText);
  let retryUsed = false;
  let coverageRetryUsed = false;

  if (!hasSubstantiveVideoAnalysis(parsed)) {
    retryUsed = true;
    primary = await analyze(
      `${prompt}\n\nIMPORTANT RECOVERY INSTRUCTION: The previous response was empty or non-substantive. Inspect the full supplied video carefully and return the complete JSON analysis. Do not return an empty object, empty summary, or all-zero scores unless the video itself is genuinely blank.`,
      'primary_json_recovery',
    );
    parsed = parseModelJson(primary.assistantText);
  }

  if (!hasSubstantiveVideoAnalysis(parsed)) {
    const error = new Error('The vLLM experiment did not produce a substantive video analysis.');
    error.statusCode = 422;
    throw error;
  }

  let analysis = normalizeVideoAnalysis(parsed, {
    objective: request.objective,
    requirements: request.requirements,
    hasTranscript: Boolean(request.transcript),
    declaredDurationSeconds: request.declaredDurationSeconds,
  });

  if (request.declaredDurationSeconds && analysis?.coverage?.fullDurationReviewed === false) {
    retryUsed = true;
    coverageRetryUsed = true;
    const recovery = await analyze(
      `${prompt}\n\nFULL-DURATION RECOVERY REQUIRED: Reinspect the ENTIRE supplied clip from first frame through final frame. Timeline intervals must collectively cover at least 95% of the declared ${request.declaredDurationSeconds}-second clip, begin near 0 seconds, cover the middle contiguously, and reach the final 5%. Re-evaluate continuity, CTA, and every production requirement from the full clip. Return JSON only.`,
      'primary_coverage_recovery',
    );
    const recovered = parseModelJson(recovery.assistantText);
    if (hasSubstantiveVideoAnalysis(recovered)) {
      analysis = normalizeVideoAnalysis(recovered, {
        objective: request.objective,
        requirements: request.requirements,
        hasTranscript: Boolean(request.transcript),
        declaredDurationSeconds: request.declaredDurationSeconds,
      });
    }
  }

  if (request.declaredDurationSeconds && analysis?.coverage?.fullDurationReviewed === false) {
    const error = new Error(
      `The vLLM experiment could not verify full-duration coverage through the declared ${request.declaredDurationSeconds} seconds.`,
    );
    error.statusCode = 422;
    throw error;
  }

  let complianceVerificationUsed = false;
  let complianceVerificationRetryUsed = false;
  let complianceVerificationCoverage = null;
  let complianceVerificationAgreement = null;

  if (Object.keys(request.requirements || {}).length > 0) {
    complianceVerificationUsed = true;
    const compliancePrompt = buildVideoCompliancePrompt({
      requirements: request.requirements,
      declaredDurationSeconds: request.declaredDurationSeconds,
    });

    const verify = async (promptText, kind) => {
      const call = await invokeVllm({
        profile,
        videoUrl,
        mediaUuid,
        systemPrompt: VIDEO_COMPLIANCE_SYSTEM_PROMPT,
        userPrompt: promptText,
        maxTokens: 2600,
        temperature: 0,
        kind,
      });
      calls.push(call);
      return call;
    };

    let verifierCall = await verify(compliancePrompt, 'blind_compliance');
    let verifierParsed = parseModelJson(verifierCall.assistantText);

    if (!verifierParsed) {
      complianceVerificationRetryUsed = true;
      verifierCall = await verify(
        `${compliancePrompt}\n\nJSON RECOVERY: Return the required JSON object only. Keep independently observed compliance verdicts and visual evidence. No markdown or commentary.`,
        'blind_compliance_json_recovery',
      );
      verifierParsed = parseModelJson(verifierCall.assistantText);
    }

    if (!verifierParsed) {
      const error = new Error('The vLLM blind compliance verifier returned invalid JSON after recovery.');
      error.statusCode = 422;
      throw error;
    }

    let blindCompliance = normalizeVideoCompliance(verifierParsed, request.requirements);
    let blindCoverage = assessVideoAnalysisCoverage(
      verifierParsed,
      request.declaredDurationSeconds,
    );

    if (
      request.declaredDurationSeconds
      && !isAuthoritativeVerifierCoverage(blindCoverage, request.declaredDurationSeconds)
    ) {
      complianceVerificationRetryUsed = true;
      const recoveredCall = await verify(
        `${compliancePrompt}\n\nFULL-DURATION VERIFIER RECOVERY: Reinspect the video from near 0 seconds through the final 5%, cover the middle contiguously, then re-evaluate every requirement from observable evidence only. Return JSON only.`,
        'blind_compliance_coverage_recovery',
      );
      const recoveredParsed = parseModelJson(recoveredCall.assistantText);
      if (recoveredParsed) {
        const recoveredCompliance = normalizeVideoCompliance(
          recoveredParsed,
          request.requirements,
        );
        const recoveredCoverage = assessVideoAnalysisCoverage(
          recoveredParsed,
          request.declaredDurationSeconds,
        );
        if (
          recoveredCompliance
          && isAuthoritativeVerifierCoverage(
            recoveredCoverage,
            request.declaredDurationSeconds,
          )
        ) {
          verifierParsed = recoveredParsed;
          blindCompliance = recoveredCompliance;
          blindCoverage = recoveredCoverage;
        }
      }
    }

    if (
      request.declaredDurationSeconds
      && !isAuthoritativeVerifierCoverage(blindCoverage, request.declaredDurationSeconds)
    ) {
      const error = new Error('The vLLM blind compliance verifier did not demonstrate required full-duration coverage.');
      error.statusCode = 422;
      throw error;
    }

    complianceVerificationCoverage = blindCoverage;
    const primaryEvidenceUsable = Boolean(
      analysis?.compliance
      && Array.isArray(analysis.compliance.checks)
      && (
        !request.declaredDurationSeconds
        || analysis?.coverage?.fullDurationReviewed === true
      )
    );

    const sources = [
      ...(primaryEvidenceUsable
        ? [{ ...analysis.compliance, evidenceSource: 'primary_full_duration_analysis' }]
        : []),
      { ...blindCompliance, evidenceSource: `blind_vllm_${profile.id}` },
    ];

    const consensus = consensusVideoCompliance(sources, request.requirements);
    complianceVerificationAgreement = {
      ...consensus.agreement,
      primaryEvidenceUsed: primaryEvidenceUsable,
      blindVerifierCount: 1,
      evidenceSourceCount: sources.length,
    };
    analysis = applyVerifiedVideoCompliance(analysis, consensus.compliance);
  }

  const usage = aggregateUsage(calls);
  const result = {
    analysis,
    usage,
    calls: calls.map((call) => ({
      kind: call.kind,
      elapsedMs: call.elapsedMs,
      usage: {
        inputTokens: call.usage.inputTokens,
        outputTokens: call.usage.outputTokens,
        totalTokens: call.usage.totalTokens,
      },
      finishReason: call.finishReason,
      requestId: call.requestId,
    })),
    profile: {
      id: profile.id,
      level: profile.level,
      method: profile.method,
      pruningRate: profile.pruningRate,
      pruningEnabled: profile.pruningEnabled,
      expectedRetainedFraction: Math.round((1 - profile.pruningRate) * 100) / 100,
      vllmVersion: profile.vllmVersion,
    },
    modelId: profile.model,
    experimentVersion: VLLM_EXPERIMENT_VERSION,
    retryUsed,
    coverageRetryUsed,
    complianceVerificationUsed,
    complianceVerificationRetryUsed,
    complianceVerificationCoverage,
    complianceVerificationAgreement,
    analysisCacheHit: false,
    analysisCacheAgeSeconds: 0,
    analysisCacheVersion: VLLM_EXPERIMENT_VERSION,
  };

  if (cacheKey) {
    await writeAnalysisCache(cacheKey, cacheSafeResult(result));
  }

  return result;
}
