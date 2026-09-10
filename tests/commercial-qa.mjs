import assert from 'node:assert/strict';
import { evaluateCampaign } from '../backend/qa.mjs';

const healthy = {
  summary: 'A focused 15-second vertical campaign.',
  audience: 'Young professionals',
  platform: 'TikTok',
  aspectRatio: '9:16',
  durationSeconds: 15,
  continuity: { leadCharacter: 'One consistent lead', locked: true },
  scenes: [
    {
      id: 1,
      durationSeconds: 5,
      visualDirection: 'Close, controlled opening shot with motivated camera movement.',
      voiceover: 'Busy days need simple rituals.',
      generationPrompt: 'Vertical premium commercial, controlled lighting, realistic subject, consistent wardrobe, close camera movement.',
    },
    {
      id: 2,
      durationSeconds: 5,
      visualDirection: 'Hero product reveal in the same lighting world.',
      voiceover: 'Keep the routine simple.',
      generationPrompt: 'Vertical product hero shot, same lighting, premium macro detail, continuity preserved across the campaign.',
    },
    {
      id: 3,
      durationSeconds: 5,
      visualDirection: 'Clean end frame with negative space for CTA.',
      voiceover: 'Finish with less friction.',
      generationPrompt: 'Minimal vertical product end frame, clean composition, premium realistic lighting, negative space for CTA.',
    },
  ],
  changeSummary: 'Initial campaign created.',
};

const healthyResult = evaluateCampaign(healthy);
assert.equal(healthyResult.passed, true);
assert.equal(healthyResult.score, 100);
assert.equal(healthyResult.issues.length, 0);

const broken = structuredClone(healthy);
broken.durationSeconds = 20;
broken.continuity.locked = false;
broken.scenes[0].voiceover = 'This sentence contains far too many spoken words for a five second shot and should trigger the density warning automatically.';

const brokenResult = evaluateCampaign(broken);
assert.equal(brokenResult.passed, false);
assert.ok(brokenResult.score < 100);
assert.ok(brokenResult.issues.some((issue) => issue.code === 'DURATION_MISMATCH'));
assert.ok(brokenResult.issues.some((issue) => issue.code === 'CONTINUITY_UNLOCKED'));
assert.ok(brokenResult.issues.some((issue) => issue.code === 'VOICEOVER_DENSITY'));

console.log('Commercial QA tests passed');
