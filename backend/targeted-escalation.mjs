import { createHash } from 'node:crypto';

export const TARGETED_ESCALATION_EXPERIMENT_VERSION = 'fd-targeted-escalation-v1';
export const TARGETED_ESCALATION_POLICY_VERSION = 'fd-targeted-routing-v1';
export const TARGETED_ESCALATION_MEDIA_VERSION = 'fd-segment-media-v1';

export const TARGETED_ESCALATION_STRATEGIES = Object.freeze({
  conservative: Object.freeze({ paddingSeconds: 10, mergeGapSeconds: 3 }),
  medium: Object.freeze({ paddingSeconds: 5, mergeGapSeconds: 2 }),
  aggressive: Object.freeze({ paddingSeconds: 2, mergeGapSeconds: 1 }),
  hybrid: Object.freeze({ paddingSeconds: 5, mergeGapSeconds: 2 }),
});

export const DEFAULT_TARGETED_ESCALATION_LIMITS = Object.freeze({
  maxProCalls: 3,
  maxTotalEscalatedSeconds: 60,
  maxIndividualIntervalSeconds: 30,
});

const TARGETABLE_DEFECT_TYPES = new Set([
  'forbidden_content_presence',
  'visible_text_defect',
  'localized_visual_artifact',
  'object_product_mismatch',
  'transition_issue',
]);

const WHOLE_VIDEO_DEFECT_TYPES = new Set([
  'global_pacing',
  'global_repetition',
  'full_duration_coverage',
  'global_consistency',
  'global_audio_video_sync',
  'missing_global_content',
  'global_continuity',
  'character_inconsistency',
  'unlocalized_issue',
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, lower, upper) {
  return Math.max(lower, Math.min(upper, value));
}

function normalizeDuration(value) {
  const number = finiteNumber(value);
  return number && number > 0 ? number : null;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function targetedEscalationFeatureEnabled(env = process.env) {
  return String(env?.TARGETED_ESCALATION_EXPERIMENT_ENABLED || '').trim().toLowerCase() === 'true';
}

export function targetedEscalationRequested(payload = {}) {
  return payload?.experiments?.targetedEscalation?.enabled === true;
}

export function targetedEscalationGate(payload = {}, env = process.env) {
  const requested = targetedEscalationRequested(payload);
  const featureEnabled = targetedEscalationFeatureEnabled(env);
  return {
    requested,
    featureEnabled,
    active: requested && featureEnabled,
  };
}

export function normalizeTargetedEscalationConfig(payload = {}, env = process.env) {
  const request = payload?.experiments?.targetedEscalation || {};
  const strategy = Object.hasOwn(TARGETED_ESCALATION_STRATEGIES, request.strategy)
    ? request.strategy
    : 'hybrid';
  const defaults = TARGETED_ESCALATION_STRATEGIES[strategy];

  const requestedPadding = finiteNumber(request.paddingSeconds);
  const requestedMergeGap = finiteNumber(request.mergeGapSeconds);
  const maxProCalls = finiteNumber(request.maxProCalls)
    ?? finiteNumber(env?.TARGETED_ESCALATION_MAX_PRO_CALLS)
    ?? DEFAULT_TARGETED_ESCALATION_LIMITS.maxProCalls;
  const maxTotalEscalatedSeconds = finiteNumber(request.maxTotalEscalatedSeconds)
    ?? finiteNumber(env?.TARGETED_ESCALATION_MAX_TOTAL_SECONDS)
    ?? DEFAULT_TARGETED_ESCALATION_LIMITS.maxTotalEscalatedSeconds;
  const maxIndividualIntervalSeconds = finiteNumber(request.maxIndividualIntervalSeconds)
    ?? finiteNumber(env?.TARGETED_ESCALATION_MAX_INTERVAL_SECONDS)
    ?? DEFAULT_TARGETED_ESCALATION_LIMITS.maxIndividualIntervalSeconds;

  return {
    experimentVersion: TARGETED_ESCALATION_EXPERIMENT_VERSION,
    policyVersion: TARGETED_ESCALATION_POLICY_VERSION,
    mediaVersion: TARGETED_ESCALATION_MEDIA_VERSION,
    strategy,
    paddingSeconds: clamp(requestedPadding ?? defaults.paddingSeconds, 0, 30),
    mergeGapSeconds: clamp(requestedMergeGap ?? defaults.mergeGapSeconds, 0, 15),
    limits: {
      maxProCalls: Math.max(1, Math.min(10, Math.floor(maxProCalls))),
      maxTotalEscalatedSeconds: Math.max(1, Math.min(600, maxTotalEscalatedSeconds)),
      maxIndividualIntervalSeconds: Math.max(0.25, Math.min(300, maxIndividualIntervalSeconds)),
    },
  };
}

function classifyTextDefect(text = '') {
  const value = normalizeText(text).toLowerCase();

  if (!value) return 'unlocalized_issue';
  if (/\b(pacing|too slow|too fast|dragging|rushed|tempo)\b/.test(value)) return 'global_pacing';
  if (/\b(repeat|repetition|repetitive|duplicate|duplicated)\b/.test(value)) return 'global_repetition';
  if (/\b(audio|lip[- ]?sync|sync(?:hronization)?|voiceover timing)\b/.test(value)) return 'global_audio_video_sync';
  if (/\b(character|face|identity|wardrobe|person changed|same person)\b/.test(value)) return 'character_inconsistency';
  if (/\b(continuity|changed from|changes from|different from earlier|inconsistent across)\b/.test(value)) return 'global_continuity';
  if (/\b(transition|jump cut|cut point|hard cut|dissolve|wipe)\b/.test(value)) return 'transition_issue';
  if (/\b(text|caption|subtitle|spelling|typo|legib|on[- ]?screen|wording)\b/.test(value)) return 'visible_text_defect';
  if (/\b(logo|product|object|label|packaging|brand mark|bottle|box|device)\b/.test(value)) return 'object_product_mismatch';
  if (/\b(artifact|glitch|distort|deform|flicker|warping|geometry|blur|pixelat|render error)\b/.test(value)) return 'localized_visual_artifact';

  return 'unlocalized_issue';
}

function routeDefect(defectType, hasLocalization) {
  if (!hasLocalization) {
    return {
      mode: 'whole_video',
      targetedEligible: false,
      reason: 'missing_or_unreliable_localization',
    };
  }

  if (TARGETABLE_DEFECT_TYPES.has(defectType)) {
    return {
      mode: 'targeted',
      targetedEligible: true,
      reason: 'localized_defect_supported_by_policy',
    };
  }

  if (WHOLE_VIDEO_DEFECT_TYPES.has(defectType)) {
    return {
      mode: 'whole_video',
      targetedEligible: false,
      reason: defectType === 'character_inconsistency' || defectType === 'global_continuity'
        ? 'paired_or_global_context_required_in_policy_v1'
        : 'global_or_context_sensitive_defect',
    };
  }

  return {
    mode: 'whole_video',
    targetedEligible: false,
    reason: 'defect_type_not_allowlisted_for_targeted_escalation',
  };
}

function normalizeInterval(startSeconds, endSeconds, durationSeconds = null) {
  let start = finiteNumber(startSeconds);
  let end = finiteNumber(endSeconds);
  const duration = normalizeDuration(durationSeconds);

  if (start === null && end === null) return null;
  if (start === null) start = end;
  if (end === null) end = start;
  if (start > end) [start, end] = [end, start];

  start = Math.max(0, start);
  end = Math.max(0, end);

  if (duration) {
    start = clamp(start, 0, duration);
    end = clamp(end, 0, duration);
  }

  if (end < start) end = start;

  return {
    startSeconds: Math.round(start * 1000) / 1000,
    endSeconds: Math.round(end * 1000) / 1000,
  };
}

function timelineIntervalForTimestamp(analysis, timestampSeconds, durationSeconds = null) {
  const timestamp = finiteNumber(timestampSeconds);
  if (timestamp === null) return null;

  const match = asArray(analysis?.timeline).find((entry) => {
    const start = finiteNumber(entry?.startSeconds);
    const end = finiteNumber(entry?.endSeconds);
    return start !== null && end !== null && timestamp >= start && timestamp <= end;
  });

  if (!match) return normalizeInterval(timestamp, timestamp, durationSeconds);
  return normalizeInterval(match.startSeconds, match.endSeconds, durationSeconds);
}

function makeFinding({
  sourceFindingId,
  sourceKind,
  defectType,
  reason,
  interval,
  localizationPrecision,
  sourceConfidence = null,
  metadata = {},
}) {
  const hasLocalization = Boolean(
    interval
    && finiteNumber(interval.startSeconds) !== null
    && finiteNumber(interval.endSeconds) !== null
  );

  return {
    defectType,
    sourceFindingId,
    sourceKind,
    sourceConfidence,
    approximateStartSeconds: interval?.startSeconds ?? null,
    approximateEndSeconds: interval?.endSeconds ?? null,
    localizationPrecision: hasLocalization ? localizationPrecision : 'none',
    escalationReason: normalizeText(reason),
    routing: routeDefect(defectType, hasLocalization),
    metadata,
  };
}

export function collectSuspiciousIntervals(analysis = {}, {
  durationSeconds = null,
} = {}) {
  const duration = normalizeDuration(durationSeconds);
  const findings = [];

  asArray(analysis?.compliance?.checks).forEach((check, index) => {
    if (String(check?.status || '').toLowerCase() !== 'fail') return;

    const type = String(check?.type || '').trim();
    let defectType = 'unlocalized_issue';

    if (type === 'mustNotShow') defectType = 'forbidden_content_presence';
    else if (type === 'mustShow' || type === 'mustIncludeText' || type === 'ctaRequired') {
      defectType = 'missing_global_content';
    } else if (type === 'continuityRule') {
      defectType = 'global_continuity';
    }

    const timestamp = finiteNumber(check?.timestampSeconds);
    const interval = timestamp === null
      ? null
      : timelineIntervalForTimestamp(analysis, timestamp, duration);

    findings.push(makeFinding({
      sourceFindingId: `compliance:${type || 'requirement'}:${index}`,
      sourceKind: 'compliance',
      defectType,
      reason: check?.evidence || check?.rule || type,
      interval,
      localizationPrecision: interval && interval.startSeconds !== interval.endSeconds
        ? 'timestamp_with_timeline_context'
        : 'point_timestamp',
      metadata: {
        requirementType: type,
        rule: normalizeText(check?.rule),
        status: 'fail',
      },
    }));
  });

  asArray(analysis?.timeline).forEach((entry, timelineIndex) => {
    const interval = normalizeInterval(entry?.startSeconds, entry?.endSeconds, duration);

    asArray(entry?.issues).forEach((issue, issueIndex) => {
      const defectType = classifyTextDefect(issue);
      findings.push(makeFinding({
        sourceFindingId: `timeline:${timelineIndex}:issue:${issueIndex}`,
        sourceKind: 'timeline_issue',
        defectType,
        reason: issue,
        interval,
        localizationPrecision: interval ? 'timeline_interval' : 'none',
        metadata: {
          purpose: normalizeText(entry?.purpose),
        },
      }));
    });
  });

  asArray(analysis?.regenerationPrompts).forEach((item, index) => {
    const interval = normalizeInterval(item?.startSeconds, item?.endSeconds, duration);
    const reason = item?.reason || item?.prompt || '';
    const defectType = classifyTextDefect(reason);

    findings.push(makeFinding({
      sourceFindingId: `regeneration:${index}`,
      sourceKind: 'regeneration_prompt',
      defectType,
      reason,
      interval,
      localizationPrecision: interval ? 'explicit_interval' : 'none',
    }));
  });

  asArray(analysis?.retentionRisks).forEach((item, index) => {
    const timestamp = finiteNumber(item?.startSeconds);
    const interval = timestamp === null
      ? null
      : timelineIntervalForTimestamp(analysis, timestamp, duration);
    const reason = item?.reason || item?.fix || '';
    const defectType = classifyTextDefect(reason);

    findings.push(makeFinding({
      sourceFindingId: `retention:${index}`,
      sourceKind: 'retention_risk',
      defectType,
      reason,
      interval,
      localizationPrecision: interval && interval.startSeconds !== interval.endSeconds
        ? 'timestamp_with_timeline_context'
        : timestamp === null ? 'none' : 'point_timestamp',
      metadata: {
        severity: normalizeText(item?.severity),
      },
    }));
  });

  return findings;
}

export function applyTemporalPadding(finding, {
  paddingSeconds,
  durationSeconds = null,
} = {}) {
  const padding = Math.max(0, finiteNumber(paddingSeconds) ?? 0);
  const duration = normalizeDuration(durationSeconds);
  const start = finiteNumber(finding?.approximateStartSeconds);
  const end = finiteNumber(finding?.approximateEndSeconds);

  if (start === null || end === null) return null;

  const paddedStart = duration
    ? clamp(start - padding, 0, duration)
    : Math.max(0, start - padding);
  const paddedEnd = duration
    ? clamp(end + padding, 0, duration)
    : Math.max(paddedStart, end + padding);

  return {
    ...finding,
    paddingAppliedSeconds: padding,
    finalStartSeconds: Math.round(paddedStart * 1000) / 1000,
    finalEndSeconds: Math.round(paddedEnd * 1000) / 1000,
  };
}

export function mergeEscalationIntervals(intervals = [], {
  mergeGapSeconds = 0,
} = {}) {
  const gap = Math.max(0, finiteNumber(mergeGapSeconds) ?? 0);
  const sorted = asArray(intervals)
    .filter((item) => finiteNumber(item?.finalStartSeconds) !== null
      && finiteNumber(item?.finalEndSeconds) !== null)
    .map((item) => ({ ...item }))
    .sort((a, b) => (
      a.finalStartSeconds - b.finalStartSeconds
      || a.finalEndSeconds - b.finalEndSeconds
      || String(a.sourceFindingId || '').localeCompare(String(b.sourceFindingId || ''))
    ));

  const merged = [];

  for (const item of sorted) {
    const current = {
      startSeconds: item.finalStartSeconds,
      endSeconds: item.finalEndSeconds,
      sourceFindingIds: [item.sourceFindingId],
      defectTypes: [item.defectType],
      sourceKinds: [item.sourceKind],
      findings: [item],
    };

    const previous = merged[merged.length - 1];
    if (!previous || current.startSeconds > previous.endSeconds + gap) {
      merged.push(current);
      continue;
    }

    previous.endSeconds = Math.max(previous.endSeconds, current.endSeconds);
    previous.sourceFindingIds.push(...current.sourceFindingIds);
    previous.defectTypes.push(...current.defectTypes);
    previous.sourceKinds.push(...current.sourceKinds);
    previous.findings.push(...current.findings);
  }

  return merged.map((item, index) => ({
    ...item,
    intervalId: `target-window-${index + 1}`,
    durationSeconds: Math.round((item.endSeconds - item.startSeconds) * 1000) / 1000,
    sourceFindingIds: [...new Set(item.sourceFindingIds)],
    defectTypes: [...new Set(item.defectTypes)],
    sourceKinds: [...new Set(item.sourceKinds)],
  }));
}

export function assessTargetedEscalationBudget(mergedIntervals = [], limits = DEFAULT_TARGETED_ESCALATION_LIMITS) {
  const normalizedLimits = {
    maxProCalls: Math.max(1, Math.floor(finiteNumber(limits?.maxProCalls)
      ?? DEFAULT_TARGETED_ESCALATION_LIMITS.maxProCalls)),
    maxTotalEscalatedSeconds: Math.max(0, finiteNumber(limits?.maxTotalEscalatedSeconds)
      ?? DEFAULT_TARGETED_ESCALATION_LIMITS.maxTotalEscalatedSeconds),
    maxIndividualIntervalSeconds: Math.max(0, finiteNumber(limits?.maxIndividualIntervalSeconds)
      ?? DEFAULT_TARGETED_ESCALATION_LIMITS.maxIndividualIntervalSeconds),
  };

  const intervals = asArray(mergedIntervals);
  const totalSeconds = intervals.reduce((sum, interval) => (
    sum + Math.max(0, finiteNumber(interval?.durationSeconds)
      ?? ((finiteNumber(interval?.endSeconds) ?? 0) - (finiteNumber(interval?.startSeconds) ?? 0)))
  ), 0);
  const longest = intervals.reduce((max, interval) => (
    Math.max(max, finiteNumber(interval?.durationSeconds)
      ?? ((finiteNumber(interval?.endSeconds) ?? 0) - (finiteNumber(interval?.startSeconds) ?? 0)))
  ), 0);

  const violations = [];
  if (intervals.length > normalizedLimits.maxProCalls) violations.push('max_pro_calls_exceeded');
  if (totalSeconds > normalizedLimits.maxTotalEscalatedSeconds) violations.push('max_total_escalated_seconds_exceeded');
  if (longest > normalizedLimits.maxIndividualIntervalSeconds) violations.push('max_individual_interval_seconds_exceeded');

  return {
    allowed: violations.length === 0,
    violations,
    limits: normalizedLimits,
    proCallCount: intervals.length,
    totalEscalatedSeconds: Math.round(totalSeconds * 1000) / 1000,
    longestIntervalSeconds: Math.round(longest * 1000) / 1000,
  };
}

export function buildTargetedEscalationPlan(analysis = {}, {
  durationSeconds = null,
  config = normalizeTargetedEscalationConfig(),
} = {}) {
  const findings = collectSuspiciousIntervals(analysis, { durationSeconds });
  const eligibleFindings = findings.filter((finding) => finding.routing?.targetedEligible === true);
  const wholeVideoFindings = findings.filter((finding) => finding.routing?.targetedEligible !== true);
  const paddedIntervals = eligibleFindings
    .map((finding) => applyTemporalPadding(finding, {
      paddingSeconds: config.paddingSeconds,
      durationSeconds,
    }))
    .filter(Boolean);
  const mergedIntervals = mergeEscalationIntervals(paddedIntervals, {
    mergeGapSeconds: config.mergeGapSeconds,
  });
  const budget = assessTargetedEscalationBudget(mergedIntervals, config.limits);

  return {
    experimentVersion: TARGETED_ESCALATION_EXPERIMENT_VERSION,
    policyVersion: TARGETED_ESCALATION_POLICY_VERSION,
    strategy: config.strategy,
    paddingSeconds: config.paddingSeconds,
    mergeGapSeconds: config.mergeGapSeconds,
    findings,
    eligibleFindings,
    wholeVideoFindings,
    paddedIntervals,
    mergedIntervals,
    mergeStats: {
      originalEligibleIntervals: paddedIntervals.length,
      mergedIntervals: mergedIntervals.length,
      proCallsAvoidedByMerging: Math.max(0, paddedIntervals.length - mergedIntervals.length),
    },
    budget,
    targetedEscalationPossible: mergedIntervals.length > 0 && budget.allowed,
    wholeVideoFallbackRequired: wholeVideoFindings.length > 0 || !budget.allowed,
  };
}

export function mapSegmentTimestampToSource({
  localSeconds,
  actualSourceStartSeconds,
  actualSourceEndSeconds = null,
}) {
  const local = finiteNumber(localSeconds);
  const sourceStart = finiteNumber(actualSourceStartSeconds);
  const sourceEnd = finiteNumber(actualSourceEndSeconds);

  if (local === null || sourceStart === null) return null;

  const mapped = sourceStart + Math.max(0, local);
  const bounded = sourceEnd === null ? mapped : clamp(mapped, sourceStart, sourceEnd);
  return Math.round(bounded * 1000) / 1000;
}

export function mapProFindingToSource(finding = {}, segment = {}) {
  return {
    ...finding,
    segmentLocalStartSeconds: finiteNumber(finding?.startSeconds),
    segmentLocalEndSeconds: finiteNumber(finding?.endSeconds),
    startSeconds: mapSegmentTimestampToSource({
      localSeconds: finding?.startSeconds,
      actualSourceStartSeconds: segment?.actualSourceStartSeconds ?? segment?.sourceStartSeconds,
      actualSourceEndSeconds: segment?.actualSourceEndSeconds ?? segment?.sourceEndSeconds,
    }),
    endSeconds: mapSegmentTimestampToSource({
      localSeconds: finding?.endSeconds,
      actualSourceStartSeconds: segment?.actualSourceStartSeconds ?? segment?.sourceStartSeconds,
      actualSourceEndSeconds: segment?.actualSourceEndSeconds ?? segment?.sourceEndSeconds,
    }),
  };
}

export function targetedEscalationDurationMetrics(sourceDurationSeconds, mergedIntervals = []) {
  const sourceDuration = normalizeDuration(sourceDurationSeconds);
  const targetedSeconds = asArray(mergedIntervals).reduce((sum, interval) => (
    sum + Math.max(0, finiteNumber(interval?.durationSeconds)
      ?? ((finiteNumber(interval?.endSeconds) ?? 0) - (finiteNumber(interval?.startSeconds) ?? 0)))
  ), 0);

  const baselineSeconds = sourceDuration ?? null;
  const reductionSeconds = baselineSeconds === null ? null : Math.max(0, baselineSeconds - targetedSeconds);
  const reductionPercent = baselineSeconds
    ? Math.max(0, Math.min(100, (reductionSeconds / baselineSeconds) * 100))
    : null;

  return {
    baselineFullVideoSeconds: baselineSeconds,
    targetedProSeconds: Math.round(targetedSeconds * 1000) / 1000,
    reductionSeconds: reductionSeconds === null ? null : Math.round(reductionSeconds * 1000) / 1000,
    reductionPercent: reductionPercent === null ? null : Math.round(reductionPercent * 100) / 100,
  };
}

export function targetedEscalationCacheKey({
  sourceFingerprint,
  config,
  primaryModelId,
  proModelId,
  primaryPromptVersion,
  proPromptVersion,
  mergedIntervals,
  mediaRepresentationVersion = TARGETED_ESCALATION_MEDIA_VERSION,
}) {
  const fingerprint = normalizeText(sourceFingerprint);
  if (!fingerprint) return null;

  const material = {
    experimentVersion: TARGETED_ESCALATION_EXPERIMENT_VERSION,
    policyVersion: TARGETED_ESCALATION_POLICY_VERSION,
    strategy: config?.strategy || null,
    paddingSeconds: config?.paddingSeconds ?? null,
    mergeGapSeconds: config?.mergeGapSeconds ?? null,
    limits: config?.limits || null,
    primaryModelId: primaryModelId || null,
    proModelId: proModelId || null,
    primaryPromptVersion: primaryPromptVersion || null,
    proPromptVersion: proPromptVersion || null,
    sourceFingerprint: fingerprint,
    mergedIntervals: asArray(mergedIntervals).map((interval) => ({
      startSeconds: interval?.startSeconds ?? null,
      endSeconds: interval?.endSeconds ?? null,
      sourceFindingIds: asArray(interval?.sourceFindingIds),
      defectTypes: asArray(interval?.defectTypes),
    })),
    mediaRepresentationVersion,
  };

  return createHash('sha256').update(stableJson(material)).digest('hex');
}
