import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { SYSTEM_PROMPT, buildUserPrompt } from './director-prompt.mjs';
import { evaluateCampaign } from './qa.mjs';
import { createVideoUpload, deleteVideoAsset, resolveVideoAsset } from './storage.mjs';
import {
  VIDEO_ANALYSIS_SYSTEM_PROMPT,
  buildVideoAnalysisPrompt,
  normalizeVideoAnalysis,
} from './video-intelligence.mjs';

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
});

const MODEL_ID = process.env.BEDROCK_MODEL_ID;
const RAPIDAPI_PROXY_SECRET = process.env.RAPIDAPI_PROXY_SECRET || '';
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 120000);
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES || 31457280);

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
    .replace(/^\`\`\`(?:json)?\s*/i, '')
    .replace(/\s*\`\`\`$/i, '')
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

function assertText(value, field, max = 6000, required = true) {
  const text = String(value || '').trim();
  if (required && !text) {
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

function assertDeclaredDuration(value) {
  if (value === undefined || value === null || value === '') return null;
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 120) {
    const error = new Error('durationSeconds must be between 1 and 120.');
    error.statusCode = 400;
    throw error;
  }
  return Math.round(duration * 10) / 10;
}

function assertObjective(value) {
  const objective = String(value || 'engagement').trim().toLowerCase();
  const allowed = new Set(['engagement', 'conversion', 'awareness', 'education', 'app-install', 'lead-generation']);
  if (!allowed.has(objective)) {
    const error = new Error('objective must be engagement, conversion, awareness, education, app-install, or lead-generation.');
    error.statusCode = 400;
    throw error;
  }
  return objective;
}

function assertPlatform(value) {
  const source = String(value || 'General').trim().toLowerCase();
  const platforms = new Map([
    ['tiktok', 'TikTok'],
    ['instagram reels', 'Instagram Reels'],
    ['instagram', 'Instagram Reels'],
    ['reels', 'Instagram Reels'],
    ['youtube shorts', 'YouTube Shorts'],
    ['youtube', 'YouTube Shorts'],
    ['shorts', 'YouTube Shorts'],
    ['general', 'General'],
  ]);
  const platform = platforms.get(source);
  if (!platform) {
    const error = new Error('platform must be TikTok, Instagram Reels, YouTube Shorts, or General.');
    error.statusCode = 400;
    throw error;
  }
  return platform;
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

async function invokeVideoAnalysis({ asset, payload }) {
  if (!MODEL_ID) {
    const error = new Error('BEDROCK_MODEL_ID is not configured.');
    error.statusCode = 503;
    throw error;
  }

  const platform = assertPlatform(payload?.platform);
  const objective = assertObjective(payload?.objective);
  const audience = assertText(payload?.audience, 'audience', 1000, false);
  const context = assertText(payload?.context, 'context', 3000, false);
  const transcript = assertText(payload?.transcript, 'transcript', 12000, false);
  const declaredDurationSeconds = assertDeclaredDuration(payload?.durationSeconds);

  const prompt = buildVideoAnalysisPrompt({
    platform,
    objective,
    audience,
    context,
    transcript,
    declaredDurationSeconds,
  });

  const result = await client.send(new ConverseCommand({
    modelId: MODEL_ID,
    system: [{ text: VIDEO_ANALYSIS_SYSTEM_PROMPT }],
    messages: [{
      role: 'user',
      content: [
        {
          video: {
            format: asset.format,
            source: {
              s3Location: {
                uri: asset.uri,
              },
            },
          },
        },
        { text: prompt },
      ],
    }],
    inferenceConfig: {
      maxTokens: 5000,
      temperature: 0.2,
      topP: 0.9,
    },
  }));

  const rawText = extractText(result);
  const analysis = normalizeVideoAnalysis(JSON.parse(cleanModelJson(rawText)));

  return {
    analysis,
    usage: result?.usage || null,
    platform,
    objective,
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
    version: '1.1.0',
    status: 'ok',
    endpoints: {
      upload: 'POST /v1/uploads',
      analyze: 'POST /v1/analyze',
      plan: 'POST /v1/plan',
      revise: 'POST /v1/revise',
      qa: 'POST /v1/qa',
      health: 'GET /health',
    },
    limits: {
      maxVideoBytes: MAX_VIDEO_BYTES,
      maxVideoDurationSeconds: 120,
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
    if (method === 'POST' && path === '/v1/uploads') {
      const contentType = assertText(payload?.contentType, 'contentType', 100);
      const declaredSize = payload?.sizeBytes === undefined ? null : Number(payload.sizeBytes);
      if (declaredSize !== null && (!Number.isFinite(declaredSize) || declaredSize <= 0 || declaredSize > MAX_VIDEO_BYTES)) {
        const error = new Error(`sizeBytes must be between 1 and ${MAX_VIDEO_BYTES}.`);
        error.statusCode = 400;
        throw error;
      }

      const assetId = crypto.randomUUID();
      const upload = await createVideoUpload({ assetId, contentType });
      return response(200, {
        upload,
        next: {
          endpoint: 'POST /v1/analyze',
          body: { assetId },
        },
        requestId,
      });
    }

    if (method === 'POST' && path === '/v1/analyze') {
      const assetId = assertText(payload?.assetId, 'assetId', 100);
      const asset = await resolveVideoAsset(assetId);
      try {
        const result = await invokeVideoAnalysis({ asset, payload });
        return response(200, {
          analysis: result.analysis,
          meta: {
            operation: 'analyze',
            modelId: MODEL_ID,
            platform: result.platform,
            objective: result.objective,
            asset: {
              id: asset.assetId,
              sizeBytes: asset.sizeBytes,
              contentType: asset.contentType,
              deletedAfterAnalysis: true,
            },
            usage: result.usage,
            scoringNotice: 'Scores are heuristic creative-quality assessments, not predictions of views, sales, retention, ROAS, or virality.',
            requestId,
          },
        });
      } finally {
        await deleteVideoAsset(assetId);
      }
    }

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
