import { FocusFrameSelector } from '../../backend/frame-selection.mjs';
import { deriveFrameBudgets } from './benchmark-utils.mjs';

const durations = [6, 12, 30, 60, 90, 120];
const rows = [];

for (const durationSeconds of durations) {
  const frames = Array.from({ length: durationSeconds }, (_, index) => ({
    index,
    timestampSeconds: index,
  }));

  let scorerCalls = 0;
  let scoredFrames = 0;
  const selector = new FocusFrameSelector({
    scoreFrames: async (_query, selectedFrames) => {
      scorerCalls += 1;
      scoredFrames += selectedFrames.length;
      // Deterministic monotonic relevance makes later arms consistently win
      // and keeps this structural overhead probe reproducible.
      return selectedFrames.map((frame) => (
        durationSeconds > 1 ? frame.timestampSeconds / (durationSeconds - 1) : 1
      ));
    },
  });

  const budgets = deriveFrameBudgets(frames.length, { coverageRequired: false });
  const result = await selector.select({
    frames,
    budget: budgets.medium,
    query: 'semantic production-defect evidence',
  });

  rows.push({
    durationSeconds,
    baselineCandidateFrames: frames.length,
    mediumRetainedFrames: result.selectedFrames.length,
    scorerCalls,
    selectorScoredFrames: scoredFrames,
    selectorScoredFraction: Number((scoredFrames / frames.length).toFixed(4)),
    coarseScoredFrames: result.metadata.coarseSampling.length,
    fineScoredFrames: result.metadata.fineSampling.length,
  });
}

console.log(JSON.stringify({
  kind: 'structural-selector-overhead',
  note: 'No Bedrock/Titan call is made. Counts use the current FOCUS-style default configuration and 1-FPS candidate geometry.',
  rows,
}, null, 2));
