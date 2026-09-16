import assert from 'node:assert/strict';
import {
  FRAME_BUDGET_POLICY_VERSION,
  deriveFrameBudgets,
} from '../experiments/focus/benchmark-utils.mjs';

assert.deepEqual(deriveFrameBudgets(0), {
  policyVersion: FRAME_BUDGET_POLICY_VERSION,
  baseline: 0,
  conservative: 0,
  medium: 0,
  aggressive: 0,
  hybrid: 0,
});

assert.deepEqual(deriveFrameBudgets(8), {
  policyVersion: FRAME_BUDGET_POLICY_VERSION,
  baseline: 8,
  conservative: 6,
  medium: 4,
  aggressive: 2,
  hybrid: 4,
});

assert.deepEqual(deriveFrameBudgets(8, { coverageRequired: true }), {
  policyVersion: FRAME_BUDGET_POLICY_VERSION,
  baseline: 8,
  conservative: 6,
  medium: 4,
  aggressive: 4,
  hybrid: 4,
});

assert.deepEqual(deriveFrameBudgets(3, { coverageRequired: true }), {
  policyVersion: FRAME_BUDGET_POLICY_VERSION,
  baseline: 3,
  conservative: 3,
  medium: 3,
  aggressive: 3,
  hybrid: 3,
});

assert.deepEqual(deriveFrameBudgets(1), {
  policyVersion: FRAME_BUDGET_POLICY_VERSION,
  baseline: 1,
  conservative: 1,
  medium: 1,
  aggressive: 1,
  hybrid: 1,
});

console.log('frame-budget tests passed');
