import assert from 'node:assert/strict';
import {
  TARGETED_ESCALATION_EXPERIMENT_VERSION,
  TARGETED_ESCALATION_POLICY_VERSION,
  applyTemporalPadding,
  assessTargetedEscalationBudget,
  buildTargetedEscalationPlan,
  collectSuspiciousIntervals,
  mapProFindingToSource,
  mapSegmentTimestampToSource,
  mergeEscalationIntervals,
  normalizeTargetedEscalationConfig,
  targetedEscalationCacheKey,
  targetedEscalationDurationMetrics,
  targetedEscalationFeatureEnabled,
  targetedEscalationGate,
  targetedEscalationRequested,
} from '../backend/targeted-escalation.mjs';

assert.equal(TARGETED_ESCALATION_EXPERIMENT_VERSION, 'fd-targeted-escalation-v1');
assert.equal(TARGETED_ESCALATION_POLICY_VERSION, 'fd-targeted-routing-v1');

assert.equal(targetedEscalationFeatureEnabled({ TARGETED_ESCALATION_EXPERIMENT_ENABLED: 'true' }), true);
assert.equal(targetedEscalationFeatureEnabled({ TARGETED_ESCALATION_EXPERIMENT_ENABLED: 'FALSE' }), false);
assert.equal(targetedEscalationRequested({ experiments: { targetedEscalation: { enabled: true } } }), true);
assert.equal(targetedEscalationRequested({}), false);
assert.deepEqual(
  targetedEscalationGate(
    { experiments: { targetedEscalation: { enabled: true } } },
    { TARGETED_ESCALATION_EXPERIMENT_ENABLED: 'true' },
  ),
  { requested: true, featureEnabled: true, active: true },
);
assert.deepEqual(
  targetedEscalationGate(
    { experiments: { targetedEscalation: { enabled: true } } },
    {},
  ),
  { requested: true, featureEnabled: false, active: false },
);

const medium = normalizeTargetedEscalationConfig({
  experiments: {
    targetedEscalation: {
      enabled: true,
      strategy: 'medium',
    },
  },
});
assert.equal(medium.strategy, 'medium');
assert.equal(medium.paddingSeconds, 5);
assert.equal(medium.mergeGapSeconds, 2);

const custom = normalizeTargetedEscalationConfig({
  experiments: {
    targetedEscalation: {
      enabled: true,
      strategy: 'aggressive',
      paddingSeconds: 1.5,
      mergeGapSeconds: 0.5,
      maxProCalls: 2,
      maxTotalEscalatedSeconds: 20,
      maxIndividualIntervalSeconds: 12,
    },
  },
});
assert.equal(custom.paddingSeconds, 1.5);
assert.equal(custom.mergeGapSeconds, 0.5);
assert.equal(custom.limits.maxProCalls, 2);

const analysis = {
  timeline: [
    {
      startSeconds: 0,
      endSeconds: 5,
      purpose: 'hook',
      issues: ['Visible text contains a spelling typo.'],
    },
    {
      startSeconds: 5,
      endSeconds: 10,
      purpose: 'demo',
      issues: ['Product bottle geometry visibly warps for one shot.'],
    },
    {
      startSeconds: 10,
      endSeconds: 15,
      purpose: 'transition',
      issues: ['Pacing becomes too slow across the ending.'],
    },
  ],
  compliance: {
    checks: [
      {
        type: 'mustNotShow',
        rule: 'Competitor logo',
        status: 'fail',
        evidence: 'Competitor logo is visible.',
        timestampSeconds: 7,
      },
      {
        type: 'mustShow',
        rule: 'Required disclaimer',
        status: 'fail',
        evidence: 'Required disclaimer was not observed anywhere.',
        timestampSeconds: null,
      },
      {
        type: 'continuityRule',
        rule: 'Bottle remains red throughout',
        status: 'fail',
        evidence: 'Bottle changes colour.',
        timestampSeconds: 12,
      },
    ],
  },
  regenerationPrompts: [
    {
      startSeconds: 8,
      endSeconds: 9,
      reason: 'Fix transition glitch at the cut.',
      prompt: 'Replace transition.',
    },
  ],
  retentionRisks: [
    {
      startSeconds: 11,
      severity: 'medium',
      reason: 'Repetition across distant scenes weakens the ending.',
    },
  ],
};

const findings = collectSuspiciousIntervals(analysis, { durationSeconds: 15 });
assert.ok(findings.length >= 7);

const forbidden = findings.find((finding) => finding.sourceFindingId === 'compliance:mustNotShow:0');
assert.equal(forbidden.defectType, 'forbidden_content_presence');
assert.equal(forbidden.routing.targetedEligible, true);
assert.equal(forbidden.approximateStartSeconds, 5);
assert.equal(forbidden.approximateEndSeconds, 10);

const missing = findings.find((finding) => finding.sourceFindingId === 'compliance:mustShow:1');
assert.equal(missing.defectType, 'missing_global_content');
assert.equal(missing.routing.targetedEligible, false);

const continuity = findings.find((finding) => finding.sourceFindingId === 'compliance:continuityRule:2');
assert.equal(continuity.routing.targetedEligible, false);
assert.match(continuity.routing.reason, /paired_or_global_context/);

const typo = findings.find((finding) => finding.sourceFindingId === 'timeline:0:issue:0');
assert.equal(typo.defectType, 'visible_text_defect');
assert.equal(typo.routing.targetedEligible, true);

const productWarp = findings.find((finding) => finding.sourceFindingId === 'timeline:1:issue:0');
assert.equal(productWarp.defectType, 'object_product_mismatch');
assert.equal(productWarp.routing.targetedEligible, true);

const pacing = findings.find((finding) => finding.sourceFindingId === 'timeline:2:issue:0');
assert.equal(pacing.defectType, 'global_pacing');
assert.equal(pacing.routing.targetedEligible, false);

const padded = applyTemporalPadding(typo, {
  paddingSeconds: 10,
  durationSeconds: 15,
});
assert.equal(padded.finalStartSeconds, 0);
assert.equal(padded.finalEndSeconds, 15);

const merged = mergeEscalationIntervals([
  {
    ...typo,
    finalStartSeconds: 0,
    finalEndSeconds: 7,
  },
  {
    ...productWarp,
    finalStartSeconds: 6,
    finalEndSeconds: 12,
  },
  {
    ...forbidden,
    finalStartSeconds: 13,
    finalEndSeconds: 15,
  },
], { mergeGapSeconds: 1 });
assert.equal(merged.length, 1);
assert.equal(merged[0].startSeconds, 0);
assert.equal(merged[0].endSeconds, 15);
assert.equal(merged[0].sourceFindingIds.length, 3);

const noMerge = mergeEscalationIntervals([
  {
    ...typo,
    finalStartSeconds: 0,
    finalEndSeconds: 2,
  },
  {
    ...productWarp,
    finalStartSeconds: 4.1,
    finalEndSeconds: 6,
  },
], { mergeGapSeconds: 2 });
assert.equal(noMerge.length, 2);

const allowedBudget = assessTargetedEscalationBudget([
  { durationSeconds: 8 },
  { durationSeconds: 10 },
], {
  maxProCalls: 3,
  maxTotalEscalatedSeconds: 30,
  maxIndividualIntervalSeconds: 15,
});
assert.equal(allowedBudget.allowed, true);

const deniedBudget = assessTargetedEscalationBudget([
  { durationSeconds: 20 },
  { durationSeconds: 20 },
], {
  maxProCalls: 1,
  maxTotalEscalatedSeconds: 30,
  maxIndividualIntervalSeconds: 15,
});
assert.equal(deniedBudget.allowed, false);
assert.ok(deniedBudget.violations.includes('max_pro_calls_exceeded'));
assert.ok(deniedBudget.violations.includes('max_total_escalated_seconds_exceeded'));
assert.ok(deniedBudget.violations.includes('max_individual_interval_seconds_exceeded'));

const plan = buildTargetedEscalationPlan(analysis, {
  durationSeconds: 15,
  config: {
    ...medium,
    limits: {
      maxProCalls: 3,
      maxTotalEscalatedSeconds: 30,
      maxIndividualIntervalSeconds: 30,
    },
  },
});
assert.ok(plan.eligibleFindings.length > 0);
assert.ok(plan.wholeVideoFindings.length > 0);
assert.equal(plan.targetedEscalationPossible, true);
assert.equal(plan.wholeVideoFallbackRequired, true);
assert.ok(plan.mergeStats.proCallsAvoidedByMerging >= 0);

const noFindingPlan = buildTargetedEscalationPlan({
  timeline: [{ startSeconds: 0, endSeconds: 3, issues: [] }],
  compliance: { checks: [] },
}, {
  durationSeconds: 3,
  config: medium,
});
assert.equal(noFindingPlan.findings.length, 0);
assert.equal(noFindingPlan.targetedEscalationPossible, false);

const malformedPlan = buildTargetedEscalationPlan({
  timeline: [{
    startSeconds: 'bad',
    endSeconds: 'also bad',
    issues: ['Visible text typo'],
  }],
}, {
  durationSeconds: 10,
  config: medium,
});
assert.equal(malformedPlan.eligibleFindings.length, 0);
assert.equal(malformedPlan.targetedEscalationPossible, false);

assert.equal(mapSegmentTimestampToSource({
  localSeconds: 7,
  actualSourceStartSeconds: 200,
  actualSourceEndSeconds: 215,
}), 207);

assert.equal(mapSegmentTimestampToSource({
  localSeconds: 20,
  actualSourceStartSeconds: 200,
  actualSourceEndSeconds: 215,
}), 215);

const mappedFinding = mapProFindingToSource({
  startSeconds: 7,
  endSeconds: 9,
  status: 'confirmed',
}, {
  actualSourceStartSeconds: 200,
  actualSourceEndSeconds: 215,
});
assert.equal(mappedFinding.startSeconds, 207);
assert.equal(mappedFinding.endSeconds, 209);
assert.equal(mappedFinding.segmentLocalStartSeconds, 7);

const metrics = targetedEscalationDurationMetrics(120, [
  { durationSeconds: 10 },
  { durationSeconds: 5 },
]);
assert.equal(metrics.baselineFullVideoSeconds, 120);
assert.equal(metrics.targetedProSeconds, 15);
assert.equal(metrics.reductionSeconds, 105);
assert.equal(metrics.reductionPercent, 87.5);

const keyBase = {
  sourceFingerprint: 'etag-123',
  config: medium,
  primaryModelId: 'eu.amazon.nova-2-lite-v1:0',
  proModelId: 'eu.amazon.nova-pro-v1:0',
  primaryPromptVersion: 'video-analysis-v1.5',
  proPromptVersion: 'targeted-pro-v1',
  mergedIntervals: [{
    startSeconds: 10,
    endSeconds: 20,
    sourceFindingIds: ['timeline:1:issue:0'],
    defectTypes: ['localized_visual_artifact'],
  }],
};

const cacheKeyA = targetedEscalationCacheKey(keyBase);
const cacheKeyB = targetedEscalationCacheKey({
  ...keyBase,
  config: { ...medium, paddingSeconds: 10 },
});
const cacheKeyC = targetedEscalationCacheKey({
  ...keyBase,
  mergedIntervals: [{
    ...keyBase.mergedIntervals[0],
    startSeconds: 9,
  }],
});

assert.match(cacheKeyA, /^[a-f0-9]{64}$/);
assert.notEqual(cacheKeyA, cacheKeyB);
assert.notEqual(cacheKeyA, cacheKeyC);
assert.equal(targetedEscalationCacheKey({ sourceFingerprint: '' }), null);

console.log('Targeted escalation planner tests passed');
