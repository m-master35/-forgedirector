import { createHash } from 'node:crypto';
import {
  FRAME_SELECTION_EXPERIMENT_VERSION,
  createFrameSelectionStrategy,
} from './frame-selection.mjs';

export const FRAME_SELECTION_CACHE_NAMESPACE = 'fd-video-analysis-frame-selection-exp-1';
export const FRAME_SELECTION_INPUT_REPRESENTATION_VERSION = 'fd-selected-frame-input-1';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function boundedNumber(value, {
  field,
  min,
  max,
  integer = false,
  fallback = null,
} = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${field} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}`);
  }
  return parsed;
}

function normalizeSelectorConfig(strategy, raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const common = {
    seed: boundedNumber(source.seed, {
      field: 'frameSelection.selectorConfig.seed',
      min: 0,
      max: 0x7fffffff,
      integer: true,
      fallback: 42,
    }),
  };

  if (strategy === 'uniform') return common;

  const focusSource = strategy === 'hybrid'
    ? (
        source.focus
        && typeof source.focus === 'object'
        && !Array.isArray(source.focus)
          ? source.focus
          : source
      )
    : source;

  const focus = {
    ...common,
    coarseEverySeconds: boundedNumber(focusSource.coarseEverySeconds, {
      field: 'frameSelection.selectorConfig.coarseEverySeconds',
      min: 0.1,
      max: 120,
      fallback: 16,
    }),
    fineEverySeconds: boundedNumber(focusSource.fineEverySeconds, {
      field: 'frameSelection.selectorConfig.fineEverySeconds',
      min: 0.01,
      max: 120,
      fallback: 1,
    }),
    zoomRatio: boundedNumber(focusSource.zoomRatio, {
      field: 'frameSelection.selectorConfig.zoomRatio',
      min: 0.01,
      max: 1,
      fallback: 0.25,
    }),
    minCoarseSegments: boundedNumber(focusSource.minCoarseSegments, {
      field: 'frameSelection.selectorConfig.minCoarseSegments',
      min: 1,
      max: 128,
      integer: true,
      fallback: 8,
    }),
    minZoomSegments: boundedNumber(focusSource.minZoomSegments, {
      field: 'frameSelection.selectorConfig.minZoomSegments',
      min: 1,
      max: 128,
      integer: true,
      fallback: 4,
    }),
    maxZoomSegments: boundedNumber(focusSource.maxZoomSegments, {
      field: 'frameSelection.selectorConfig.maxZoomSegments',
      min: 1,
      max: 256,
      integer: true,
      fallback: 32,
    }),
    extraSamplesPerRegion: boundedNumber(focusSource.extraSamplesPerRegion, {
      field: 'frameSelection.selectorConfig.extraSamplesPerRegion',
      min: 0,
      max: 16,
      integer: true,
      fallback: 2,
    }),
    topRatio: boundedNumber(focusSource.topRatio, {
      field: 'frameSelection.selectorConfig.topRatio',
      min: 0,
      max: 1,
      fallback: 0.2,
    }),
    minGapSeconds: boundedNumber(focusSource.minGapSeconds, {
      field: 'frameSelection.selectorConfig.minGapSeconds',
      min: 0,
      max: 120,
      fallback: 0,
    }),
    confidenceScale: boundedNumber(focusSource.confidenceScale, {
      field: 'frameSelection.selectorConfig.confidenceScale',
      min: 0,
      max: 10,
      fallback: 1,
    }),
    finalArmPolicy: focusSource.finalArmPolicy === 'paper_empirical_mean'
      ? 'paper_empirical_mean'
      : 'released_optimistic',
  };

  if (strategy !== 'hybrid') return focus;

  return {
    coverageRatio: boundedNumber(source.coverageRatio, {
      field: 'frameSelection.selectorConfig.coverageRatio',
      min: 0,
      max: 1,
      fallback: 0.5,
    }),
    minCoverageFrames: boundedNumber(source.minCoverageFrames, {
      field: 'frameSelection.selectorConfig.minCoverageFrames',
      min: 0,
      max: 256,
      integer: true,
      fallback: 4,
    }),
    focus,
  };
}

export function frameSelectionExperimentEnabled(env = process.env) {
  return String(env?.FRAME_SELECTION_EXPERIMENT_ENABLED || '').trim().toLowerCase() === 'true';
}

/**
 * Experimental configuration requires two independent opt-ins:
 * 1. deployment/environment feature flag, and
 * 2. explicit request-level experiment.enabled === true.
 *
 * Production requests therefore remain baseline even if callers invent
 * frame-selection fields while the environment flag is off.
 */
export function normalizeFrameSelectionExperiment(payload = {}, env = process.env) {
  if (!frameSelectionExperimentEnabled(env)) return null;

  const raw = payload?.experiment?.frameSelection;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.enabled !== true) return null;

  const strategy = String(raw.strategy || 'hybrid').trim().toLowerCase();
  if (!['uniform', 'focus', 'hybrid'].includes(strategy)) {
    throw new Error('frameSelection.strategy must be uniform, focus, or hybrid');
  }

  const frameBudget = boundedNumber(raw.frameBudget, {
    field: 'frameSelection.frameBudget',
    min: 1,
    max: 256,
    integer: true,
    fallback: 32,
  });

  const selector = createFrameSelectionStrategy(strategy);

  return {
    enabled: true,
    experimentVersion: FRAME_SELECTION_EXPERIMENT_VERSION,
    cacheNamespace: FRAME_SELECTION_CACHE_NAMESPACE,
    inputRepresentationVersion: FRAME_SELECTION_INPUT_REPRESENTATION_VERSION,
    strategy,
    selectorVersion: selector.version,
    frameBudget,
    selectorConfig: normalizeSelectorConfig(strategy, raw.selectorConfig),
  };
}

/**
 * Build an explicitly incompatible cache identity for a selected-frame
 * analysis. This is intentionally separate from the production cache-key
 * helper until the experimental input path exists.
 */
export function buildFrameSelectionExperimentCacheIdentity({
  asset = {},
  request = {},
  primaryModelId = null,
  fallbackModelId = null,
  promptVersion = null,
  experiment,
} = {}) {
  if (!experiment?.enabled) {
    throw new Error('enabled frame-selection experiment configuration is required');
  }

  const fingerprint = String(asset?.contentFingerprint || '').trim();
  if (!fingerprint) {
    throw new Error('contentFingerprint is required for experimental cache identity');
  }

  const material = {
    cacheNamespace: FRAME_SELECTION_CACHE_NAMESPACE,
    experimentVersion: experiment.experimentVersion,
    inputRepresentationVersion: experiment.inputRepresentationVersion,
    contentFingerprint: fingerprint,
    sizeBytes: Number(asset?.sizeBytes || 0),
    contentType: String(asset?.contentType || ''),
    platform: request?.platform ?? null,
    objective: request?.objective ?? null,
    audience: request?.audience ?? null,
    context: request?.context ?? null,
    transcript: request?.transcript ?? null,
    declaredDurationSeconds: request?.declaredDurationSeconds ?? null,
    requirements: request?.requirements ?? {},
    primaryModelId,
    fallbackModelId,
    promptVersion,
    frameSelection: {
      strategy: experiment.strategy,
      selectorVersion: experiment.selectorVersion,
      selectorConfig: experiment.selectorConfig,
      frameBudget: experiment.frameBudget,
    },
  };

  const serialized = stableJson(material);
  return {
    key: createHash('sha256').update(serialized).digest('hex'),
    material,
    serialized,
  };
}
