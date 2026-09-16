import assert from 'node:assert/strict';
import {
  FRAME_SELECTION_EXPERIMENT_VERSION,
  UniformFrameSelector,
  FocusFrameSelector,
  HybridFrameSelector,
  createFrameSelectionStrategy,
  selectFramesWithFallback,
} from '../backend/frame-selection.mjs';

const frames = Array.from({ length: 100 }, (_, index) => ({
  index,
  timestampSeconds: index,
}));

const uniform = new UniformFrameSelector();

{
  const result = await uniform.select({ frames, budget: 5 });
  assert.deepEqual(result.metadata.selectedFrameIndexes, [0, 25, 50, 74, 99]);
  assert.equal(result.metadata.totalCandidateFrames, 100);
  assert.equal(result.metadata.totalRetainedFrames, 5);
  assert.equal(result.metadata.experimentVersion, FRAME_SELECTION_EXPERIMENT_VERSION);
}

{
  const result = await uniform.select({ frames: frames.slice(0, 3), budget: 20 });
  assert.deepEqual(result.metadata.selectedFrameIndexes, [0, 1, 2]);
  assert.equal(result.metadata.effectiveBudget, 3);
}

{
  const result = await uniform.select({ frames, budget: 0 });
  assert.deepEqual(result.selectedFrames, []);
  assert.equal(result.metadata.totalRetainedFrames, 0);
}

{
  const malformed = [
    { index: 4, timestampSeconds: 4 },
    { index: 2, timestampSeconds: 2 },
    { index: 2, timestampSeconds: 99 },
    { index: -1, timestampSeconds: 0 },
    { index: 3, timestampSeconds: Number.NaN },
    null,
  ];
  const result = await uniform.select({ frames: malformed, budget: 10 });
  assert.deepEqual(result.metadata.selectedFrameIndexes, [2, 4]);
  assert.deepEqual(result.metadata.selectedTimestampsSeconds, [2, 4]);
}

const peakScorer = async (query, selected) => {
  assert.ok(String(query).length > 0);
  return selected.map((frame) => {
    const distance = Math.abs(frame.timestampSeconds - 70);
    return Math.max(0, 1 - (distance / 40));
  });
};

const focusConfig = {
  scoreFrames: peakScorer,
  seed: 1234,
  coarseEverySeconds: 10,
  fineEverySeconds: 2,
  minCoarseSegments: 5,
  minZoomSegments: 2,
  maxZoomSegments: 5,
  zoomRatio: 0.4,
  topRatio: 0.25,
  minGapSeconds: 0,
};

{
  const selector = new FocusFrameSelector(focusConfig);
  const first = await selector.select({ frames, budget: 12, query: 'brand logo' });
  const second = await selector.select({ frames, budget: 12, query: 'brand logo' });

  assert.deepEqual(first.metadata.selectedFrameIndexes, second.metadata.selectedFrameIndexes);
  assert.deepEqual(first.metadata.coarseSampling, second.metadata.coarseSampling);
  assert.deepEqual(first.metadata.fineSampling, second.metadata.fineSampling);
  assert.equal(first.metadata.totalRetainedFrames, 12);
  assert.equal(first.metadata.totalCandidateFrames, 100);
  assert.equal(first.metadata.fallbackUsed, false);
  assert.ok(first.metadata.coarseSampling.length > 0);
  assert.ok(first.metadata.arms.length >= 5);
  assert.ok(
    first.selectedFrames.some((frame) => Math.abs(frame.timestampSeconds - 70) <= 5),
    'query-aware selection should retain a frame near the synthetic relevance peak',
  );
}

{
  const selector = new FocusFrameSelector({
    ...focusConfig,
    finalArmPolicy: 'paper_empirical_mean',
  });
  const result = await selector.select({ frames, budget: 8, query: 'product consistency' });
  assert.equal(result.metadata.finalArmPolicy, 'paper_empirical_mean');
  assert.equal(result.metadata.configuration.finalArmPolicy, 'paper_empirical_mean');
}

{
  const selector = new FocusFrameSelector({
    ...focusConfig,
    finalArmPolicy: 'released_optimistic',
  });
  const result = await selector.select({ frames, budget: 8, query: 'product consistency' });
  assert.equal(result.metadata.finalArmPolicy, 'released_optimistic');
}

{
  const selector = new FocusFrameSelector(focusConfig);
  const result = await selector.select({ frames, budget: 6, query: '   ' });
  assert.equal(result.strategy, 'focus');
  assert.equal(result.metadata.fallbackUsed, true);
  assert.equal(result.metadata.fallbackReason, 'empty_query');
  assert.equal(result.metadata.requestedStrategy, 'focus');
  assert.equal(result.metadata.totalRetainedFrames, 6);
}

{
  const selector = new FocusFrameSelector({
    ...focusConfig,
    minGapSeconds: 500,
  });
  const result = await selector.select({ frames, budget: 4, query: 'rare defect' });
  assert.equal(result.metadata.totalRetainedFrames, 4);
  assert.equal(result.metadata.gapRelaxed, true);
}

{
  const twoFrames = [
    { index: 10, timestampSeconds: 0 },
    { index: 20, timestampSeconds: 0.2 },
  ];
  const selector = new FocusFrameSelector({
    scoreFrames: async (_query, selected) => selected.map((frame) => (
      frame.index === 20 ? 1 : 0
    )),
    minCoarseSegments: 8,
  });
  const result = await selector.select({
    frames: twoFrames,
    budget: 2,
    query: 'visible defect',
  });
  assert.deepEqual(result.metadata.selectedFrameIndexes, [10, 20]);
}

{
  const focusSelector = new FocusFrameSelector(focusConfig);
  const hybrid = new HybridFrameSelector({
    coverageRatio: 0.5,
    minCoverageFrames: 4,
    focusSelector,
  });
  const result = await hybrid.select({ frames, budget: 10, query: 'brand logo' });

  assert.equal(result.metadata.totalRetainedFrames, 10);
  assert.ok(result.metadata.coverageFrameIndexes.includes(0));
  assert.ok(result.metadata.coverageFrameIndexes.includes(99));
  assert.ok(result.metadata.queryAwareFrameIndexes.length > 0);
  assert.equal(result.metadata.focus.finalArmPolicy, 'released_optimistic');
}

{
  const brokenFocus = new FocusFrameSelector({
    scoreFrames: async () => {
      throw new Error('synthetic scorer failure');
    },
  });

  const result = await selectFramesWithFallback({
    primary: brokenFocus,
    fallback: new UniformFrameSelector(),
    request: { frames, budget: 5, query: 'defect' },
  });

  assert.equal(result.strategy, 'uniform');
  assert.equal(result.metadata.fallbackUsed, true);
  assert.equal(result.metadata.fallbackFromStrategy, 'focus');
  assert.match(result.metadata.fallbackReason, /synthetic scorer failure/);
  assert.deepEqual(result.metadata.selectedFrameIndexes, [0, 25, 50, 74, 99]);
}

{
  assert.ok(createFrameSelectionStrategy('uniform') instanceof UniformFrameSelector);
  assert.ok(
    createFrameSelectionStrategy('focus', { scoreFrames: peakScorer }) instanceof FocusFrameSelector,
  );
  assert.throws(() => createFrameSelectionStrategy('unknown'), /Unknown frame-selection strategy/);
}

console.log('frame-selection tests passed');
