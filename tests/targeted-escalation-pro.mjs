import assert from 'node:assert/strict';
import {
  TARGETED_PRO_PROMPT_VERSION,
  buildTargetedProPrompt,
  normalizeTargetedProResult,
  parseTargetedProJson,
} from '../backend/targeted-escalation-pro.mjs';

const expectedFindings = [
  {
    sourceFindingId: 'compliance:mustNotShow:0',
    defectType: 'forbidden_content_presence',
    escalationReason: 'Competitor logo is visible.',
    metadata: {
      requirementType: 'mustNotShow',
      rule: 'Competitor logo',
    },
  },
  {
    sourceFindingId: 'timeline:2:issue:0',
    defectType: 'localized_visual_artifact',
    escalationReason: 'Geometry warps.',
    metadata: {},
  },
];

const segment = {
  sourceStartSeconds: 200,
  sourceEndSeconds: 215,
  actualSourceStartSeconds: 200,
  actualSourceEndSeconds: 215,
  outputDurationSeconds: 15,
};

const prompt = buildTargetedProPrompt({
  segment,
  findings: expectedFindings,
});

assert.match(prompt, /SOURCE WINDOW: 200-215 seconds/);
assert.match(prompt, /UNTRUSTED_CANDIDATE_DATA/);
assert.match(prompt, /compliance:mustNotShow:0/);
assert.match(prompt, /Return exactly one verdict/);
assert.match(prompt, new RegExp(TARGETED_PRO_PROMPT_VERSION));

assert.deepEqual(parseTargetedProJson('{"findings":[]}'), { findings: [] });
assert.deepEqual(parseTargetedProJson('```json\n{"findings":[]}\n```'), { findings: [] });
assert.equal(parseTargetedProJson('not json'), null);

const normalized = normalizeTargetedProResult({
  findings: [
    {
      sourceFindingId: 'compliance:mustNotShow:0',
      defectType: 'forbidden_content_presence',
      status: 'confirmed',
      confidence: 'high',
      evidence: 'Competitor logo is visible in the center.',
      startSeconds: 7,
      endSeconds: 8,
      contextRequired: false,
    },
    {
      sourceFindingId: 'timeline:2:issue:0',
      defectType: 'localized_visual_artifact',
      status: 'uncertain',
      confidence: 'medium',
      evidence: 'Comparison with an earlier frame is needed.',
      startSeconds: 4,
      endSeconds: 5,
      contextRequired: true,
    },
    {
      sourceFindingId: 'invented-id',
      defectType: 'localized_visual_artifact',
      status: 'confirmed',
      confidence: 'high',
      evidence: 'Should be ignored.',
      startSeconds: 1,
      endSeconds: 2,
    },
  ],
  limitations: ['Only this segment was inspected.'],
}, {
  expectedFindings,
  segment,
});

assert.equal(normalized.promptVersion, TARGETED_PRO_PROMPT_VERSION);
assert.equal(normalized.findings.length, 2);
assert.equal(normalized.findings[0].status, 'confirmed');
assert.equal(normalized.findings[0].startSeconds, 207);
assert.equal(normalized.findings[0].endSeconds, 208);
assert.equal(normalized.findings[0].segmentLocalStartSeconds, 7);
assert.equal(normalized.findings[1].contextRequired, true);
assert.deepEqual(normalized.limitations, ['Only this segment was inspected.']);

const missingVerdict = normalizeTargetedProResult({
  findings: [],
}, {
  expectedFindings: [expectedFindings[0]],
  segment,
});
assert.equal(missingVerdict.findings[0].status, 'uncertain');
assert.equal(missingVerdict.findings[0].contextRequired, true);

const clamped = normalizeTargetedProResult({
  findings: [{
    sourceFindingId: 'compliance:mustNotShow:0',
    status: 'confirmed',
    confidence: 'high',
    evidence: 'Observed.',
    startSeconds: -5,
    endSeconds: 99,
  }],
}, {
  expectedFindings: [expectedFindings[0]],
  segment,
});
assert.equal(clamped.findings[0].segmentLocalStartSeconds, 0);
assert.equal(clamped.findings[0].segmentLocalEndSeconds, 15);
assert.equal(clamped.findings[0].startSeconds, 200);
assert.equal(clamped.findings[0].endSeconds, 215);

console.log('Targeted Nova Pro contract tests passed');
