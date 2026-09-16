import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) {
    throw new Error('cosineSimilarity requires non-empty vectors of equal length');
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      throw new Error('cosineSimilarity received a non-finite value');
    }
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }

  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, items.length)) }, worker),
  );
  return results;
}

function parseInvokeBody(response) {
  const body = new TextDecoder().decode(response.body);
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed.embedding) || parsed.embedding.length === 0) {
    throw new Error('Titan embedding response did not contain an embedding');
  }
  return parsed;
}

export class TitanMultimodalRelevanceScorer {
  constructor({
    region = process.env.AWS_REGION || 'eu-west-1',
    modelId = 'amazon.titan-embed-image-v1',
    outputEmbeddingLength = 256,
    concurrency = 4,
    client = null,
    pricing = {},
  } = {}) {
    this.client = client || new BedrockRuntimeClient({ region });
    this.modelId = modelId;
    this.outputEmbeddingLength = outputEmbeddingLength;
    this.concurrency = Math.max(1, Math.floor(Number(concurrency) || 1));
    this.pricing = {
      imageUsd: Number.isFinite(Number(pricing.imageUsd)) ? Number(pricing.imageUsd) : null,
      textPerThousandTokensUsd: Number.isFinite(Number(pricing.textPerThousandTokensUsd))
        ? Number(pricing.textPerThousandTokensUsd)
        : null,
    };

    this.queryEmbeddings = new Map();
    this.imageEmbeddings = new Map();
    this.stats = {
      modelId,
      outputEmbeddingLength,
      textCalls: 0,
      imageCalls: 0,
      textInputTokens: 0,
      imageBytes: 0,
      queryCacheHits: 0,
      imageCacheHits: 0,
      invokeLatencyMs: 0,
      scoreLatencyMs: 0,
    };
  }

  async #invoke(body) {
    const start = performance.now();
    const response = await this.client.send(new InvokeModelCommand({
      modelId: this.modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    }));
    this.stats.invokeLatencyMs += performance.now() - start;
    return parseInvokeBody(response);
  }

  async #embedQuery(query) {
    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) throw new Error('Titan relevance query must not be empty');

    if (this.queryEmbeddings.has(cleanQuery)) {
      this.stats.queryCacheHits += 1;
      return this.queryEmbeddings.get(cleanQuery);
    }

    const parsed = await this.#invoke({
      inputText: cleanQuery,
      embeddingConfig: {
        outputEmbeddingLength: this.outputEmbeddingLength,
      },
    });
    this.stats.textCalls += 1;
    this.stats.textInputTokens += Number(parsed.inputTextTokenCount || 0);
    this.queryEmbeddings.set(cleanQuery, parsed.embedding);
    return parsed.embedding;
  }

  async #embedFrame(frame) {
    const cacheKey = String(frame.imagePath || frame.index);
    if (this.imageEmbeddings.has(cacheKey)) {
      this.stats.imageCacheHits += 1;
      return this.imageEmbeddings.get(cacheKey);
    }

    if (!frame.imagePath) {
      throw new Error('frame ' + frame.index + ' is missing imagePath');
    }

    const bytes = await readFile(frame.imagePath);
    this.stats.imageBytes += bytes.length;
    const parsed = await this.#invoke({
      inputImage: bytes.toString('base64'),
      embeddingConfig: {
        outputEmbeddingLength: this.outputEmbeddingLength,
      },
    });
    this.stats.imageCalls += 1;
    this.imageEmbeddings.set(cacheKey, parsed.embedding);
    return parsed.embedding;
  }

  async scoreFrames(query, frames) {
    const started = performance.now();
    const queryEmbedding = await this.#embedQuery(query);
    const imageEmbeddings = await mapLimit(
      frames,
      this.concurrency,
      (frame) => this.#embedFrame(frame),
    );

    const scores = imageEmbeddings.map((embedding) => (
      clamp((cosineSimilarity(queryEmbedding, embedding) + 1) / 2, 0, 1)
    ));
    this.stats.scoreLatencyMs += performance.now() - started;
    return scores;
  }

  snapshot() {
    const selectionCostUsd = (
      this.pricing.imageUsd === null
      || this.pricing.textPerThousandTokensUsd === null
    )
      ? null
      : (
          (this.stats.imageCalls * this.pricing.imageUsd)
          + ((this.stats.textInputTokens / 1000) * this.pricing.textPerThousandTokensUsd)
        );

    return {
      ...this.stats,
      invokeLatencyMs: Number(this.stats.invokeLatencyMs.toFixed(2)),
      scoreLatencyMs: Number(this.stats.scoreLatencyMs.toFixed(2)),
      pricing: this.pricing,
      estimatedCostUsd: selectionCostUsd === null
        ? null
        : Number(selectionCostUsd.toFixed(8)),
    };
  }
}
