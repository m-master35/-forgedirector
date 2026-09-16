import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-vllm-grader-'));

function report(name, overrides = {}) {
  const base = {
    schemaVersion: 1,
    profile: { name },
    summary: {
      technicalFailures: 0,
      incorrectChecks: 0,
      falseNegatives: 0,
      falsePositives: 0,
      coverageFailures: 0,
      noSpeechFailures: 0,
      gateFailures: 0,
      totalInputTokens: 100000,
      totalOutputTokens: 5000,
      totalPrefillKvComputedTokens: 90000,
      totalPrefillTimeSeconds: 100,
      totalWallMs: 120000,
      peakKvCacheUsagePerc: 0.8,
      peakGpuMemoryMiB: 20000,
      estimatedInferenceCostUsd: 1.0,
    },
    rows: [{
      name: 'case-a',
      checkResults: [{
        type: 'mustNotShow',
        rule: 'competitor logo',
        expected: 'fail',
        actual: 'fail',
        correct: true,
        falseNegative: false,
        falsePositive: false,
        timestampSeconds: 5,
      }],
    }],
  };
  return {
    ...base,
    ...overrides,
    summary: { ...base.summary, ...(overrides.summary || {}) },
    profile: { ...base.profile, ...(overrides.profile || {}) },
    rows: overrides.rows || base.rows,
  };
}

fs.writeFileSync(path.join(root, 'baseline.json'), JSON.stringify(report('baseline'), null, 2));

fs.writeFileSync(path.join(root, 'evs-medium.json'), JSON.stringify(report('evs-medium', {
  summary: {
    totalInputTokens: 80000,
    totalPrefillKvComputedTokens: 70000,
    totalPrefillTimeSeconds: 75,
    totalWallMs: 90000,
    peakKvCacheUsagePerc: 0.6,
    peakGpuMemoryMiB: 19000,
    estimatedInferenceCostUsd: 0.75,
  },
  rows: [{
    name: 'case-a',
    checkResults: [{
      type: 'mustNotShow',
      rule: 'competitor logo',
      expected: 'fail',
      actual: 'fail',
      correct: true,
      falseNegative: false,
      falsePositive: false,
      timestampSeconds: 5.5,
    }],
  }],
}), null, 2));

fs.writeFileSync(path.join(root, 'evs-aggressive.json'), JSON.stringify(report('evs-aggressive', {
  summary: {
    incorrectChecks: 1,
    falseNegatives: 1,
    totalInputTokens: 30000,
    totalPrefillKvComputedTokens: 25000,
    totalPrefillTimeSeconds: 35,
    totalWallMs: 45000,
    peakKvCacheUsagePerc: 0.3,
    peakGpuMemoryMiB: 17000,
    estimatedInferenceCostUsd: 0.35,
  },
  rows: [{
    name: 'case-a',
    checkResults: [{
      type: 'mustNotShow',
      rule: 'competitor logo',
      expected: 'fail',
      actual: 'pass',
      correct: false,
      falseNegative: true,
      falsePositive: false,
      timestampSeconds: null,
    }],
  }],
}), null, 2));

fs.writeFileSync(path.join(root, 'evs-conservative.json'), JSON.stringify(report('evs-conservative', {
  summary: {
    totalInputTokens: 96000,
    totalPrefillKvComputedTokens: 95000,
    totalPrefillTimeSeconds: 96,
    totalWallMs: 116000,
    peakKvCacheUsagePerc: 0.78,
    peakGpuMemoryMiB: 19800,
    estimatedInferenceCostUsd: 0.96,
  },
}), null, 2));

execFileSync(
  process.execPath,
  ['experiments/vllm-pruning/grade-benchmarks.mjs', root],
  {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, VLLM_MEANINGFUL_REDUCTION: '0.15' },
    stdio: 'pipe',
  },
);

const decision = JSON.parse(fs.readFileSync(path.join(root, 'decision.json'), 'utf8'));
const byProfile = new Map(decision.decisions.map((item) => [item.profile, item]));

assert.equal(decision.baselineQualityClean, true);
assert.equal(
  byProfile.get('evs-medium').decision,
  'eligible_for_larger_controlled_validation',
);
assert.ok(byProfile.get('evs-medium').reductions.prefillKvComputedTokens > 0.15);
assert.equal(
  byProfile.get('evs-aggressive').decision,
  'reject_quality',
  'large resource savings must never override a new labeled false negative',
);
assert.equal(byProfile.get('evs-aggressive').quality.newFalseNegatives, 1);
assert.equal(
  byProfile.get('evs-conservative').decision,
  'no_material_resource_gain',
);
assert.equal(byProfile.get('evs-medium').productionPromotion, false);
assert.equal(byProfile.get('evs-medium').timestampDrift.comparableChecks, 1);
assert.equal(byProfile.get('evs-medium').timestampDrift.meanAbsoluteSeconds, 0.5);

fs.rmSync(root, { recursive: true, force: true });
console.log('vLLM pruning benchmark grader tests passed');
