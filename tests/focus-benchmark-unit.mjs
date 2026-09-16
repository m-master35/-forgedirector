import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cosineSimilarity,
  TitanMultimodalRelevanceScorer,
} from '../experiments/focus/titan-scorer.mjs';
import {
  buildBinaryQaPrompt,
  estimateNovaCost,
  parseBinaryQaResponse,
  runVideoBinaryQa,
} from '../experiments/focus/vlm.mjs';

assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
assert.throws(() => cosineSimilarity([1], [1, 2]), /equal length/);

{
  const parsed = parseBinaryQaResponse(
    'prefix {"answer":"yes","evidenceTimestampSeconds":2,"evidence":"visible","confidence":1.2} suffix',
  );
  assert.equal(parsed.answer, true);
  assert.equal(parsed.evidenceTimestampSeconds, 2);
  assert.equal(parsed.evidence, 'visible');
  assert.equal(parsed.confidence, 1);
}

{
  const parsed = parseBinaryQaResponse(
    '{"answer":false,"evidenceTimestampSeconds":null,"evidence":"","confidence":0.1}',
  );
  assert.equal(parsed.answer, false);
  assert.equal(parsed.evidenceTimestampSeconds, null);
}

assert.throws(
  () => parseBinaryQaResponse('not json'),
  /did not contain a JSON object/,
);

assert.equal(
  estimateNovaCost(
    { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    { inputPerMillionUsd: 0.30, outputPerMillionUsd: 2.50 },
  ),
  2.8,
);
assert.equal(estimateNovaCost({}, {}), null);

{
  const prompt = buildBinaryQaPrompt({
    question: 'Is RIVAL visible?',
    timestampMap: [
      { proxyTimestampSeconds: 0, sourceTimestampSeconds: 4 },
      { proxyTimestampSeconds: 1, sourceTimestampSeconds: 17 },
    ],
  });
  assert.match(prompt, /untrusted evidence/i);
  assert.match(prompt, /Do not infer that unseen source moments were reviewed/i);
  assert.match(prompt, /0s=>4s, 1s=>17s/);
  assert.match(prompt, /QUESTION: Is RIVAL visible\?/);
}

const root = await mkdtemp(join(tmpdir(), 'fd-focus-cloud-unit-'));
try {
  const framePath = join(root, 'frame.jpg');
  await writeFile(framePath, Buffer.from([1, 2, 3, 4]));

  let invokeCalls = 0;
  const fakeTitanClient = {
    async send(command) {
      invokeCalls += 1;
      const input = command.input;
      const body = JSON.parse(String(input.body));
      if (body.inputText) {
        return {
          body: Buffer.from(JSON.stringify({
            embedding: [1, 0],
            inputTextTokenCount: 4,
          })),
        };
      }
      return {
        body: Buffer.from(JSON.stringify({
          embedding: [1, 0],
          inputTextTokenCount: 0,
        })),
      };
    },
  };

  const scorer = new TitanMultimodalRelevanceScorer({
    client: fakeTitanClient,
    outputEmbeddingLength: 256,
    pricing: {
      imageUsd: 0.00006,
      textPerThousandTokensUsd: 0.00080,
    },
  });

  const scores = await scorer.scoreFrames('product logo', [{
    index: 0,
    timestampSeconds: 0,
    imagePath: framePath,
  }]);
  assert.deepEqual(scores, [1]);

  const second = await scorer.scoreFrames('product logo', [{
    index: 0,
    timestampSeconds: 0,
    imagePath: framePath,
  }]);
  assert.deepEqual(second, [1]);

  const stats = scorer.snapshot();
  assert.equal(invokeCalls, 2, 'query and image embeddings should be cached after first use');
  assert.equal(stats.textCalls, 1);
  assert.equal(stats.imageCalls, 1);
  assert.equal(stats.queryCacheHits, 1);
  assert.equal(stats.imageCacheHits, 1);
  assert.ok(stats.estimatedCostUsd > 0);

  const videoPath = join(root, 'proxy.mp4');
  await writeFile(videoPath, Buffer.from([0, 0, 0, 1]));

  let capturedConverseInput = null;
  const fakeNovaClient = {
    async send(command) {
      capturedConverseInput = command.input;
      return {
        output: {
          message: {
            content: [{
              text: '{"answer":true,"evidenceTimestampSeconds":1,"evidence":"RIVAL visible","confidence":0.9}',
            }],
          },
        },
        usage: {
          inputTokens: 1000,
          outputTokens: 100,
          totalTokens: 1100,
        },
        metrics: {
          latencyMs: 321,
        },
      };
    },
  };

  const qa = await runVideoBinaryQa({
    client: fakeNovaClient,
    modelId: 'test-model',
    videoPath,
    question: 'Is RIVAL visible?',
    timestampMap: [
      { proxyTimestampSeconds: 0, sourceTimestampSeconds: 4 },
      { proxyTimestampSeconds: 1, sourceTimestampSeconds: 17 },
    ],
    pricing: {
      inputPerMillionUsd: 0.30,
      outputPerMillionUsd: 2.50,
    },
  });

  assert.equal(qa.answer, true);
  assert.equal(qa.evidenceTimestampSeconds, 1);
  assert.equal(qa.sourceEvidenceTimestampSeconds, 17);
  assert.equal(qa.usage.totalTokens, 1100);
  assert.equal(qa.modelLatencyMs, 321);
  assert.ok(qa.estimatedCostUsd > 0);
  assert.equal(capturedConverseInput.modelId, 'test-model');
  assert.equal(capturedConverseInput.messages[0].content[0].video.format, 'mp4');
  assert.match(capturedConverseInput.messages[0].content[1].text, /SPARSE EXPERIMENTAL PROXY/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('focus benchmark cloud-adapter unit tests passed');
