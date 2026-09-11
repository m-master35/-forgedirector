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

assert.equal(normalized.analysisVersion, '1.4');
assert.equal(normalized.scoringVersion, 'fd-shortform-v5');
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

const evidenceDerived = normalizeVideoAnalysis({
  scores: {
    hook: 80, pacing: 80, clarity: 80, visualQuality: 80,
    continuity: 80, cta: 80, platformFit: 80, conversionReadiness: 80,
  },
  hook: { verdict: 'strong' },
  timeline: [{
    startSeconds: 0,
    endSeconds: 6,
    purpose: 'cta',
    visual: 'Dark title card with FORGE FLOW and START FREE. No RIVAL branding is present.',
    onScreenText: 'FORGE FLOW\nSTART FREE',
    issues: [],
  }],
  cta: { present: true, type: 'visual', clarity: 'strong', issue: null },
  continuity: { verdict: 'strong', issues: [] },
  platformAssessment: { fit: 'strong', reasons: [] },
  compliance: {
    checks: [{
      type: 'mustNotShow',
      rule: 'RIVAL',
      status: 'uncertain',
      evidence: '',
      timestampSeconds: null,
    }],
  },
}, {
  objective: 'conversion',
  requirements: {
    mustIncludeText: ['START FREE'],
    mustNotShow: ['RIVAL'],
    ctaRequired: true,
  },
});

assert.equal(evidenceDerived.compliance.status, 'pass');
assert.equal(evidenceDerived.compliance.checks.find((x) => x.type === 'mustIncludeText').status, 'pass');
assert.equal(evidenceDerived.compliance.checks.find((x) => x.type === 'mustNotShow').status, 'pass');
assert.equal(evidenceDerived.compliance.checks.find((x) => x.type === 'ctaRequired').status, 'pass');

const forbiddenDerived = normalizeVideoAnalysis({
  scores: {
    hook: 70, pacing: 70, clarity: 70, visualQuality: 70,
    continuity: 70, cta: 50, platformFit: 70, conversionReadiness: 50,
  },
  summary: 'Title card showing FORGE FLOW and RIVAL.',
  timeline: [{
    startSeconds: 0,
    endSeconds: 6,
    purpose: 'other',
    visual: 'Centered text FORGE FLOW and RIVAL.',
    onScreenText: 'FORGE FLOW\nRIVAL',
    issues: [],
  }],
  compliance: {
    checks: [{
      type: 'mustNotShow',
      rule: 'RIVAL',
      status: 'pass',
      evidence: 'RIVAL is displayed but this was incorrectly marked pass.',
      timestampSeconds: 0,
    }],
  },
}, {
  requirements: {
    mustNotShow: ['RIVAL'],
  },
});

assert.equal(forbiddenDerived.compliance.checks[0].status, 'fail');

const missingCtaDerived = normalizeVideoAnalysis({
  scores: {
    hook: 60, pacing: 60, clarity: 60, visualQuality: 60,
    continuity: 60, cta: 20, platformFit: 60, conversionReadiness: 40,
  },
  cta: { present: false, type: 'none', clarity: 'weak', issue: 'No CTA was observed.' },
  timeline: [{ startSeconds: 0, endSeconds: 6, onScreenText: 'FORGE FLOW' }],
}, {
  requirements: {
    ctaRequired: true,
  },
});

assert.equal(missingCtaDerived.compliance.checks[0].status, 'fail');

const sanitized = normalizeVideoAnalysis({
  scores: {
    hook: 70,
    pacing: 70,
    clarity: 70,
    visualQuality: 70,
    continuity: 70,
    cta: 70,
    platformFit: 70,
    conversionReadiness: 70,
  },
  hook: {
    verdict: 'strong',
    spokenHook: 'Model guessed speech',
    issues: ['Use trending audio', 'Opening text is visually unclear'],
  },
  timeline: [{
    startSeconds: 0,
    endSeconds: 3,
    purpose: 'hook',
    speech: 'Guessed speech',
    recommendations: ['Add hashtags', 'Move the visual reveal earlier'],
  }],
  platformAssessment: {
    fit: 'mixed',
    reasons: ['Could help the algorithm', 'Aspect ratio fits the target platform'],
  },
  fixes: [
    { issue: 'Low discoverability', action: 'Add hashtags' },
    { issue: 'Slow reveal', action: 'Move the first meaningful visual earlier' },
  ],
  regenerationPrompts: [
    { reason: 'Needs virality', prompt: 'Use a trending challenge' },
    { reason: 'Slow visual opening', prompt: 'Start with immediate visible action' },
  ],
  repurpose: {
    tiktok: ['Use trending audio', 'Tighten the first cut'],
    instagramReels: ['Add hashtags', 'Preserve the 9:16 crop'],
    youtubeShorts: ['Boost discoverability', 'Keep the CTA legible'],
  },
}, { objective: 'engagement', hasTranscript: false });

assert.equal(sanitized.hook.spokenHook, null);
assert.equal(sanitized.timeline[0].speech, null);
assert.deepEqual(sanitized.timeline[0].recommendations, ['Move the visual reveal earlier']);
assert.equal(sanitized.fixes.length, 1);
assert.equal(sanitized.regenerationPrompts.length, 1);
assert.deepEqual(sanitized.repurpose.tiktok, ['Tighten the first cut']);
assert.deepEqual(sanitized.repurpose.instagramReels, ['Preserve the 9:16 crop']);
assert.deepEqual(sanitized.repurpose.youtubeShorts, ['Keep the CTA legible']);
assert.ok(sanitized.limitations.some((item) => item.includes('Audio was not analyzed')));

console.log('Video intelligence tests passed');
