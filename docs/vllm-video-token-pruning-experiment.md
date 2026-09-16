# Native vLLM video-token pruning experiment

Status: **isolated experiment**. Production ForgeDirector `POST /v1/analyze` remains on the existing Bedrock/Nova path. Nothing in this experiment deploys, changes provider credentials, changes billing, or promotes a vLLM path to production.

## Question

Can ForgeDirector reduce multimodal video-analysis prefill work, KV-cache pressure, latency and estimated inference cost with vLLM-native video-token pruning **without materially reducing defect/compliance detection**?

The experiment deliberately excludes FOCUS, TimePLE, Vista-LLM, MMTok, PriorTR, AVIOT, OmniAgent, frame pre-selection and other sampling/pruning systems. Only vLLM-native post-vision-encoder video-token pruning is in scope.

## Verified vLLM capability

Verified against vLLM documentation and source on 2026-09-16:

- vLLM 0.29.0 exposes `--video-pruning-rate q`, with `q` constrained to `[0, 1)`.
- `--video-pruning-method evs` selects Efficient Video Sampling (EVS).
- `--video-pruning-method vidcom2` selects Video Compression Commander (VidCom2).
- EVS is the default pruning method for models implementing multimodal pruning.
- Qwen3-VL declares native support for both `evs` and `vidcom2`; vLLM rejects unsupported model/method combinations at startup.
- pruning is applied after the vision encoder, so the primary expected savings are language-model prefill/KV work rather than the vision encoder's own FLOPs.
- vLLM's documentation notes that enabling video pruning disables multimodal encoder CUDA graphs because retained token counts become data-dependent.
- the OpenAI-compatible server accepts video through `video_url`.
- the Prometheus endpoint exposes metrics including `vllm:kv_cache_usage_perc`, prompt-token counters, generation-token counters and request-latency metrics.

Pinned first validation target: **vLLM 0.29.0 + Qwen/Qwen3-VL-8B-Instruct**. Do not silently substitute another vLLM build or model revision in benchmark evidence. Record the exact vLLM version, model ID and model revision used for every controlled run.

The same-model no-prune vLLM control is the causal baseline for pruning. Current production Nova remains a reference capability/cost benchmark, but it is not the pruning control because changing both runtime/model and pruning would confound the result.

## Profiles

| Profile | Method | Fraction pruned | Purpose |
| --- | --- | ---: | --- |
| `baseline` | pruning disabled | 0% | same-model vLLM control |
| `evs-conservative` | EVS | 25% | low-risk pruning |
| `evs-medium` | EVS | 50% | balanced pruning |
| `evs-aggressive` | EVS | 75% | aggressive pruning |
| `vidcom2-conservative` | VidCom2 | 25% | low-risk Qwen3-VL-only pruning |
| `vidcom2-medium` | VidCom2 | 50% | balanced Qwen3-VL-only pruning |
| `vidcom2-aggressive` | VidCom2 | 75% | aggressive Qwen3-VL-only pruning |

The rates are ordinary values accepted by vLLM's `[0,1)` configuration. The 75% profile is also the rate used in vLLM's public VidCom2 example. No unsupported per-request pruning knobs are invented.

## Isolation

vLLM pruning is a **server/model configuration**, not a request-time setting. Each benchmark profile must therefore point at a server started with the matching pruning flags, or the same server must be restarted sequentially between profiles.

ForgeDirector exposes one internal experiment-only route:

`POST /v1/experimental/analyze-vllm`

It is reachable only when:

`FORGEDIRECTOR_VLLM_EXPERIMENT_ENABLED=true`

The request uses the normal analysis fields plus an explicit profile:

```json
{
  "assetId": "uploaded-asset-uuid",
  "profile": "evs-medium",
  "platform": "General",
  "objective": "awareness",
  "durationSeconds": 12,
  "requirements": {
    "mustShow": ["motorcycle"],
    "mustNotShow": ["wine bottle"]
  }
}
```

The production `POST /v1/analyze` route does **not** inspect an experiment field and does not switch to vLLM. This experiment route is intentionally absent from the public RapidAPI/OpenAPI contract.

Each profile maps to a separately declared vLLM endpoint through `VLLM_EXPERIMENT_ENDPOINTS_JSON`. The declaration must attest the model, vLLM version, pruning method and pruning rate; ForgeDirector fails closed when the declaration conflicts with the profile.

Example:

```json
{
  "baseline": {
    "baseUrl": "http://127.0.0.1:8100",
    "model": "Qwen/Qwen3-VL-8B-Instruct",
    "vllmVersion": "0.29.0",
    "pruningRate": 0,
    "pruningMethod": "evs"
  },
  "evs-medium": {
    "baseUrl": "http://127.0.0.1:8150",
    "model": "Qwen/Qwen3-VL-8B-Instruct",
    "vllmVersion": "0.29.0",
    "pruningRate": 0.5,
    "pruningMethod": "evs"
  }
}
```

An endpoint declaration is an experiment configuration assertion, not cryptographic proof of server flags. The controlled benchmark must also preserve the exact server launch command/log for each profile.

## Private video handling

The production asset remains private in S3. Only after the experiment route is selected does ForgeDirector create a short-lived signed GET URL and pass that URL to the configured vLLM server as `video_url`.

For any remotely reachable vLLM server:

- restrict `--allowed-media-domains` to the required S3 media host(s);
- set `VLLM_MEDIA_URL_ALLOW_REDIRECTS=0`;
- do not expose the vLLM server publicly without authentication/network controls;
- never put a signed S3 URL into logs or benchmark artifacts.

The direct benchmark runner can use local data URLs instead, avoiding S3/network timing when the goal is pure inference comparison.

## Cache isolation

Production and experimental cache entries cannot collide. The experimental cache digest includes:

- its own experiment cache schema version;
- video content fingerprint, size and type;
- normalized ForgeDirector analysis request;
- profile name;
- model ID and declared vLLM version;
- pruning method and pruning rate.

A cached experimental repeat reports zero model usage. **Cache hits are never valid fresh pruning benchmark observations.**

## QA parity

The experimental analyzer reuses ForgeDirector's existing:

- `VIDEO_ANALYSIS_SYSTEM_PROMPT`;
- `buildVideoAnalysisPrompt`;
- `normalizeVideoAnalysis`;
- full-duration coverage gate;
- `VIDEO_COMPLIANCE_SYSTEM_PROMPT`;
- `buildVideoCompliancePrompt`;
- `normalizeVideoCompliance`;
- primary + blind-verifier consensus;
- deterministic quality gate.

This keeps the requested QA criteria fixed while the vLLM profile changes.

The existing 29-video labeled corpus remains the main quality corpus. The six-video repeatability corpus remains useful for a later repeated/stability pass.

## Benchmark workflow

1. Build the existing corpus without provider calls:

   ```bash
   FORGEDIRECTOR_CORPUS_ONLY=1 tests/run-live-video-benchmark.sh benchmark-results
   ```

2. Start one pinned vLLM profile. For decision-grade evidence, pin the model revision too:

   ```bash
   VLLM_MODEL_REVISION=<exact-hugging-face-commit> \
   VLLM_PRUNING_PROFILE=baseline \
   experiments/vllm-pruning/launch-profile.sh
   ```

   Repeat with `evs-conservative`, `evs-medium`, `evs-aggressive`, `vidcom2-conservative`, `vidcom2-medium`, and `vidcom2-aggressive`. Use the same GPU type, model revision, max model length, GPU-memory-utilization setting, and all other server arguments across profiles.

3. Run the direct benchmark once per server/profile:

   ```bash
   VLLM_BENCH_PROFILE=baseline \
   VLLM_MODEL=Qwen/Qwen3-VL-8B-Instruct \
   VLLM_VERSION=0.29.0 \
   VLLM_MODEL_REVISION=<same-exact-commit> \
   VLLM_BASE_URL=http://127.0.0.1:8000 \
   VLLM_GPU_HOURLY_USD=<actual-dedicated-gpu-rate-if-known> \
   node experiments/vllm-pruning/run-benchmark.mjs
   ```

   For a local server, the runner records the matching `vllm serve` process command and refuses a rate/method mismatch. For a remote server, retain the server launch log/config alongside the benchmark artifact because `/v1/models` alone does not attest pruning flags.

4. Keep the no-prune `baseline.json` and every pruned profile report in the same output directory.

5. Run the decision gate:

   ```bash
   node experiments/vllm-pruning/grade-benchmarks.mjs benchmark-vllm
   ```

6. Only after the vLLM profiles are understood, optionally compare against a separately approved **fresh** production/Nova benchmark. The existing recorded ForgeDirector release benchmark is the historical QA bar; do not spend Bedrock inference merely to make the vLLM experiment run.

If an upstream/runtime quality issue is suspected, a second all-profile run may use a changed runtime setting such as eager execution, but the setting must be identical for baseline and every pruning profile. Never change compilation/eager settings only for the failing pruning profile.

## Measurements

For every **fresh** case/profile record:

- labeled requirement checks correct / incorrect;
- false negatives: expected defect/fail not detected;
- false positives: expected pass reported fail;
- no-speech hallucination status;
- full-duration coverage status;
- quality-gate action;
- end-to-end and model-call latency;
- input/prompt and output tokens reported by vLLM;
- `vllm:request_prefill_kv_computed_tokens` to measure newly computed prefill KV tokens where exposed;
- `vllm:request_prefill_time_seconds`, TTFT and inference/e2e timing deltas where exposed;
- `vllm:kv_cache_usage_perc` before/peak/after where measurable;
- prompt-token and generation-token counter deltas where measurable;
- GPU memory peak from `nvidia-smi` when the runner is colocated with the server;
- throughput under the same concurrency schedule;
- estimated inference cost when the actual GPU hourly price is supplied;
- compliance timestamp drift versus same-model no-prune baseline where comparable.

Direct video-token count is reported only if the runtime exposes it directly. Total prompt tokens must not be relabeled as "video tokens". The first-pass throughput field is explicitly **sequential cases/second**; concurrency stress belongs in the larger controlled validation if a profile first clears the quality gate.

## Decision gate

A pruned profile can advance to a larger controlled validation only if all are true:

1. no material reduction in labeled defect/compliance detection versus same-model no-prune vLLM;
2. no new release-critical false negatives;
3. full-duration coverage and no-speech safeguards remain clean;
4. compute/token/KV/latency improvement is meaningful on fresh requests;
5. operational complexity remains reasonable;
6. the result does not depend on an unpinned local vLLM patch.

For the first corpus pass, **any new false negative on a labeled defect is a rejection signal** for that profile. Large compute savings do not compensate for missing a production defect.

The automated grader never promotes a profile to production. An eligible profile only earns a larger controlled validation. Production enablement requires a separate reviewed change.

## Spend boundary

No paid Bedrock/Nova inference or paid GPU provisioning is authorized by this experiment branch. Corpus generation and static/unit validation are free/offline. A controlled GPU benchmark requires an available GPU endpoint; if provisioning would incur cost, obtain explicit approval first.
