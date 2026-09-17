import {
  buildTargetedEscalationPlan,
  normalizeTargetedEscalationConfig,
  targetedEscalationGate,
} from './targeted-escalation.mjs';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function inactiveReason(gate) {
  if (!gate.requested) return 'request_opt_in_missing';
  if (!gate.featureEnabled) return 'environment_feature_flag_disabled';
  return 'inactive';
}

async function runWholeVideoFallback({
  reason,
  plan,
  invokeWholeVideoFallback,
}) {
  if (typeof invokeWholeVideoFallback !== 'function') {
    return {
      outcome: 'fail_closed',
      fallbackReason: reason,
      plan,
      errorCode: 'WHOLE_VIDEO_FALLBACK_UNAVAILABLE',
    };
  }

  try {
    const fallback = await invokeWholeVideoFallback({ reason, plan });
    return {
      outcome: 'whole_video_fallback',
      fallbackReason: reason,
      plan,
      fallback,
    };
  } catch (error) {
    return {
      outcome: 'fail_closed',
      fallbackReason: reason,
      plan,
      errorCode: error?.code || error?.name || 'WHOLE_VIDEO_FALLBACK_FAILED',
      errorMessage: error?.message || String(error),
    };
  }
}

/**
 * Isolated orchestration for the targeted-escalation experiment.
 *
 * This module is deliberately dependency-injected and is not called by the
 * production /v1/analyze path. A future explicit experimental insertion seam
 * can provide concrete media and Bedrock adapters without changing the default
 * baseline.
 */
export async function runTargetedEscalationExperiment({
  analysis,
  payload = {},
  env = process.env,
  durationSeconds = null,
  extractSegment,
  invokeTargetedPro,
  invokeWholeVideoFallback,
} = {}) {
  const gate = targetedEscalationGate(payload, env);
  if (!gate.active) {
    return {
      active: false,
      gate,
      outcome: 'baseline_unchanged',
      reason: inactiveReason(gate),
    };
  }

  const config = normalizeTargetedEscalationConfig(payload, env);
  const plan = buildTargetedEscalationPlan(analysis, {
    durationSeconds,
    config,
  });

  if (!plan.findings.length) {
    return {
      active: true,
      gate,
      config,
      plan,
      outcome: 'no_escalation',
      targetedResults: [],
    };
  }

  if (!plan.budget.allowed) {
    return runWholeVideoFallback({
      reason: 'targeted_budget_rejected',
      plan,
      invokeWholeVideoFallback,
    }).then((result) => ({ active: true, gate, config, ...result }));
  }

  if (!plan.targetedEscalationPossible) {
    return runWholeVideoFallback({
      reason: 'no_safe_targeted_window',
      plan,
      invokeWholeVideoFallback,
    }).then((result) => ({ active: true, gate, config, ...result }));
  }

  // Hybrid is intentionally conservative: if any finding requires global or
  // comparison context, reuse the existing whole-video behavior instead of
  // paying for targeted calls that cannot safely resolve the full request.
  if (config.strategy === 'hybrid' && plan.wholeVideoFindings.length > 0) {
    return runWholeVideoFallback({
      reason: 'hybrid_global_or_context_sensitive_finding',
      plan,
      invokeWholeVideoFallback,
    }).then((result) => ({ active: true, gate, config, ...result }));
  }

  if (typeof extractSegment !== 'function' || typeof invokeTargetedPro !== 'function') {
    return {
      active: true,
      gate,
      config,
      plan,
      outcome: 'fail_closed',
      errorCode: 'TARGETED_ADAPTER_UNAVAILABLE',
      targetedResults: [],
    };
  }

  const targetedResults = [];

  for (const interval of plan.mergedIntervals) {
    let segment;
    try {
      segment = await extractSegment({ interval, plan, config });
    } catch (error) {
      if (config.strategy === 'hybrid') {
        const fallback = await runWholeVideoFallback({
          reason: 'segment_extraction_failed',
          plan,
          invokeWholeVideoFallback,
        });
        return {
          active: true,
          gate,
          config,
          ...fallback,
          targetedResults,
          extractionError: {
            code: error?.code || error?.name || 'SEGMENT_EXTRACTION_FAILED',
            message: error?.message || String(error),
          },
        };
      }

      return {
        active: true,
        gate,
        config,
        plan,
        outcome: 'fail_closed',
        errorCode: error?.code || error?.name || 'SEGMENT_EXTRACTION_FAILED',
        errorMessage: error?.message || String(error),
        targetedResults,
      };
    }

    try {
      const proResult = await invokeTargetedPro({
        interval,
        findings: asArray(interval.findings),
        segment,
        plan,
        config,
      });
      targetedResults.push({
        intervalId: interval.intervalId,
        interval,
        segment,
        proResult,
      });
    } catch (error) {
      if (config.strategy === 'hybrid') {
        const fallback = await runWholeVideoFallback({
          reason: 'targeted_pro_failed',
          plan,
          invokeWholeVideoFallback,
        });
        return {
          active: true,
          gate,
          config,
          ...fallback,
          targetedResults,
          proError: {
            code: error?.code || error?.name || 'TARGETED_PRO_FAILED',
            message: error?.message || String(error),
          },
        };
      }

      return {
        active: true,
        gate,
        config,
        plan,
        outcome: 'fail_closed',
        errorCode: error?.code || error?.name || 'TARGETED_PRO_FAILED',
        errorMessage: error?.message || String(error),
        targetedResults,
      };
    }
  }

  return {
    active: true,
    gate,
    config,
    plan,
    outcome: 'targeted_complete',
    targetedResults,
  };
}
