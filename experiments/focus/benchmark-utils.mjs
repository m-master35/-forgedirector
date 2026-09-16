export const FRAME_BUDGET_POLICY_VERSION = 'fd-frame-budget-ladder-1';

export function deriveFrameBudgets(candidateCount, { coverageRequired = false } = {}) {
  const count = Math.max(0, Math.floor(Number(candidateCount) || 0));
  if (count === 0) {
    return {
      policyVersion: FRAME_BUDGET_POLICY_VERSION,
      baseline: 0,
      conservative: 0,
      medium: 0,
      aggressive: 0,
      hybrid: 0,
    };
  }

  const floor = coverageRequired ? Math.min(4, count) : 1;
  const bounded = (ratio) => Math.min(count, Math.max(floor, Math.ceil(count * ratio)));

  return {
    policyVersion: FRAME_BUDGET_POLICY_VERSION,
    baseline: count,
    conservative: bounded(0.75),
    medium: bounded(0.50),
    aggressive: bounded(0.25),
    hybrid: bounded(0.50),
  };
}
