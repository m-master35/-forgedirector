import assert from 'node:assert/strict';
import {
  effectiveEscalationMetrics,
  intervalSeconds,
  summarizeLatency,
  tokenCostUsd,
} from '../experiments/targeted-escalation/benchmark-utils.mjs';

assert.equal(intervalSeconds([
  { startSeconds: 1, endSeconds: 3 },
  { durationSeconds: 4 },
]), 6);

const localized = effectiveEscalationMetrics(20, {
  findings: [{ sourceFindingId: 'one' }],
  mergedIntervals: [{ startSeconds: 3, endSeconds: 15, durationSeconds: 12 }],
  targetedEscalationPossible: true,
  wholeVideoFallbackRequired: false,
});
assert.equal(localized.baselineProCalls, 1);
assert.equal(localized.baselineProSeconds, 20);
assert.equal(localized.targetedSegmentSeconds, 12);
assert.equal(localized.effectiveRoute, 'targeted_segments');
assert.equal(localized.effectiveProCalls, 1);
assert.equal(localized.effectiveProSeconds, 12);
assert.equal(localized.reductionPercent, 40);

const global = effectiveEscalationMetrics(20, {
  findings: [{ sourceFindingId: 'global' }],
  mergedIntervals: [],
  targetedEscalationPossible: false,
  wholeVideoFallbackRequired: true,
});
assert.equal(global.baselineProSeconds, 20);
assert.equal(global.effectiveRoute, 'whole_video_fallback');
assert.equal(global.effectiveProSeconds, 20);
assert.equal(global.reductionPercent, 0);

const mixed = effectiveEscalationMetrics(20, {
  findings: [{ sourceFindingId: 'local' }, { sourceFindingId: 'global' }],
  mergedIntervals: [{ startSeconds: 6, endSeconds: 12, durationSeconds: 6 }],
  targetedEscalationPossible: true,
  wholeVideoFallbackRequired: true,
});
assert.equal(mixed.targetedSegmentSeconds, 6);
assert.equal(mixed.effectiveRoute, 'whole_video_fallback');
assert.equal(mixed.effectiveProCalls, 1);
assert.equal(mixed.effectiveProSeconds, 20);
assert.equal(mixed.reductionPercent, 0);

const clean = effectiveEscalationMetrics(20, {
  findings: [],
  mergedIntervals: [],
  targetedEscalationPossible: false,
  wholeVideoFallbackRequired: false,
});
assert.equal(clean.baselineEscalationRequired, false);
assert.equal(clean.baselineProSeconds, 0);
assert.equal(clean.effectiveRoute, 'no_pro_needed');
assert.equal(clean.effectiveProSeconds, 0);
assert.equal(clean.reductionPercent, null);

const budgetFallback = effectiveEscalationMetrics(20, {
  findings: [{ sourceFindingId: 'local' }],
  mergedIntervals: [{ startSeconds: 8, endSeconds: 10, durationSeconds: 2 }],
  targetedEscalationPossible: false,
  wholeVideoFallbackRequired: true,
});
assert.equal(budgetFallback.effectiveRoute, 'whole_video_fallback');
assert.equal(budgetFallback.effectiveProSeconds, 20);

assert.equal(tokenCostUsd(
  { inputTokens: 1_000_000, outputTokens: 500_000 },
  { inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5 },
), 1.55);

assert.deepEqual(summarizeLatency([100, 200, 300, 400, 500]), {
  samples: 5,
  p50: 300,
  p95: 500,
});

console.log('Targeted escalation benchmark economics tests passed');
