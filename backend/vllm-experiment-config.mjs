import { createHash } from 'node:crypto';

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
    const url = String(
      value && typeof value === 'object' && !Array.isArray(value)
        ? value.url
        : value,
    ).trim().replace(/\/+$/, '');
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) {
      const error = new Error(`vLLM endpoint for profile ${key} must use http:// or https://.`);
      error.statusCode = 503;
      throw error;
    }
    result[key] = {
      url,
      ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
    };
  }
  return result;
}

function assertEndpointAttestation(profile, configured) {
  if (!configured || typeof configured !== 'object') return;
  if (configured.method !== undefined && String(configured.method) !== profile.method) {
    const error = new Error(
      `Configured endpoint for ${profile.id} attests method ${configured.method}, expected ${profile.method}.`,
    );
    error.statusCode = 503;
    throw error;
  }
  if (
    configured.pruningRate !== undefined
    && Number(configured.pruningRate) !== Number(profile.pruningRate)
  ) {
    const error = new Error(
      `Configured endpoint for ${profile.id} attests pruningRate ${configured.pruningRate}, expected ${profile.pruningRate}.`,
    );
    error.statusCode = 503;
    throw error;
  }
  if (
    configured.vllmVersion !== undefined
    && String(configured.vllmVersion) !== '0.29.0'
  ) {
    const error = new Error(
      `Configured endpoint for ${profile.id} attests vLLM ${configured.vllmVersion}, expected 0.29.0.`,
    );
    error.statusCode = 503;
    throw error;
  }
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
  const configured = endpoints[id];
  if (!configured?.url) {
    const error = new Error(`No vLLM endpoint is configured for experiment profile ${id}.`);
    error.statusCode = 503;
    throw error;
  }
  assertEndpointAttestation(profile, configured);

  const model = String(configured.model || configuredModel()).trim();
  if (profile.requiresQwen3Vl && !/qwen3[-_. ]?vl/i.test(model)) {
    const error = new Error(`Profile ${id} uses VidCom2, which vLLM currently supports only for Qwen3-VL. Configured model: ${model || '(empty)'}.`);
    error.statusCode = 503;
    throw error;
  }
  return {
    ...profile,
    baseUrl: configured.url,
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
