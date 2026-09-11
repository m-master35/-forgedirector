const SUPPORTED_CONTENT_TYPES = new Map([
  ['video/mp4', 'mp4'],
  ['video/quicktime', 'mov'],
  ['video/x-matroska', 'mkv'],
  ['video/webm', 'webm'],
]);

const SCORE_KEYS = [
  'hook',
  'pacing',
  'clarity',
  'visualQuality',
  'continuity',
  'cta',
  'platformFit',
  'conversionReadiness',
];

const SCORE_WEIGHTS_BY_OBJECTIVE = {
  engagement: {
    hook: 0.25,
    pacing: 0.20,
    clarity: 0.10,
    visualQuality: 0.10,
    continuity: 0.05,
    cta: 0.05,
    platformFit: 0.20,
    conversionReadiness: 0.05,
  },
  conversion: {
    hook: 0.15,
    pacing: 0.10,
    clarity: 0.15,
    visualQuality: 0.10,
    continuity: 0.05,
    cta: 0.20,
    platformFit: 0.10,
    conversionReadiness: 0.15,
  },
  awareness: {
    hook: 0.20,
    pacing: 0.15,
    clarity: 0.20,
    visualQuality: 0.15,
    continuity: 0.10,
    cta: 0.05,
    platformFit: 0.10,
    conversionReadiness: 0.05,
  },
  education: {
    hook: 0.10,
    pacing: 0.15,
    clarity: 0.30,
    visualQuality: 0.10,
    continuity: 0.10,
    cta: 0.05,
    platformFit: 0.10,
    conversionReadiness: 0.10,
  },
  'app-install': {
    hook: 0.15,
    pacing: 0.10,
    clarity: 0.15,
    visualQuality: 0.10,
    continuity: 0.05,
    cta: 0.20,
    platformFit: 0.10,
    conversionReadiness: 0.15,
  },
  'lead-generation': {
    hook: 0.10,
    pacing: 0.10,
    clarity: 0.20,
    visualQuality: 0.10,
    continuity: 0.05,
    cta: 0.20,
    platformFit: 0.10,
    conversionReadiness: 0.15,
  },
};

const ALLOWED_TIMELINE_PURPOSES = new Set([
  'hook',
  'problem',
  'proof',
  'demo',
  'benefit',
  'transition',
  'cta',
  'other',
]);

export const VIDEO_ANALYSIS_SYSTEM_PROMPT = `You are ForgeDirector Video Intelligence, an expert short-form video creative analyst.

Analyze the supplied video as a production and creative artifact. Your output is consumed by software, so return ONLY valid JSON with no markdown or commentary.

Important rules:
- Judge observable creative execution, not hypothetical audience outcomes.
- Scores are heuristic creative-quality scores, not promises or predictions of views, retention, ROAS, sales, or virality.
- Do not invent speech, on-screen text, brand names, products, claims, events, trends, or subject matter that are not visible or supplied in the transcript/context.
- Never assume the asset is an advertisement or product video unless the video or supplied context establishes that.
- Do not make claims about platform algorithms, predicted retention, predicted engagement, virality, sales, or ROAS.
- If context is absent, keep fixes structurally specific but subject-matter neutral.
- If spoken content cannot be reliably determined from the video input and no transcript is supplied, set speech-dependent fields to null or explain the limitation.
- Give precise timestamps when reasonably observable; otherwise use your best approximate timestamp and mark it approximate.
- Numeric scores must agree with qualitative verdicts: strong should normally be 70-100, mixed 35-69, and weak 0-45.
- If PRODUCTION REQUIREMENTS are supplied, evaluate every supplied rule. Never silently omit a rule. Mark a rule uncertain when the video does not provide enough evidence.
- Prioritize actionable corrections that an editor, video-generation model, or automation system can execute.
- For regeneration prompts, describe only the replacement segment and preserve identity, product, wardrobe, setting, lighting, and camera continuity unless a change is explicitly recommended.
- Keep arrays concise and ranked by impact.

Return this JSON shape:
{
  "summary": "what the video is and how it works creatively",
  "creativeAngle": "core creative idea",
  "scores": {
    "hook": 0,
    "pacing": 0,
    "clarity": 0,
    "visualQuality": 0,
    "continuity": 0,
    "cta": 0,
    "platformFit": 0,
    "conversionReadiness": 0
  },
  "hook": {
    "firstThreeSeconds": "observable opening",
    "spokenHook": "string or null",
    "onScreenHook": "string or null",
    "verdict": "strong|mixed|weak",
    "issues": ["..."]
  },
  "timeline": [
    {
      "startSeconds": 0,
      "endSeconds": 3,
      "purpose": "hook|problem|proof|demo|benefit|transition|cta|other",
      "visual": "observable visual description",
      "speech": "string or null",
      "onScreenText": "string or null",
      "issues": ["..."],
      "recommendations": ["..."]
    }
  ],
  "retentionRisks": [
    {
      "startSeconds": 0,
      "severity": "high|medium|low",
      "reason": "...",
      "fix": "..."
    }
  ],
  "continuity": {
    "verdict": "strong|mixed|weak",
    "issues": ["..."]
  },
  "cta": {
    "present": true,
    "type": "spoken|visual|both|none",
    "clarity": "strong|mixed|weak",
    "issue": "string or null",
    "recommendedCta": "string or null"
  },
  "platformAssessment": {
    "fit": "strong|mixed|weak",
    "reasons": ["..."]
  },
  "fixes": [
    {
      "priority": 1,
      "impact": "high|medium|low",
      "effort": "low|medium|high",
      "issue": "...",
      "action": "..."
    }
  ],
  "regenerationPrompts": [
    {
      "startSeconds": 0,
      "endSeconds": 3,
      "reason": "...",
      "prompt": "production-ready replacement-generation prompt"
    }
  ],
  "repurpose": {
    "tiktok": ["..."],
    "instagramReels": ["..."],
    "youtubeShorts": ["..."]
  },
  "compliance": {
    "checks": [
      {
        "type": "mustShow|mustNotShow|mustIncludeText|continuityRule|ctaRequired",
        "rule": "exact supplied rule",
        "status": "pass|fail|uncertain",
        "evidence": "brief observable evidence",
        "timestampSeconds": 0
      }
    ]
  },
  "limitations": ["only genuine analysis limitations"]
}`;

export function buildVideoAnalysisPrompt({
  platform = 'General',
  objective = 'engagement',
  audience = '',
  context = '',
  transcript = '',
  declaredDurationSeconds = null,
  requirements = {},
} = {}) {
  const safePlatform = String(platform || 'General');
  const safeObjective = String(objective || 'engagement');
  const safeAudience = String(audience || '').trim();
  const safeContext = String(context || '').trim();
  const safeTranscript = String(transcript || '').trim();
  const safeRequirements = requirements && typeof requirements === 'object' && !Array.isArray(requirements)
    ? requirements
    : {};

  return [
    'Analyze this short-form video for production and creative intelligence.',
    `TARGET PLATFORM: ${safePlatform}`,
    `OBJECTIVE: ${safeObjective}`,
    declaredDurationSeconds ? `DECLARED DURATION: ${declaredDurationSeconds} seconds` : '',
    safeAudience ? `TARGET AUDIENCE: ${safeAudience}` : '',
    safeContext ? `CREATIVE CONTEXT: ${safeContext}` : '',
    safeTranscript ? `SUPPLIED TRANSCRIPT:\n${safeTranscript}` : 'SUPPLIED TRANSCRIPT: none',
    Object.keys(safeRequirements).length
      ? `PRODUCTION REQUIREMENTS:\n${JSON.stringify(safeRequirements)}`
      : 'PRODUCTION REQUIREMENTS: none',
    '',
    'Focus on the first three seconds, pacing, clarity, visual execution, continuity, CTA, platform fit, retention risks, exact corrective actions, and any supplied production requirements.',
    'Return JSON only.',
  ].filter(Boolean).join('\n');
}

export function videoFormatFromContentType(contentType = '') {
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
  return SUPPORTED_CONTENT_TYPES.get(normalized) || null;
}

export function supportedVideoContentTypes() {
  return [...SUPPORTED_CONTENT_TYPES.keys()];
}

export function assertAssetId(value) {
  const assetId = String(value || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId)) {
    const error = new Error('assetId must be a valid UUID.');
    error.statusCode = 400;
    throw error;
  }
  return assetId;
}

function boundedScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function reconcileVerdictScore(score, verdict) {
  const normalized = String(verdict || '').trim().toLowerCase();
  if (normalized === 'strong') return Math.max(score, 70);
  if (normalized === 'mixed') return Math.max(35, Math.min(score, 69));
  if (normalized === 'weak') return Math.min(score, 45);
  return score;
}

const SPECULATIVE_PLATFORM_PATTERNS = [
  /\balgorithm(?:ic)?\b/i,
  /\bviral(?:ity)?\b/i,
  /\btrend(?:ing|s)?\b/i,
  /\bhashtags?\b/i,
  /\bdiscoverability\b/i,
  /\bshareability\b/i,
  /\bboost(?:ing)?\s+(?:engagement|reach|views|discoverability)\b/i,
  /\bguarantee(?:d)?\s+(?:engagement|reach|views|sales)\b/i,
];

function containsSpeculativePlatformClaim(value) {
  const text = String(value || '');
  return SPECULATIVE_PLATFORM_PATTERNS.some((pattern) => pattern.test(text));
}

function filterStrings(items) {
  return asArray(items)
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item) => !containsSpeculativePlatformClaim(item));
}

function normalizeTimeline(items, hasTranscript) {
  return asArray(items).slice(0, 30).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return {};
    const purpose = String(item.purpose || 'other').trim().toLowerCase();
    return {
      ...item,
      purpose: ALLOWED_TIMELINE_PURPOSES.has(purpose) ? purpose : 'other',
      speech: hasTranscript ? (item.speech ?? null) : null,
      recommendations: filterStrings(item.recommendations),
    };
  });
}

function sanitizeFixes(items) {
  return asArray(items)
    .slice(0, 12)
    .filter((fix) => {
      const text = `${fix?.issue || ''} ${fix?.action || ''}`;
      return !containsSpeculativePlatformClaim(text);
    });
}

function sanitizeRegenerationPrompts(items) {
  return asArray(items)
    .slice(0, 12)
    .filter((item) => {
      const text = `${item?.reason || ''} ${item?.prompt || ''}`;
      return !containsSpeculativePlatformClaim(text);
    });
}

function sanitizeRepurpose(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    tiktok: filterStrings(source.tiktok),
    instagramReels: filterStrings(source.instagramReels),
    youtubeShorts: filterStrings(source.youtubeShorts),
  };
}

function sanitizePlatformAssessment(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...source,
    reasons: filterStrings(source.reasons),
  };
}

function normalizeHook(value, hasTranscript) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...source,
    spokenHook: hasTranscript ? (source.spokenHook ?? null) : null,
    issues: filterStrings(source.issues),
  };
}

function objectiveWeights(objective) {
  return SCORE_WEIGHTS_BY_OBJECTIVE[objective] || SCORE_WEIGHTS_BY_OBJECTIVE.engagement;
}

function expectedRequirementChecks(requirements) {
  const checks = [];
  const add = (type, rules) => {
    for (const rule of asArray(rules)) {
      const text = String(rule || '').trim();
      if (text) checks.push({ type, rule: text });
    }
  };

  add('mustShow', requirements?.mustShow);
  add('mustNotShow', requirements?.mustNotShow);
  add('mustIncludeText', requirements?.mustIncludeText);
  add('continuityRule', requirements?.continuityRules);
  if (requirements?.ctaRequired === true) {
    checks.push({ type: 'ctaRequired', rule: 'CTA is required' });
  }
  return checks;
}

function normalizeMatchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectOnScreenText(value) {
  const items = [];
  const add = (text) => {
    const cleaned = String(text || '').trim();
    if (cleaned) items.push(cleaned);
  };
  add(value?.hook?.onScreenHook);
  for (const item of asArray(value?.timeline)) add(item?.onScreenText);
  return items;
}

function collectVisualEvidence(value) {
  const items = [];
  const add = (text) => {
    const cleaned = String(text || '').trim();
    if (cleaned) items.push(cleaned);
  };
  add(value?.summary);
  add(value?.creativeAngle);
  add(value?.hook?.firstThreeSeconds);
  add(value?.hook?.onScreenHook);
  for (const item of asArray(value?.timeline)) {
    add(item?.visual);
    add(item?.onScreenText);
    for (const issue of asArray(item?.issues)) add(issue);
  }
  for (const issue of asArray(value?.continuity?.issues)) add(issue);
  return items;
}

function corpusIncludes(items, rule) {
  const needle = normalizeMatchText(rule);
  if (!needle) return false;
  const haystack = normalizeMatchText(items.join(' | '));
  return haystack.includes(needle);
}

function corpusAffirmativelyIncludes(items, rule) {
  const needle = normalizeMatchText(rule);
  if (!needle) return false;

  return items.some((item) => {
    const text = normalizeMatchText(item);
    const index = text.indexOf(needle);
    if (index < 0) return false;

    const before = text.slice(Math.max(0, index - 45), index);
    const after = text.slice(index + needle.length, index + needle.length + 30);
    const negatedBefore = /(?:^|\s)(?:no|not|without|lacks?|missing|absent)\s+(?:\w+\s+){0,4}$/.test(before);
    const negatedAfter = /^(?:\s+\w+){0,3}\s+(?:is|are|was|were)?\s*(?:not|absent|missing)/.test(after);
    return !negatedBefore && !negatedAfter;
  });
}

function sourceComplianceChecks(value) {
  const sourceChecks = value?.compliance && typeof value.compliance === 'object'
    ? asArray(value.compliance.checks)
    : [];
  return sourceChecks.slice(0, 80).map((check) => {
    const status = ['pass', 'fail', 'uncertain'].includes(String(check?.status || '').toLowerCase())
      ? String(check.status).toLowerCase()
      : 'uncertain';
    return {
      type: String(check?.type || 'requirement').trim(),
      rule: String(check?.rule || '').trim(),
      status,
      evidence: String(check?.evidence || '').trim(),
      timestampSeconds: Number.isFinite(Number(check?.timestampSeconds))
        ? Math.max(0, Number(check.timestampSeconds))
        : null,
    };
  });
}

function findSourceCheck(sourceChecks, item, used) {
  const target = normalizeMatchText(item.rule);
  let index = sourceChecks.findIndex((check, candidateIndex) => {
    if (used.has(candidateIndex)) return false;
    return check.type.toLowerCase() === item.type.toLowerCase()
      && normalizeMatchText(check.rule) === target;
  });
  if (index < 0) {
    index = sourceChecks.findIndex((check, candidateIndex) => {
      if (used.has(candidateIndex)) return false;
      return normalizeMatchText(check.rule) === target;
    });
  }
  if (index >= 0) used.add(index);
  return index >= 0 ? sourceChecks[index] : null;
}

function normalizeCompliance(value, requirements) {
  const expected = expectedRequirementChecks(requirements);

  if (expected.length === 0) {
    return {
      status: 'not_requested',
      passed: null,
      failedCount: 0,
      uncertainCount: 0,
      checks: [],
    };
  }

  const onScreenText = collectOnScreenText(value);
  const visualEvidence = collectVisualEvidence(value);
  const sourceChecks = sourceComplianceChecks(value);
  const used = new Set();

  const checks = expected.map((item) => {
    const source = findSourceCheck(sourceChecks, item, used);

    if (item.type === 'ctaRequired') {
      if (value?.cta?.present === true) {
        return {
          ...item,
          status: 'pass',
          evidence: 'CTA was observed by the video analysis.',
          timestampSeconds: source?.timestampSeconds ?? null,
        };
      }
      if (value?.cta?.present === false) {
        return {
          ...item,
          status: 'fail',
          evidence: String(value?.cta?.issue || 'No CTA was observed.'),
          timestampSeconds: source?.timestampSeconds ?? null,
        };
      }
    }

    if (item.type === 'mustIncludeText') {
      if (corpusIncludes(onScreenText, item.rule)) {
        return {
          ...item,
          status: 'pass',
          evidence: `Required on-screen text observed: "${item.rule}".`,
          timestampSeconds: source?.timestampSeconds ?? null,
        };
      }
      if (source && source.status !== 'uncertain') return { ...source, type: item.type, rule: item.rule };
      if (onScreenText.length > 0) {
        return {
          ...item,
          status: 'fail',
          evidence: `Required on-screen text was not observed. Extracted text: ${onScreenText.join(' | ')}`,
          timestampSeconds: null,
        };
      }
    }

    if (item.type === 'mustNotShow') {
      if (corpusIncludes(onScreenText, item.rule) || corpusAffirmativelyIncludes(visualEvidence, item.rule)) {
        return {
          ...item,
          status: 'fail',
          evidence: `Forbidden element was observed in the video evidence: "${item.rule}".`,
          timestampSeconds: source?.timestampSeconds ?? null,
        };
      }
      if (source && source.status === 'fail') return { ...source, type: item.type, rule: item.rule };
      if (visualEvidence.length > 0) {
        return {
          ...item,
          status: 'pass',
          evidence: `Forbidden element was not observed in the analyzed video: "${item.rule}".`,
          timestampSeconds: null,
        };
      }
    }

    if (item.type === 'mustShow') {
      if (corpusIncludes(onScreenText, item.rule) || corpusAffirmativelyIncludes(visualEvidence, item.rule)) {
        return {
          ...item,
          status: 'pass',
          evidence: `Required element was observed in the video evidence: "${item.rule}".`,
          timestampSeconds: source?.timestampSeconds ?? null,
        };
      }
      if (source && source.status !== 'uncertain') return { ...source, type: item.type, rule: item.rule };
    }

    if (item.type === 'continuityRule') {
      if (source && source.status !== 'uncertain') return { ...source, type: item.type, rule: item.rule };
      const issueCorpus = [
        ...asArray(value?.continuity?.issues),
        ...asArray(value?.timeline).flatMap((entry) => asArray(entry?.issues)),
      ];
      if (issueCorpus.some((issue) => /continuity|change|changed|different|violat/i.test(String(issue)))) {
        return {
          ...item,
          status: 'fail',
          evidence: issueCorpus.join(' | ').slice(0, 800),
          timestampSeconds: null,
        };
      }
    }

    if (source) return { ...source, type: item.type, rule: item.rule };

    return {
      ...item,
      status: 'uncertain',
      evidence: 'The analysis did not return enough evidence for this required check.',
      timestampSeconds: null,
    };
  });

  const failedCount = checks.filter((check) => check.status === 'fail').length;
  const uncertainCount = checks.filter((check) => check.status === 'uncertain').length;
  const status = failedCount > 0 ? 'fail' : uncertainCount > 0 ? 'needs_review' : 'pass';

  return {
    status,
    passed: status === 'pass',
    failedCount,
    uncertainCount,
    checks,
  };
}

function qualityGate(scores, retentionRisks, fixes, compliance) {
  const highRisks = retentionRisks.filter((risk) => String(risk?.severity || '').toLowerCase() === 'high');
  const highImpactFixes = fixes.filter((fix) => String(fix?.impact || '').toLowerCase() === 'high');
  const blockers = [];

  if (scores.visualQuality < 35) blockers.push('visual_quality_below_35');
  if (scores.continuity < 30) blockers.push('continuity_below_30');
  if (scores.hook < 25 && scores.pacing < 40) blockers.push('opening_execution_too_weak');
  if (highRisks.length >= 3) blockers.push('multiple_high_retention_risks');

  let action = 'revise';
  if (scores.overall < 45 || blockers.length > 0) {
    action = 'regenerate';
  } else if (
    scores.overall >= 80
    && scores.hook >= 60
    && scores.clarity >= 60
    && scores.platformFit >= 60
    && highRisks.length === 0
  ) {
    action = 'accept';
  }

  if (compliance?.status === 'fail' && action === 'accept') action = 'revise';
  if (compliance?.status === 'needs_review' && action === 'accept') action = 'revise';

  const reasons = [];
  if (compliance?.status === 'fail') {
    reasons.push(`${compliance.failedCount} explicit production requirement(s) failed.`);
  } else if (compliance?.status === 'needs_review') {
    reasons.push(`${compliance.uncertainCount} production requirement(s) need review.`);
  }

  if (action === 'accept') {
    reasons.push('Overall creative-quality score cleared the acceptance threshold.');
    reasons.push('Hook, clarity, and platform-fit floors were met with no high-severity retention risk.');
  } else if (action === 'regenerate') {
    reasons.push('One or more core production-quality thresholds require a material rebuild.');
    if (scores.overall < 45) reasons.push('Overall creative-quality score is below 45.');
    if (blockers.length) reasons.push(`Blocking checks: ${blockers.join(', ')}.`);
  } else {
    reasons.push('The asset is structurally usable but has material issues worth correcting before acceptance.');
    if (highImpactFixes.length) reasons.push(`${highImpactFixes.length} high-impact fix(es) were identified.`);
  }

  const distance = action === 'accept'
    ? scores.overall - 80
    : action === 'regenerate'
      ? 45 - scores.overall
      : Math.min(Math.abs(scores.overall - 45), Math.abs(80 - scores.overall));

  const confidence = distance >= 15 || blockers.length >= 2 ? 'high' : distance >= 7 ? 'medium' : 'low';

  return {
    action,
    confidence,
    blockers,
    reasons,
    thresholds: {
      acceptOverallAtLeast: 80,
      regenerateOverallBelow: 45,
      acceptHookAtLeast: 60,
      acceptClarityAtLeast: 60,
      acceptPlatformFitAtLeast: 60,
    },
  };
}

export function normalizeVideoAnalysis(value, {
  objective = 'engagement',
  requirements = {},
  hasTranscript = false,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Video analysis model returned an invalid JSON object.');
  }

  const normalizedObjective = SCORE_WEIGHTS_BY_OBJECTIVE[objective] ? objective : 'engagement';
  const weights = objectiveWeights(normalizedObjective);
  const sourceScores = value.scores && typeof value.scores === 'object' ? value.scores : {};
  const dimensionScores = {};
  for (const key of SCORE_KEYS) dimensionScores[key] = boundedScore(sourceScores[key]);

  dimensionScores.hook = reconcileVerdictScore(dimensionScores.hook, value?.hook?.verdict);
  dimensionScores.continuity = reconcileVerdictScore(dimensionScores.continuity, value?.continuity?.verdict);
  dimensionScores.cta = reconcileVerdictScore(dimensionScores.cta, value?.cta?.clarity);
  dimensionScores.platformFit = reconcileVerdictScore(dimensionScores.platformFit, value?.platformAssessment?.fit);

  const overall = Math.round(
    SCORE_KEYS.reduce((sum, key) => sum + dimensionScores[key] * weights[key], 0),
  );

  const scores = { overall, ...dimensionScores };
  const timeline = normalizeTimeline(value.timeline, hasTranscript);
  const retentionRisks = asArray(value.retentionRisks).slice(0, 12);
  const fixes = sanitizeFixes(value.fixes);
  const regenerationPrompts = sanitizeRegenerationPrompts(value.regenerationPrompts);
  const compliance = normalizeCompliance(value, requirements);
  const limitations = filterStrings(value.limitations);
  if (!hasTranscript) {
    limitations.push('Audio was not analyzed; supply a transcript for spoken-word analysis.');
  }

  return {
    analysisVersion: '1.4',
    scoringVersion: 'fd-shortform-v5',
    scoring: {
      objective: normalizedObjective,
      weights,
    },
    summary: String(value.summary || '').trim(),
    creativeAngle: String(value.creativeAngle || '').trim(),
    scores,
    compliance,
    qualityGate: qualityGate(scores, retentionRisks, fixes, compliance),
    hook: normalizeHook(value.hook, hasTranscript),
    timeline,
    retentionRisks,
    continuity: value.continuity && typeof value.continuity === 'object' ? value.continuity : {},
    cta: value.cta && typeof value.cta === 'object' ? value.cta : {},
    platformAssessment: sanitizePlatformAssessment(value.platformAssessment),
    fixes,
    regenerationPrompts,
    repurpose: sanitizeRepurpose(value.repurpose),
    limitations: limitations.slice(0, 10),
  };
}
