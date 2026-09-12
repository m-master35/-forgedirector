const REQUIRED_SCENE_FIELDS = ['visualDirection', 'voiceover', 'generationPrompt'];
const VALID_PLATFORMS = ['TikTok', 'Instagram Reels', 'YouTube Shorts', 'General'];
const VISUAL_DETAIL_GROUPS = [
  /camera|shot|frame|close[- ]?up|wide|medium|macro|push|pull|pan|tilt|orbit|dolly|tracking/i,
  /light|lighting|shadow|exposure|backlit|softbox|sun|neon|practical/i,
  /move|motion|walk|turn|reach|pour|open|reveal|enter|exit|action|transition/i,
];

function words(text = '') {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

export function evaluateCampaign(campaign) {
  const issues = [];
  const checks = [];

  if (!campaign || typeof campaign !== 'object') {
    return {
      score: 0,
      passed: false,
      checks: [],
      issues: [{ code: 'INVALID_CAMPAIGN', severity: 'error', message: 'Campaign must be a JSON object.' }],
    };
  }

  const scenes = Array.isArray(campaign.scenes) ? campaign.scenes : [];
  const duration = Number(campaign.durationSeconds || 0);
  const summedDuration = scenes.reduce((sum, scene) => sum + Number(scene?.durationSeconds || 0), 0);

  const hasSummary = String(campaign.summary || '').trim().length >= 12;
  checks.push({ name: 'campaign_summary', passed: hasSummary, detail: hasSummary ? 'Summary present' : 'Summary missing or too thin' });
  if (!hasSummary) issues.push({ code: 'THIN_SUMMARY', severity: 'warning', message: 'Campaign summary should clearly state the creative direction.' });

  const hasAudience = String(campaign.audience || '').trim().length >= 3;
  checks.push({ name: 'audience', passed: hasAudience, detail: String(campaign.audience || 'missing') });
  if (!hasAudience) issues.push({ code: 'MISSING_AUDIENCE', severity: 'warning', message: 'Campaign should identify an audience, even if broad.' });

  const validPlatform = VALID_PLATFORMS.includes(String(campaign.platform || ''));
  checks.push({ name: 'platform', passed: validPlatform, detail: String(campaign.platform || 'missing') });
  if (!validPlatform) issues.push({ code: 'PLATFORM', severity: 'warning', message: 'Use TikTok, Instagram Reels, YouTube Shorts, or General.' });

  const durationMatches = duration > 0 && duration === summedDuration;
  checks.push({ name: 'duration_integrity', passed: durationMatches, detail: `${summedDuration}s of ${duration || 0}s allocated` });
  if (!durationMatches) {
    issues.push({ code: 'DURATION_MISMATCH', severity: 'error', message: 'Scene durations must sum exactly to durationSeconds.' });
  }

  const hasScenes = scenes.length > 0;
  checks.push({ name: 'has_scenes', passed: hasScenes, detail: `${scenes.length} scene(s)` });
  if (!hasScenes) issues.push({ code: 'NO_SCENES', severity: 'error', message: 'Campaign contains no scenes.' });

  const ids = scenes.map((scene) => Number(scene?.id));
  const sequentialIds = ids.every((id, index) => Number.isInteger(id) && id === index + 1);
  checks.push({ name: 'scene_ids', passed: sequentialIds, detail: sequentialIds ? 'Sequential scene IDs' : 'Scene IDs should be 1..N' });
  if (!sequentialIds) issues.push({ code: 'SCENE_IDS', severity: 'warning', message: 'Scene IDs are not sequential.' });

  for (const scene of scenes) {
    const id = Number(scene?.id) || '?';
    for (const field of REQUIRED_SCENE_FIELDS) {
      if (!String(scene?.[field] || '').trim()) {
        issues.push({ code: 'MISSING_SCENE_FIELD', severity: 'error', sceneId: id, field, message: `Scene ${id} is missing ${field}.` });
      }
    }

    const sceneDuration = Number(scene?.durationSeconds || 0);
    if (!Number.isFinite(sceneDuration) || sceneDuration <= 0) {
      issues.push({ code: 'INVALID_SCENE_DURATION', severity: 'error', sceneId: id, message: `Scene ${id} must have a positive duration.` });
    }

    const wordCount = words(scene?.voiceover);
    const maxComfortableWords = Math.max(4, Math.floor(sceneDuration * 2.6));
    if (wordCount > maxComfortableWords) {
      issues.push({
        code: 'VOICEOVER_DENSITY',
        severity: 'warning',
        sceneId: id,
        message: `Scene ${id} has ${wordCount} voiceover words for ${sceneDuration}s; consider ${maxComfortableWords} or fewer.`,
      });
    }

    const generationPrompt = String(scene?.generationPrompt || '');
    if (generationPrompt.length < 120) {
      issues.push({ code: 'THIN_GENERATION_PROMPT', severity: 'warning', sceneId: id, message: `Scene ${id} generation prompt may be too vague for consistent generation.` });
    }

    const detailGroups = VISUAL_DETAIL_GROUPS.filter((pattern) => pattern.test(generationPrompt)).length;
    if (generationPrompt && detailGroups < 2) {
      issues.push({
        code: 'GENERATION_PROMPT_DETAIL',
        severity: 'warning',
        sceneId: id,
        message: `Scene ${id} generation prompt should specify more concrete camera, lighting, and motion direction.`,
      });
    }
  }

  if (scenes.length > 1) {
    const prompts = scenes.map((scene) => String(scene?.generationPrompt || '').trim().toLowerCase());
    const uniquePrompts = new Set(prompts.filter(Boolean));
    if (uniquePrompts.size < prompts.length) {
      issues.push({ code: 'DUPLICATE_SCENE_PROMPTS', severity: 'warning', message: 'Each scene should have distinct generation direction rather than duplicate prompts.' });
    }
  }

  const continuityLocked = Boolean(campaign?.continuity?.locked);
  checks.push({ name: 'continuity_lock', passed: continuityLocked, detail: continuityLocked ? 'Continuity locked' : 'Continuity not locked' });
  if (!continuityLocked) {
    issues.push({ code: 'CONTINUITY_UNLOCKED', severity: 'warning', message: 'Continuity is not locked; multi-scene identity/style drift is more likely.' });
  }

  const validAspect = ['9:16', '1:1', '16:9'].includes(String(campaign.aspectRatio || ''));
  checks.push({ name: 'aspect_ratio', passed: validAspect, detail: String(campaign.aspectRatio || 'missing') });
  if (!validAspect) issues.push({ code: 'ASPECT_RATIO', severity: 'warning', message: 'Use a supported aspectRatio: 9:16, 1:1, or 16:9.' });

  const verticalPlatform = ['TikTok', 'Instagram Reels', 'YouTube Shorts'].includes(String(campaign.platform || ''));
  if (verticalPlatform && campaign.aspectRatio !== '9:16') {
    issues.push({
      code: 'PLATFORM_ASPECT_MISMATCH',
      severity: 'warning',
      message: `${campaign.platform} is normally best served by 9:16 unless another aspect ratio is intentional.`,
    });
  }

  if (duration >= 10 && scenes.length < 2) {
    issues.push({
      code: 'LOW_SCENE_COVERAGE',
      severity: 'warning',
      message: 'Longer short-form videos usually benefit from more than one visual beat.',
    });
  }

  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;
  const score = Math.max(0, Math.min(100, 100 - errors * 20 - warnings * 5));

  return {
    score,
    passed: errors === 0,
    checks,
    issues,
    summary: errors === 0
      ? warnings === 0
        ? 'Production manifest passed all automated checks.'
        : `Production manifest passed with ${warnings} warning(s).`
      : `Production manifest has ${errors} blocking issue(s) and ${warnings} warning(s).`,
  };
}
