const PLATFORM_ALIASES = new Map([
  ['tiktok', 'TikTok'],
  ['instagram reels', 'Instagram Reels'],
  ['instagram', 'Instagram Reels'],
  ['reels', 'Instagram Reels'],
  ['youtube shorts', 'YouTube Shorts'],
  ['youtube', 'YouTube Shorts'],
  ['shorts', 'YouTube Shorts'],
  ['general', 'General'],
]);

const VALID_ASPECTS = new Set(['9:16', '1:1', '16:9']);
const GENERIC_BRIEF_WORDS = new Set([
  'make', 'create', 'video', 'ad', 'good', 'great', 'nice', 'cool', 'better',
  'something', 'anything', 'viral', 'cinematic', 'content', 'please', 'for', 'me',
]);

function cleanText(value, max = 6000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function normalizePlatform(value, fallback = 'General') {
  const key = cleanText(value, 100).toLowerCase();
  return PLATFORM_ALIASES.get(key) || fallback;
}

function normalizeAspect(value, fallback = '9:16') {
  const text = cleanText(value, 20);
  return VALID_ASPECTS.has(text) ? text : fallback;
}

function normalizeDuration(value, fallback = 15) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(5, Math.min(120, Math.round(n * 10) / 10));
}

function meaningfulWordCount(text) {
  return cleanText(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !GENERIC_BRIEF_WORDS.has(word)).length;
}

function looksLikeNoise(text) {
  const source = cleanText(text);
  if (!source) return true;
  const alphaNum = (source.match(/[a-z0-9]/gi) || []).length;
  const ratio = alphaNum / Math.max(1, source.length);
  const repeated = /(.)\1{7,}/.test(source);
  return ratio < 0.35 || repeated;
}

function normalizedConstraints(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result = {};
  if (raw.platform != null) result.platform = normalizePlatform(raw.platform);
  if (raw.aspectRatio != null) result.aspectRatio = normalizeAspect(raw.aspectRatio);
  if (raw.durationSeconds != null) result.durationSeconds = normalizeDuration(raw.durationSeconds);
  for (const key of ['audience', 'tone', 'product', 'brand', 'cta', 'style']) {
    const text = cleanText(raw[key], 500);
    if (text) result[key] = text;
  }
  return result;
}

export function prepareCreativeRequest(payload = {}) {
  const rawBrief = cleanText(payload?.brief ?? payload?.message ?? payload?.prompt, 6000);
  const constraints = normalizedConstraints(payload?.constraints);
  const issues = [];
  const assumptions = [];

  if (!rawBrief) issues.push('missing_brief');
  if (rawBrief && rawBrief.length < 20) issues.push('very_short_brief');
  if (rawBrief && meaningfulWordCount(rawBrief) < 2) issues.push('underspecified_brief');
  if (rawBrief && looksLikeNoise(rawBrief)) issues.push('noisy_brief');

  let qualityScore = 100;
  if (issues.includes('missing_brief')) qualityScore -= 70;
  if (issues.includes('very_short_brief')) qualityScore -= 25;
  if (issues.includes('underspecified_brief')) qualityScore -= 30;
  if (issues.includes('noisy_brief')) qualityScore -= 35;
  if (Object.keys(constraints).length) qualityScore += 10;
  qualityScore = Math.max(0, Math.min(100, qualityScore));

  const salvageable = rawBrief && !looksLikeNoise(rawBrief)
    ? rawBrief
    : 'Create a polished short-form social video with a clear visual hook, coherent progression, and memorable final beat.';

  if (!rawBrief || looksLikeNoise(rawBrief)) {
    assumptions.push('Used a safe short-form creative default because the supplied brief was empty or unusable.');
  }
  if (!constraints.platform) assumptions.push('Defaulted platform to General.');
  if (!constraints.aspectRatio) assumptions.push('Defaulted aspect ratio to 9:16 for short-form viewing.');
  if (!constraints.durationSeconds) assumptions.push('Defaulted duration to 15 seconds.');
  if (!constraints.audience) assumptions.push('Used a broad mobile-first audience unless the brief clearly identifies one.');

  const enrichedBrief = [
    salvageable,
    '',
    'FORGEDIRECTOR DEFAULTS WHEN THE BRIEF IS SILENT:',
    `- Platform: ${constraints.platform || 'General'}`,
    `- Aspect ratio: ${constraints.aspectRatio || '9:16'}`,
    `- Duration: ${constraints.durationSeconds || 15} seconds`,
    `- Audience: ${constraints.audience || 'broad mobile-first audience'}`,
    '- Build a strong opening visual in the first 2 seconds.',
    '- Use a clear beginning, development, and payoff/end frame.',
    '- Keep recurring people, products, wardrobe, setting, and palette visually consistent.',
    '- Prefer concrete, generator-ready camera and lighting instructions over generic adjectives.',
    '- Do not invent factual product, medical, financial, legal, performance, or comparative claims.',
  ].join('\n');

  return {
    rawBrief,
    enrichedBrief,
    constraints,
    quality: {
      score: qualityScore,
      tier: qualityScore >= 70 ? 'good' : qualityScore >= 35 ? 'weak' : 'poor',
      issues,
    },
    assumptions: unique(assumptions),
  };
}

export function extractJsonObject(text) {
  const source = String(text || '').trim();
  if (!source) return '';

  const unfenced = source
    .replace(/^\`\`\`(?:json)?\s*/i, '')
    .replace(/\s*\`\`\`$/i, '')
    .trim();

  if (unfenced.startsWith('{') && unfenced.endsWith('}')) return unfenced;

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < unfenced.length; i += 1) {
    const ch = unfenced[i];
    if (start < 0) {
      if (ch !== '{') continue;
      start = i;
      depth = 1;
      continue;
    }

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return unfenced.slice(start, i + 1);
    }
  }

  return '';
}

export function parseDirectorJson(text) {
  const candidate = extractJsonObject(text);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function defaultSceneRole(index, count) {
  if (index === 0) return 'hook';
  if (index === count - 1) return 'payoff';
  return index === 1 ? 'development' : 'proof';
}

function sceneCountForDuration(duration) {
  if (duration <= 7) return 2;
  if (duration <= 18) return 3;
  if (duration <= 35) return 4;
  return 5;
}

function allocateDurations(rawScenes, totalDuration) {
  const count = rawScenes.length;
  const raw = rawScenes.map((scene) => Number(scene?.durationSeconds));
  const validTotal = raw.every((n) => Number.isFinite(n) && n > 0)
    ? raw.reduce((sum, n) => sum + n, 0)
    : 0;

  const durations = [];
  let allocated = 0;

  for (let i = 0; i < count; i += 1) {
    if (i === count - 1) {
      durations.push(Math.round((totalDuration - allocated) * 10) / 10);
      break;
    }
    const share = validTotal > 0 ? raw[i] / validTotal : 1 / count;
    const remainingMin = (count - i - 1) * 0.5;
    const proposed = Math.round(totalDuration * share * 10) / 10;
    const duration = Math.max(0.5, Math.min(proposed, totalDuration - allocated - remainingMin));
    durations.push(duration);
    allocated = Math.round((allocated + duration) * 10) / 10;
  }

  return durations;
}

function safeVoiceover(value, role, durationSeconds) {
  let text = cleanText(value, 500);
  if (!text) {
    if (role === 'hook') text = 'Start with what matters.';
    else if (role === 'payoff') text = 'Make the next step clear.';
    else text = 'Keep the story moving.';
  }

  const maxWords = Math.max(4, Math.floor(Number(durationSeconds || 0) * 2.6));
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;

  const trimmed = words.slice(0, maxWords).join(' ').replace(/[,:;\-]+$/, '');
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function defaultVisual(role, brief) {
  const seed = cleanText(brief, 500);
  if (role === 'hook') {
    return `Immediate visual hook based on: ${seed}. Start on the most distinctive subject or action, close enough to read instantly on mobile; motivated camera movement; no slow establishing shot.`;
  }
  if (role === 'payoff') {
    return `Resolve the visual story from: ${seed}. Clean final composition, stable subject identity and styling, clear focal point, negative space for optional end-frame copy or CTA.`;
  }
  return `Develop the idea from: ${seed}. Show a concrete action or proof beat, preserve recurring subject/product appearance, use purposeful composition and a visually distinct progression from the previous scene.`;
}

function roleProductionSpec(role, index, count) {
  if (role === 'hook') {
    return [
      'Scene function: opening hook; begin in medias res on the most visually distinctive problem, action, or product detail within the first frame.',
      'Camera path: start tight (macro or close medium depending on subject) and use one controlled push-in, snap reveal, or short motivated track during the first 1-2 seconds; no slow establishing shot.',
      'Progression cue: end on an action, glance, tap, object movement, or compositional change that creates a clean cut into the next beat.',
    ].join(' ');
  }
  if (role === 'payoff') {
    return [
      'Scene function: payoff/end state; show a visibly resolved state rather than repeating the opening composition.',
      'Camera path: settle into a stable medium, product-hero, or clean detail frame with a subtle pull-back or focus settle; finish with one unmistakable focal subject.',
      'Progression cue: the final composition must visually contrast with the opening state while preserving the same world, product, and styling.',
    ].join(' ');
  }
  if (role === 'proof') {
    return [
      'Scene function: proof/detail beat; reveal one new observable detail or consequence that has not appeared in earlier scenes.',
      'Camera path: use a deliberate detail-to-context move, short lateral track, or focus pull tied to the subject action.',
      'Progression cue: introduce a genuinely new visual fact, state, or interaction rather than replaying the prior beat.',
    ].join(' ');
  }
  return [
    'Scene function: development/demo beat; show one concrete interaction, transformation, or observable state change.',
    'Camera path: start at a readable medium or close-medium frame, then pan, track, or push toward the exact action; keep the movement physically motivated.',
    'Progression cue: move the story from the opening condition toward the payoff with a visibly different action and composition.',
  ].join(' ');
}

function productionLock({ role, visual, aspectRatio, continuityText, index = 0, count = 1 }) {
  return [
    `Short-form ${aspectRatio} video, ${role} scene.`,
    roleProductionSpec(role, index, count),
    visual,
    'Lighting lock: use one identifiable key-light direction and exposure logic; preserve that lighting world across connected shots unless the story explicitly motivates a change.',
    `Continuity lock: ${continuityText}.`,
    'Motion lock: natural subject motion, stable geometry, physically plausible timing, and only one primary camera movement per shot.',
    'Composition lock: one clear focal subject, mobile-readable silhouette, foreground/background separation, and intentional negative space only where useful.',
    'Negative constraints: no identity drift, no wardrobe or product-color drift, no unrelated people, no random logos, no extra text overlays unless requested, no warped hands/faces, no duplicate objects, no geometry mutations, no unexplained environment reset, no sudden style or palette change.',
  ].join(' ');
}

function generatorPrompt({ role, visual, aspectRatio, continuityText, index = 0, count = 1 }) {
  return productionLock({ role, visual, aspectRatio, continuityText, index, count });
}

function roleCameraClause(role) {
  if (role === 'hook') return 'Camera: begin on a tight macro or close-medium frame and use one controlled push-in, snap reveal, or short motivated track during the first 1-2 seconds.';
  if (role === 'payoff') return 'Camera: settle into a stable medium, product-hero, or clean detail frame with a subtle pull-back or focus settle.';
  if (role === 'proof') return 'Camera: use a deliberate detail-to-context move, short lateral track, or focus pull tied to the subject action.';
  return 'Camera: start at a readable medium or close-medium frame, then pan, track, or push toward the exact action with one physically motivated move.';
}

function roleProgressionClause(role) {
  if (role === 'hook') return 'Progression: open in medias res on the most distinctive problem, action, or product detail and end on a visible change that motivates the next cut.';
  if (role === 'payoff') return 'Progression: show a visibly resolved end state that contrasts with the opening composition instead of repeating it.';
  if (role === 'proof') return 'Progression: reveal one new observable detail or consequence that has not appeared in earlier scenes.';
  return 'Progression: show one concrete interaction, transformation, or observable state change that moves the story toward the payoff.';
}

function enrichGenerationPrompt(rawPrompt, {
  role,
  visual,
  aspectRatio,
  continuityText,
}) {
  let text = cleanText(rawPrompt, 4000);
  const additions = [];

  if (text.length < 80) {
    additions.push(`Short-form ${aspectRatio} ${role} scene. ${visual}`);
  }
  if (!/camera|shot|frame|close[- ]?up|wide|medium|macro|push|pull|pan|tilt|orbit|dolly|track/i.test(text)) {
    additions.push(roleCameraClause(role));
  }
  if (!/light|lighting|shadow|exposure|backlit|softbox|sun|neon|practical/i.test(text)) {
    additions.push('Lighting: use a clear, coherent key-light direction and exposure logic that matches connected scenes.');
  }
  if (!/progression|transform|change|reveal|action|interaction|payoff|before|after|resolve/i.test(text)) {
    additions.push(roleProgressionClause(role));
  }
  if (!/continuity|same (?:person|product|subject|wardrobe|environment)|identity|palette|styling/i.test(text)) {
    additions.push(`Continuity: ${continuityText}.`);
  }
  if (!/negative constraints:|avoid:|no identity drift|no random logos|no extra text/i.test(text)) {
    additions.push('Negative constraints: no identity drift, no wardrobe or product-color drift, no unrelated people, no random logos, no extra text overlays unless requested, no warped anatomy, no duplicate objects, no geometry mutations, no unexplained environment reset, no sudden style or palette change.');
  }

  text = [text, ...additions].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 4000);
}

export function normalizeCampaignManifest(candidate, {
  request = {},
  previousCampaign = null,
  isRevision = false,
} = {}) {
  const source = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? clone(candidate)
    : {};
  const previous = previousCampaign && typeof previousCampaign === 'object' ? previousCampaign : null;
  const constraints = request.constraints || {};
  const brief = request.enrichedBrief || request.rawBrief || 'A polished short-form video.';

  const platform = normalizePlatform(
    source.platform,
    constraints.platform || previous?.platform || 'General',
  );
  const aspectRatio = normalizeAspect(
    source.aspectRatio,
    constraints.aspectRatio || previous?.aspectRatio || '9:16',
  );
  const durationSeconds = normalizeDuration(
    source.durationSeconds,
    constraints.durationSeconds || previous?.durationSeconds || 15,
  );

  let scenes = Array.isArray(source.scenes)
    ? source.scenes.filter((scene) => scene && typeof scene === 'object').slice(0, 20)
    : [];

  if (!scenes.length) {
    const count = sceneCountForDuration(durationSeconds);
    scenes = Array.from({ length: count }, () => ({}));
  }

  const durations = allocateDurations(scenes, durationSeconds);
  const continuityLead = cleanText(
    source?.continuity?.leadCharacter ?? previous?.continuity?.leadCharacter,
    800,
  );
  const continuityText = continuityLead
    || 'preserve any recurring person, product, wardrobe, props, palette, environment, and visual style exactly across scenes';

  scenes = scenes.map((scene, index) => {
    const role = defaultSceneRole(index, scenes.length);
    const baseVisual = cleanText(scene.visualDirection, 1800)
      || defaultVisual(role, brief);
    const roleCue = roleProductionSpec(role, index, scenes.length);
    const visualDirection = /scene function:|opening hook|payoff\/end state|development\/demo beat|proof\/detail beat/i.test(baseVisual)
      ? baseVisual
      : `${baseVisual} ${roleCue}`.slice(0, 1800);

    const rawGenerationPrompt = cleanText(scene.generationPrompt, 4000);
    const enrichedGenerationPrompt = enrichGenerationPrompt(rawGenerationPrompt, {
      role,
      visual: visualDirection,
      aspectRatio,
      continuityText,
    });

    return {
      id: index + 1,
      durationSeconds: durations[index],
      visualDirection,
      voiceover: safeVoiceover(scene.voiceover, role, durations[index]),
      generationPrompt: enrichedGenerationPrompt,
    };
  });

  const seenPrompts = new Set();
  scenes = scenes.map((scene, index) => {
    const key = scene.generationPrompt.trim().toLowerCase();
    if (!seenPrompts.has(key)) {
      seenPrompts.add(key);
      return scene;
    }
    const role = defaultSceneRole(index, scenes.length);
    const generationPrompt = `${scene.generationPrompt} Scene-specific beat: ${role}; make the action and composition visibly distinct from the preceding scene while preserving continuity.`.slice(0, 4000);
    seenPrompts.add(generationPrompt.toLowerCase());
    return { ...scene, generationPrompt };
  });

  return {
    summary: cleanText(source.summary, 1200)
      || `A ${durationSeconds}-second ${platform} short-form concept built from the supplied creative direction.`,
    audience: cleanText(source.audience, 800)
      || constraints.audience
      || cleanText(previous?.audience, 800)
      || 'Broad mobile-first audience',
    platform,
    aspectRatio,
    durationSeconds,
    continuity: {
      leadCharacter: continuityLead || null,
      locked: true,
    },
    scenes,
    changeSummary: cleanText(source.changeSummary, 1200)
      || (isRevision
        ? 'Applied the requested revision while preserving unrelated production decisions.'
        : 'Created a production-ready campaign with conservative defaults where the brief was silent.'),
  };
}

export function buildDeterministicFallbackCampaign({ request, previousCampaign = null, isRevision = false }) {
  if (isRevision && previousCampaign) {
    return normalizeCampaignManifest({
      ...clone(previousCampaign),
      changeSummary: 'Preserved the existing campaign because the model path was unavailable; structural production safeguards were re-applied.',
    }, { request, previousCampaign, isRevision: true });
  }

  return normalizeCampaignManifest({}, { request, previousCampaign, isRevision });
}

export function buildDirectorRepairPrompt({ originalMessage, candidate, qa, creativeCritic = null, previousCampaign }) {
  return [
    'Repair the campaign manifest below. Return ONLY the full corrected JSON manifest.',
    'Do not explain the repair.',
    'Preserve valid creative decisions unless a listed QA issue requires a change.',
    'Resolve every blocking QA issue and as many warnings as possible.',
    'Scene durations must sum exactly to campaign duration.',
    'Every scene needs a concrete visualDirection, concise voiceover, and detailed generationPrompt.',
    'Keep recurring identity/product/wardrobe/style continuity locked.',
    '',
    'ORIGINAL REQUEST:',
    cleanText(originalMessage, 6000),
    '',
    'PREVIOUS CAMPAIGN STATE:',
    JSON.stringify(previousCampaign || null),
    '',
    'CANDIDATE MANIFEST:',
    JSON.stringify(candidate || null),
    '',
    'AUTOMATED QA:',
    JSON.stringify(qa || null),
    '',
    'CREATIVE CRITIC:',
    JSON.stringify(creativeCritic || null),
  ].join('\n');
}


const CRITIC_DIMENSIONS = [
  'briefFit',
  'hookStrength',
  'visualSpecificity',
  'progression',
  'generationReadiness',
  'continuity',
  'claimRestraint',
];

function clampScore(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function normalizeCreativeCritique(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const dimensions = {};
  for (const key of CRITIC_DIMENSIONS) {
    dimensions[key] = clampScore(value?.dimensions?.[key], 0);
  }

  const blockingIssues = Array.isArray(value.blockingIssues)
    ? value.blockingIssues.map((item) => cleanText(item, 500)).filter(Boolean).slice(0, 10)
    : [];
  const improvements = Array.isArray(value.improvements)
    ? value.improvements.map((item) => cleanText(item, 500)).filter(Boolean).slice(0, 10)
    : [];

  const dimensionValues = Object.values(dimensions);
  const dimensionAverage = Math.round(
    dimensionValues.reduce((sum, score) => sum + score, 0) / Math.max(1, dimensionValues.length),
  );
  const declared = clampScore(value.score, dimensionAverage);
  const score = Math.min(declared, Math.max(0, dimensionAverage + 8));

  const dimensionFloors = {
    briefFit: 82,
    hookStrength: 78,
    visualSpecificity: 80,
    progression: 78,
    generationReadiness: 82,
    continuity: 82,
    claimRestraint: 90,
  };
  const weakDimensions = Object.entries(dimensionFloors)
    .filter(([key, floor]) => dimensions[key] < floor)
    .map(([key]) => key);

  return {
    score,
    dimensions,
    blockingIssues,
    improvements,
    weakDimensions,
    passed: score >= 85 && blockingIssues.length === 0 && weakDimensions.length === 0,
  };
}

export function critiqueNeedsRepair(critique) {
  return !critique || critique.passed !== true;
}


function explicitRevisionTargets(instruction, sceneCount) {
  const text = cleanText(instruction, 6000).toLowerCase();
  if (!text || sceneCount <= 0) return null;

  const targets = new Set();
  const sceneWord = '(?:scene|sceen|scne|scean|scen)';
  const numberedPattern = new RegExp('\\b' + sceneWord + '\\s*(\\d{1,2})\\b', 'g');
  const numbered = [...text.matchAll(numberedPattern)];
  for (const match of numbered) {
    const number = Number(match[1]);
    if (number >= 1 && number <= sceneCount) targets.add(number);
  }

  const firstPattern = new RegExp('\\b(first|opening|intro)\\s+' + sceneWord + '\\b|\\b' + sceneWord + '\\s+one\\b');
  const lastPattern = new RegExp('\\b(last|final|ending|end)\\s+' + sceneWord + '\\b|\\b' + sceneWord + '\\s+(?:last|final)\\b');
  if (firstPattern.test(text)) targets.add(1);
  if (lastPattern.test(text)) targets.add(sceneCount);

  const onlyLanguage = /\bonly\b|\bjust\b|\bpreserv\w*\b|\bkeep\b|\bkeap\b|\bunchang\w*\b|\beverything\s+else\b|\bevryth?ng\s+els\w*\b|\b(?:keep|keap)[^.!?]{0,80}\bsame\b|\bdon['’]?t\s+change\b/.test(text);
  if (!targets.size || !onlyLanguage) return null;
  return targets;
}

export function applyRevisionPreservation(candidate, previousCampaign, instruction) {
  if (!candidate || typeof candidate !== 'object' || !previousCampaign || typeof previousCampaign !== 'object') {
    return candidate;
  }

  const previousScenes = Array.isArray(previousCampaign.scenes) ? previousCampaign.scenes : [];
  const candidateScenes = Array.isArray(candidate.scenes) ? candidate.scenes : [];
  if (!previousScenes.length || candidateScenes.length !== previousScenes.length) return candidate;

  const targets = explicitRevisionTargets(instruction, previousScenes.length);
  if (!targets) return candidate;

  const next = clone(candidate);
  next.scenes = candidateScenes.map((scene, index) => {
    const sceneNumber = index + 1;
    return targets.has(sceneNumber) ? scene : clone(previousScenes[index]);
  });

  const text = cleanText(instruction, 6000).toLowerCase();
  if (!/\b(duration|seconds?|length|runtime)\b/.test(text)) {
    next.durationSeconds = previousCampaign.durationSeconds;
  }
  if (!/\b(platform|tiktok|reels?|youtube|shorts?)\b/.test(text)) {
    next.platform = previousCampaign.platform;
  }
  if (!/\b(aspect|9:16|16:9|1:1|vertical|horizontal|square)\b/.test(text)) {
    next.aspectRatio = previousCampaign.aspectRatio;
  }
  if (!/\b(audience|target|viewer|customer)\b/.test(text)) {
    next.audience = previousCampaign.audience;
  }
  if (!/\b(character|actor|person|wardrobe|outfit|continuity)\b/.test(text)) {
    next.continuity = clone(previousCampaign.continuity);
  }

  next.changeSummary = cleanText(candidate.changeSummary, 1200)
    || 'Applied the requested scoped revision while preserving unrelated campaign decisions.';
  return next;
}


export function normalizeBriefEnrichment(value, request = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const subject = cleanText(value.subject, 500)
    || (request?.rawBrief && !looksLikeNoise(request.rawBrief) ? cleanText(request.rawBrief, 500) : '')
    || 'a fictional focus timer app';
  const objective = cleanText(value.objective, 500)
    || 'create a clear short-form story with an immediate visual hook and a memorable payoff';
  const audience = cleanText(value.audience, 500)
    || request?.constraints?.audience
    || 'broad mobile-first audience';
  const hook = cleanText(value.hook, 700)
    || `Open immediately on the most visually distinctive state of ${subject}, framed close enough to understand within two seconds.`;

  let beats = Array.isArray(value.beats)
    ? value.beats.map((item) => cleanText(item, 700)).filter(Boolean).slice(0, 5)
    : [];
  if (beats.length < 3) {
    beats = [
      hook,
      `Show a concrete action, use case, transformation, or observable change involving ${subject}; make this visually distinct from the opening.`,
      `Resolve on a clean hero/payoff frame for ${subject} with a neutral next step and no unsupported claims.`,
    ];
  }

  const visualStyle = cleanText(value.visualStyle, 700)
    || 'realistic mobile-first commercial imagery with purposeful framing, restrained lighting, clear focal separation, and physically plausible motion';
  const continuity = cleanText(value.continuity, 700)
    || (/focus timer/i.test(subject)
      ? 'use the same dark smartphone, same desk environment, teal interface accent, restrained charcoal-and-warm-neutral palette, and soft left-side window light across connected shots'
      : 'preserve recurring subject/product identity, exact product or wardrobe colors, props, environment, palette, lighting direction, and styling across connected shots');
  const cta = cleanText(value.cta, 300) || null;
  const claimBoundaries = Array.isArray(value.claimBoundaries)
    ? value.claimBoundaries.map((item) => cleanText(item, 400)).filter(Boolean).slice(0, 8)
    : [];

  const constraints = request?.constraints || {};
  const resolvedBrief = [
    `SUBJECT: ${subject}`,
    `OBJECTIVE: ${objective}`,
    `AUDIENCE: ${audience}`,
    `VISUAL HOOK: ${hook}`,
    'STORY BEATS:',
    ...beats.map((beat, index) => `${index + 1}. ${beat}`),
    `VISUAL STYLE: ${visualStyle}`,
    `CONTINUITY: ${continuity}`,
    cta ? `CTA: ${cta}` : 'CTA: use a neutral, non-claiming end-frame next step only if appropriate',
    claimBoundaries.length
      ? `CLAIM BOUNDARIES: ${claimBoundaries.join('; ')}`
      : 'CLAIM BOUNDARIES: do not invent measurable, medical, financial, legal, scientific, comparative, guarantee, award, review, or endorsement claims',
    Object.keys(constraints).length
      ? `AUTHORITATIVE CONSTRAINTS: ${JSON.stringify(constraints)}`
      : '',
  ].filter(Boolean).join('\n');

  return {
    subject,
    objective,
    audience,
    hook,
    beats,
    visualStyle,
    continuity,
    cta,
    claimBoundaries,
    resolvedBrief,
  };
}


function voiceoverForRole(role, subject, cta) {
  const cleanSubject = cleanText(subject, 120).replace(/^(a|an|the)\s+/i, '');
  if (role === 'hook') return `See ${cleanSubject} in action.`;
  if (role === 'payoff') return cleanText(cta, 120) || 'See the next step clearly.';
  if (role === 'proof') return 'Notice the detail that changes the result.';
  return 'Watch the change happen.';
}

function deterministicBeatVisual({
  role,
  beat,
  subject,
  visualStyle,
  continuity,
}) {
  const roleSpecific = role === 'hook'
    ? 'Open on the most visually distinctive state immediately; do not spend time establishing the location.'
    : role === 'payoff'
      ? 'Show the resolved end state in a cleaner composition that visibly contrasts with the opening.'
      : role === 'proof'
        ? 'Reveal one new observable detail that has not appeared in the prior beat.'
        : 'Show one concrete interaction or state change that moves the story forward.';

  return [
    `Subject: ${subject}.`,
    `Beat: ${beat}.`,
    roleSpecific,
    `Visual style: ${visualStyle}.`,
    `Continuity anchors: ${continuity}.`,
  ].join(' ');
}

export function buildGuaranteedCampaign({
  request = {},
  briefEnrichment = null,
  previousCampaign = null,
  isRevision = false,
} = {}) {
  if (isRevision && previousCampaign) {
    const preserved = clone(previousCampaign);
    preserved.changeSummary = 'Returned the last validated campaign because the requested revision could not be improved without dropping below the production quality floor.';
    return preserved;
  }

  const constraints = request.constraints || {};
  const enrichment = briefEnrichment || normalizeBriefEnrichment({}, request) || {};
  const subject = cleanText(enrichment.subject, 500) || 'a fictional focus timer app';
  const visualStyle = cleanText(enrichment.visualStyle, 700)
    || 'realistic mobile-first commercial imagery, restrained lighting, clean focal separation, physically plausible motion';
  const continuity = cleanText(enrichment.continuity, 700)
    || 'preserve the same subject or product, exact colors, environment, palette, props, and lighting direction across connected shots';
  const hook = cleanText(enrichment.hook, 700)
    || `Open immediately on the most visually distinctive state of ${subject}.`;
  const sourceBeats = Array.isArray(enrichment.beats)
    ? enrichment.beats.map((beat) => cleanText(beat, 700)).filter(Boolean)
    : [];

  const durationSeconds = normalizeDuration(constraints.durationSeconds, 15);
  const count = sceneCountForDuration(durationSeconds);
  const beats = [];
  for (let index = 0; index < count; index += 1) {
    if (index === 0) beats.push(hook);
    else if (index === count - 1) {
      beats.push(
        sourceBeats[sourceBeats.length - 1]
        || `Resolve on a clean hero/payoff frame for ${subject} with a neutral next step and no unsupported claims.`,
      );
    } else {
      const sourceIndex = Math.min(index, Math.max(0, sourceBeats.length - 2));
      beats.push(
        sourceBeats[sourceIndex]
        || `Show a concrete interaction, transformation, or observable state change involving ${subject}.`,
      );
    }
  }

  const rawScenes = Array.from({ length: count }, () => ({}));
  const durations = allocateDurations(rawScenes, durationSeconds);
  const aspectRatio = normalizeAspect(constraints.aspectRatio, '9:16');

  const scenes = beats.map((beat, index) => {
    const role = defaultSceneRole(index, count);
    const visualDirection = deterministicBeatVisual({
      role,
      beat,
      subject,
      visualStyle,
      continuity,
    });
    const generationPrompt = productionLock({
      role,
      visual: visualDirection,
      aspectRatio,
      continuityText: continuity,
      index,
      count,
    });

    return {
      id: index + 1,
      durationSeconds: durations[index],
      visualDirection,
      voiceover: safeVoiceover(
        voiceoverForRole(role, subject, enrichment.cta),
        role,
        durations[index],
      ),
      generationPrompt,
    };
  });

  return normalizeCampaignManifest({
    summary: `A production-safe ${durationSeconds}-second short-form concept for ${subject}, using a strong opening hook, visible progression, and clean payoff.`,
    audience: cleanText(enrichment.audience, 500)
      || constraints.audience
      || 'Broad mobile-first audience',
    platform: normalizePlatform(constraints.platform, 'General'),
    aspectRatio,
    durationSeconds,
    continuity: {
      leadCharacter: null,
      locked: true,
    },
    scenes,
    changeSummary: 'Used ForgeDirector guaranteed-safe production blueprint after model candidates did not meet the quality floor.',
  }, { request, previousCampaign, isRevision: false });
}

export function assessGuaranteedCampaign(campaign) {
  const scenes = Array.isArray(campaign?.scenes) ? campaign.scenes : [];
  const checks = {
    hasScenes: scenes.length >= 2 && scenes.length <= 20,
    durationValid: Number(campaign?.durationSeconds) >= 5
      && Math.abs(
        scenes.reduce((sum, scene) => sum + Number(scene?.durationSeconds || 0), 0)
        - Number(campaign?.durationSeconds || 0)
      ) <= 0.01,
    continuityLocked: campaign?.continuity?.locked === true,
    distinctVisuals: new Set(
      scenes.map((scene) => normalizeMatchForQuality(scene?.visualDirection)),
    ).size === scenes.length,
    generationReady: scenes.every((scene) => {
      const prompt = String(scene?.generationPrompt || '');
      return prompt.length >= 300
        && /camera path:|camera:/i.test(prompt)
        && /lighting lock:|lighting:/i.test(prompt)
        && /continuity lock:|continuity:/i.test(prompt)
        && /progression cue:|progression:/i.test(prompt)
        && /negative constraints:/i.test(prompt);
    }),
    sceneRoles: scenes.every((scene, index) => {
      const role = defaultSceneRole(index, scenes.length);
      const text = `${scene?.visualDirection || ''} ${scene?.generationPrompt || ''}`.toLowerCase();
      if (role === 'hook') return /hook|opening|first frame|in medias res/.test(text);
      if (role === 'payoff') return /payoff|resolved|end state|hero/.test(text);
      return /development|proof|interaction|state change|new observable detail/.test(text);
    }),
  };

  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    method: 'deterministic-production-blueprint-v1',
  };
}

function normalizeMatchForQuality(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
