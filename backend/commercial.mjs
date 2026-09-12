import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  CRITIC_SYSTEM_PROMPT,
  buildCriticPrompt,
  BRIEF_ENRICHER_SYSTEM_PROMPT,
  buildBriefEnricherPrompt,
} from './director-prompt.mjs';
import { evaluateCampaign } from './qa.mjs';
import { createVideoUpload, deleteVideoAsset, resolveVideoAsset } from './storage.mjs';
import {
  VIDEO_ANALYSIS_SYSTEM_PROMPT,
  buildVideoAnalysisPrompt,
  normalizeVideoAnalysis,
} from './video-intelligence.mjs';
import {
  prepareCreativeRequest,
  parseDirectorJson,
  normalizeCampaignManifest,
  buildDeterministicFallbackCampaign,
  buildDirectorRepairPrompt,
  normalizeCreativeCritique,
  critiqueNeedsRepair,
  applyRevisionPreservation,
  normalizeBriefEnrichment,
} from './director-reliability.mjs';

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
});

const MODEL_ID = process.env.BEDROCK_MODEL_ID;
const VIDEO_FALLBACK_MODEL_ID = process.env.VIDEO_FALLBACK_MODEL_ID || '';
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
  if (!Number.isFinite(duration) || duration <= 0 || Math.abs(total - duration) > 0.001) {
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

function assertStringList(value, field, maxItems = 20, maxLength = 300) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    const error = new Error(`${field} must be an array of strings.`);
    error.statusCode = 400;
    throw error;
  }
  if (value.length > maxItems) {
    const error = new Error(`${field} cannot contain more than ${maxItems} items.`);
    error.statusCode = 400;
    throw error;
  }
  return value.map((item, index) => {
    const text = String(item || '').trim();
    if (!text || text.length > maxLength) {
      const error = new Error(`${field}[${index}] must be 1-${maxLength} characters.`);
      error.statusCode = 400;
      throw error;
    }
    return text;
  });
}

function assertRequirements(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('requirements must be a JSON object.');
    error.statusCode = 400;
    throw error;
  }

  const requirements = {};
  const fields = [
    ['mustShow', 'requirements.mustShow'],
    ['mustNotShow', 'requirements.mustNotShow'],
    ['mustIncludeText', 'requirements.mustIncludeText'],
    ['continuityRules', 'requirements.continuityRules'],
  ];

  for (const [key, field] of fields) {
    const list = assertStringList(value[key], field);
    if (list.length) requirements[key] = list;
  }

  if (value.ctaRequired !== undefined) {
    if (typeof value.ctaRequired !== 'boolean') {
      const error = new Error('requirements.ctaRequired must be a boolean.');
      error.statusCode = 400;
      throw error;
    }
    if (value.ctaRequired) requirements.ctaRequired = true;
  }

  return requirements;
}

function authorized(event, path) {
  if (!RAPIDAPI_PROXY_SECRET || !path.startsWith('/v1/')) return true;
  const supplied = header(event, 'x-rapidapi-proxy-secret');
  return supplied && supplied === RAPIDAPI_PROXY_SECRET;
}

async function invokeDirector({ message, campaign, request, isRevision = false }) {
  if (!MODEL_ID) {
    const fallbackCampaign = buildDeterministicFallbackCampaign({
      request,
      previousCampaign: campaign,
      isRevision,
    });
    return {
      campaign: validateManifest(fallbackCampaign),
      usage: null,
      repairUsed: false,
      degradedFallbackUsed: true,
      modelId: null,
      initialQa: evaluateCampaign(fallbackCampaign),
    };
  }

  const invokeOnce = async (modelId, promptText) => client.send(new ConverseCommand({
    modelId,
    system: [{ text: SYSTEM_PROMPT }],
    messages: [{
      role: 'user',
      content: [{ text: buildUserPrompt({ message: promptText, campaign }) }],
    }],
    inferenceConfig: {
      maxTokens: 4200,
      temperature: 0.2,
      topP: 0.9,
    },
  }));

  const sendDirector = async (modelId, promptText) => {
    const retryable = new Set([
      'ThrottlingException',
      'ServiceUnavailableException',
      'InternalServerException',
      'ModelTimeoutException',
      'ModelNotReadyException',
    ]);

    try {
      return await invokeOnce(modelId, promptText);
    } catch (error) {
      const name = String(error?.name || error?.Code || '');
      const status = Number(error?.$metadata?.httpStatusCode || 0);
      if (!retryable.has(name) && !(status >= 500 && status <= 599)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 700));
      return invokeOnce(modelId, promptText);
    }
  };

  const runCreativeCritic = async (candidate) => {
    if (!MODEL_ID) return { critique: null, usage: null, modelId: null };

    const invokeCriticOnce = async (modelId) => client.send(new ConverseCommand({
      modelId,
      system: [{ text: CRITIC_SYSTEM_PROMPT }],
      messages: [{
        role: 'user',
        content: [{ text: buildCriticPrompt({ request, campaign: candidate }) }],
      }],
      inferenceConfig: {
        maxTokens: 1400,
        temperature: 0,
        topP: 0.9,
      },
    }));

    const attempt = async (modelId) => {
      let criticResult;
      try {
        criticResult = await invokeCriticOnce(modelId);
      } catch (error) {
        const name = String(error?.name || error?.Code || '');
        const status = Number(error?.$metadata?.httpStatusCode || 0);
        const retryable = new Set([
          'ThrottlingException',
          'ServiceUnavailableException',
          'InternalServerException',
          'ModelTimeoutException',
          'ModelNotReadyException',
        ]);
        if (!retryable.has(name) && !(status >= 500 && status <= 599)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
        criticResult = await invokeCriticOnce(modelId);
      }

      const raw = parseDirectorJson(extractText(criticResult));
      return {
        critique: normalizeCreativeCritique(raw),
        usage: criticResult?.usage || null,
        modelId,
      };
    };

    let first;
    try {
      first = await attempt(MODEL_ID);
      if (first.critique) return first;
    } catch {
      first = null;
    }

    if (VIDEO_FALLBACK_MODEL_ID && VIDEO_FALLBACK_MODEL_ID !== MODEL_ID) {
      try {
        const fallback = await attempt(VIDEO_FALLBACK_MODEL_ID);
        if (fallback.critique) return fallback;
      } catch {
        // Return the primary failure below; caller can decide how to degrade.
      }
    }

    return first || { critique: null, usage: null, modelId: null };
  };

  let briefEnrichment = null;
  let briefEnrichmentUsed = false;

  if (!isRevision && request?.quality?.tier !== 'good' && MODEL_ID) {
    const enrichWithModel = async (modelId) => client.send(new ConverseCommand({
      modelId,
      system: [{ text: BRIEF_ENRICHER_SYSTEM_PROMPT }],
      messages: [{
        role: 'user',
        content: [{ text: buildBriefEnricherPrompt({ request }) }],
      }],
      inferenceConfig: {
        maxTokens: 1500,
        temperature: 0.15,
        topP: 0.9,
      },
    }));

    const models = request?.quality?.tier === 'poor' && VIDEO_FALLBACK_MODEL_ID
      ? [VIDEO_FALLBACK_MODEL_ID, MODEL_ID]
      : [MODEL_ID, VIDEO_FALLBACK_MODEL_ID].filter(Boolean);

    for (const modelId of [...new Set(models)]) {
      try {
        const enrichResult = await enrichWithModel(modelId);
        const parsedEnrichment = parseDirectorJson(extractText(enrichResult));
        const normalizedEnrichment = normalizeBriefEnrichment(parsedEnrichment, request);
        if (normalizedEnrichment) {
          briefEnrichment = normalizedEnrichment;
          briefEnrichmentUsed = true;
          request.enrichedBrief = normalizedEnrichment.resolvedBrief;
          message = planMessage(request);
          break;
        }
      } catch {
        // Continue to the next available model; deterministic recovery defaults
        // remain available if brief enrichment cannot be produced.
      }
    }
  }

  const preferredModel = request?.quality?.tier === 'poor' && VIDEO_FALLBACK_MODEL_ID
    ? VIDEO_FALLBACK_MODEL_ID
    : MODEL_ID;

  let result;
  let usedModelId = preferredModel;
  let degradedFallbackUsed = false;

  try {
    result = await sendDirector(usedModelId, message);
  } catch (primaryError) {
    if (VIDEO_FALLBACK_MODEL_ID && VIDEO_FALLBACK_MODEL_ID !== usedModelId) {
      usedModelId = VIDEO_FALLBACK_MODEL_ID;
      try {
        result = await sendDirector(usedModelId, message);
      } catch {
        const fallbackCampaign = buildDeterministicFallbackCampaign({
          request,
          previousCampaign: campaign,
          isRevision,
        });
        return {
          campaign: validateManifest(fallbackCampaign),
          usage: null,
          repairUsed: false,
          degradedFallbackUsed: true,
          modelId: null,
          initialQa: evaluateCampaign(fallbackCampaign),
        };
      }
    } else {
      const fallbackCampaign = buildDeterministicFallbackCampaign({
        request,
        previousCampaign: campaign,
        isRevision,
      });
      return {
        campaign: validateManifest(fallbackCampaign),
        usage: null,
        repairUsed: false,
        degradedFallbackUsed: true,
        modelId: null,
        initialQa: evaluateCampaign(fallbackCampaign),
      };
    }
  }

  let parsed = parseDirectorJson(extractText(result));
  let normalized = normalizeCampaignManifest(parsed, {
    request,
    previousCampaign: campaign,
    isRevision,
  });
  if (isRevision && campaign) {
    normalized = applyRevisionPreservation(normalized, campaign, request?.rawBrief || '');
  }
  let qa = evaluateCampaign(normalized);
  const initialQa = qa;
  let repairUsed = false;
  let rescueRewriteUsed = false;
  let creativeCritique = null;
  let criticUsage = null;

  try {
    const criticResult = await runCreativeCritic(normalized);
    creativeCritique = criticResult.critique;
    criticUsage = criticResult.usage;
  } catch {
    creativeCritique = null;
  }

  if (!parsed || !qa.passed || qa.score < 90 || (creativeCritique && critiqueNeedsRepair(creativeCritique))) {
    repairUsed = true;
    const repairPrompt = buildDirectorRepairPrompt({
      originalMessage: message,
      candidate: normalized,
      qa,
      creativeCritic: creativeCritique,
      previousCampaign: campaign,
    });
    const repairModel = VIDEO_FALLBACK_MODEL_ID || usedModelId;

    try {
      const repairResult = await sendDirector(repairModel, repairPrompt);
      const repairedParsed = parseDirectorJson(extractText(repairResult));
      if (repairedParsed) {
        let repaired = normalizeCampaignManifest(repairedParsed, {
          request,
          previousCampaign: campaign,
          isRevision,
        });
        if (isRevision && campaign) {
          repaired = applyRevisionPreservation(repaired, campaign, request?.rawBrief || '');
        }
        const repairedQa = evaluateCampaign(repaired);
        let repairedCritique = null;
        let repairedCriticUsage = null;
        try {
          const criticResult = await runCreativeCritic(repaired);
          repairedCritique = criticResult.critique;
          repairedCriticUsage = criticResult.usage;
        } catch {
          repairedCritique = null;
        }

        const currentCreativeScore = creativeCritique?.score ?? 0;
        const repairedCreativeScore = repairedCritique?.score ?? 0;
        const structuralUpgrade = repairedQa.passed && !qa.passed;
        const semanticUpgrade = repairedCritique
          && (
            !creativeCritique
            || (repairedCritique.passed && !creativeCritique.passed)
            || repairedCreativeScore > currentCreativeScore
          );
        const noSemanticRegression = !creativeCritique
          || !repairedCritique
          || repairedCreativeScore >= currentCreativeScore;

        if (
          structuralUpgrade
          || semanticUpgrade
          || (repairedQa.score > qa.score && noSemanticRegression)
        ) {
          normalized = repaired;
          qa = repairedQa;
          result = repairResult;
          usedModelId = repairModel;
          if (repairedCritique) creativeCritique = repairedCritique;
          if (repairedCriticUsage) criticUsage = repairedCriticUsage;
        }
      }
    } catch {
      // The deterministic normalization below is intentionally sufficient to
      // return a structurally valid campaign even when the repair call fails.
    }
  }

  if (creativeCritique && critiqueNeedsRepair(creativeCritique)) {
    rescueRewriteUsed = true;
    const rescuePrompt = buildDirectorRepairPrompt({
      originalMessage: message,
      candidate: normalized,
      qa,
      creativeCritic: creativeCritique,
      previousCampaign: campaign,
    });
    const rescueModel = VIDEO_FALLBACK_MODEL_ID || usedModelId;

    try {
      const rescueResult = await sendDirector(rescueModel, `${rescuePrompt}\n\nFINAL QUALITY PASS: Rewrite the manifest so every creative-critic weakness is concretely resolved. Favor specificity, a stronger first-two-second visual hook, visibly distinct scene progression, generator-ready camera/lighting/motion direction, strict continuity, and restrained claims. Return the full JSON manifest only.`);
      const rescueParsed = parseDirectorJson(extractText(rescueResult));
      if (rescueParsed) {
        let rescueCandidate = normalizeCampaignManifest(rescueParsed, {
          request,
          previousCampaign: campaign,
          isRevision,
        });
        if (isRevision && campaign) {
          rescueCandidate = applyRevisionPreservation(rescueCandidate, campaign, request?.rawBrief || '');
        }

        const rescueQa = evaluateCampaign(rescueCandidate);
        let rescueCritique = null;
        let rescueCriticUsage = null;
        try {
          const criticResult = await runCreativeCritic(rescueCandidate);
          rescueCritique = criticResult.critique;
          rescueCriticUsage = criticResult.usage;
        } catch {
          rescueCritique = null;
        }

        const currentScore = creativeCritique?.score ?? 0;
        const rescueScore = rescueCritique?.score ?? 0;
        if (
          rescueQa.passed
          && rescueQa.score >= qa.score
          && rescueCritique
          && (
            rescueCritique.passed
            || rescueScore > currentScore
          )
        ) {
          normalized = rescueCandidate;
          qa = rescueQa;
          result = rescueResult;
          usedModelId = rescueModel;
          creativeCritique = rescueCritique;
          if (rescueCriticUsage) criticUsage = rescueCriticUsage;
        }
      }
    } catch {
      // Keep the best validated candidate from the earlier passes.
    }
  }

  try {
    return {
      campaign: validateManifest(normalized),
      usage: result?.usage || null,
      repairUsed,
      rescueRewriteUsed,
      briefEnrichmentUsed,
      briefEnrichment,
      degradedFallbackUsed,
      modelId: usedModelId,
      initialQa,
      creativeCritique,
      criticUsage,
    };
  } catch {
    degradedFallbackUsed = true;
    const fallbackCampaign = buildDeterministicFallbackCampaign({
      request,
      previousCampaign: campaign,
      isRevision,
    });
    return {
      campaign: validateManifest(fallbackCampaign),
      usage: result?.usage || null,
      repairUsed,
      rescueRewriteUsed,
      briefEnrichmentUsed,
      briefEnrichment,
      degradedFallbackUsed,
      modelId: usedModelId,
      initialQa,
      creativeCritique,
      criticUsage,
    };
  }
}

function parseVideoAnalysisModelJson(text) {
  try {
    const parsed = JSON.parse(cleanModelJson(text));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function hasSubstantiveVideoAnalysis(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (String(value.summary || '').trim()) return true;
  if (Array.isArray(value.timeline) && value.timeline.length > 0) return true;
  const scores = value.scores && typeof value.scores === 'object' ? value.scores : {};
  return Object.values(scores).some((score) => Number.isFinite(Number(score)) && Number(score) > 0);
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
  const requirements = assertRequirements(payload?.requirements);

  const prompt = buildVideoAnalysisPrompt({
    platform,
    objective,
    audience,
    context,
    transcript,
    declaredDurationSeconds,
    requirements,
  });

  const invokeAnalysisOnce = async (modelId, promptText) => client.send(new ConverseCommand({
    modelId,
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
        { text: promptText },
      ],
    }],
    inferenceConfig: {
      maxTokens: 5000,
      temperature: 0.1,
      topP: 0.9,
    },
  }));

  const sendAnalysis = async (modelId, promptText) => {
    const retryable = new Set([
      'ThrottlingException',
      'ServiceUnavailableException',
      'InternalServerException',
      'ModelTimeoutException',
      'ModelNotReadyException',
    ]);

    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await invokeAnalysisOnce(modelId, promptText);
      } catch (error) {
        lastError = error;
        const name = String(error?.name || error?.Code || '');
        const status = Number(error?.$metadata?.httpStatusCode || 0);
        const canRetry = retryable.has(name) || (status >= 500 && status <= 599);
        if (!canRetry || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
      }
    }
    throw lastError;
  };

  const continuitySensitive = Array.isArray(requirements?.continuityRules)
    && requirements.continuityRules.length > 0;
  let usedModelId = continuitySensitive && VIDEO_FALLBACK_MODEL_ID
    ? VIDEO_FALLBACK_MODEL_ID
    : MODEL_ID;
  let fallbackUsed = usedModelId !== MODEL_ID;
  let retryUsed = false;
  let result;

  try {
    result = await sendAnalysis(usedModelId, prompt);
  } catch (primaryError) {
    if (
      VIDEO_FALLBACK_MODEL_ID
      && VIDEO_FALLBACK_MODEL_ID !== usedModelId
    ) {
      retryUsed = true;
      usedModelId = VIDEO_FALLBACK_MODEL_ID;
      fallbackUsed = true;
      result = await sendAnalysis(usedModelId, prompt);
    } else {
      throw primaryError;
    }
  }

  let rawText = extractText(result);
  let parsed = parseVideoAnalysisModelJson(rawText);

  if (!hasSubstantiveVideoAnalysis(parsed)) {
    retryUsed = true;
    const recoveryPrompt = `${prompt}\n\nIMPORTANT RECOVERY INSTRUCTION: The primary analysis was empty or non-substantive. Inspect the full supplied video carefully and return the complete JSON analysis. Do not return an empty object, empty summary, or all-zero scores unless the video itself is genuinely blank.`;

    if (VIDEO_FALLBACK_MODEL_ID && VIDEO_FALLBACK_MODEL_ID !== MODEL_ID) {
      usedModelId = VIDEO_FALLBACK_MODEL_ID;
      fallbackUsed = true;
    }

    result = await sendAnalysis(usedModelId, recoveryPrompt);
    rawText = extractText(result);
    parsed = parseVideoAnalysisModelJson(rawText);
  }

  if (!hasSubstantiveVideoAnalysis(parsed)) {
    const error = new Error('The video was received but no reliable visual analysis could be produced by the primary or fallback analysis path. Try a shorter clip or a different supported encoding.');
    error.statusCode = 422;
    throw error;
  }

  const analysis = normalizeVideoAnalysis(
    parsed,
    { objective, requirements, hasTranscript: Boolean(transcript) },
  );

  return {
    analysis,
    usage: result?.usage || null,
    platform,
    objective,
    requirements,
    retryUsed,
    fallbackUsed,
    modelId: usedModelId,
  };
}

function planMessage(request) {
  const constraints = Object.keys(request?.constraints || {}).length
    ? `\n\nNORMALIZED USER CONSTRAINTS:\n${JSON.stringify(request.constraints)}`
    : '';
  return `Create a NEW campaign manifest. Do not treat this as a revision.\n\nCREATIVE BRIEF:\n${request.enrichedBrief}${constraints}`;
}

function revisionMessage(request) {
  const instruction = request.rawBrief
    || 'Improve the existing campaign by resolving production weaknesses while preserving its core concept and all unrelated decisions.';
  return `Revise the existing campaign according to this instruction. Preserve every unrelated decision materially unchanged. If the instruction is vague, make the smallest useful improvement rather than changing the concept.\n\nREVISION INSTRUCTION:\n${instruction}`;
}

function apiInfo() {
  return {
    name: 'ForgeDirector Video Creative Intelligence API',
    version: '1.2.0',
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
            modelId: result.modelId,
            platform: result.platform,
            objective: result.objective,
            requirementsApplied: Object.keys(result.requirements || {}).length > 0,
            analysisRetryUsed: result.retryUsed,
            fallbackModelUsed: result.fallbackUsed,
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
      const request = prepareCreativeRequest(payload);
      const result = await invokeDirector({
        message: planMessage(request),
        campaign: null,
        request,
        isRevision: false,
      });
      const qa = evaluateCampaign(result.campaign);
      return response(200, {
        campaign: result.campaign,
        qa,
        meta: {
          operation: 'plan',
          modelId: result.modelId,
          usage: result.usage,
          promptQuality: request.quality,
          assumptions: request.assumptions,
          automaticRepairUsed: result.repairUsed,
          rescueRewriteUsed: result.rescueRewriteUsed,
          briefEnrichmentUsed: result.briefEnrichmentUsed,
          briefEnrichment: result.briefEnrichment,
          degradedFallbackUsed: result.degradedFallbackUsed,
          initialQaScore: result.initialQa?.score ?? null,
          finalQaScore: qa.score,
          creativeQuality: result.creativeCritique,
          criticUsage: result.criticUsage,
          requestId,
        },
      });
    }

    if (method === 'POST' && path === '/v1/revise') {
      const campaign = assertCampaign(payload?.campaign);
      const request = prepareCreativeRequest({
        brief: payload?.instruction ?? payload?.message ?? '',
        constraints: {
          platform: campaign.platform,
          aspectRatio: campaign.aspectRatio,
          durationSeconds: campaign.durationSeconds,
          audience: campaign.audience,
        },
      });
      const result = await invokeDirector({
        message: revisionMessage(request),
        campaign,
        request,
        isRevision: true,
      });
      const qa = evaluateCampaign(result.campaign);
      return response(200, {
        campaign: result.campaign,
        qa,
        meta: {
          operation: 'revise',
          modelId: result.modelId,
          usage: result.usage,
          promptQuality: request.quality,
          assumptions: request.assumptions,
          automaticRepairUsed: result.repairUsed,
          rescueRewriteUsed: result.rescueRewriteUsed,
          briefEnrichmentUsed: result.briefEnrichmentUsed,
          briefEnrichment: result.briefEnrichment,
          degradedFallbackUsed: result.degradedFallbackUsed,
          initialQaScore: result.initialQa?.score ?? null,
          finalQaScore: qa.score,
          creativeQuality: result.creativeCritique,
          criticUsage: result.criticUsage,
          requestId,
        },
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
