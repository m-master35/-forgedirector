import assert from 'node:assert/strict';
import {
  FRAME_SELECTION_CACHE_NAMESPACE,
  FRAME_SELECTION_INPUT_REPRESENTATION_VERSION,
  frameSelectionExperimentEnabled,
  normalizeFrameSelectionExperiment,
  buildFrameSelectionExperimentCacheIdentity,
} from '../backend/frame-selection-experiment.mjs';

const disabledEnv = { FRAME_SELECTION_EXPERIMENT_ENABLED: 'false' };
const enabledEnv = { FRAME_SELECTION_EXPERIMENT_ENABLED: 'true' };

assert.equal(frameSelectionExperimentEnabled(disabledEnv), false);
assert.equal(frameSelectionExperimentEnabled({ FRAME_SELECTION_EXPERIMENT_ENABLED: 'TRUE' }), true);

const requested = {
  experiment: {
    frameSelection: {
      enabled: true,
      strategy: 'focus',
      frameBudget: 24,
      selectorConfig: {
        seed: 7,
        coarseEverySeconds: 12,
        fineEverySeconds: 0.5,
        zoomRatio: 0.3,
        finalArmPolicy: 'paper_empirical_mean',
      },
    },
  },
};

assert.equal(normalizeFrameSelectionExperiment(requested, disabledEnv), null);
assert.equal(normalizeFrameSelectionExperiment({}, enabledEnv), null);
assert.equal(
  normalizeFrameSelectionExperiment({
    experiment: { frameSelection: { enabled: false } },
  }, enabledEnv),
  null,
);

const focusExperiment = normalizeFrameSelectionExperiment(requested, enabledEnv);
assert.equal(focusExperiment.enabled, true);
assert.equal(focusExperiment.strategy, 'focus');
assert.equal(focusExperiment.selectorVersion, 'fd-focus-concept-1');
assert.equal(focusExperiment.frameBudget, 24);
assert.equal(focusExperiment.selectorConfig.seed, 7);
assert.equal(focusExperiment.selectorConfig.coarseEverySeconds, 12);
assert.equal(focusExperiment.selectorConfig.finalArmPolicy, 'paper_empirical_mean');
assert.equal(focusExperiment.cacheNamespace, FRAME_SELECTION_CACHE_NAMESPACE);
assert.equal(
  focusExperiment.inputRepresentationVersion,
  FRAME_SELECTION_INPUT_REPRESENTATION_VERSION,
);

assert.throws(
  () => normalizeFrameSelectionExperiment({
    experiment: {
      frameSelection: {
        enabled: true,
        strategy: 'focus',
        frameBudget: 0,
      },
    },
  }, enabledEnv),
  /frameSelection\.frameBudget/,
);

assert.throws(
  () => normalizeFrameSelectionExperiment({
    experiment: {
      frameSelection: {
        enabled: true,
        strategy: 'mystery',
      },
    },
  }, enabledEnv),
  /uniform, focus, or hybrid/,
);

const baseArgs = {
  asset: {
    contentFingerprint: 'abc123',
    sizeBytes: 123456,
    contentType: 'video/mp4',
  },
  request: {
    platform: 'General',
    objective: 'awareness',
    audience: 'test',
    context: 'benchmark',
    transcript: '',
    declaredDurationSeconds: 60,
    requirements: {
      mustShow: ['product'],
    },
  },
  primaryModelId: 'primary-model',
  fallbackModelId: 'fallback-model',
  promptVersion: 'video-prompt-v1',
};

const identityA = buildFrameSelectionExperimentCacheIdentity({
  ...baseArgs,
  experiment: focusExperiment,
});

assert.equal(identityA.material.cacheNamespace, FRAME_SELECTION_CACHE_NAMESPACE);
assert.equal(identityA.material.frameSelection.strategy, 'focus');
assert.equal(identityA.material.frameSelection.frameBudget, 24);
assert.match(identityA.key, /^[a-f0-9]{64}$/);

const reorderedExperiment = {
  ...focusExperiment,
  selectorConfig: {
    finalArmPolicy: focusExperiment.selectorConfig.finalArmPolicy,
    zoomRatio: focusExperiment.selectorConfig.zoomRatio,
    fineEverySeconds: focusExperiment.selectorConfig.fineEverySeconds,
    coarseEverySeconds: focusExperiment.selectorConfig.coarseEverySeconds,
    seed: focusExperiment.selectorConfig.seed,
    minCoarseSegments: focusExperiment.selectorConfig.minCoarseSegments,
    minZoomSegments: focusExperiment.selectorConfig.minZoomSegments,
    maxZoomSegments: focusExperiment.selectorConfig.maxZoomSegments,
    extraSamplesPerRegion: focusExperiment.selectorConfig.extraSamplesPerRegion,
    topRatio: focusExperiment.selectorConfig.topRatio,
    minGapSeconds: focusExperiment.selectorConfig.minGapSeconds,
    confidenceScale: focusExperiment.selectorConfig.confidenceScale,
  },
};

const identityReordered = buildFrameSelectionExperimentCacheIdentity({
  ...baseArgs,
  experiment: reorderedExperiment,
});
assert.equal(identityA.key, identityReordered.key, 'object key order must not change cache identity');

const changedBudget = buildFrameSelectionExperimentCacheIdentity({
  ...baseArgs,
  experiment: {
    ...focusExperiment,
    frameBudget: 12,
  },
});
assert.notEqual(identityA.key, changedBudget.key);

const changedPolicy = buildFrameSelectionExperimentCacheIdentity({
  ...baseArgs,
  experiment: {
    ...focusExperiment,
    selectorConfig: {
      ...focusExperiment.selectorConfig,
      finalArmPolicy: 'released_optimistic',
    },
  },
});
assert.notEqual(identityA.key, changedPolicy.key);

const changedModel = buildFrameSelectionExperimentCacheIdentity({
  ...baseArgs,
  primaryModelId: 'different-model',
  experiment: focusExperiment,
});
assert.notEqual(identityA.key, changedModel.key);

const changedPrompt = buildFrameSelectionExperimentCacheIdentity({
  ...baseArgs,
  promptVersion: 'video-prompt-v2',
  experiment: focusExperiment,
});
assert.notEqual(identityA.key, changedPrompt.key);

const uniformExperiment = normalizeFrameSelectionExperiment({
  experiment: {
    frameSelection: {
      enabled: true,
      strategy: 'uniform',
      frameBudget: 24,
      selectorConfig: { seed: 7 },
    },
  },
}, enabledEnv);

const uniformIdentity = buildFrameSelectionExperimentCacheIdentity({
  ...baseArgs,
  experiment: uniformExperiment,
});
assert.notEqual(identityA.key, uniformIdentity.key);

const hybridExperiment = normalizeFrameSelectionExperiment({
  experiment: {
    frameSelection: {
      enabled: true,
      strategy: 'hybrid',
      frameBudget: 24,
      selectorConfig: {
        coverageRatio: 0.5,
        minCoverageFrames: 6,
        focus: {
          seed: 7,
          finalArmPolicy: 'released_optimistic',
        },
      },
    },
  },
}, enabledEnv);

const hybridIdentity = buildFrameSelectionExperimentCacheIdentity({
  ...baseArgs,
  experiment: hybridExperiment,
});
assert.notEqual(identityA.key, hybridIdentity.key);
assert.equal(hybridIdentity.material.frameSelection.strategy, 'hybrid');
assert.equal(hybridExperiment.selectorConfig.coverageRatio, 0.5);
assert.equal(hybridExperiment.selectorConfig.minCoverageFrames, 6);

assert.throws(
  () => buildFrameSelectionExperimentCacheIdentity({
    ...baseArgs,
    experiment: null,
  }),
  /enabled frame-selection experiment/,
);

assert.throws(
  () => buildFrameSelectionExperimentCacheIdentity({
    ...baseArgs,
    asset: { contentFingerprint: '' },
    experiment: focusExperiment,
  }),
  /contentFingerprint/,
);

console.log('frame-selection cache-isolation tests passed');
