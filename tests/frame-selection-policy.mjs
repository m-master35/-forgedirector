import assert from 'node:assert/strict';
import {
  FRAME_SELECTION_POLICY_VERSION,
  DEFECT_SELECTION_POLICY,
  buildFrameSelectionTasks,
  summarizeFrameSelectionTasks,
  sharedFrameSetStrategy,
} from '../backend/frame-selection-policy.mjs';

assert.equal(DEFECT_SELECTION_POLICY.required_object.strategy, 'focus');
assert.equal(DEFECT_SELECTION_POLICY.forbidden_object.strategy, 'hybrid');
assert.equal(DEFECT_SELECTION_POLICY.pacing.strategy, 'uniform');
assert.equal(DEFECT_SELECTION_POLICY.scene_transition.strategy, 'uniform');

{
  const tasks = buildFrameSelectionTasks({
    requirements: {
      mustShow: ['motorcycle'],
      mustNotShow: ['wine bottle'],
      mustIncludeText: ['START FREE'],
      continuityRules: ['lead keeps the same shirt color'],
      ctaRequired: true,
    },
    transcript: 'A short narration.',
    includeGeneralAnalysis: false,
  });

  assert.equal(tasks.length, 5);
  assert.equal(tasks.every((item) => item.policyVersion === FRAME_SELECTION_POLICY_VERSION), true);

  const mustShow = tasks.find((item) => item.source === 'mustShow');
  assert.equal(mustShow.strategy, 'focus');
  assert.equal(mustShow.coverageFloor, false);
  assert.match(mustShow.query, /motorcycle/);

  const mustNotShow = tasks.find((item) => item.source === 'mustNotShow');
  assert.equal(mustNotShow.strategy, 'hybrid');
  assert.equal(mustNotShow.coverageFloor, true);
  assert.match(mustNotShow.query, /wine bottle/);

  const requiredText = tasks.find((item) => item.source === 'mustIncludeText');
  assert.equal(requiredText.strategy, 'hybrid');
  assert.match(requiredText.query, /START FREE/);

  const continuity = tasks.find((item) => item.source === 'continuityRule');
  assert.equal(continuity.strategy, 'hybrid');

  const cta = tasks.find((item) => item.source === 'ctaRequired');
  assert.equal(cta.strategy, 'hybrid');

  const summary = summarizeFrameSelectionTasks(tasks);
  assert.equal(summary.total, 5);
  assert.deepEqual(summary.byStrategy, { uniform: 0, focus: 1, hybrid: 4 });
  assert.equal(summary.requiresGlobalCoverage, true);
  assert.equal(sharedFrameSetStrategy(tasks), 'hybrid');
}

{
  const tasks = buildFrameSelectionTasks({
    requirements: {
      mustShow: ['product'],
      mustShowExtra: ['ignored'],
    },
    includeGeneralAnalysis: true,
  });

  const summary = summarizeFrameSelectionTasks(tasks);
  assert.equal(summary.byStrategy.uniform, 6);
  assert.ok(summary.byStrategy.hybrid >= 6);
  assert.equal(summary.byStrategy.focus, 1);
  assert.equal(sharedFrameSetStrategy(tasks), 'uniform');
}

{
  const tasks = buildFrameSelectionTasks({
    transcript: 'Narration exists.',
    includeGeneralAnalysis: true,
  });
  assert.ok(tasks.some((item) => item.defectCategory === 'narration_visual_mismatch'));
  assert.equal(sharedFrameSetStrategy(tasks), 'uniform');
}

{
  const tasks = buildFrameSelectionTasks({
    transcript: '',
    includeGeneralAnalysis: false,
    requirements: { mustShow: ['brand logo'] },
  });
  assert.equal(tasks.length, 1);
  assert.equal(sharedFrameSetStrategy(tasks), 'focus');
}

{
  const tasks = buildFrameSelectionTasks({
    requirements: {
      mustShow: ['   product\nlogo   '],
      mustNotShow: [null, '', 'RIVAL'],
      mustIncludeText: 'not-an-array',
    },
    includeGeneralAnalysis: false,
  });
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].rule, 'product logo');
  assert.equal(tasks[1].rule, 'RIVAL');
}

{
  const tasks = buildFrameSelectionTasks({
    requirements: null,
    includeGeneralAnalysis: false,
  });
  assert.deepEqual(tasks, []);
  assert.equal(sharedFrameSetStrategy(tasks), 'uniform');
}

console.log('frame-selection policy tests passed');
