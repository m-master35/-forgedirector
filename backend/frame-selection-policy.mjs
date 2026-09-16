/**
 * Experimental defect-to-selector routing for ForgeDirector.
 *
 * This file is not imported by the production analyzer. It expresses which
 * defect families are safe candidates for semantic/query-aware selection and
 * which require temporal/global coverage. The policy is versioned so any later
 * benchmark/cache evidence can identify the exact routing decision.
 */

export const FRAME_SELECTION_POLICY_VERSION = 'fd-defect-selection-policy-1';

export const DEFECT_SELECTION_POLICY = Object.freeze({
  required_object: {
    strategy: 'focus',
    coverageFloor: false,
    rationale: 'Expected semantic content is named and may be localized.',
  },
  required_text: {
    strategy: 'hybrid',
    coverageFloor: true,
    rationale: 'Visible text may be brief; relevance should supplement temporal anchors.',
  },
  forbidden_object: {
    strategy: 'hybrid',
    coverageFloor: true,
    rationale: 'A global absence claim cannot rely only on semantically likely moments.',
  },
  narration_visual_mismatch: {
    strategy: 'hybrid',
    coverageFloor: true,
    rationale: 'Requires visual evidence across narration time, not one semantic peak.',
  },
  object_continuity: {
    strategy: 'hybrid',
    coverageFloor: true,
    rationale: 'Requires comparison across separated moments.',
  },
  character_consistency: {
    strategy: 'hybrid',
    coverageFloor: true,
    rationale: 'Identity/wardrobe consistency is comparative across time.',
  },
  product_logo_consistency: {
    strategy: 'hybrid',
    coverageFloor: true,
    rationale: 'Relevant product/logo moments matter, but temporal comparison is required.',
  },
  visual_artifact: {
    strategy: 'hybrid',
    coverageFloor: true,
    rationale: 'Artifacts can be brief and semantically unrelated to the query.',
  },
  unexpected_object: {
    strategy: 'hybrid',
    coverageFloor: true,
    rationale: 'Unexpected content is not necessarily nameable in the selector query.',
  },
  incorrect_visual_content: {
    strategy: 'hybrid',
    coverageFloor: true,
    rationale: 'Expected semantics help, but incorrect content can appear outside the peak.',
  },
  cta: {
    strategy: 'hybrid',
    coverageFloor: true,
    rationale: 'CTA is often localized but may occur anywhere and can be visual or textual.',
  },
  black_blank_frame: {
    strategy: 'uniform',
    coverageFloor: true,
    rationale: 'Semantic relevance is the wrong signal for blank/black visual failures.',
  },
  frozen_imagery: {
    strategy: 'uniform',
    coverageFloor: true,
    rationale: 'Requires adjacent-time comparison over the video.',
  },
  pacing: {
    strategy: 'uniform',
    coverageFloor: true,
    rationale: 'Temporal density and change rate are the signal.',
  },
  repeated_imagery: {
    strategy: 'uniform',
    coverageFloor: true,
    rationale: 'Requires cross-time comparison and broad coverage.',
  },
  scene_transition: {
    strategy: 'uniform',
    coverageFloor: true,
    rationale: 'Short boundary defects are easy to discard with semantic retrieval.',
  },
  missing_visuals: {
    strategy: 'uniform',
    coverageFloor: true,
    rationale: 'A selector cannot safely infer absence from relevance-selected moments.',
  },
});

function cleanRule(value, maxLength = 400) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function cleanList(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => cleanRule(value)).filter(Boolean);
}

function task({ id, defectCategory, rule = null, query = null, source = 'generic' }) {
  const policy = DEFECT_SELECTION_POLICY[defectCategory];
  if (!policy) throw new Error(`Unknown defect category: ${defectCategory}`);
  return {
    id,
    policyVersion: FRAME_SELECTION_POLICY_VERSION,
    defectCategory,
    strategy: policy.strategy,
    coverageFloor: policy.coverageFloor,
    rule,
    query,
    source,
    rationale: policy.rationale,
  };
}

/**
 * Build selector tasks from the same requirements ForgeDirector already
 * accepts. A task is an experiment/evaluation unit, not a production VLM call.
 *
 * Generic creative QA is intentionally split into temporal/global and
 * semantic/consistency tasks instead of pretending one FOCUS query can safely
 * cover every production defect.
 */
export function buildFrameSelectionTasks({
  requirements = {},
  transcript = '',
  includeGeneralAnalysis = true,
} = {}) {
  const safeRequirements = requirements
    && typeof requirements === 'object'
    && !Array.isArray(requirements)
    ? requirements
    : {};
  const tasks = [];

  if (includeGeneralAnalysis) {
    for (const category of [
      'black_blank_frame',
      'frozen_imagery',
      'pacing',
      'repeated_imagery',
      'scene_transition',
      'missing_visuals',
    ]) {
      tasks.push(task({
        id: `general:${category}`,
        defectCategory: category,
        source: 'general_analysis',
      }));
    }

    for (const category of [
      'object_continuity',
      'character_consistency',
      'product_logo_consistency',
      'visual_artifact',
      'unexpected_object',
      'incorrect_visual_content',
    ]) {
      tasks.push(task({
        id: `general:${category}`,
        defectCategory: category,
        query: [
          'Inspect frames for video-production defects.',
          category.replaceAll('_', ' '),
          'Preserve source timestamps and compare evidence across the clip.',
        ].join(' '),
        source: 'general_analysis',
      }));
    }

    if (cleanRule(transcript)) {
      tasks.push(task({
        id: 'general:narration_visual_mismatch',
        defectCategory: 'narration_visual_mismatch',
        query: 'Find visual moments needed to verify whether the imagery matches the supplied narration over time.',
        source: 'general_analysis',
      }));
    }
  }

  cleanList(safeRequirements.mustShow).forEach((rule, index) => {
    tasks.push(task({
      id: `requirement:mustShow:${index}`,
      defectCategory: 'required_object',
      rule,
      query: `Find frames with visual evidence relevant to this required content: ${rule}`,
      source: 'mustShow',
    }));
  });

  cleanList(safeRequirements.mustNotShow).forEach((rule, index) => {
    tasks.push(task({
      id: `requirement:mustNotShow:${index}`,
      defectCategory: 'forbidden_object',
      rule,
      query: `Find frames that could contain or disprove the presence of this forbidden content: ${rule}`,
      source: 'mustNotShow',
    }));
  });

  cleanList(safeRequirements.mustIncludeText).forEach((rule, index) => {
    tasks.push(task({
      id: `requirement:mustIncludeText:${index}`,
      defectCategory: 'required_text',
      rule,
      query: `Find frames likely to contain this required visible text or its surrounding title/CTA card: ${rule}`,
      source: 'mustIncludeText',
    }));
  });

  cleanList(safeRequirements.continuityRules).forEach((rule, index) => {
    tasks.push(task({
      id: `requirement:continuityRule:${index}`,
      defectCategory: 'object_continuity',
      rule,
      query: `Find separated visual moments needed to compare this continuity rule: ${rule}`,
      source: 'continuityRule',
    }));
  });

  if (safeRequirements.ctaRequired === true) {
    tasks.push(task({
      id: 'requirement:ctaRequired',
      defectCategory: 'cta',
      rule: 'CTA is required',
      query: 'Find frames likely to contain the call to action, end card, button, offer text, or spoken-CTA visual context.',
      source: 'ctaRequired',
    }));
  }

  return tasks;
}

export function summarizeFrameSelectionTasks(tasks = []) {
  const summary = {
    policyVersion: FRAME_SELECTION_POLICY_VERSION,
    total: 0,
    byStrategy: { uniform: 0, focus: 0, hybrid: 0 },
    byDefectCategory: {},
    requiresGlobalCoverage: false,
  };

  for (const item of Array.isArray(tasks) ? tasks : []) {
    if (!item || typeof item !== 'object') continue;
    summary.total += 1;
    if (Object.hasOwn(summary.byStrategy, item.strategy)) {
      summary.byStrategy[item.strategy] += 1;
    }
    summary.byDefectCategory[item.defectCategory] = (
      summary.byDefectCategory[item.defectCategory] || 0
    ) + 1;
    if (item.coverageFloor) summary.requiresGlobalCoverage = true;
  }

  return summary;
}

/**
 * Returns the least-aggressive strategy that can support every supplied task
 * if a caller insists on one shared frame set.
 *
 * This is intentionally conservative:
 * - any true global/temporal task -> uniform
 * - otherwise any hybrid task -> hybrid
 * - only all-localizable semantic tasks -> focus
 *
 * The preferred experiment is still per-task benchmarking; this helper merely
 * prevents an unsafe global collapse to FOCUS.
 */
export function sharedFrameSetStrategy(tasks = []) {
  const normalized = Array.isArray(tasks) ? tasks : [];
  if (normalized.some((item) => item?.strategy === 'uniform')) return 'uniform';
  if (normalized.some((item) => item?.strategy === 'hybrid')) return 'hybrid';
  if (normalized.some((item) => item?.strategy === 'focus')) return 'focus';
  return 'uniform';
}
