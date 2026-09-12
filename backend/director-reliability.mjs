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
  if (rawBrief && rawBrief.length < 12) issues.push('very_short_brief');
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

function safeVoiceover(value, role) {
  const text = cleanText(value, 500);
  if (text) return text;
  if (role === 'hook') return 'Start with what matters.';
  if (role === 'payoff') return 'Make the next step clear.';
  return 'Keep the story moving.';
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

function generatorPrompt({ role, visual, aspectRatio, continuityText }) {
  return [
    `Short-form ${aspectRatio} video, ${role} scene.`,
    visual,
    'Camera: specify a deliberate framing and motivated movement; avoid random zooms or unmotivated cuts.',
    'Lighting: realistic, coherent direction and exposure; preserve the same lighting world across connected scenes.',
    `Continuity: ${continuityText}`,
    'Motion: natural subject and camera motion with physically plausible timing.',
    'Composition: one clear focal subject, mobile-readable silhouette, uncluttered background separation.',
    'Avoid: identity drift, wardrobe/color changes, warped hands/faces, illegible text, duplicate objects, sudden style changes, unnecessary logos.',
  ].join(' ');
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
  const brief = request.rawBrief || request.enrichedBrief || 'A polished short-form video.';

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
    const visualDirection = cleanText(scene.visualDirection, 1800)
      || defaultVisual(role, brief);
    const generationPrompt = cleanText(scene.generationPrompt, 4000)
      || generatorPrompt({ role, visual: visualDirection, aspectRatio, continuityText });

    const enrichedGenerationPrompt = generationPrompt.length < 120
      ? `${generationPrompt} ${generatorPrompt({ role, visual: visualDirection, aspectRatio, continuityText })}`
      : generationPrompt;

    return {
      id: index + 1,
      durationSeconds: durations[index],
      visualDirection,
      voiceover: safeVoiceover(scene.voiceover, role),
      generationPrompt: enrichedGenerationPrompt.slice(0, 4000),
    };
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

export function buildDirectorRepairPrompt({ originalMessage, candidate, qa, previousCampaign }) {
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
  ].join('\n');
}
