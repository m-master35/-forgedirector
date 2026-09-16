# Native vLLM video-token pruning experiment

Status: isolated experiment. The production ForgeDirector `/v1/analyze` path remains Bedrock/Nova by default.

## Question

Can ForgeDirector reduce multimodal video-analysis cost, prefill latency, and KV-cache pressure with vLLM-native video-token pruning without materially reducing defect/compliance detection?

The experiment deliberately excludes FOCUS, TimePLE, Vista-LLM, MMTok, PriorTR, AVIOT, OmniAgent, frame pre-selection, and other pruning/sampling systems. Only vLLM-native post-vision-encoder token pruning is in scope.

## Verified vLLM capability

Verified against current vLLM documentation and source on 2026-09-16:

- `--video-pruning-rate q` accepts a pruning fraction in `[0, 1)`; pruning is enabled when `q > 0`.
- `--video-pruning-method evs` is the default native method for models implementing multimodal pruning.
- `--video-pruning-method vidcom2` is supported by Qwen3-VL; unsupported model/method combinations are rejected at startup.
- pruning happens after the vision encoder, so the expected wins are language-model prefill work and KV-cache use rather than vision-encoder FLOPs.
- enabling pruning disables encoder CUDA graphs because the retained-token count is data-dependent.
- vLLM exposes Prometheus metrics including `vllm:kv_cache_usage_perc`, prompt-token counters/histograms, TTFT, request latency, and throughput-related counters.

Pinned first validation target: **vLLM 0.28.0 + Qwen/Qwen3-VL-4B-Instruct**. v0.28.0 contains the Qwen3-VL device placement fix required by the pruning path and includes native VidCom2 support. Do not silently substitute another vLLM build in benchmark evidence: record exact version/commit and model revision.

Known upstream caution: recent vLLM releases have had pruning regressions in Qwen-family multimodal models. Every benchmark server must pass a one-video pruning smoke test before the corpus run. An upstream crash is an experiment failure, not a reason to patch production ForgeDirector.

## Profiles

The experiment has one no-prune control and two method families:

| Profile | Method | Fraction pruned | Purpose |
| --- | --- | ---: | --- |
| `baseline` | EVS configured but inactive | 0% | same-model vLLM control |
| `evs-conservative` | EVS | 25% | low-risk pruning |
| `evs-medium` | EVS | 50% | balanced pruning |
| `evs-aggressive` | EVS | 75% | high pruning; vLLM docs use 75% in their example |
| `vidcom2-conservative` | VidCom2 | 25% | low-risk Qwen3-VL-only pruning |
| `vidcom2-medium` | VidCom2 | 50% | balanced Qwen3-VL-only pruning |
| `vidcom2-aggressive` | VidCom2 | 75% | aggressive Qwen3-VL-only pruning |

The causal pruning comparison is **vLLM baseline vs the pruned vLLM profiles using the same model, revision, decoding settings, video, prompt, and ForgeDirector normalization/gates**. Current production Bedrock/Nova remains a reference benchmark, but it is not the pruning control because changing both model/runtime and pruning would confound the result.

## Isolation and request contract

No production behavior changes unless both are true:

1. `FORGEDIRECTOR_VLLM_EXPERIMENT_ENABLED=true` is present in that environment; and
2. the analyze payload contains an internal-only block such as:

```json
{
  "experiment": {
    "backend": "vllm",
    "profile": "evs-medium"
  }
}
```

If an experiment is requested while the feature flag is off, the API fails closed instead of silently returning a Bedrock result and corrupting benchmark evidence.

Each profile maps to a separately configured vLLM endpoint via `VLLM_EXPERIMENT_ENDPOINTS_JSON`. vLLM pruning is a server/model setting, not a per-request setting, so the endpoint declaration must state the exact `model`, `vllmVersion`, `pruningRate`, and `pruningMethod`. ForgeDirector rejects mismatches. Example:

```json
{
  "baseline": {
    "baseUrl": "http://127.0.0.1:8100",
    "model": "Qwen/Qwen3-VL-4B-Instruct",
    "vllmVersion": "0.28.0",
    "pruningRate": 0,
    "pruningMethod": "evs"
  },
  "evs-medium": {
    "baseUrl": "http://127.0.0.1:8150",
    "model": "Qwen/Qwen3-VL-4B-Instruct",
    "vllmVersion": "0.28.0",
    "pruningRate": 0.5,
    "pruningMethod": "evs"
  }
}
```

The experimental adapter uses vLLM's OpenAI-compatible `video_url` chat input. ForgeDirector creates a short-lived signed GET URL for its private S3 object only after the experiment path is selected.

## Cache isolation

Production and experimental cache entries cannot collide. The experimental cache digest includes:

- its own experiment cache schema version;
- video content fingerprint, size and type;
- normalized analysis request;
- profile name;
- model and declared vLLM version;
- pruning method and rate.

A cached experimental repeat returns zero model usage, exactly like the existing production cache. Cache hits must never be included as fresh latency/token measurements in pruning comparisons.

## QA parity

The adapter deliberately reuses ForgeDirector's existing prompts and normalization/gating code:

- `VIDEO_ANALYSIS_SYSTEM_PROMPT`
- `buildVideoAnalysisPrompt`
- `normalizeVideoAnalysis`
- full-duration coverage gate
- `VIDEO_COMPLIANCE_SYSTEM_PROMPT`
- `buildVideoCompliancePrompt`
- `normalizeVideoCompliance`
- two-source primary + blind-verifier consensus
- deterministic quality gate

This is required so pruning is the intended independent variable. The existing 29-video labeled corpus remains the main quality corpus; the six-video repeatability corpus remains useful for repeated/stability checks.

## Benchmark measurements

For every fresh case/profile record at minimum:

- labeled requirement checks correct / incorrect;
- false negatives (expected defect/fail not detected);
- false positives (expected pass reported fail);
- no-speech hallucination status;
- full-duration coverage status;
- quality-gate action;
- end-to-end and model-call latency;
- prompt/input and output tokens reported by vLLM;
- `vllm:kv_cache_usage_perc` before/peak/after where measurable;
- prompt-token and generation-token counter deltas;
- TTFT / request-latency metrics where measurable;
- GPU memory peak from NVML when the runner exposes it;
- throughput under the same concurrency schedule;
- estimated inference cost using the actual GPU hourly price and measured wall/GPU time;
- compliance timestamps and their absolute delta from the no-prune control when comparable.

Vision-token count should be reported separately only when directly measurable from the runtime. Do not rename total prompt tokens as "video tokens".

## Decision gate

A pruned profile can advance to a larger controlled validation only if all are true:

1. no material reduction in labeled defect/compliance detection versus same-model no-prune vLLM;
2. no unacceptable increase in false negatives, especially must-not-show, required-text, CTA, or continuity failures;
3. full-duration coverage remains at release-gate quality;
4. compute/token/KV/latency improvement is meaningful on fresh requests;
5. operational complexity remains reasonable;
6. the result is not dependent on an upstream patch or unpinned local vLLM modification.

For the first corpus pass, any new false negative on a release-critical labeled defect is a rejection signal for that profile. A 70% compute saving does not offset missing a production defect.

No experiment result promotes itself to production. Production enablement requires a separate reviewed change after a larger controlled validation.
