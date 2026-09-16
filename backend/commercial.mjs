import { createHash } from 'node:crypto';
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
import {
  createVideoUpload,
  createVideoReadUrl,
  deleteVideoAsset,
  resolveVideoAsset,
  readAnalysisCache,
  writeAnalysisCache,
} from './storage.mjs';
import {
  VIDEO_ANALYSIS_SYSTEM_PROMPT,
  VIDEO_COMPLIANCE_SYSTEM_PROMPT,
  buildVideoAnalysisPrompt,
  buildVideoCompliancePrompt,
  normalizeVideoAnalysis,
  normalizeVideoCompliance,
  consensusVideoCompliance,
  applyVerifiedVideoCompliance,
  assessVideoAnalysisCoverage,
  isAuthoritativeVerifierCoverage,
  assertAssetId,
} from './video-intelligence.mjs';
import {
  VLLM_EXPERIMENT_CACHE_VERSION,
  experimentalVllmRequest,
  configuredVllmEndpoint,
  vllmExperimentCacheKey,
  analyzeWithExperimentalVllm,
} from './experimental-vllm.mjs';
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
  buildGuaranteedCampaign,
  assessGuaranteedCampaign,
  applyClaimSafety,
  campaignClaimSafety,
} from './director-reliability.mjs';

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
});

const MODEL_ID = process.env.BEDROCK_MODEL_ID;
const VIDEO_FALLBACK_MODEL_ID = process.env.VIDEO_FALLBACK_MODEL_ID || '';
const RAPIDAPI_PROXY_SECRET = process.env.RAPIDAPI_PROXY_SECRET || '';
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 120000);
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES || 31457280);
const VIDEO_ANALYSIS_CACHE_VERSION = 'fd-video-analysis-1.5|fd-shortform-v5|compliance-primary-blind-v1';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function videoAnalysisCacheKey({
  asset,
  platform,
  objective,
  audience,
  context,
  transcript,
  declaredDurationSeconds,
  requirements,
}) {
  const fingerprint = String(asset?.contentFingerprint || '').trim();
  if (!fingerprint) return null;

  const material = stableJson({
    version: VIDEO_ANALYSIS_CACHE_VERSION,
    contentFingerprint: fingerprint,
    sizeBytes: Number(asset?.sizeBytes || 0),
    contentType: String(asset?.contentType || ''),
    platform,
    objective,
    audience,
    context,
    transcript,
    declaredDurationSeconds,
    requirements,
    primaryModelId: MODEL_ID || null,
    fallbackModelId: VIDEO_FALLBACK_MODEL_ID || null,
  });

  return createHash('sha256').update(material).digest('hex');
}

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
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length === 0
  ) {
    const error = new Error('campaign must be a non-empty JSON object.');
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
  let modelServiceDegraded = false;
  let modelCallCount = 0;
  const aggregateUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  const MAX_MODEL_CALLS = 8;
  const markModelCall = () => {
    modelCallCount += 1;
    if (modelCallCount > MAX_MODEL_CALLS) {
      const error = new Error('ForgeDirector model-call budget exhausted for this request.');
      error.name = 'ModelCallBudgetExceeded';
      throw error;
    }
  };
  const recordModelUsage = (result) => {
    const usage = result?.usage || {};
    const inputTokens = Number(usage.inputTokens || 0);
    const outputTokens = Number(usage.outputTokens || 0);
    const totalTokens = Number(usage.totalTokens || (inputTokens + outputTokens));
    if (Number.isFinite(inputTokens) && inputTokens > 0) aggregateUsage.inputTokens += inputTokens;
    if (Number.isFinite(outputTokens) && outputTokens > 0) aggregateUsage.outputTokens += outputTokens;
    if (Number.isFinite(totalTokens) && totalTokens > 0) aggregateUsage.totalTokens += totalTokens;
  };
  const requestUsage = () => ({
    modelCalls: modelCallCount,
    inputTokens: aggregateUsage.inputTokens,
    outputTokens: aggregateUsage.outputTokens,
    totalTokens: aggregateUsage.totalTokens,
  });
  const isRetryableModelError = (error) => {
    const retryable = new Set([
      'ThrottlingException',
      'ServiceUnavailableException',
      'InternalServerException',
      'ModelTimeoutException',
      'ModelNotReadyException',
    ]);
    const name = String(error?.name || error?.Code || '');
    const status = Number(error?.$metadata?.httpStatusCode || 0);
    return retryable.has(name) || (status >= 500 && status <= 599);
  };

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
      requestUsage: requestUsage(),
      modelServiceDegraded,
      modelCallCount,
    };
  }

  const invokeOnce = async (modelId, promptText) => {
    markModelCall();
    const modelResult = await client.send(new ConverseCommand({
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
    recordModelUsage(modelResult);
    return modelResult;
  };

  const sendDirector = async (modelId, promptText) => {
    try {
      return await invokeOnce(modelId, promptText);
    } catch (error) {
      if (!isRetryableModelError(error)) throw error;
      modelServiceDegraded = true;
      await new Promise((resolve) => setTimeout(resolve, 350));
      return invokeOnce(modelId, promptText);
    }
  };

  const runCreativeCritic = async (candidate) => {
    if (!MODEL_ID) return { critique: null, usage: null, modelId: null };

    const invokeCriticOnce = async (modelId) => {
      markModelCall();
      const modelResult = await client.send(new ConverseCommand({
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
      recordModelUsage(modelResult);
      return modelResult;
    };

    const attempt = async (modelId) => {
      let criticResult;
      try {
        criticResult = await invokeCriticOnce(modelId);
      } catch (error) {
        if (!isRetryableModelError(error)) throw error;
        modelServiceDegraded = true;
        await new Promise((resolve) => setTimeout(resolve, 300));
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
    } catch {
      first = null;
    }

    const needsSecondOpinion = !first?.critique || critiqueNeedsRepair(first.critique);
    if (
      !modelServiceDegraded
      && needsSecondOpinion
      && VIDEO_FALLBACK_MODEL_ID
      && VIDEO_FALLBACK_MODEL_ID !== MODEL_ID
    ) {
      try {
        const fallback = await attempt(VIDEO_FALLBACK_MODEL_ID);
        if (fallback.critique) {
          if (!first?.critique) return fallback;
          if (fallback.critique.passed && !first.critique.passed) return fallback;
          if (
            fallback.critique.passed === first.critique.passed
            && fallback.critique.score >= first.critique.score
          ) return fallback;
          // When both critics still reject the candidate, prefer the stronger
          // model's diagnosis so the repair pass targets the harder standard.
          if (!fallback.critique.passed && !first.critique.passed) return fallback;
        }
      } catch {
        // Fall back to the primary critic result below.
      }
    }

    return first || { critique: null, usage: null, modelId: null };
  };

  let briefEnrichment = null;
  let briefEnrichmentUsed = false;

  const zeroSignalPrompt = !isRevision
    && (
      request?.quality?.issues?.includes('missing_brief')
      || (
        request?.quality?.issues?.includes('noisy_brief')
        && !String(request?.rawBrief || '').match(/[a-z0-9]{3,}/i)
      )
    );

  if (zeroSignalPrompt) {
    const deterministicEnrichment = normalizeBriefEnrichment({}, request);
    const quickCampaign = buildGuaranteedCampaign({
      request,
      briefEnrichment: deterministicEnrichment,
      previousCampaign: null,
      isRevision: false,
    });
    const quickQa = evaluateCampaign(quickCampaign);
    const quickAssessment = assessGuaranteedCampaign(quickCampaign);

    if (quickQa.passed && quickQa.score >= 90 && quickAssessment.passed) {
      try {
        const criticResult = await runCreativeCritic(quickCampaign);
        if (criticResult.critique?.passed) {
          return {
            campaign: validateManifest(quickCampaign),
            usage: null,
            repairUsed: false,
            rescueRewriteUsed: false,
            candidateTournamentUsed: false,
            candidateTournamentAttempts: 0,
            deterministicQualityFallbackUsed: false,
            guaranteedBlueprintUsed: true,
            guaranteedBlueprintAssessment: quickAssessment,
            briefEnrichmentUsed: true,
            briefEnrichment: deterministicEnrichment,
            degradedFallbackUsed: true,
            modelId: null,
            initialQa: quickQa,
            creativeCritique: criticResult.critique,
            criticUsage: criticResult.usage,
          };
        }
      } catch {
        // Continue into the full recovery pipeline if the quick quality check
        // cannot be completed reliably.
      }
    }
  }

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
        let enrichResult;
        try {
          markModelCall();
          enrichResult = await enrichWithModel(modelId);
          recordModelUsage(enrichResult);
        } catch (error) {
          if (isRetryableModelError(error)) modelServiceDegraded = true;
          throw error;
        }
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
  let forcedFallbackCampaign = null;
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
        degradedFallbackUsed = true;
        usedModelId = null;
        result = null;
        forcedFallbackCampaign = buildDeterministicFallbackCampaign({
          request,
          previousCampaign: campaign,
          isRevision,
        });
      }
    } else {
      degradedFallbackUsed = true;
      usedModelId = null;
      result = null;
      forcedFallbackCampaign = buildDeterministicFallbackCampaign({
        request,
        previousCampaign: campaign,
        isRevision,
      });
    }
  }

  let parsed = result ? parseDirectorJson(extractText(result)) : null;
  let normalized = forcedFallbackCampaign || normalizeCampaignManifest(parsed, {
    request,
    previousCampaign: campaign,
    isRevision,
  });
  if (isRevision && campaign) {
    normalized = applyRevisionPreservation(normalized, campaign, request?.rawBrief || '');
      normalized = applyClaimSafety(normalized, request);
  }
  let qa = evaluateCampaign(normalized);
  const initialQa = qa;
  let repairUsed = false;
  let rescueRewriteUsed = false;
  let candidateTournamentUsed = false;
  let candidateTournamentAttempts = 0;
  let creativeCritique = null;
  let criticUsage = null;

  try {
    const criticResult = await runCreativeCritic(normalized);
    creativeCritique = criticResult.critique;
    criticUsage = criticResult.usage;
  } catch {
    creativeCritique = null;
  }

  if (!modelServiceDegraded && (!parsed || !qa.passed || qa.score < 90 || (creativeCritique && critiqueNeedsRepair(creativeCritique)))) {
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
      repaired = applyClaimSafety(repaired, request);
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

  if (!modelServiceDegraded && creativeCritique && critiqueNeedsRepair(creativeCritique)) {
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
      rescueCandidate = applyClaimSafety(rescueCandidate, request);
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

  if (!modelServiceDegraded && (!creativeCritique || critiqueNeedsRepair(creativeCritique))) {
    candidateTournamentUsed = true;
    const tournamentModel = VIDEO_FALLBACK_MODEL_ID || usedModelId;
    const variants = [
      'ALTERNATIVE A: prioritize a visually arresting first frame, one concrete action per scene, and a clean before-to-after progression. Avoid montage filler.',
      'ALTERNATIVE B: prioritize product/subject specificity, generator-ready camera blocking, exact lighting continuity, and a distinct payoff composition. Avoid generic marketing imagery.',
    ];

    for (const variant of variants) {
      candidateTournamentAttempts += 1;
      const tournamentPrompt = `${message}\n\nQUALITY TOURNAMENT: Create a fresh alternative manifest rather than editing the previous candidate. ${variant} Resolve all known weak dimensions. Return JSON only.`;

      try {
        const altResult = await sendDirector(tournamentModel, tournamentPrompt);
        const altParsed = parseDirectorJson(extractText(altResult));
        if (!altParsed) continue;

        let altCandidate = normalizeCampaignManifest(altParsed, {
          request,
          previousCampaign: campaign,
          isRevision,
        });
        if (isRevision && campaign) {
          altCandidate = applyRevisionPreservation(altCandidate, campaign, request?.rawBrief || '');
      altCandidate = applyClaimSafety(altCandidate, request);
        }

        const altQa = evaluateCampaign(altCandidate);
        if (!altQa.passed || altQa.score < 90) continue;

        let altCritique = null;
        let altCriticUsage = null;
        try {
          const criticResult = await runCreativeCritic(altCandidate);
          altCritique = criticResult.critique;
          altCriticUsage = criticResult.usage;
        } catch {
          altCritique = null;
        }
        if (!altCritique) continue;

        const currentPass = creativeCritique?.passed === true;
        const altPass = altCritique.passed === true;
        const currentScore = creativeCritique?.score ?? 0;
        const altScore = altCritique.score ?? 0;

        if (
          (altPass && !currentPass)
          || (altPass === currentPass && altScore > currentScore)
        ) {
          normalized = altCandidate;
          qa = altQa;
          result = altResult;
          usedModelId = tournamentModel;
          creativeCritique = altCritique;
          if (altCriticUsage) criticUsage = altCriticUsage;
        }

        if (creativeCritique?.passed) break;
      } catch {
        // Continue to the next bounded candidate.
      }
    }
  }

  let deterministicQualityFallbackUsed = false;
  if (!creativeCritique || critiqueNeedsRepair(creativeCritique) || !qa.passed || qa.score < 90) {
    const allowDeterministicFallback = !isRevision || request?.quality?.tier !== 'good';
    if (allowDeterministicFallback) {
      deterministicQualityFallbackUsed = true;
      let fallbackCandidate = buildDeterministicFallbackCampaign({
        request,
        previousCampaign: campaign,
        isRevision,
      });
      if (isRevision && campaign) {
        fallbackCandidate = applyRevisionPreservation(fallbackCandidate, campaign, request?.rawBrief || '');
      fallbackCandidate = applyClaimSafety(fallbackCandidate, request);
      }

      const fallbackQa = evaluateCampaign(fallbackCandidate);
      let fallbackCritique = null;
      let fallbackCriticUsage = null;
      try {
        if (modelServiceDegraded) throw new Error('skip critic while model service is degraded');
        const criticResult = await runCreativeCritic(fallbackCandidate);
        fallbackCritique = criticResult.critique;
        fallbackCriticUsage = criticResult.usage;
      } catch {
        fallbackCritique = null;
      }

      if (
        fallbackQa.passed
        && fallbackQa.score >= 90
        && fallbackCritique?.passed
      ) {
        normalized = fallbackCandidate;
        qa = fallbackQa;
        creativeCritique = fallbackCritique;
        if (fallbackCriticUsage) criticUsage = fallbackCriticUsage;
        degradedFallbackUsed = true;
      }
    }
  }

  let guaranteedBlueprintUsed = false;
  let guaranteedBlueprintAssessment = null;

  if (
    !qa.passed
    || qa.score < 90
    || !creativeCritique
    || critiqueNeedsRepair(creativeCritique)
  ) {
    if (!modelServiceDegraded && !isRevision && !briefEnrichment && MODEL_ID) {
      const finalEnrichmentModels = [
        VIDEO_FALLBACK_MODEL_ID,
        MODEL_ID,
      ].filter(Boolean);

      for (const modelId of [...new Set(finalEnrichmentModels)]) {
        try {
          markModelCall();
          const enrichResult = await client.send(new ConverseCommand({
            modelId,
            system: [{ text: BRIEF_ENRICHER_SYSTEM_PROMPT }],
            messages: [{
              role: 'user',
              content: [{ text: buildBriefEnricherPrompt({ request }) }],
            }],
            inferenceConfig: {
              maxTokens: 1500,
              temperature: 0.1,
              topP: 0.9,
            },
          }));
          recordModelUsage(enrichResult);
          const parsedEnrichment = parseDirectorJson(extractText(enrichResult));
          const normalizedEnrichment = normalizeBriefEnrichment(parsedEnrichment, request);
          if (normalizedEnrichment) {
            briefEnrichment = normalizedEnrichment;
            briefEnrichmentUsed = true;
            request.enrichedBrief = normalizedEnrichment.resolvedBrief;
            break;
          }
        } catch {
          // The deterministic subject extractor below remains available.
        }
      }
    }

    let guaranteed = buildGuaranteedCampaign({
      request,
      briefEnrichment,
      previousCampaign: campaign,
      isRevision,
    });

    if (isRevision && campaign) {
      guaranteed = applyRevisionPreservation(
        guaranteed,
        campaign,
        request?.rawBrief || '',
      );
      guaranteed = applyClaimSafety(guaranteed, request);
    }

    const guaranteedQa = evaluateCampaign(guaranteed);
    const guaranteedAssessment = isRevision && campaign
      ? {
          passed: guaranteedQa.passed && guaranteedQa.score >= 90,
          method: 'validated-previous-campaign-preservation-v1',
          checks: {
            structuralQaPassed: guaranteedQa.passed,
            structuralQaAtLeast90: guaranteedQa.score >= 90,
            scenesPreserved: true,
          },
        }
      : assessGuaranteedCampaign(guaranteed);

    if (
      guaranteedQa.passed
      && guaranteedQa.score >= 90
      && guaranteedAssessment.passed
    ) {
      normalized = guaranteed;
      qa = guaranteedQa;
      guaranteedBlueprintUsed = true;
      guaranteedBlueprintAssessment = guaranteedAssessment;
      degradedFallbackUsed = true;

      // The deterministic blueprint is the release authority here. Keep the
      // model critic as advisory metadata if it exists rather than allowing a
      // stochastic critic disagreement to turn a safe result into an outage.
      try {
        if (modelServiceDegraded) throw new Error('skip advisory critic while model service is degraded');
        const criticResult = await runCreativeCritic(guaranteed);
        if (criticResult.critique) {
          creativeCritique = criticResult.critique;
          if (criticResult.usage) criticUsage = criticResult.usage;
        }
      } catch {
        // Safe deterministic assessment remains authoritative.
      }
    }
  }

  normalized = applyClaimSafety(normalized, request);
  qa = evaluateCampaign(normalized);
  const claimSafetyAssessment = campaignClaimSafety(normalized, request);

  if (
    !qa.passed
    || qa.score < 90
    || !claimSafetyAssessment.passed
    || (
      !guaranteedBlueprintUsed
      && (!creativeCritique || critiqueNeedsRepair(creativeCritique))
    )
  ) {
    const error = new Error('ForgeDirector could not produce a campaign that met the production quality gate. No below-standard campaign was returned.');
    error.statusCode = 503;
    throw error;
  }

  try {
    return {
      campaign: validateManifest(normalized),
      usage: result?.usage || null,
      repairUsed,
      rescueRewriteUsed,
      candidateTournamentUsed,
      candidateTournamentAttempts,
      deterministicQualityFallbackUsed,
      guaranteedBlueprintUsed,
      guaranteedBlueprintAssessment,
      briefEnrichmentUsed,
      briefEnrichment,
      degradedFallbackUsed,
      modelId: usedModelId,
      initialQa,
      creativeCritique,
      criticUsage,
      modelServiceDegraded,
      modelCallCount,
      requestUsage: requestUsage(),
      claimSafetyAssessment,
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
      candidateTournamentUsed,
      candidateTournamentAttempts,
      deterministicQualityFallbackUsed,
      guaranteedBlueprintUsed,
      guaranteedBlueprintAssessment,
      briefEnrichmentUsed,
      briefEnrichment,
      degradedFallbackUsed,
      modelId: usedModelId,
      initialQa,
      creativeCritique,
      criticUsage,
      modelServiceDegraded,
      modelCallCount,
      requestUsage: requestUsage(),
      claimSafetyAssessment,
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

  const analysisCacheKey = videoAnalysisCacheKey({
    asset,
    platform,
    objective,
    audience,
    context,
    transcript,
    declaredDurationSeconds,
    requirements,
  });

  if (analysisCacheKey) {
    const cached = await readAnalysisCache(analysisCacheKey);
    if (cached?.value?.analysis) {
      const cachedValue = cached.value;
      return {
        ...cachedValue,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        complianceVerificationUsage: cachedValue.complianceVerificationUsage
          ? {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            }
          : null,
        analysisCacheHit: true,
        analysisCacheAgeSeconds: cached.ageSeconds,
        analysisCacheVersion: VIDEO_ANALYSIS_CACHE_VERSION,
      };
    }
  }

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

  let analysis = normalizeVideoAnalysis(
    parsed,
    {
      objective,
      requirements,
      hasTranscript: Boolean(transcript),
      declaredDurationSeconds,
    },
  );

  let coverageRetryUsed = false;
  if (
    declaredDurationSeconds
    && analysis?.coverage?.fullDurationReviewed === false
  ) {
    retryUsed = true;
    coverageRetryUsed = true;

    const coverageRecoveryPrompt = `${prompt}\n\nFULL-DURATION RECOVERY REQUIRED: Your previous timeline did not demonstrate inspection of the complete declared ${declaredDurationSeconds}-second video. Reinspect the ENTIRE supplied clip from first frame through final frame. Return chronological timeline segments spanning opening, middle, and end. Timeline intervals must collectively cover at least 95% of ${declaredDurationSeconds}, beginning near 0 seconds and reaching the final 5% of the clip without skipping large middle sections. Re-evaluate continuity, CTA, mustShow, mustNotShow, mustIncludeText, and all other requirements using evidence from the whole clip. Do not state that analysis is limited to the first three seconds.`;

    if (VIDEO_FALLBACK_MODEL_ID) {
      usedModelId = VIDEO_FALLBACK_MODEL_ID;
      fallbackUsed = usedModelId !== MODEL_ID;
    }

    result = await sendAnalysis(usedModelId, coverageRecoveryPrompt);
    rawText = extractText(result);
    parsed = parseVideoAnalysisModelJson(rawText);

    if (hasSubstantiveVideoAnalysis(parsed)) {
      analysis = normalizeVideoAnalysis(
        parsed,
        {
          objective,
          requirements,
          hasTranscript: Boolean(transcript),
          declaredDurationSeconds,
        },
      );
    }
  }

  if (
    declaredDurationSeconds
    && analysis?.coverage?.fullDurationReviewed === false
  ) {
    const error = new Error(
      `The video was received, but ForgeDirector could not verify full-duration coverage through the declared ${declaredDurationSeconds} seconds. No partial-video QA verdict was returned.`,
    );
    error.statusCode = 422;
    throw error;
  }

  let complianceVerificationUsed = false;
  let complianceVerificationRetryUsed = false;
  let complianceVerificationModelId = null;
  let complianceVerificationModelIds = [];
  let complianceVerificationUsage = null;
  let complianceVerificationCoverage = null;
  let complianceVerificationAgreement = null;
  let complianceVerificationConsensusUsed = false;
  let complianceVerificationDiagnostics = [];

  if (Object.keys(requirements || {}).length > 0) {
    complianceVerificationUsed = true;
    const compliancePrompt = buildVideoCompliancePrompt({
      requirements,
      declaredDurationSeconds,
    });

    const invokeComplianceOnce = async (modelId, promptText) => client.send(new ConverseCommand({
      modelId,
      system: [{ text: VIDEO_COMPLIANCE_SYSTEM_PROMPT }],
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
        maxTokens: 2600,
        temperature: 0,
        topP: 0.9,
      },
    }));

    const isRetryableComplianceError = (error) => {
      const name = String(error?.name || error?.Code || '');
      const status = Number(error?.$metadata?.httpStatusCode || 0);
      return [
        'ThrottlingException',
        'ServiceUnavailableException',
        'InternalServerException',
        'ModelTimeoutException',
        'ModelNotReadyException',
        'ModelErrorException',
      ].includes(name) || (status >= 500 && status <= 599) || status === 424;
    };

    const invokeComplianceWithRetry = async (modelId, promptText) => {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await invokeComplianceOnce(modelId, promptText);
        } catch (error) {
          lastError = error;
          if (!isRetryableComplianceError(error) || attempt === 2) throw error;
          complianceVerificationRetryUsed = true;
          await new Promise((resolve) => setTimeout(resolve, 400 * (2 ** attempt)));
        }
      }
      throw lastError;
    };

    const complianceModels = [...new Set([
      VIDEO_FALLBACK_MODEL_ID,
      MODEL_ID,
    ].filter(Boolean))];

    const verificationRecords = [];
    const verifierDiagnostics = complianceVerificationDiagnostics;
    let lastVerifierError = null;
    const verifierUsageTotals = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };

    const recordVerifierUsage = (result) => {
      const usage = result?.usage || {};
      const inputTokens = Number(usage.inputTokens || 0);
      const outputTokens = Number(usage.outputTokens || 0);
      const totalTokens = Number(usage.totalTokens || (inputTokens + outputTokens));
      if (Number.isFinite(inputTokens) && inputTokens > 0) verifierUsageTotals.inputTokens += inputTokens;
      if (Number.isFinite(outputTokens) && outputTokens > 0) verifierUsageTotals.outputTokens += outputTokens;
      if (Number.isFinite(totalTokens) && totalTokens > 0) verifierUsageTotals.totalTokens += totalTokens;
    };

    const verifierErrorCode = (error) => {
      const name = String(error?.name || error?.Code || '');
      const status = Number(error?.$metadata?.httpStatusCode || 0);
      if (name === 'ValidationException') return 'model_validation';
      if (name === 'ThrottlingException') return 'model_throttled';
      if (name === 'ModelTimeoutException') return 'model_timeout';
      if (name === 'ServiceUnavailableException') return 'model_unavailable';
      if (name === 'ModelNotReadyException') return 'model_not_ready';
      if (name === 'ModelErrorException' || status === 424) return 'model_execution';
      if (status >= 500) return 'model_5xx';
      return `model_error_${name || 'unknown'}`;
    };

    for (const verifierModelId of complianceModels) {
      let verifierParsed = null;
      let verifierResult = null;

      try {
        verifierResult = await invokeComplianceWithRetry(verifierModelId, compliancePrompt);
        recordVerifierUsage(verifierResult);
        verifierParsed = parseVideoAnalysisModelJson(extractText(verifierResult));

        if (!verifierParsed) {
          complianceVerificationRetryUsed = true;
          const recoveryPrompt = `${compliancePrompt}\n\nJSON RECOVERY: Return the required JSON object only. Keep your independently observed compliance verdicts and visual evidence. Do not add markdown or commentary.`;
          const recoveryResult = await invokeComplianceWithRetry(verifierModelId, recoveryPrompt);
          recordVerifierUsage(recoveryResult);
          verifierParsed = parseVideoAnalysisModelJson(extractText(recoveryResult));
          verifierResult = recoveryResult;
        }

        if (!verifierParsed) {
          lastVerifierError = new Error('Blind compliance verifier returned invalid JSON after one recovery attempt.');
          lastVerifierError.diagnosticCode = 'compliance_verifier_invalid_json';
          verifierDiagnostics.push({
            modelId: verifierModelId,
            stage: 'json',
            code: 'invalid_json',
          });
          continue;
        }

        let normalizedCompliance = normalizeVideoCompliance(verifierParsed, requirements);
        if (!normalizedCompliance) {
          lastVerifierError = new Error('Blind compliance verifier did not return a usable normalized compliance result.');
          lastVerifierError.diagnosticCode = 'compliance_verifier_unusable_result';
          verifierDiagnostics.push({
            modelId: verifierModelId,
            stage: 'normalize',
            code: 'unusable_result',
          });
          continue;
        }

        let verifierCoverage = assessVideoAnalysisCoverage(verifierParsed, declaredDurationSeconds);

        if (
          declaredDurationSeconds
          && !isAuthoritativeVerifierCoverage(
            verifierCoverage,
            declaredDurationSeconds,
          )
        ) {
          complianceVerificationRetryUsed = true;
          const coverageRecoveryPrompt = `${compliancePrompt}\n\nFULL-DURATION VERIFIER RECOVERY: Your previous timeline did not prove inspection of at least 95% of the declared ${declaredDurationSeconds}-second clip. Reinspect the video from near 0 seconds through the final 5%, cover the middle contiguously, and then re-evaluate every requirement from observable evidence only. Return the required JSON object only.`;

          try {
            const coverageRecoveryResult = await invokeComplianceWithRetry(
              verifierModelId,
              coverageRecoveryPrompt,
            );
            recordVerifierUsage(coverageRecoveryResult);
            const recoveredParsed = parseVideoAnalysisModelJson(
              extractText(coverageRecoveryResult),
            );

            if (recoveredParsed) {
              const recoveredCompliance = normalizeVideoCompliance(
                recoveredParsed,
                requirements,
              );
              const recoveredCoverage = assessVideoAnalysisCoverage(
                recoveredParsed,
                declaredDurationSeconds,
              );

              if (
                recoveredCompliance
                && isAuthoritativeVerifierCoverage(
                  recoveredCoverage,
                  declaredDurationSeconds,
                )
              ) {
                verifierParsed = recoveredParsed;
                normalizedCompliance = recoveredCompliance;
                verifierCoverage = recoveredCoverage;
                verifierResult = coverageRecoveryResult;
              }
            }
          } catch (error) {
            lastVerifierError = error;
          }
        }

        if (
          declaredDurationSeconds
          && !isAuthoritativeVerifierCoverage(
            verifierCoverage,
            declaredDurationSeconds,
          )
        ) {
          lastVerifierError = new Error(
            'Blind compliance verifier did not demonstrate required full-duration coverage.',
          );
          lastVerifierError.diagnosticCode = 'compliance_verifier_incomplete_coverage';
          verifierDiagnostics.push({
            modelId: verifierModelId,
            stage: 'coverage',
            code: 'incomplete_coverage',
            coverageRatio: verifierCoverage?.coverageRatio ?? null,
            observedThroughSeconds: verifierCoverage?.observedThroughSeconds ?? null,
            timelineSegments: verifierCoverage?.timelineSegments ?? null,
          });
          continue;
        }

        verificationRecords.push({
          modelId: verifierModelId,
          compliance: normalizedCompliance,
          coverage: verifierCoverage,
          usage: verifierResult?.usage || null,
        });
        verifierDiagnostics.push({
          modelId: verifierModelId,
          stage: 'complete',
          code: 'usable',
          coverageRatio: verifierCoverage?.coverageRatio ?? null,
          observedThroughSeconds: verifierCoverage?.observedThroughSeconds ?? null,
          timelineSegments: verifierCoverage?.timelineSegments ?? null,
        });
      } catch (error) {
        const name = String(error?.name || error?.Code || '');
        const status = Number(error?.$metadata?.httpStatusCode || 0);
        error.diagnosticCode = error?.diagnosticCode
          || (
            name === 'ValidationException'
              ? 'compliance_verifier_model_validation'
              : name === 'ThrottlingException'
                ? 'compliance_verifier_model_throttled'
                : name === 'ModelTimeoutException'
                  ? 'compliance_verifier_model_timeout'
                  : name === 'ServiceUnavailableException'
                    ? 'compliance_verifier_model_unavailable'
                    : name === 'ModelNotReadyException'
                      ? 'compliance_verifier_model_not_ready'
                      : name === 'ModelErrorException' || status === 424
                        ? 'compliance_verifier_model_execution'
                        : status >= 500
                          ? 'compliance_verifier_model_5xx'
                          : 'compliance_verifier_model_error'
          );
        lastVerifierError = error;
        verifierDiagnostics.push({
          modelId: verifierModelId,
          stage: 'invoke',
          code: verifierErrorCode(error),
          errorName: String(error?.name || error?.Code || 'Error'),
          httpStatus: Number(error?.$metadata?.httpStatusCode || 0) || null,
        });
        complianceVerificationRetryUsed = true;
      }
    }

    if (!verificationRecords.length) {
      const error = new Error(
        'The video was analyzed, but ForgeDirector could not obtain any usable independent compliance verification. No potentially context-influenced compliance verdict was returned.',
      );
      error.statusCode = 422;
      error.diagnosticCode = lastVerifierError?.diagnosticCode || 'compliance_verifier_unresolved';
      error.verifierDiagnostics = verifierDiagnostics;
      error.cause = lastVerifierError;
      throw error;
    }

    const primaryEvidenceUsable = (
      analysis?.compliance
      && Array.isArray(analysis.compliance.checks)
      && (
        !declaredDurationSeconds
        || analysis?.coverage?.fullDurationReviewed === true
      )
    );

    const consensusSources = [
      ...(primaryEvidenceUsable
        ? [{
            ...analysis.compliance,
            evidenceSource: 'primary_full_duration_analysis',
          }]
        : []),
      ...verificationRecords.map((record) => ({
        ...record.compliance,
        evidenceSource: `blind_${record.modelId}`,
      })),
    ];

    const consensus = consensusVideoCompliance(
      consensusSources,
      requirements,
    );

    complianceVerificationConsensusUsed = consensusSources.length > 1;
    complianceVerificationAgreement = {
      ...consensus.agreement,
      primaryEvidenceUsed: primaryEvidenceUsable,
      blindVerifierCount: verificationRecords.length,
      evidenceSourceCount: consensusSources.length,
    };
    complianceVerificationModelIds = verificationRecords.map((record) => record.modelId);
    complianceVerificationModelId = complianceVerificationModelIds[0] || null;
    complianceVerificationUsage = verifierUsageTotals.totalTokens > 0
      ? verifierUsageTotals
      : null;

    const coverageCandidates = verificationRecords
      .map((record) => record.coverage)
      .filter(Boolean)
      .sort((a, b) => (
        Number(b?.coverageRatio || 0) - Number(a?.coverageRatio || 0)
      ));
    complianceVerificationCoverage = coverageCandidates[0] || null;

    analysis = applyVerifiedVideoCompliance(analysis, consensus.compliance);
  }

  const analysisResult = {
    analysis,
    usage: result?.usage || null,
    platform,
    objective,
    requirements,
    retryUsed,
    coverageRetryUsed,
    fallbackUsed,
    modelId: usedModelId,
    complianceVerificationUsed,
    complianceVerificationRetryUsed,
    complianceVerificationModelId,
    complianceVerificationModelIds,
    complianceVerificationUsage,
    complianceVerificationCoverage,
    complianceVerificationAgreement,
    complianceVerificationConsensusUsed,
    complianceVerificationDiagnostics,
    analysisCacheHit: false,
    analysisCacheAgeSeconds: 0,
    analysisCacheVersion: VIDEO_ANALYSIS_CACHE_VERSION,
  };

  if (analysisCacheKey) {
    await writeAnalysisCache(analysisCacheKey, analysisResult);
  }

  return analysisResult;
}


async function invokeExperimentalVllmAnalysis({ asset, payload, experiment }) {
  const endpoint = configuredVllmEndpoint(experiment.profileName);

  // Reuse the production request validators before an experimental request can
  // reach another runtime. The experiment changes inference, not the public
  // input contract.
  const platform = assertPlatform(payload?.platform);
  const objective = assertObjective(payload?.objective);
  const audience = assertText(payload?.audience, 'audience', 1000, false);
  const context = assertText(payload?.context, 'context', 3000, false);
  const transcript = assertText(payload?.transcript, 'transcript', 12000, false);
  const declaredDurationSeconds = assertDeclaredDuration(payload?.durationSeconds);
  const requirements = assertRequirements(payload?.requirements);

  const normalizedRequest = {
    platform,
    objective,
    audience,
    context,
    transcript,
    declaredDurationSeconds,
    requirements,
  };
  const cacheKey = vllmExperimentCacheKey({
    asset,
    request: normalizedRequest,
    endpoint,
  });

  if (cacheKey) {
    const cached = await readAnalysisCache(cacheKey);
    if (cached?.value?.analysis) {
      return {
        ...cached.value,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        complianceVerificationUsage: cached.value.complianceVerificationUsage
          ? { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
          : null,
        performance: {
          modelCalls: 0,
          modelCallLatenciesMs: [],
          totalModelLatencyMs: 0,
          cachedFreshPerformance: cached.value.performance || null,
        },
        analysisCacheHit: true,
        analysisCacheAgeSeconds: cached.ageSeconds,
        analysisCacheVersion: VLLM_EXPERIMENT_CACHE_VERSION,
      };
    }
  }

  // vLLM may fetch the video separately for primary analysis and blind
  // verification, so use the existing maximum upload-ticket lifetime rather
  // than a single-request-sized URL.
  const videoUrl = await createVideoReadUrl(asset.assetId, 900);
  const result = await analyzeWithExperimentalVllm({
    payload: {
      platform,
      objective,
      audience,
      context,
      transcript,
      durationSeconds: declaredDurationSeconds,
      requirements,
    },
    videoUrl,
    endpoint,
  });

  const experimentalResult = {
    ...result,
    platform,
    objective,
    requirements,
    modelId: endpoint.model,
    analysisBackend: 'vllm',
    analysisCacheHit: false,
    analysisCacheAgeSeconds: 0,
    analysisCacheVersion: VLLM_EXPERIMENT_CACHE_VERSION,
  };

  if (cacheKey) await writeAnalysisCache(cacheKey, experimentalResult);
  return experimentalResult;
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
    version: '1.3.0',
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
    const message = error instanceof SyntaxError
      ? 'Request body must be valid JSON.'
      : (error?.message || 'Request body must be valid JSON.');
    return response(error?.statusCode || 400, { error: message, requestId });
  }

  try {
    if (method === 'POST' && path === '/v1/uploads') {
      const contentType = assertText(payload?.contentType, 'contentType', 100);
      if (payload?.sizeBytes === undefined || payload?.sizeBytes === null || payload?.sizeBytes === '') {
        const error = new Error('sizeBytes is required.');
        error.statusCode = 400;
        throw error;
      }
      const declaredSize = Number(payload.sizeBytes);
      if (!Number.isInteger(declaredSize) || declaredSize <= 0 || declaredSize > MAX_VIDEO_BYTES) {
        const error = new Error(`sizeBytes must be an integer between 1 and ${MAX_VIDEO_BYTES}.`);
        error.statusCode = 400;
        throw error;
      }

      const assetId = crypto.randomUUID();
      const upload = await createVideoUpload({ assetId, contentType, sizeBytes: declaredSize });
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
      const assetId = assertAssetId(assertText(payload?.assetId, 'assetId', 100));
      try {
        const asset = await resolveVideoAsset(assetId);
        const experiment = experimentalVllmRequest(payload);
        const result = experiment
          ? await invokeExperimentalVllmAnalysis({ asset, payload, experiment })
          : await invokeVideoAnalysis({ asset, payload });
        return response(200, {
          analysis: result.analysis,
          meta: {
            operation: 'analyze',
            analysisBackend: result.analysisBackend || 'bedrock',
            experiment: result.experiment || null,
            performance: result.performance || null,
            modelId: result.modelId,
            platform: result.platform,
            objective: result.objective,
            requirementsApplied: Object.keys(result.requirements || {}).length > 0,
            analysisRetryUsed: result.retryUsed,
            coverageRetryUsed: result.coverageRetryUsed,
            fallbackModelUsed: result.fallbackUsed,
            complianceVerificationUsed: result.complianceVerificationUsed,
            complianceVerificationRetryUsed: result.complianceVerificationRetryUsed,
            complianceVerificationModelId: result.complianceVerificationModelId,
            complianceVerificationModelIds: result.complianceVerificationModelIds,
            complianceVerificationUsage: result.complianceVerificationUsage,
            complianceVerificationCoverage: result.complianceVerificationCoverage,
            complianceVerificationAgreement: result.complianceVerificationAgreement,
            complianceVerificationConsensusUsed: result.complianceVerificationConsensusUsed,
            complianceVerificationDiagnostics: result.complianceVerificationDiagnostics,
            analysisCacheHit: result.analysisCacheHit === true,
            analysisCacheAgeSeconds: result.analysisCacheAgeSeconds ?? null,
            analysisCacheVersion: result.analysisCacheVersion || null,
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
      const campaign = assertCampaign(payload?.campaign);
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
          candidateTournamentUsed: result.candidateTournamentUsed,
          candidateTournamentAttempts: result.candidateTournamentAttempts,
          deterministicQualityFallbackUsed: result.deterministicQualityFallbackUsed,
          guaranteedBlueprintUsed: result.guaranteedBlueprintUsed,
          guaranteedBlueprintAssessment: result.guaranteedBlueprintAssessment,
          briefEnrichmentUsed: result.briefEnrichmentUsed,
          briefEnrichment: result.briefEnrichment,
          degradedFallbackUsed: result.degradedFallbackUsed,
          initialQaScore: result.initialQa?.score ?? null,
          finalQaScore: qa.score,
          creativeQuality: result.creativeCritique,
          claimSafety: result.claimSafetyAssessment,
          qualityGate: result.guaranteedBlueprintUsed
            ? {
                passed: result.guaranteedBlueprintAssessment?.passed === true
                  && result.claimSafetyAssessment?.passed !== false,
                method: result.guaranteedBlueprintAssessment?.method || 'deterministic-production-blueprint-v1',
                structuralQa: qa.score,
                criticAdvisoryScore: result.creativeCritique?.score ?? null,
              }
            : {
                passed: result.creativeCritique?.passed === true
                  && qa.passed
                  && qa.score >= 90
                  && result.claimSafetyAssessment?.passed !== false,
                method: 'semantic-critic-v1',
                structuralQa: qa.score,
                creativeScore: result.creativeCritique?.score ?? null,
              },
          modelServiceDegraded: result.modelServiceDegraded,
          modelCallCount: result.modelCallCount,
          requestUsage: result.requestUsage,
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
          candidateTournamentUsed: result.candidateTournamentUsed,
          candidateTournamentAttempts: result.candidateTournamentAttempts,
          deterministicQualityFallbackUsed: result.deterministicQualityFallbackUsed,
          guaranteedBlueprintUsed: result.guaranteedBlueprintUsed,
          guaranteedBlueprintAssessment: result.guaranteedBlueprintAssessment,
          briefEnrichmentUsed: result.briefEnrichmentUsed,
          briefEnrichment: result.briefEnrichment,
          degradedFallbackUsed: result.degradedFallbackUsed,
          initialQaScore: result.initialQa?.score ?? null,
          finalQaScore: qa.score,
          creativeQuality: result.creativeCritique,
          claimSafety: result.claimSafetyAssessment,
          qualityGate: result.guaranteedBlueprintUsed
            ? {
                passed: result.guaranteedBlueprintAssessment?.passed === true
                  && result.claimSafetyAssessment?.passed !== false,
                method: result.guaranteedBlueprintAssessment?.method || 'deterministic-production-blueprint-v1',
                structuralQa: qa.score,
                criticAdvisoryScore: result.creativeCritique?.score ?? null,
              }
            : {
                passed: result.creativeCritique?.passed === true
                  && qa.passed
                  && qa.score >= 90
                  && result.claimSafetyAssessment?.passed !== false,
                method: 'semantic-critic-v1',
                structuralQa: qa.score,
                creativeScore: result.creativeCritique?.score ?? null,
              },
          modelServiceDegraded: result.modelServiceDegraded,
          modelCallCount: result.modelCallCount,
          requestUsage: result.requestUsage,
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
      ...(error?.diagnosticCode ? { diagnosticCode: error.diagnosticCode } : {}),
      ...(Array.isArray(error?.verifierDiagnostics)
        ? { verifierDiagnostics: error.verifierDiagnostics }
        : {}),
      requestId,
    });
  }
};
