import assert from 'node:assert/strict';
import {
  VLLM_EXPERIMENT_VERSION,
  VLLM_PRUNING_PROFILES,
  buildVllmChatRequest,
  buildVllmExperimentCacheKey,
  resolveVllmProfile,
  vllmExperimentEnabled,
} from '../backend/vllm-experiment.mjs';

assert.match(VLLM_EXPERIMENT_VERSION, /vllm-0\.29\.0/);

assert.deepEqual(
  [
    VLLM_PRUNING_PROFILES.baseline.pruningRate,
    VLLM_PRUNING_PROFILES['evs-conservative'].pruningRate,
    VLLM_PRUNING_PROFILES['evs-medium'].pruningRate,
    VLLM_PRUNING_PROFILES['evs-aggressive'].pruningRate,
  ],
  [0, 0.25, 0.5, 0.75],
);

for (const profile of Object.values(VLLM_PRUNING_PROFILES)) {
  assert.ok(profile.pruningRate >= 0 && profile.pruningRate < 1);
  assert.ok(['evs', 'vidcom2'].includes(profile.method));
}
assert.equal(VLLM_PRUNING_PROFILES.baseline.pruningEnabled, false);
assert.equal(VLLM_PRUNING_PROFILES['vidcom2-medium'].requiresQwen3Vl, true);

const previousEnabled = process.env.VLLM_EXPERIMENT_ENABLED;
const previousEndpoints = process.env.VLLM_EXPERIMENT_ENDPOINTS_JSON;
const previousModel = process.env.VLLM_EXPERIMENT_MODEL;

try {
  delete process.env.VLLM_EXPERIMENT_ENABLED;
  assert.equal(vllmExperimentEnabled(), false);
  process.env.VLLM_EXPERIMENT_ENABLED = 'true';
  assert.equal(vllmExperimentEnabled(), true);

  process.env.VLLM_EXPERIMENT_ENDPOINTS_JSON = JSON.stringify({
    baseline: 'http://127.0.0.1:8100/v1',
    'evs-medium': 'http://127.0.0.1:8101/v1',
    'vidcom2-medium': 'http://127.0.0.1:8102/v1',
  });
  process.env.VLLM_EXPERIMENT_MODEL = 'Qwen/Qwen3-VL-8B-Instruct';

  const baseline = resolveVllmProfile('baseline');
  const evsMedium = resolveVllmProfile('evs-medium');
  const vidcom2Medium = resolveVllmProfile('vidcom2-medium');

  assert.equal(baseline.pruningRate, 0);
  assert.equal(evsMedium.pruningRate, 0.5);
  assert.equal(vidcom2Medium.method, 'vidcom2');
  assert.equal(evsMedium.baseUrl, 'http://127.0.0.1:8101/v1');

  const request = buildVllmChatRequest({
    profile: evsMedium,
    videoUrl: 'https://example.test/private-video.mp4?signature=redacted',
    mediaUuid: 'video-fingerprint',
    systemPrompt: 'system',
    userPrompt: 'inspect',
    maxTokens: 123,
    temperature: 0.1,
  });

  assert.equal(request.model, 'Qwen/Qwen3-VL-8B-Instruct');
  assert.equal(request.messages[1].content[0].type, 'video_url');
  assert.equal(
    request.messages[1].content[0].video_url.url,
    'https://example.test/private-video.mp4?signature=redacted',
  );
  assert.equal(request.messages[1].content[0].uuid, 'video-fingerprint');
  assert.equal(request.messages[1].content[1].text, 'inspect');
  assert.equal(request.max_completion_tokens, 123);

  const asset = {
    contentFingerprint: 'same-content',
    sizeBytes: 12345,
    contentType: 'video/mp4',
  };
  const normalizedRequest = {
    platform: 'General',
    objective: 'awareness',
    audience: '',
    context: 'same request',
    transcript: '',
    declaredDurationSeconds: 12,
    requirements: { mustShow: ['motorcycle'] },
  };

  const baselineKey = buildVllmExperimentCacheKey({
    asset,
    request: normalizedRequest,
    profile: baseline,
  });
  const evsKey = buildVllmExperimentCacheKey({
    asset,
    request: normalizedRequest,
    profile: evsMedium,
  });
  const vidcom2Key = buildVllmExperimentCacheKey({
    asset,
    request: normalizedRequest,
    profile: vidcom2Medium,
  });

  assert.match(baselineKey, /^[a-f0-9]{64}$/);
  assert.notEqual(baselineKey, evsKey);
  assert.notEqual(evsKey, vidcom2Key);

  process.env.VLLM_EXPERIMENT_MODEL = 'some-other-video-model';
  assert.throws(
    () => resolveVllmProfile('vidcom2-medium'),
    /VidCom2.*Qwen3-VL/i,
  );
} finally {
  if (previousEnabled === undefined) delete process.env.VLLM_EXPERIMENT_ENABLED;
  else process.env.VLLM_EXPERIMENT_ENABLED = previousEnabled;
  if (previousEndpoints === undefined) delete process.env.VLLM_EXPERIMENT_ENDPOINTS_JSON;
  else process.env.VLLM_EXPERIMENT_ENDPOINTS_JSON = previousEndpoints;
  if (previousModel === undefined) delete process.env.VLLM_EXPERIMENT_MODEL;
  else process.env.VLLM_EXPERIMENT_MODEL = previousModel;
}

console.log('vLLM pruning experiment tests passed');
