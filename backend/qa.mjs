const REQUIRED_SCENE_FIELDS = ['visualDirection', 'voiceover', 'generationPrompt'];

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

    if (String(scene?.generationPrompt || '').length < 45) {
      issues.push({ code: 'THIN_GENERATION_PROMPT', severity: 'warning', sceneId: id, message: `Scene ${id} generation prompt may be too vague for consistent generation.` });
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
