import assert from 'node:assert/strict';
import {
  assertAssetId,
  buildVideoAnalysisPrompt,
  normalizeVideoAnalysis,
  videoFormatFromContentType,
} from '../backend/video-intelligence.mjs';

assert.equal(videoFormatFromContentType('video/mp4'), 'mp4');
assert.equal(videoFormatFromContentType('video/quicktime'), 'mov');
assert.equal(videoFormatFromContentType('application/octet-stream'), null);

const id = '8f0f6a79-14c8-4cc9-9bde-272d25dd7070';
assert.equal(assertAssetId(id), id);

const prompt = buildVideoAnalysisPrompt({
  platform: 'TikTok',
  objective: 'conversion',
  audience: 'Young professionals',
  transcript: 'Sample transcript.',
  declaredDurationSeconds: 15,
});
assert.match(prompt, /TARGET PLATFORM: TikTok/);
assert.match(prompt, /OBJECTIVE: conversion/);

const normalized = normalizeVideoAnalysis({
  summary: 'A concise product ad.',
  scores: {
    hook: 80,
    pacing: 70,
    clarity: 90,
    visualQuality: 75,
    continuity: 100,
    cta: 60,
    platformFit: 85,
    conversionReadiness: 65,
  },
  timeline: [{ startSeconds: 0, endSeconds: 3 }],
  fixes: [{ priority: 1, action: 'Move the product reveal earlier.' }],
  regenerationPrompts: [],
});

assert.equal(normalized.analysisVersion, '1.2');
assert.equal(normalized.scoringVersion, 'fd-shortform-v3');
assert.equal(normalized.scoring.objective, 'engagement');
assert.equal(normalized.scores.overall, 79);
assert.equal(normalized.qualityGate.action, 'revise');
assert.equal(normalized.timeline.length, 1);

const reconciled = normalizeVideoAnalysis({
  scores: { hook: 10, pacing: 50, clarity: 50, visualQuality: 50, continuity: 10, cta: 10, platformFit: 10, conversionReadiness: 50 },
  hook: { verdict: 'weak' },
  continuity: { verdict: 'strong' },
  cta: { clarity: 'mixed' },
  platformAssessment: { fit: 'strong' },
});
assert.equal(reconciled.scores.continuity, 70);
assert.equal(reconciled.scores.platformFit, 70);
assert.equal(reconciled.scores.cta, 35);

const weak = normalizeVideoAnalysis({
  scores: {
    hook: 10,
    pacing: 20,
    clarity: 40,
    visualQuality: 25,
    continuity: 20,
    cta: 10,
    platformFit: 15,
    conversionReadiness: 10,
  },
  retentionRisks: [{ severity: 'high' }, { severity: 'high' }, { severity: 'high' }],
  fixes: [{ impact: 'high' }],
}, { objective: 'conversion' });

assert.equal(weak.scoring.objective, 'conversion');
assert.equal(weak.qualityGate.action, 'regenerate');
assert.ok(weak.qualityGate.blockers.length >= 2);

const compliantCandidate = normalizeVideoAnalysis({
  scores: {
    hook: 90,
    pacing: 90,
    clarity: 90,
    visualQuality: 90,
    continuity: 90,
    cta: 90,
    platformFit: 90,
    conversionReadiness: 90,
  },
  hook: { verdict: 'strong' },
  continuity: { verdict: 'strong' },
  cta: { clarity: 'strong' },
  platformAssessment: { fit: 'strong' },
  compliance: {
    checks: [
      {
        type: 'mustShow',
        rule: 'Brand logo',
        status: 'pass',
        evidence: 'Logo visible on end frame.',
        timestampSeconds: 2,
      },
      {
        type: 'mustNotShow',
        rule: 'Competitor logo',
        status: 'fail',
        evidence: 'Competitor mark visible.',
        timestampSeconds: 1,
      },
    ],
  },
}, {
  objective: 'conversion',
  requirements: {
    mustShow: ['Brand logo'],
    mustNotShow: ['Competitor logo'],
    ctaRequired: true,
  },
});

assert.equal(compliantCandidate.compliance.status, 'fail');
assert.equal(compliantCandidate.compliance.checks.length, 3);
assert.equal(compliantCandidate.compliance.uncertainCount, 1);
assert.equal(compliantCandidate.qualityGate.action, 'revise');

console.log('Video intelligence tests passed');
