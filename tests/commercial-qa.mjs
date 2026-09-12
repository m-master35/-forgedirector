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
      generationPrompt: 'Vertical 9:16 premium commercial, tight medium close-up of the same lead at a desk, slow controlled push-in camera movement, soft directional key light with realistic shadows, natural hand motion, shallow depth of field, uncluttered background, preserve wardrobe and facial identity exactly across scenes.',
    },
    {
      id: 2,
      durationSeconds: 5,
      visualDirection: 'Hero product reveal in the same lighting world.',
      voiceover: 'Keep the routine simple.',
      generationPrompt: 'Vertical 9:16 product hero scene, macro-to-medium camera move revealing the product on the same desk, preserve the previous scene lighting direction and exposure, realistic hand interaction, crisp focal separation, stable product geometry and label placement, maintain the same visual palette and continuity.',
    },
    {
      id: 3,
      durationSeconds: 5,
      visualDirection: 'Clean end frame with negative space for CTA.',
      voiceover: 'Finish with less friction.',
      generationPrompt: 'Minimal vertical 9:16 end frame, locked-off medium product composition with subtle settling motion, same realistic soft directional lighting and palette, clean negative space for CTA copy, preserve product shape and label, no extra objects, no sudden style or color changes.',
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
