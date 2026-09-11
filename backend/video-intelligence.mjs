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

const SCORE_WEIGHTS = {
  hook: 0.20,
  pacing: 0.15,
  clarity: 0.15,
  visualQuality: 0.10,
  continuity: 0.10,
  cta: 0.10,
  platformFit: 0.10,
  conversionReadiness: 0.10,
};

export const VIDEO_ANALYSIS_SYSTEM_PROMPT = `You are ForgeDirector Video Intelligence, an expert short-form video creative analyst.

Analyze the supplied video as a production and creative artifact. Your output is consumed by software, so return ONLY valid JSON with no markdown or commentary.

Important rules:
- Judge observable creative execution, not hypothetical audience outcomes.
- Scores are heuristic creative-quality scores, not promises or predictions of views, retention, ROAS, sales, or virality.
- Do not invent speech, on-screen text, brand names, products, claims, or events that are not visible or supplied in the transcript/context.
- If spoken content cannot be reliably determined from the video input and no transcript is supplied, set speech-dependent fields to null or explain the limitation.
- Give precise timestamps when reasonably observable; otherwise use your best approximate timestamp and mark it approximate.
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
  "limitations": ["only genuine analysis limitations"]
}`;

export function buildVideoAnalysisPrompt({
  platform = 'General',
  objective = 'engagement',
  audience = '',
  context = '',
  transcript = '',
  declaredDurationSeconds = null,
} = {}) {
  const safePlatform = String(platform || 'General');
  const safeObjective = String(objective || 'engagement');
  const safeAudience = String(audience || '').trim();
  const safeContext = String(context || '').trim();
  const safeTranscript = String(transcript || '').trim();

  return [
    'Analyze this short-form video for production and creative intelligence.',
    `TARGET PLATFORM: ${safePlatform}`,
    `OBJECTIVE: ${safeObjective}`,
    declaredDurationSeconds ? `DECLARED DURATION: ${declaredDurationSeconds} seconds` : '',
    safeAudience ? `TARGET AUDIENCE: ${safeAudience}` : '',
    safeContext ? `CREATIVE CONTEXT: ${safeContext}` : '',
    safeTranscript ? `SUPPLIED TRANSCRIPT:\n${safeTranscript}` : 'SUPPLIED TRANSCRIPT: none',
    '',
    'Focus on the first three seconds, pacing, clarity, visual execution, continuity, CTA, platform fit, retention risks, and exact corrective actions.',
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

export function normalizeVideoAnalysis(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Video analysis model returned an invalid JSON object.');
  }

  const sourceScores = value.scores && typeof value.scores === 'object' ? value.scores : {};
  const scores = {};
  for (const key of SCORE_KEYS) scores[key] = boundedScore(sourceScores[key]);

  const overall = Math.round(
    SCORE_KEYS.reduce((sum, key) => sum + scores[key] * SCORE_WEIGHTS[key], 0),
  );

  return {
    analysisVersion: '1.0',
    scoringVersion: 'fd-shortform-v1',
    summary: String(value.summary || '').trim(),
    creativeAngle: String(value.creativeAngle || '').trim(),
    scores: { overall, ...scores },
    hook: value.hook && typeof value.hook === 'object' ? value.hook : {},
    timeline: asArray(value.timeline).slice(0, 30),
    retentionRisks: asArray(value.retentionRisks).slice(0, 12),
    continuity: value.continuity && typeof value.continuity === 'object' ? value.continuity : {},
    cta: value.cta && typeof value.cta === 'object' ? value.cta : {},
    platformAssessment: value.platformAssessment && typeof value.platformAssessment === 'object'
      ? value.platformAssessment
      : {},
    fixes: asArray(value.fixes).slice(0, 12),
    regenerationPrompts: asArray(value.regenerationPrompts).slice(0, 12),
    repurpose: value.repurpose && typeof value.repurpose === 'object' ? value.repurpose : {},
    limitations: asArray(value.limitations).slice(0, 10),
  };
}
