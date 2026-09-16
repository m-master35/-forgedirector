import { createHash } from 'node:crypto';
import {
  VIDEO_ANALYSIS_SYSTEM_PROMPT, VIDEO_COMPLIANCE_SYSTEM_PROMPT,
  buildVideoAnalysisPrompt, buildVideoCompliancePrompt, normalizeVideoAnalysis,
  normalizeVideoCompliance, consensusVideoCompliance, applyVerifiedVideoCompliance,
  assessVideoAnalysisCoverage, isAuthoritativeVerifierCoverage,
} from './video-intelligence.mjs';

export const VLLM_EXPERIMENT_CACHE_VERSION = 'fd-vllm-pruning-exp-v1|fd-video-analysis-1.5|fd-shortform-v5';
export const VLLM_PRUNING_PROFILES = Object.freeze({
  baseline: { level: 'baseline', pruningRate: 0, pruningMethod: 'evs' },
  'evs-conservative': { level: 'conservative', pruningRate: 0.25, pruningMethod: 'evs' },
  'evs-medium': { level: 'medium', pruningRate: 0.5, pruningMethod: 'evs' },
  'evs-aggressive': { level: 'aggressive', pruningRate: 0.75, pruningMethod: 'evs' },
  'vidcom2-conservative': { level: 'conservative', pruningRate: 0.25, pruningMethod: 'vidcom2' },
  'vidcom2-medium': { level: 'medium', pruningRate: 0.5, pruningMethod: 'vidcom2' },
  'vidcom2-aggressive': { level: 'aggressive', pruningRate: 0.75, pruningMethod: 'vidcom2' },
});

export function vllmLaunchArgs(name) {
  const p = VLLM_PRUNING_PROFILES[name];
  if (!p) throw new Error(`Unknown vLLM pruning profile: ${name}`);
  return p.pruningRate ? ['--video-pruning-rate', String(p.pruningRate), '--video-pruning-method', p.pruningMethod] : [];
}

export function experimentalVllmRequest(payload = {}, env = process.env) {
  const x = payload?.experiment;
  if (!x?.backend) return null;
  if (String(x.backend).toLowerCase() !== 'vllm') throw Object.assign(new Error('Unsupported video analysis experiment backend.'), { statusCode: 400 });
  if (String(env.FORGEDIRECTOR_VLLM_EXPERIMENT_ENABLED || '').toLowerCase() !== 'true') throw Object.assign(new Error('The vLLM video-analysis experiment is disabled.'), { statusCode: 403 });
  const profileName = String(x.profile || '').trim();
  if (!VLLM_PRUNING_PROFILES[profileName]) throw Object.assign(new Error(`Unknown vLLM pruning profile: ${profileName || '(missing)'}.`), { statusCode: 400 });
  return { profileName, profile: VLLM_PRUNING_PROFILES[profileName] };
}

export function configuredVllmEndpoint(name, env = process.env) {
  const p = VLLM_PRUNING_PROFILES[name];
  if (!p) throw new Error(`Unknown vLLM pruning profile: ${name}`);
  let all;
  try { all = JSON.parse(String(env.VLLM_EXPERIMENT_ENDPOINTS_JSON || '{}')); }
  catch { throw Object.assign(new Error('VLLM_EXPERIMENT_ENDPOINTS_JSON must be valid JSON.'), { statusCode: 503 }); }
  const raw = all?.[name];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Object.assign(new Error(`No vLLM endpoint is configured for profile ${name}.`), { statusCode: 503 });
  const endpoint = {
    profileName: name, ...p, baseUrl: String(raw.baseUrl || '').replace(/\/+$/, ''),
    model: String(raw.model || '').trim(), vllmVersion: String(raw.vllmVersion || '').trim(),
    apiKey: String(raw.apiKey || env.VLLM_EXPERIMENT_API_KEY || '').trim(),
  };
  if (!/^https?:\/\//i.test(endpoint.baseUrl) || !endpoint.model || !endpoint.vllmVersion) throw Object.assign(new Error(`vLLM endpoint ${name} requires baseUrl, model, and vllmVersion.`), { statusCode: 503 });
  if (Number(raw.pruningRate) !== p.pruningRate || String(raw.pruningMethod || 'evs').toLowerCase() !== p.pruningMethod) throw Object.assign(new Error(`vLLM endpoint ${name} pruning declaration does not match its profile.`), { statusCode: 503 });
  if (p.pruningMethod === 'vidcom2' && !/qwen3[-_/ ]?vl/i.test(endpoint.model)) throw Object.assign(new Error('VidCom2 experiment profiles require a Qwen3-VL model.'), { statusCode: 503 });
  return endpoint;
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export function vllmExperimentCacheKey({ asset, request, endpoint }) {
  const fp = String(asset?.contentFingerprint || '').trim();
  if (!fp) return null;
  const material = { cacheVersion: VLLM_EXPERIMENT_CACHE_VERSION, fingerprint: fp, sizeBytes: Number(asset?.sizeBytes || 0), contentType: String(asset?.contentType || ''), request, profile: endpoint.profileName, model: endpoint.model, vllmVersion: endpoint.vllmVersion, pruningRate: endpoint.pruningRate, pruningMethod: endpoint.pruningMethod };
  return createHash('sha256').update(stable(material)).digest('hex');
}

function requestOf(p = {}) { return { platform: String(p.platform || 'General'), objective: String(p.objective || 'engagement'), audience: String(p.audience || '').trim(), context: String(p.context || '').trim(), transcript: String(p.transcript || '').trim(), declaredDurationSeconds: p.durationSeconds == null ? null : Number(p.durationSeconds), requirements: p.requirements && typeof p.requirements === 'object' && !Array.isArray(p.requirements) ? p.requirements : {} }; }
function parseJson(text) { try { const v = JSON.parse(String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } }
function use(body) { const u = body?.usage || {}; const i = Number(u.prompt_tokens || u.input_tokens || 0), o = Number(u.completion_tokens || u.output_tokens || 0); return { inputTokens: i || 0, outputTokens: o || 0, totalTokens: Number(u.total_tokens || i + o) || 0 }; }
function add(a, b) { a.inputTokens += b.inputTokens; a.outputTokens += b.outputTokens; a.totalTokens += b.totalTokens; }
async function chat({ endpoint, system, prompt, videoUrl, maxTokens, temperature, fetchImpl }) {
  const headers = { 'content-type': 'application/json' }; if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
  const start = performance.now();
  const res = await fetchImpl(`${endpoint.baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: endpoint.model, messages: [{ role: 'system', content: system }, { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'video_url', video_url: { url: videoUrl } }] }], max_tokens: maxTokens, temperature, top_p: 0.9 }), signal: AbortSignal.timeout(180000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`vLLM analysis failed with HTTP ${res.status}: ${body?.error?.message || body?.error || 'unknown error'}`), { statusCode: res.status >= 500 ? 503 : 422 });
  return { parsed: parseJson(body?.choices?.[0]?.message?.content), usage: use(body), latencyMs: Math.round((performance.now() - start) * 100) / 100 };
}

export async function analyzeWithExperimentalVllm({ payload, videoUrl, endpoint, fetchImpl = fetch }) {
  const request = requestOf(payload), usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, latencies = [];
  const call = async (system, prompt, maxTokens, temperature) => { const r = await chat({ endpoint, system, prompt, videoUrl, maxTokens, temperature, fetchImpl }); add(usage, r.usage); latencies.push(r.latencyMs); return r; };
  const primaryPrompt = buildVideoAnalysisPrompt(request);
  let primary = await call(VIDEO_ANALYSIS_SYSTEM_PROMPT, primaryPrompt, 5000, 0.1);
  if (!primary.parsed) primary = await call(VIDEO_ANALYSIS_SYSTEM_PROMPT, `${primaryPrompt}\n\nRECOVERY: Return the complete requested JSON analysis.`, 5000, 0.1);
  if (!primary.parsed) throw Object.assign(new Error('The experimental vLLM path returned invalid analysis JSON.'), { statusCode: 422 });
  let analysis = normalizeVideoAnalysis(primary.parsed, { objective: request.objective, requirements: request.requirements, hasTranscript: Boolean(request.transcript), declaredDurationSeconds: request.declaredDurationSeconds });
  let coverageRetryUsed = false;
  if (request.declaredDurationSeconds && analysis?.coverage?.fullDurationReviewed === false) {
    coverageRetryUsed = true;
    const r = await call(VIDEO_ANALYSIS_SYSTEM_PROMPT, `${primaryPrompt}\n\nFULL-DURATION RECOVERY: Reinspect the entire video and return chronological windows covering at least 95% from the beginning through the final 5%.`, 5000, 0.1);
    if (r.parsed) analysis = normalizeVideoAnalysis(r.parsed, { objective: request.objective, requirements: request.requirements, hasTranscript: Boolean(request.transcript), declaredDurationSeconds: request.declaredDurationSeconds });
  }
  if (request.declaredDurationSeconds && analysis?.coverage?.fullDurationReviewed === false) throw Object.assign(new Error('The experimental vLLM path did not demonstrate full-duration coverage.'), { statusCode: 422 });

  let verifier = { used: false, retry: false, usage: null, coverage: null, agreement: null };
  if (Object.keys(request.requirements).length) {
    verifier.used = true; const vu = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }; const vp = buildVideoCompliancePrompt({ requirements: request.requirements, declaredDurationSeconds: request.declaredDurationSeconds });
    let vr = await call(VIDEO_COMPLIANCE_SYSTEM_PROMPT, vp, 2600, 0); add(vu, vr.usage);
    let vc = vr.parsed ? normalizeVideoCompliance(vr.parsed, request.requirements) : null; let cov = vr.parsed ? assessVideoAnalysisCoverage(vr.parsed, request.declaredDurationSeconds) : null;
    if (!vc || (request.declaredDurationSeconds && !isAuthoritativeVerifierCoverage(cov, request.declaredDurationSeconds))) { verifier.retry = true; vr = await call(VIDEO_COMPLIANCE_SYSTEM_PROMPT, `${vp}\n\nVERIFIER RECOVERY: Return valid JSON and prove contiguous review of at least 95% of the full clip.`, 2600, 0); add(vu, vr.usage); vc = vr.parsed ? normalizeVideoCompliance(vr.parsed, request.requirements) : null; cov = vr.parsed ? assessVideoAnalysisCoverage(vr.parsed, request.declaredDurationSeconds) : null; }
    if (!vc || (request.declaredDurationSeconds && !isAuthoritativeVerifierCoverage(cov, request.declaredDurationSeconds))) throw Object.assign(new Error('The experimental vLLM blind verifier did not produce authoritative full-video evidence.'), { statusCode: 422 });
    const consensus = consensusVideoCompliance([{ ...analysis.compliance, evidenceSource: 'vllm_primary_full_duration_analysis' }, { ...vc, evidenceSource: 'vllm_blind_verifier' }], request.requirements);
    analysis = applyVerifiedVideoCompliance(analysis, consensus.compliance); verifier = { ...verifier, usage: vu, coverage: cov, agreement: { ...consensus.agreement, primaryEvidenceUsed: true, blindVerifierCount: 1, evidenceSourceCount: 2 } };
  }
  return {
    analysis, request, usage, retryUsed: latencies.length > (verifier.used ? 2 : 1), coverageRetryUsed, fallbackUsed: false,
    complianceVerificationUsed: verifier.used, complianceVerificationRetryUsed: verifier.retry, complianceVerificationModelId: verifier.used ? endpoint.model : null, complianceVerificationModelIds: verifier.used ? [endpoint.model] : [], complianceVerificationUsage: verifier.usage, complianceVerificationCoverage: verifier.coverage, complianceVerificationAgreement: verifier.agreement, complianceVerificationConsensusUsed: verifier.used, complianceVerificationDiagnostics: [],
    performance: { modelCalls: latencies.length, modelCallLatenciesMs: latencies, totalModelLatencyMs: Math.round(latencies.reduce((a, b) => a + b, 0) * 100) / 100 },
    experiment: { backend: 'vllm', profile: endpoint.profileName, level: endpoint.level, pruningRate: endpoint.pruningRate, pruningMethod: endpoint.pruningMethod, model: endpoint.model, vllmVersion: endpoint.vllmVersion },
  };
}
