function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function intervalSeconds(intervals = []) {
  return round(asArray(intervals).reduce((sum, interval) => {
    const explicit = finiteNumber(interval?.durationSeconds);
    if (explicit !== null) return sum + Math.max(0, explicit);
    const start = finiteNumber(interval?.startSeconds);
    const end = finiteNumber(interval?.endSeconds);
    if (start === null || end === null) return sum;
    return sum + Math.max(0, end - start);
  }, 0));
}

/**
 * Compares a hypothetical existing whole-video Pro confirmation with the safe
 * effective media route selected by the targeted-escalation plan.
 *
 * This deliberately does NOT count an unchanged production blind-compliance
 * verifier. Paid benchmarks report verifier cost separately so that targeted
 * savings cannot be overstated by hiding other Pro calls.
 */
export function effectiveEscalationMetrics(sourceDurationSeconds, plan = {}) {
  const sourceDuration = finiteNumber(sourceDurationSeconds);
  if (sourceDuration === null || sourceDuration <= 0) {
    return {
      baselineEscalationRequired: false,
      baselineProCalls: null,
      baselineProSeconds: null,
      targetedSegmentCalls: asArray(plan?.mergedIntervals).length,
      targetedSegmentSeconds: intervalSeconds(plan?.mergedIntervals),
      effectiveRoute: 'unknown_duration',
      effectiveProCalls: null,
      effectiveProSeconds: null,
      reductionSeconds: null,
      reductionPercent: null,
    };
  }

  const findings = asArray(plan?.findings);
  const targetedIntervals = asArray(plan?.mergedIntervals);
  const targetedSeconds = intervalSeconds(targetedIntervals);
  const baselineEscalationRequired = findings.length > 0;
  const baselineProCalls = baselineEscalationRequired ? 1 : 0;
  const baselineProSeconds = baselineEscalationRequired ? sourceDuration : 0;

  let effectiveRoute = 'no_pro_needed';
  let effectiveProCalls = 0;
  let effectiveProSeconds = 0;

  if (baselineEscalationRequired) {
    if (plan?.wholeVideoFallbackRequired === true) {
      // Do not double-charge a targeted call plus full-video fallback. A safe
      // hybrid implementation should choose the whole-video route directly
      // when any finding requires global context or a budget guard rejects the
      // targeted plan.
      effectiveRoute = 'whole_video_fallback';
      effectiveProCalls = 1;
      effectiveProSeconds = sourceDuration;
    } else if (plan?.targetedEscalationPossible === true && targetedIntervals.length > 0) {
      effectiveRoute = 'targeted_segments';
      effectiveProCalls = targetedIntervals.length;
      effectiveProSeconds = targetedSeconds;
    } else {
      effectiveRoute = 'whole_video_fallback';
      effectiveProCalls = 1;
      effectiveProSeconds = sourceDuration;
    }
  }

  const reductionSeconds = Math.max(0, baselineProSeconds - effectiveProSeconds);
  const reductionPercent = baselineProSeconds > 0
    ? Math.max(0, Math.min(100, (reductionSeconds / baselineProSeconds) * 100))
    : null;

  return {
    baselineEscalationRequired,
    baselineProCalls,
    baselineProSeconds: round(baselineProSeconds),
    targetedSegmentCalls: targetedIntervals.length,
    targetedSegmentSeconds: targetedSeconds,
    effectiveRoute,
    effectiveProCalls,
    effectiveProSeconds: round(effectiveProSeconds),
    reductionSeconds: round(reductionSeconds),
    reductionPercent: reductionPercent === null ? null : round(reductionPercent, 2),
  };
}

export function tokenCostUsd(usage = {}, {
  inputPerMillionUsd,
  outputPerMillionUsd,
} = {}) {
  const inputRate = finiteNumber(inputPerMillionUsd);
  const outputRate = finiteNumber(outputPerMillionUsd);
  if (inputRate === null || outputRate === null) return null;

  const inputTokens = Math.max(0, finiteNumber(usage?.inputTokens) ?? 0);
  const outputTokens = Math.max(0, finiteNumber(usage?.outputTokens) ?? 0);
  return round(
    (inputTokens / 1_000_000) * inputRate
      + (outputTokens / 1_000_000) * outputRate,
    8,
  );
}

export function summarizeLatency(values = []) {
  const numbers = asArray(values)
    .map((value) => finiteNumber(value))
    .filter((value) => value !== null && value >= 0)
    .sort((a, b) => a - b);

  const percentile = (p) => {
    if (!numbers.length) return null;
    const index = Math.min(
      numbers.length - 1,
      Math.max(0, Math.ceil((p / 100) * numbers.length) - 1),
    );
    return round(numbers[index], 2);
  };

  return {
    samples: numbers.length,
    p50: percentile(50),
    p95: percentile(95),
  };
}
