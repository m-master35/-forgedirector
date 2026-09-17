import assert from 'node:assert/strict';
import { runTargetedEscalationExperiment } from '../backend/targeted-escalation-runtime.mjs';

const envOn = { TARGETED_ESCALATION_EXPERIMENT_ENABLED: 'true' };
const optIn = {
  experiments: {
    targetedEscalation: {
      enabled: true,
      strategy: 'medium',
      maxProCalls: 3,
      maxTotalEscalatedSeconds: 60,
      maxIndividualIntervalSeconds: 30,
    },
  },
};

const localizedAnalysis = {
  timeline: [{
    startSeconds: 5,
    endSeconds: 10,
    purpose: 'other',
    issues: ['Visible text contains a spelling typo.'],
  }],
  compliance: { checks: [] },
  regenerationPrompts: [],
  retentionRisks: [],
};

const inactiveMissingRequest = await runTargetedEscalationExperiment({
  analysis: localizedAnalysis,
  payload: {},
  env: envOn,
  durationSeconds: 20,
});
assert.equal(inactiveMissingRequest.active, false);
assert.equal(inactiveMissingRequest.outcome, 'baseline_unchanged');
assert.equal(inactiveMissingRequest.reason, 'request_opt_in_missing');

const inactiveFlag = await runTargetedEscalationExperiment({
  analysis: localizedAnalysis,
  payload: optIn,
  env: {},
  durationSeconds: 20,
});
assert.equal(inactiveFlag.active, false);
assert.equal(inactiveFlag.reason, 'environment_feature_flag_disabled');

const noFindings = await runTargetedEscalationExperiment({
  analysis: {
    timeline: [{ startSeconds: 0, endSeconds: 10, issues: [] }],
    compliance: { checks: [] },
  },
  payload: optIn,
  env: envOn,
  durationSeconds: 10,
});
assert.equal(noFindings.active, true);
assert.equal(noFindings.outcome, 'no_escalation');

const targetedCalls = [];
const targeted = await runTargetedEscalationExperiment({
  analysis: localizedAnalysis,
  payload: optIn,
  env: envOn,
  durationSeconds: 20,
  extractSegment: async ({ interval }) => ({
    sourceStartSeconds: interval.startSeconds,
    sourceEndSeconds: interval.endSeconds,
    actualSourceStartSeconds: interval.startSeconds,
    actualSourceEndSeconds: interval.endSeconds,
    outputDurationSeconds: interval.endSeconds - interval.startSeconds,
  }),
  invokeTargetedPro: async (input) => {
    targetedCalls.push(input);
    return { findings: [{ status: 'confirmed' }] };
  },
});
assert.equal(targeted.outcome, 'targeted_complete');
assert.equal(targeted.targetedResults.length, 1);
assert.equal(targetedCalls.length, 1);

const hybridPayload = structuredClone(optIn);
hybridPayload.experiments.targetedEscalation.strategy = 'hybrid';
const globalAnalysis = {
  timeline: [{
    startSeconds: 0,
    endSeconds: 20,
    purpose: 'other',
    issues: ['Pacing is too slow across the whole video.'],
  }],
  compliance: { checks: [] },
};
let fallbackCalls = 0;
const globalFallback = await runTargetedEscalationExperiment({
  analysis: globalAnalysis,
  payload: hybridPayload,
  env: envOn,
  durationSeconds: 20,
  invokeWholeVideoFallback: async ({ reason }) => {
    fallbackCalls += 1;
    return { ok: true, reason };
  },
});
assert.equal(globalFallback.outcome, 'whole_video_fallback');
assert.equal(globalFallback.fallbackReason, 'no_safe_targeted_window');
assert.equal(fallbackCalls, 1);

const mixedAnalysis = {
  timeline: [
    { startSeconds: 5, endSeconds: 10, issues: ['Visible text contains a spelling typo.'] },
    { startSeconds: 0, endSeconds: 20, issues: ['Pacing is too slow across the whole video.'] },
  ],
  compliance: { checks: [] },
};
const mixedFallback = await runTargetedEscalationExperiment({
  analysis: mixedAnalysis,
  payload: hybridPayload,
  env: envOn,
  durationSeconds: 20,
  invokeWholeVideoFallback: async () => ({ ok: true }),
});
assert.equal(mixedFallback.outcome, 'whole_video_fallback');
assert.equal(mixedFallback.fallbackReason, 'hybrid_global_or_context_sensitive_finding');

const extractionFailure = await runTargetedEscalationExperiment({
  analysis: localizedAnalysis,
  payload: hybridPayload,
  env: envOn,
  durationSeconds: 20,
  extractSegment: async () => {
    const error = new Error('ffmpeg failed');
    error.code = 'MEDIA_COMMAND_FAILED';
    throw error;
  },
  invokeTargetedPro: async () => ({ ok: true }),
  invokeWholeVideoFallback: async () => ({ ok: true }),
});
assert.equal(extractionFailure.outcome, 'whole_video_fallback');
assert.equal(extractionFailure.fallbackReason, 'segment_extraction_failed');
assert.equal(extractionFailure.extractionError.code, 'MEDIA_COMMAND_FAILED');

const proFailure = await runTargetedEscalationExperiment({
  analysis: localizedAnalysis,
  payload: hybridPayload,
  env: envOn,
  durationSeconds: 20,
  extractSegment: async ({ interval }) => ({
    sourceStartSeconds: interval.startSeconds,
    sourceEndSeconds: interval.endSeconds,
  }),
  invokeTargetedPro: async () => {
    const error = new Error('provider timeout');
    error.code = 'ModelTimeoutException';
    throw error;
  },
  invokeWholeVideoFallback: async () => ({ ok: true }),
});
assert.equal(proFailure.outcome, 'whole_video_fallback');
assert.equal(proFailure.fallbackReason, 'targeted_pro_failed');
assert.equal(proFailure.proError.code, 'ModelTimeoutException');

const nonHybridFailure = await runTargetedEscalationExperiment({
  analysis: localizedAnalysis,
  payload: optIn,
  env: envOn,
  durationSeconds: 20,
  extractSegment: async () => {
    throw new Error('bad media');
  },
  invokeTargetedPro: async () => ({ ok: true }),
});
assert.equal(nonHybridFailure.outcome, 'fail_closed');

const tinyBudgetPayload = {
  experiments: {
    targetedEscalation: {
      enabled: true,
      strategy: 'medium',
      maxProCalls: 1,
      maxTotalEscalatedSeconds: 1,
      maxIndividualIntervalSeconds: 1,
    },
  },
};
const budgetFallback = await runTargetedEscalationExperiment({
  analysis: localizedAnalysis,
  payload: tinyBudgetPayload,
  env: envOn,
  durationSeconds: 20,
  invokeWholeVideoFallback: async () => ({ ok: true }),
});
assert.equal(budgetFallback.outcome, 'whole_video_fallback');
assert.equal(budgetFallback.fallbackReason, 'targeted_budget_rejected');

const fallbackFailure = await runTargetedEscalationExperiment({
  analysis: globalAnalysis,
  payload: hybridPayload,
  env: envOn,
  durationSeconds: 20,
  invokeWholeVideoFallback: async () => {
    throw new Error('baseline provider unavailable');
  },
});
assert.equal(fallbackFailure.outcome, 'fail_closed');
assert.match(fallbackFailure.errorMessage, /baseline provider unavailable/);

console.log('Targeted escalation runtime tests passed');
