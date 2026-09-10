import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { SYSTEM_PROMPT, buildUserPrompt } from './director-prompt.mjs';

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
});

const MODEL_ID = process.env.BEDROCK_MODEL_ID;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': ALLOWED_ORIGIN,
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST,OPTIONS',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event?.body) return {};
  if (typeof event.body === 'object') return event.body;
  return JSON.parse(event.body);
}

function extractText(result) {
  const blocks = result?.output?.message?.content || [];
  return blocks
    .filter((block) => typeof block?.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function safeJson(text) {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Model returned no manifest.');
  if (!Array.isArray(manifest.scenes) || manifest.scenes.length === 0) throw new Error('Manifest has no scenes.');
  const total = manifest.scenes.reduce((sum, scene) => sum + Number(scene.durationSeconds || 0), 0);
  if (Number(manifest.durationSeconds) !== total) throw new Error('Scene durations do not match campaign duration.');
  return manifest;
}

export const handler = async (event) => {
  if (event?.requestContext?.http?.method === 'OPTIONS' || event?.httpMethod === 'OPTIONS') {
    return response(204, {});
  }

  if (!MODEL_ID) {
    return response(500, { error: 'BEDROCK_MODEL_ID is not configured.' });
  }

  let payload;
  try {
    payload = parseBody(event);
  } catch {
    return response(400, { error: 'Request body must be valid JSON.' });
  }

  const message = String(payload?.message || '').trim();
  const campaign = payload?.campaign ?? null;

  if (!message) return response(400, { error: 'message is required.' });
  if (message.length > 6000) return response(400, { error: 'message is too long.' });

  try {
    const command = new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [
        {
          role: 'user',
          content: [{ text: buildUserPrompt({ message, campaign }) }],
        },
      ],
      inferenceConfig: {
        maxTokens: 3000,
        temperature: 0.35,
        topP: 0.9,
      },
    });

    const result = await client.send(command);
    const text = extractText(result);
    const manifest = validateManifest(safeJson(text));

    return response(200, {
      campaign: manifest,
      usage: result?.usage || null,
      modelId: MODEL_ID,
    });
  } catch (error) {
    console.error('ForgeDirector Bedrock error', error);
    return response(502, {
      error: 'The director could not produce a valid campaign manifest.',
      detail: process.env.DEBUG_ERRORS === 'true' ? String(error?.message || error) : undefined,
    });
  }
};
