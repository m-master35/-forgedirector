import assert from 'node:assert/strict';
import {
  VLLM_PRUNING_PROFILES,
  VLLM_EXPERIMENT_VLLM_VERSION,
  VLLM_EXPERIMENT_DEFAULT_MODEL,
  vllmExperimentEnabled,
  vllmLaunchArgs,
  experimentalVllmRequest,
  configuredVllmEndpoint,
  vllmExperimentCacheKey,
  analyzeWithExperimentalVllm,
} from '../backend/experimental-vllm.mjs';

assert.equal(VLLM_EXPERIMENT_VLLM_VERSION, '0.29.0');
assert.equal(VLLM_EXPERIMENT_DEFAULT_MODEL, 'Qwen/Qwen3-VL-8B-Instruct');
assert.equal(vllmExperimentEnabled({ FORGEDIRECTOR_VLLM_EXPERIMENT_ENABLED: 'true' }), true);
assert.equal(vllmExperimentEnabled({}), false);
assert.equal(VLLM_PRUNING_PROFILES.baseline.pruningRate, 0);
assert.deepEqual(vllmLaunchArgs('baseline'), []);
assert.deepEqual(vllmLaunchArgs('evs-medium'), ['--video-pruning-rate', '0.5', '--video-pruning-method', 'evs']);
assert.deepEqual(vllmLaunchArgs('vidcom2-aggressive'), ['--video-pruning-rate', '0.75', '--video-pruning-method', 'vidcom2']);

assert.equal(experimentalVllmRequest({}, {}), null);
assert.throws(
  () => experimentalVllmRequest({ experiment: { profile: 'evs-medium' } }, { FORGEDIRECTOR_VLLM_EXPERIMENT_ENABLED: 'true' }),
  /backend is required/i,
);
assert.throws(
  () => experimentalVllmRequest({ experiment: { backend: 'vllm', profile: 'evs-medium' } }, {}),
  /disabled/i,
);
const requested = experimentalVllmRequest(
  { experiment: { backend: 'vllm', profile: 'evs-medium' } },
  { FORGEDIRECTOR_VLLM_EXPERIMENT_ENABLED: 'true' },
);
assert.equal(requested.profile.pruningRate, 0.5);

const env = {
  VLLM_EXPERIMENT_ENDPOINTS_JSON: JSON.stringify({
    baseline: {
      baseUrl: 'http://127.0.0.1:8100',
      model: 'Qwen/Qwen3-VL-8B-Instruct',
      vllmVersion: '0.29.0',
      pruningRate: 0,
      pruningMethod: 'evs',
    },
    'vidcom2-medium': {
      baseUrl: 'http://127.0.0.1:8150',
      model: 'Qwen/Qwen3-VL-8B-Instruct',
      vllmVersion: '0.29.0',
      pruningRate: 0.5,
      pruningMethod: 'vidcom2',
    },
  }),
};
const endpoint = configuredVllmEndpoint('baseline', env);
assert.equal(endpoint.baseUrl, 'http://127.0.0.1:8100');
assert.equal(configuredVllmEndpoint('vidcom2-medium', env).pruningMethod, 'vidcom2');
assert.throws(
  () => configuredVllmEndpoint('vidcom2-medium', {
    VLLM_EXPERIMENT_ENDPOINTS_JSON: JSON.stringify({
      'vidcom2-medium': {
        baseUrl: 'http://127.0.0.1:8150',
        model: 'llava-hf/llava-onevision-qwen2-0.5b-ov-hf',
        vllmVersion: '0.29.0',
        pruningRate: 0.5,
        pruningMethod: 'vidcom2',
      },
    }),
  }),
  /Qwen3-VL/,
);

const asset = {
  contentFingerprint: 'abc123',
  sizeBytes: 100,
  contentType: 'video/mp4',
};
const keyA = vllmExperimentCacheKey({ asset, request: { objective: 'awareness' }, endpoint });
const keyB = vllmExperimentCacheKey({
  asset,
  request: { objective: 'awareness' },
  endpoint: { ...endpoint, profileName: 'evs-medium', pruningRate: 0.5 },
});
assert.match(keyA, /^[a-f0-9]{64}$/);
assert.notEqual(keyA, keyB);

const modelObject = {
  summary: 'A product appears throughout the clip.',
  creativeAngle: 'Direct demonstion.',
  scores: {
    hook: 80, pacing: 75, clarity: 85, visualQuality: 80,
    continuity: 90, cta: 70, platformFit: 80, conversionReadiness: 75,
  },
  hook: { firstThreeSeconds: 'Product in frame.', spokenHook: null, onScreenHook: null, verdict: 'strong', issues: [] },
  timeline: [
    { startSeconds: 0, endSeconds: 3, purpose: 'hook', visual: 'Coffee mug visible.', speech: null, onScreenText: null, issues: [], recommendations: [] },
    { startSeconds: 3, endSeconds: 6, purpose: 'demo', visual: 'Coffee mug remains visible.', speech: null, onScreenText: null, issues: [], recommendations: [] },
  ],
  retentionRisks: [],
  continuity: { verdict: 'strong', issues: [] },
  cta: { present: false, type: 'none', clarity: 'weak', issue: 'No CTA.' },
  platformAssessment: { fit: 'strong', reasons: ['Vertical framing is clear.'] },
  fixes: [],
  regenerationPrompts: [],
  repurpose: { tiktok: [], instagramReels: [], youtubeShorts: [] },
  compliance: {
    checks: [{ type: 'mustShow', rule: 'coffee mug', status: 'pass', evidence: 'Coffee mug visible.', timestampSeconds: 1 }],
  },
  limitations: [],
};
let calls = 0;
const fakeFetch = async (_url, options) => {
  calls += 1;
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'Qwen/Qwen3-VL-8B-Instruct');
  assert.equal(body.max_completion_tokens > 0, true);
  assert.equal('max_tokens' in body, false);
  assert.ok(body.messages[1].content.some((part) => part.type === 'video_url'));
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(modelObject) } }],
    usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const result = await analyzeWithExperimentalVllm({
  payload: {
    platform: 'General',
    objective: 'awareness',
    durationSeconds: 6,
    requirements: { mustShow: ['coffee mug'] },
  },
  videoUrl: 'https://example.invalid/signed-video.mp4',
  endpoint,
  fetchImpl: fakeFetch,
});
assert.equal(calls, 2);
assert.equal(result.analysis.coverage.fullDurationReviewed, true);
assert.equal(result.analysis.compliance.status, 'pass');
assert.equal(result.complianceVerificationUsed, true);
assert.equal(result.usage.totalTokens, 2400);
assert.equal(result.experiment.pruningRate, 0);

console.log('Experimental vLLM pruning tests passed');
