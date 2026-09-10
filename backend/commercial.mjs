import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { SYSTEM_PROMPT, buildUserPrompt } from './director-prompt.mjs';
import { evaluateCampaign } from './qa.mjs';

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
});

const MODEL_ID = process.env.BEDROCK_MODEL_ID;
const RAPIDAPI_PROXY_SECRET = process.env.RAPIDAPI_PROXY_SECRET || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 120000);

function header(event, name) {
  const target = name.toLowerCase();
  const headers = event?.headers || {};
  const key = Object.keys(headers).find((item) => item.toLowerCase() === target);
  return key ? String(headers[key] ?? '') : '';
}

function response(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': ALLOWED_ORIGIN,
      'access-control-allow-headers': 'content-type,x-rapidapi-key,x-rapidapi-host,x-rapidapi-proxy-secret',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function methodOf(event) {
  return String(event?.requestContext?.http?.method || event?.httpMethod || 'POST').toUpperCase();
}

function pathOf(event) {
  const raw = String(event?.rawPath || event?.path || '/');
  return raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
}

function parseBody(event) {
  if (!event?.body) return {};
  if (typeof event.body === 'object') return event.body;
  const source = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : String(event.body);
  if (Buffer.byteLength(source, 'utf8') > MAX_BODY_BYTES) {
    const error = new Error('Request body is too large.');
    error.statusCode = 413;
    throw error;
  }
  return JSON.parse(source);
}

function cleanModelJson(text) {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractText(result) {
  return (result?.output?.message?.content || [])
    .filter((block) => typeof block?.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Model returned no campaign manifest.');
  if (!Array.isArray(manifest.scenes) || manifest.scenes.length === 0) throw new Error('Campaign manifest contains no scenes.');
  if (manifest.scenes.length > 20) throw new Error('Campaign manifest exceeds the 20-scene limit.');

  const duration = Number(manifest.durationSeconds);
  const total = manifest.scenes.reduce((sum, scene) => sum + Number(scene?.durationSeconds || 0), 0);
  if (!Number.isFinite(duration) || duration <= 0 || total !== duration) {
    throw new Error('Scene durations do not match campaign duration.');
  }

  return manifest;
}

function assertText(value, field, max = 6000) {
  const text = String(value || '').trim();
  if (!text) {
    const error = new Error(`${field} is required.`);
    error.statusCode = 400;
    throw error;
  }
  if (text.length > max) {
    const error = new Error(`${field} exceeds ${max} characters.`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

function assertCampaign(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('campaign must be a JSON object.');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function authorized(event, path) {
  if (!RAPIDAPI_PROXY_SECRET || !path.startsWith('/v1/')) return true;
  const supplied = header(event, 'x-rapidapi-proxy-secret');
  return supplied && supplied === RAPIDAPI_PROXY_SECRET;
}

async function invokeDirector({ message, campaign }) {
  if (!MODEL_ID) {
    const error = new Error('BEDROCK_MODEL_ID is not configured.');
    error.statusCode = 503;
    throw error;
  }

  const result = await client.send(new ConverseCommand({
    modelId: MODEL_ID,
    system: [{ text: SYSTEM_PROMPT }],
    messages: [{
      role: 'user',
      content: [{ text: buildUserPrompt({ message, campaign }) }],
    }],
    inferenceConfig: {
      maxTokens: 3200,
      temperature: 0.3,
      topP: 0.9,
    },
  }));

  const rawText = extractText(result);
  const campaignResult = validateManifest(JSON.parse(cleanModelJson(rawText)));
  return {
    campaign: campaignResult,
    usage: result?.usage || null,
  };
}

function planMessage(payload) {
  const brief = assertText(payload?.brief ?? payload?.message, 'brief');
  const constraints = payload?.constraints && typeof payload.constraints === 'object'
    ? `\n\nUSER CONSTRAINTS:\n${JSON.stringify(payload.constraints)}`
    : '';
  return `Create a NEW campaign manifest from this creative brief. Do not treat this as a revision.\n\nBRIEF:\n${brief}${constraints}`;
}

function revisionMessage(payload) {
  const instruction = assertText(payload?.instruction ?? payload?.message, 'instruction');
  return `Revise the existing campaign according to this instruction. Preserve every unrelated decision materially unchanged.\n\nREVISION INSTRUCTION:\n${instruction}`;
}

function apiInfo() {
  return {
    name: 'ForgeDirector Video Creative Intelligence API',
    version: '1.0.0',
    status: 'ok',
    endpoints: {
      plan: 'POST /v1/plan',
      revise: 'POST /v1/revise',
      qa: 'POST /v1/qa',
      health: 'GET /health',
    },
  };
}

export const handler = async (event) => {
  const method = methodOf(event);
  const path = pathOf(event);
  const requestId = String(event?.requestContext?.requestId || event?.requestContext?.http?.requestId || crypto.randomUUID());

  if (method === 'OPTIONS') return response(204, {});

  if (method === 'GET' && (path === '/' || path === '/health')) {
    return response(200, { ...apiInfo(), requestId });
  }

  if (!authorized(event, path)) {
    return response(401, { error: 'Unauthorized gateway request.', requestId });
  }

  let payload;
  try {
    payload = parseBody(event);
  } catch (error) {
    return response(error?.statusCode || 400, { error: error?.message || 'Request body must be valid JSON.', requestId });
  }

  try {
    if (method === 'POST' && path === '/v1/qa') {
      const campaign = assertCampaign(payload?.campaign ?? payload);
      return response(200, {
        qa: evaluateCampaign(campaign),
        requestId,
      });
    }

    if (method === 'POST' && path === '/v1/plan') {
      const result = await invokeDirector({
        message: planMessage(payload),
        campaign: null,
      });
      return response(200, {
        campaign: result.campaign,
        qa: evaluateCampaign(result.campaign),
        meta: { operation: 'plan', modelId: MODEL_ID, usage: result.usage, requestId },
      });
    }

    if (method === 'POST' && path === '/v1/revise') {
      const campaign = assertCampaign(payload?.campaign);
      const result = await invokeDirector({
        message: revisionMessage(payload),
        campaign,
      });
      return response(200, {
        campaign: result.campaign,
        qa: evaluateCampaign(result.campaign),
        meta: { operation: 'revise', modelId: MODEL_ID, usage: result.usage, requestId },
      });
    }

    return response(404, { error: 'Endpoint not found.', requestId });
  } catch (error) {
    console.error('ForgeDirector commercial API error', {
      requestId,
      path,
      message: error?.message,
    });
    return response(error?.statusCode || 502, {
      error: error?.statusCode && error.statusCode < 500
        ? error.message
        : 'The creative intelligence engine could not complete the request.',
      requestId,
    });
  }
};
