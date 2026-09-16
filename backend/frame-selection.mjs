/**
 * Experimental frame-selection strategies for ForgeDirector.
 *
 * This module is deliberately provider- and decoder-agnostic. It does not
 * change /v1/analyze, does not import FOCUS research dependencies, and is not
 * used by the production path. The FOCUS-style strategy implements the
 * research concept with an injected relevance scorer so we can benchmark the
 * selection policy independently from BLIP/LAVIS and from Bedrock.
 */

export const FRAME_SELECTION_EXPERIMENT_VERSION = 'fd-frame-selection-exp-1';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeBudget(value, maximum) {
  if (!Number.isFinite(Number(value))) return 0;
  return clamp(Math.floor(Number(value)), 0, maximum);
}

function normalizeFrames(frames = []) {
  if (!Array.isArray(frames)) return [];
  const byIndex = new Map();

  for (const candidate of frames) {
    if (!candidate || typeof candidate !== 'object') continue;
    const index = Number(candidate.index);
    const timestampSeconds = Number(candidate.timestampSeconds);
    if (!Number.isInteger(index) || index < 0) continue;
    if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0) continue;
    if (!byIndex.has(index)) {
      byIndex.set(index, {
        ...candidate,
        index,
        timestampSeconds,
      });
    }
  }

  return [...byIndex.values()].sort((a, b) => (
    a.timestampSeconds - b.timestampSeconds || a.index - b.index
  ));
}

function frameKey(frame) {
  return Number(frame.index);
}

function seededRandom(seed = 42) {
  let state = (Number(seed) >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function sampleWithoutReplacement(items, count, rng) {
  const pool = [...items];
  const selected = [];
  const wanted = Math.min(Math.max(0, count), pool.length);

  for (let i = 0; i < wanted; i += 1) {
    const position = Math.floor(rng() * pool.length);
    selected.push(pool.splice(position, 1)[0]);
  }

  return selected;
}

function evenlySpaced(frames, count) {
  const budget = normalizeBudget(count, frames.length);
  if (budget === 0) return [];
  if (budget >= frames.length) return [...frames];
  if (budget === 1) return [frames[Math.floor((frames.length - 1) / 2)]];

  const chosen = [];
  const seen = new Set();

  for (let i = 0; i < budget; i += 1) {
    const position = Math.round((i * (frames.length - 1)) / (budget - 1));
    const frame = frames[position];
    if (!seen.has(frame.index)) {
      seen.add(frame.index);
      chosen.push(frame);
    }
  }

  // Rounding can theoretically collide for very small lists. Fill any gap
  // deterministically from temporal order.
  if (chosen.length < budget) {
    for (const frame of frames) {
      if (chosen.length >= budget) break;
      if (!seen.has(frame.index)) {
        seen.add(frame.index);
        chosen.push(frame);
      }
    }
  }

  return chosen.sort((a, b) => a.timestampSeconds - b.timestampSeconds || a.index - b.index);
}

function partitionFrames(frames, armCount) {
  const count = clamp(Math.floor(armCount), 1, Math.max(1, frames.length));
  const arms = [];

  for (let armIndex = 0; armIndex < count; armIndex += 1) {
    const start = Math.floor((armIndex * frames.length) / count);
    const end = Math.floor(((armIndex + 1) * frames.length) / count);
    const armFrames = frames.slice(start, Math.max(start + 1, end));
    if (armFrames.length) {
      arms.push({
        id: armIndex,
        frames: armFrames,
        startSeconds: armFrames[0].timestampSeconds,
        endSeconds: armFrames[armFrames.length - 1].timestampSeconds,
      });
    }
  }

  return arms;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / values.length;
}

function nearestEstimatedScore(frame, scoredFrames) {
  if (!scoredFrames.length) return 0;
  let nearest = scoredFrames[0];
  let distance = Math.abs(frame.timestampSeconds - nearest.frame.timestampSeconds);

  for (const entry of scoredFrames.slice(1)) {
    const nextDistance = Math.abs(frame.timestampSeconds - entry.frame.timestampSeconds);
    if (
      nextDistance < distance
      || (nextDistance === distance && entry.frame.index < nearest.frame.index)
    ) {
      nearest = entry;
      distance = nextDistance;
    }
  }

  return nearest.score;
}

function respectsGap(frame, selected, minGapSeconds) {
  if (!(minGapSeconds > 0)) return true;
  return selected.every((other) => (
    Math.abs(frame.timestampSeconds - other.timestampSeconds) >= minGapSeconds
  ));
}

async function scoreBatch(scoreFrames, query, frames) {
  if (!frames.length) return new Map();
  if (typeof scoreFrames !== 'function') {
    throw new TypeError('FocusFrameSelector requires an injected scoreFrames(query, frames) function.');
  }

  const result = await scoreFrames(query, frames);
  if (!Array.isArray(result) || result.length !== frames.length) {
    throw new Error('relevance scorer must return one numeric score per frame');
  }

  const scored = new Map();
  for (let i = 0; i < frames.length; i += 1) {
    const score = Number(result[i]);
    if (!Number.isFinite(score)) {
      throw new Error(`relevance scorer returned a non-finite score for frame ${frames[i].index}`);
    }
    scored.set(frameKey(frames[i]), clamp(score, 0, 1));
  }
  return scored;
}

function serializableConfig(config) {
  return Object.fromEntries(
    Object.entries(config).filter(([, value]) => (
      ['string', 'number', 'boolean'].includes(typeof value) || value === null
    )),
  );
}

export class FrameSelectionStrategy {
  constructor({ name, version }) {
    this.name = name;
    this.version = version;
  }

  async select() {
    throw new Error('FrameSelectionStrategy.select() must be implemented.');
  }
}

export class UniformFrameSelector extends FrameSelectionStrategy {
  constructor(config = {}) {
    super({ name: 'uniform', version: config.version || 'fd-uniform-1' });
    this.config = { ...config };
  }

  async select({ frames = [], budget = 0 } = {}) {
    const candidates = normalizeFrames(frames);
    const effectiveBudget = normalizeBudget(budget, candidates.length);
    const selectedFrames = evenlySpaced(candidates, effectiveBudget);

    return {
      strategy: this.name,
      selectorVersion: this.version,
      selectedFrames,
      metadata: {
        experimentVersion: FRAME_SELECTION_EXPERIMENT_VERSION,
        totalCandidateFrames: candidates.length,
        requestedBudget: Math.max(0, Math.floor(finiteNumber(budget))),
        effectiveBudget,
        totalRetainedFrames: selectedFrames.length,
        selectedFrameIndexes: selectedFrames.map(frameKey),
        selectedTimestampsSeconds: selectedFrames.map((frame) => frame.timestampSeconds),
        configuration: serializableConfig(this.config),
      },
    };
  }
}

export class FocusFrameSelector extends FrameSelectionStrategy {
  constructor(config = {}) {
    super({ name: 'focus', version: config.version || 'fd-focus-concept-1' });
    this.config = {
      coarseEverySeconds: Math.max(0.1, finiteNumber(config.coarseEverySeconds, 16)),
      fineEverySeconds: Math.max(0.01, finiteNumber(config.fineEverySeconds, 1)),
      zoomRatio: clamp(finiteNumber(config.zoomRatio, 0.25), 0.01, 1),
      minCoarseSegments: Math.max(1, Math.floor(finiteNumber(config.minCoarseSegments, 8))),
      minZoomSegments: Math.max(1, Math.floor(finiteNumber(config.minZoomSegments, 4))),
      maxZoomSegments: Math.max(1, Math.floor(finiteNumber(config.maxZoomSegments, 32))),
      extraSamplesPerRegion: Math.max(0, Math.floor(finiteNumber(config.extraSamplesPerRegion, 2))),
      topRatio: clamp(finiteNumber(config.topRatio, 0.2), 0, 1),
      minGapSeconds: Math.max(0, finiteNumber(config.minGapSeconds, 0)),
      confidenceScale: Math.max(0, finiteNumber(config.confidenceScale, 1)),
      finalArmPolicy: config.finalArmPolicy === 'paper_empirical_mean'
        ? 'paper_empirical_mean'
        : 'released_optimistic',
      seed: Math.floor(finiteNumber(config.seed, 42)),
    };
    this.scoreFrames = config.scoreFrames;
    this.uniformFallback = new UniformFrameSelector({ version: 'fd-uniform-focus-fallback-1' });
  }

  async select({ frames = [], budget = 0, query = '' } = {}) {
    const candidates = normalizeFrames(frames);
    const effectiveBudget = normalizeBudget(budget, candidates.length);
    const cleanQuery = String(query || '').trim();

    if (effectiveBudget === 0) {
      return {
        strategy: this.name,
        selectorVersion: this.version,
        selectedFrames: [],
        metadata: this.#metadata({
          candidates,
          requestedBudget: budget,
          effectiveBudget,
          selectedFrames: [],
          query: cleanQuery,
          fallbackReason: null,
          coarseSamples: [],
          fineSamples: [],
          arms: [],
        }),
      };
    }

    if (!cleanQuery) {
      const fallback = await this.uniformFallback.select({ frames: candidates, budget: effectiveBudget });
      return {
        ...fallback,
        strategy: this.name,
        selectorVersion: this.version,
        metadata: {
          ...fallback.metadata,
          experimentVersion: FRAME_SELECTION_EXPERIMENT_VERSION,
          fallbackUsed: true,
          fallbackReason: 'empty_query',
          requestedStrategy: this.name,
          selectorVersion: this.version,
          configuration: serializableConfig(this.config),
        },
      };
    }

    const durationSeconds = candidates.length
      ? Math.max(0, candidates[candidates.length - 1].timestampSeconds - candidates[0].timestampSeconds)
      : 0;
    const intervalArmCount = Math.max(1, Math.ceil(
      Math.max(durationSeconds, this.config.coarseEverySeconds) / this.config.coarseEverySeconds,
    ));
    const armCount = Math.min(
      candidates.length,
      Math.max(this.config.minCoarseSegments, intervalArmCount),
    );
    const arms = partitionFrames(candidates, armCount);
    const rng = seededRandom(this.config.seed);

    const coarseFrames = [];
    const coarseSeen = new Set();

    for (const arm of arms) {
      const center = arm.frames[Math.floor((arm.frames.length - 1) / 2)];
      const extras = sampleWithoutReplacement(
        arm.frames.filter((frame) => frame.index !== center.index),
        this.config.extraSamplesPerRegion,
        rng,
      );

      for (const frame of [center, ...extras]) {
        if (!coarseSeen.has(frame.index)) {
          coarseSeen.add(frame.index);
          coarseFrames.push(frame);
        }
      }
    }

    const scores = await scoreBatch(this.scoreFrames, cleanQuery, coarseFrames);

    const armStats = arms.map((arm) => {
      const sampled = arm.frames
        .filter((frame) => scores.has(frame.index))
        .map((frame) => ({ frame, score: scores.get(frame.index) }));
      const values = sampled.map((entry) => entry.score);
      const armMean = mean(values);
      const variance = sampleVariance(values);
      const n = Math.max(1, values.length);
      const logTerm = Math.log(Math.max(3, candidates.length * 2));
      const confidence = this.config.confidenceScale * (
        Math.sqrt((2 * variance * logTerm) / n)
        + ((3 * logTerm) / n)
      );

      return {
        ...arm,
        sampled,
        meanScore: armMean,
        variance,
        confidence,
        focusScore: armMean + confidence,
      };
    });

    const zoomCount = Math.min(
      armStats.length,
      Math.max(
        this.config.minZoomSegments,
        Math.min(
          this.config.maxZoomSegments,
          Math.ceil(armStats.length * this.config.zoomRatio),
        ),
      ),
    );

    const zoomArms = [...armStats]
      .sort((a, b) => b.focusScore - a.focusScore || a.id - b.id)
      .slice(0, zoomCount);

    const fineFrames = [];
    const fineSeen = new Set(coarseFrames.map(frameKey));

    for (const arm of zoomArms) {
      let lastTimestamp = Number.NEGATIVE_INFINITY;
      for (const frame of arm.frames) {
        if (
          frame.timestampSeconds - lastTimestamp >= this.config.fineEverySeconds
          || frame === arm.frames[arm.frames.length - 1]
        ) {
          lastTimestamp = frame.timestampSeconds;
          if (!fineSeen.has(frame.index)) {
            fineSeen.add(frame.index);
            fineFrames.push(frame);
          }
        }
      }
    }

    const fineScores = await scoreBatch(this.scoreFrames, cleanQuery, fineFrames);
    for (const [index, score] of fineScores.entries()) scores.set(index, score);

    const completedArmStats = armStats.map((arm) => {
      const sampled = arm.frames
        .filter((frame) => scores.has(frame.index))
        .map((frame) => ({ frame, score: scores.get(frame.index) }));
      return {
        ...arm,
        sampled,
        meanScore: mean(sampled.map((entry) => entry.score)),
      };
    });

    const scoredEntries = [...scores.entries()]
      .map(([index, score]) => ({
        frame: candidates.find((candidate) => candidate.index === index),
        score,
      }))
      .filter((entry) => entry.frame)
      .sort((a, b) => b.score - a.score || a.frame.index - b.frame.index);

    const topCount = Math.min(
      effectiveBudget,
      Math.round(this.config.topRatio * Math.min(effectiveBudget, scoredEntries.length)),
    );

    const selected = [];
    const selectedIndexes = new Set();

    const addFrame = (frame) => {
      if (!frame || selectedIndexes.has(frame.index)) return false;
      if (!respectsGap(frame, selected, this.config.minGapSeconds)) return false;
      selectedIndexes.add(frame.index);
      selected.push(frame);
      return true;
    };

    for (const entry of scoredEntries.slice(0, topCount)) addFrame(entry.frame);

    const finalArmKey = this.config.finalArmPolicy === 'paper_empirical_mean'
      ? 'meanScore'
      : 'focusScore';
    const finalArms = [...completedArmStats]
      .sort((a, b) => b[finalArmKey] - a[finalArmKey] || a.id - b.id)
      .slice(0, zoomCount);

    let remaining = effectiveBudget - selected.length;
    if (remaining > 0 && finalArms.length) {
      for (let armRank = 0; armRank < finalArms.length && remaining > 0; armRank += 1) {
        const armsLeft = finalArms.length - armRank;
        const need = Math.ceil(remaining / armsLeft);
        const arm = finalArms[armRank];
        const sampled = arm.sampled;

        const ranked = arm.frames
          .filter((frame) => !selectedIndexes.has(frame.index))
          .map((frame) => ({
            frame,
            estimatedScore: scores.has(frame.index)
              ? scores.get(frame.index)
              : nearestEstimatedScore(frame, sampled),
          }))
          .sort((a, b) => (
            b.estimatedScore - a.estimatedScore
            || a.frame.timestampSeconds - b.frame.timestampSeconds
            || a.frame.index - b.frame.index
          ));

        let added = 0;
        for (const entry of ranked) {
          if (added >= need || remaining <= 0) break;
          if (addFrame(entry.frame)) {
            added += 1;
            remaining -= 1;
          }
        }
      }
    }

    // A strict min-gap can prevent filling the budget. Preserve the requested
    // evidence budget by relaxing the gap only for the deterministic final
    // fill, and expose that fact in metadata.
    const gapRelaxed = remaining > 0;
    if (remaining > 0) {
      const globalRanked = candidates
        .filter((frame) => !selectedIndexes.has(frame.index))
        .map((frame) => ({
          frame,
          estimatedScore: scores.has(frame.index)
            ? scores.get(frame.index)
            : nearestEstimatedScore(frame, scoredEntries),
        }))
        .sort((a, b) => (
          b.estimatedScore - a.estimatedScore
          || a.frame.timestampSeconds - b.frame.timestampSeconds
          || a.frame.index - b.frame.index
        ));

      for (const entry of globalRanked) {
        if (remaining <= 0) break;
        selectedIndexes.add(entry.frame.index);
        selected.push(entry.frame);
        remaining -= 1;
      }
    }

    const selectedFrames = selected
      .slice(0, effectiveBudget)
      .sort((a, b) => a.timestampSeconds - b.timestampSeconds || a.index - b.index);

    return {
      strategy: this.name,
      selectorVersion: this.version,
      selectedFrames,
      metadata: this.#metadata({
        candidates,
        requestedBudget: budget,
        effectiveBudget,
        selectedFrames,
        query: cleanQuery,
        fallbackReason: null,
        coarseSamples: coarseFrames.map((frame) => ({
          index: frame.index,
          timestampSeconds: frame.timestampSeconds,
          relevanceScore: scores.get(frame.index),
        })),
        fineSamples: fineFrames.map((frame) => ({
          index: frame.index,
          timestampSeconds: frame.timestampSeconds,
          relevanceScore: scores.get(frame.index),
        })),
        arms: completedArmStats.map((arm) => ({
          id: arm.id,
          startSeconds: arm.startSeconds,
          endSeconds: arm.endSeconds,
          sampledFrameIndexes: arm.sampled.map((entry) => entry.frame.index),
          meanScore: arm.meanScore,
          variance: arm.variance,
          confidence: arm.confidence,
          focusScore: arm.focusScore,
        })),
        gapRelaxed,
      }),
    };
  }

  #metadata({
    candidates,
    requestedBudget,
    effectiveBudget,
    selectedFrames,
    query,
    fallbackReason,
    coarseSamples,
    fineSamples,
    arms,
    gapRelaxed = false,
  }) {
    return {
      experimentVersion: FRAME_SELECTION_EXPERIMENT_VERSION,
      totalCandidateFrames: candidates.length,
      requestedBudget: Math.max(0, Math.floor(finiteNumber(requestedBudget))),
      effectiveBudget,
      totalRetainedFrames: selectedFrames.length,
      selectedFrameIndexes: selectedFrames.map(frameKey),
      selectedTimestampsSeconds: selectedFrames.map((frame) => frame.timestampSeconds),
      query,
      fallbackUsed: Boolean(fallbackReason),
      fallbackReason,
      finalArmPolicy: this.config.finalArmPolicy,
      gapRelaxed,
      coarseSampling: coarseSamples,
      fineSampling: fineSamples,
      arms,
      configuration: serializableConfig(this.config),
    };
  }
}

export class HybridFrameSelector extends FrameSelectionStrategy {
  constructor(config = {}) {
    super({ name: 'hybrid', version: config.version || 'fd-hybrid-focus-1' });
    this.config = {
      coverageRatio: clamp(finiteNumber(config.coverageRatio, 0.5), 0, 1),
      minCoverageFrames: Math.max(0, Math.floor(finiteNumber(config.minCoverageFrames, 4))),
    };
    this.uniform = new UniformFrameSelector({ version: 'fd-hybrid-coverage-1' });
    this.focus = config.focusSelector instanceof FocusFrameSelector
      ? config.focusSelector
      : new FocusFrameSelector(config.focus || {});
  }

  async select({ frames = [], budget = 0, query = '' } = {}) {
    const candidates = normalizeFrames(frames);
    const effectiveBudget = normalizeBudget(budget, candidates.length);
    if (!effectiveBudget) {
      return {
        strategy: this.name,
        selectorVersion: this.version,
        selectedFrames: [],
        metadata: {
          experimentVersion: FRAME_SELECTION_EXPERIMENT_VERSION,
          totalCandidateFrames: candidates.length,
          requestedBudget: Math.max(0, Math.floor(finiteNumber(budget))),
          effectiveBudget,
          totalRetainedFrames: 0,
          selectedFrameIndexes: [],
          selectedTimestampsSeconds: [],
          coverageFrameIndexes: [],
          queryAwareFrameIndexes: [],
          configuration: serializableConfig(this.config),
        },
      };
    }

    const coverageBudget = Math.min(
      effectiveBudget,
      Math.max(
        Math.min(this.config.minCoverageFrames, effectiveBudget),
        Math.ceil(effectiveBudget * this.config.coverageRatio),
      ),
    );

    const [coverage, focus] = await Promise.all([
      this.uniform.select({ frames: candidates, budget: coverageBudget }),
      this.focus.select({ frames: candidates, budget: effectiveBudget, query }),
    ]);

    const selectedByIndex = new Map();
    for (const frame of coverage.selectedFrames) selectedByIndex.set(frame.index, frame);
    for (const frame of focus.selectedFrames) {
      if (selectedByIndex.size >= effectiveBudget) break;
      if (!selectedByIndex.has(frame.index)) selectedByIndex.set(frame.index, frame);
    }

    if (selectedByIndex.size < effectiveBudget) {
      const fill = evenlySpaced(candidates, effectiveBudget);
      for (const frame of fill) {
        if (selectedByIndex.size >= effectiveBudget) break;
        if (!selectedByIndex.has(frame.index)) selectedByIndex.set(frame.index, frame);
      }
    }

    const selectedFrames = [...selectedByIndex.values()]
      .sort((a, b) => a.timestampSeconds - b.timestampSeconds || a.index - b.index);

    const coverageIndexes = new Set(coverage.selectedFrames.map(frameKey));

    return {
      strategy: this.name,
      selectorVersion: this.version,
      selectedFrames,
      metadata: {
        experimentVersion: FRAME_SELECTION_EXPERIMENT_VERSION,
        totalCandidateFrames: candidates.length,
        requestedBudget: Math.max(0, Math.floor(finiteNumber(budget))),
        effectiveBudget,
        totalRetainedFrames: selectedFrames.length,
        selectedFrameIndexes: selectedFrames.map(frameKey),
        selectedTimestampsSeconds: selectedFrames.map((frame) => frame.timestampSeconds),
        coverageFrameIndexes: selectedFrames
          .filter((frame) => coverageIndexes.has(frame.index))
          .map(frameKey),
        queryAwareFrameIndexes: selectedFrames
          .filter((frame) => !coverageIndexes.has(frame.index))
          .map(frameKey),
        configuration: serializableConfig(this.config),
        focus: focus.metadata,
      },
    };
  }
}

export function createFrameSelectionStrategy(name, config = {}) {
  switch (String(name || '').trim().toLowerCase()) {
    case 'uniform':
      return new UniformFrameSelector(config);
    case 'focus':
      return new FocusFrameSelector(config);
    case 'hybrid':
      return new HybridFrameSelector(config);
    default:
      throw new Error(`Unknown frame-selection strategy: ${name}`);
  }
}

export async function selectFramesWithFallback({
  primary,
  fallback = new UniformFrameSelector(),
  request,
} = {}) {
  if (!(primary instanceof FrameSelectionStrategy)) {
    throw new TypeError('primary must be a FrameSelectionStrategy');
  }
  if (!(fallback instanceof FrameSelectionStrategy)) {
    throw new TypeError('fallback must be a FrameSelectionStrategy');
  }

  try {
    return await primary.select(request);
  } catch (error) {
    const recovered = await fallback.select(request);
    return {
      ...recovered,
      metadata: {
        ...recovered.metadata,
        fallbackUsed: true,
        fallbackFromStrategy: primary.name,
        fallbackReason: String(error?.message || error || 'selector_failure'),
      },
    };
  }
}
