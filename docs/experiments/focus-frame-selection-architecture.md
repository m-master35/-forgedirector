# ForgeDirector query-aware frame selection experiment — baseline architecture

Status: **experiment design / baseline record only**  
Branch: `experiment/focus-frame-selection`  
Baseline: `main` at `174ab63d395e61a70ccd4e3eaaba56a2e1eef175`  
Production behavior changed by this document: **none**

This record exists before implementation so the experiment has a fixed description of what ForgeDirector actually does today. It is intentionally narrow: no production redesign, no deployment changes, no vLLM-pruning work, and no claim that FOCUS is suitable until ForgeDirector-specific defect benchmarks support it.

## 1. Current video-analysis path

The authoritative commercial path is `backend/commercial.mjs`.

```
POST /v1/uploads
  -> createVideoUpload()
  -> private S3 object under video-assets/

POST /v1/analyze
  -> resolveVideoAsset(assetId)
  -> normalize analysis request
  -> derive analysis cache key
  -> read private analysis cache
  -> invokeVideoAnalysis()
       -> Bedrock Converse: native S3 video block + analysis prompt
       -> normalize model JSON
       -> full-duration coverage check / recovery if necessary
       -> optional blind compliance verification
            -> Bedrock Converse: native S3 video block + blind verifier prompt
            -> possible second verifier/model
            -> full-duration verifier coverage check
            -> evidence consensus
       -> write private analysis cache
  -> return analysis + metadata
  -> delete temporary uploaded video in finally{}
```

The important architectural fact for this experiment is that ForgeDirector currently has **no local frame sampling stage**. It does not decode a video into frames and then choose an interval. It gives Bedrock the original S3 video as a native multimodal `video` content block. The provider therefore owns the low-level video decoding/tokenization behavior of the baseline path.

That means an intelligent selector cannot safely be inserted by changing an existing `sampleEveryNFrames` function; there is no such function. The least-coupled experiment seam is immediately before construction of the Bedrock multimodal content, where an experimental input adapter can choose between:

- the existing untouched native-video input, or
- an explicitly experimental selected-frame representation.

The baseline must remain the first and default case.

## 2. Current model/provider abstraction

Video analysis is implemented directly against AWS Bedrock's `ConverseCommand`.

Deployment defaults in `commercial-template.yaml` are:

- primary: `eu.amazon.nova-2-lite-v1:0`
- fallback: `eu.amazon.nova-pro-v1:0`

Both are environment-configurable. Continuity-sensitive requests can prefer the configured fallback. Model calls have bounded retry/recovery behavior.

There is no general multimodal-provider interface today. This experiment should not create a broad provider framework merely to add frame selection. A small input-construction seam is enough.

## 3. Current prompts and QA responsibilities

The primary video-analysis prompt requests production and creative intelligence including:

- hook quality
- pacing
- clarity
- visual quality
- continuity
- CTA
- platform fit
- conversion readiness
- timeline findings
- retention risks
- regeneration prompts
- literal production requirements

The prompt explicitly says the first three seconds are only the hook window and requires inspection of the full video.

When a declared duration is supplied, normalized analysis must demonstrate full-duration review. The current coverage contract requires, among other things:

- at least 95% covered duration,
- evidence beginning near the opening,
- evidence reaching the final 5%,
- chronological segmentation,
- a duration-scaled minimum number of timeline segments.

If primary analysis fails that contract, ForgeDirector retries with a full-duration recovery prompt. If coverage is still unproven, the API returns 422 rather than issuing a partial-video QA verdict.

When production requirements are supplied, ForgeDirector additionally performs a context-blind visual compliance pass. Its job includes `mustShow`, `mustNotShow`, `mustIncludeText`, continuity rules, and visual CTA verification. The blind verifier also has to demonstrate full-duration coverage. Usable primary full-duration evidence and blind verifier evidence are combined into a consensus; disagreement can become `needs_review`.

**Implication for frame selection:** a selector cannot be judged only by whether the primary creative score looks similar. It must preserve the evidence needed by the independent compliance path and the current full-duration safety contract.

## 4. Current cache identity

`backend/commercial.mjs` currently versions video analysis with:

```
fd-video-analysis-1.5|fd-shortform-v5|compliance-primary-blind-v1
```

The SHA-256 cache material includes:

- cache contract version
- content fingerprint
- size
- content type
- platform
- objective
- audience
- context
- transcript
- declared duration
- requirements
- primary model ID
- fallback model ID

Cached results are private S3 JSON objects under `analysis-cache/` and expire logically after 24 hours.

There is currently no selector identity because production has no selector.

Any experiment that can alter visual evidence **must use an incompatible cache identity**. At minimum the experimental identity must include:

- frame-selection strategy
- selector implementation/version
- canonical selector configuration
- requested frame budget
- actual selected-frame representation/version
- model/provider identity
- analysis prompt/contract version

A baseline request must never hit an experimental result, and two experimental configurations must never share results merely because their source video and text request are identical.

## 5. Current storage and lifecycle

Uploaded videos are private S3 objects. The API resolves metadata and uses the S3 ETag as the content fingerprint when available. The temporary source object is deleted in `finally{}` after analysis.

Experimental artifacts such as selected frames, contact sheets, reduced videos, or selector metadata must therefore have an explicit lifecycle. They must not accidentally survive under the normal production prefix, become externally readable, or be mistaken for an analysis result.

The experiment should initially keep selector artifacts outside the normal production response and make cleanup deterministic.

## 6. Current deployment/runtime constraints

The commercial API runs as an AWS SAM Lambda:

- Node.js 22
- arm64
- 1024 MB memory
- 120 second timeout
- private S3 video bucket
- Bedrock model invocation

The production package currently has only AWS SDK dependencies; it does not ship OpenCV, PyTorch, LAVIS, Decord, Ray, CUDA, or a local GPU runtime.

This matters materially. Importing the FOCUS reference environment into the Lambda would be a redesign of the runtime, not a small experiment. The experiment should therefore keep selection behind an explicit flag and favor a separable/offline or sidecar-compatible selector implementation until cost and quality are proven.

## 7. Existing benchmark corpus and release gates

ForgeDirector already has stronger evidence than a generic VideoQA score and this experiment should reuse it.

The live-video benchmark creates controlled cases including:

- required CTA present / absent
- forbidden object/text present / absent
- required text missing
- continuity break
- weak/static video
- media prompt injection
- context/transcript injection

It also evaluates public real/generated video including Runway examples, multiple Veo clips, product/UGC examples, and a cosmetic-product clip.

The current grader measures:

- literal compliance correctness
- no-speech hallucination
- full-duration coverage
- quality-gate behavior
- score relationships
- token usage

Additional workflows cover cache behavior, repeatability, performance, duration/unit economics, API contract, and stress.

The current release-readiness record on main reports:

- 52/52 labeled compliance checks correct
- 29/29 full-duration coverage
- 28/28 no-speech hallucination checks
- 0 technical failures
- 6 clips × 5 repeated analyses = 30/30 successful

Those are the minimum regression reference, not evidence that a new selector is safe.

## 8. Minimal experimental insertion seam

The experiment should introduce a narrow abstraction conceptually like:

```
VideoAnalysisInputStrategy
  NativeVideoInputStrategy      # current behavior; default
  SelectedFramesInputStrategy   # experiment only
```

and independently:

```
FrameSelectionStrategy
  UniformFrameSelector
  FocusFrameSelector
  HybridFrameSelector
```

The two abstractions solve different problems:

- the **selector** decides which moments are retained,
- the **input strategy** decides how those retained moments are represented to Bedrock.

Keeping these separate avoids permanently coupling ForgeDirector to FOCUS or to one multimodal provider's image/video input format.

The selected moments must remain inspectable and reproducible. Experimental metadata should include:

- selected source frame indexes
- source timestamps
- relevance scores
- coarse samples
- fine samples
- arm/region scores
- total candidate frames
- retained frames
- requested and effective budget
- selector seed
- selector version/config
- selection latency
- representation-building latency

This metadata must not alter the normal production response unless the experimental route explicitly asks for it.

## 9. Defect classes are not equally safe for query-aware selection

FOCUS was designed for query-relevant long-video understanding. ForgeDirector is a defect detector. Missing one brief anomaly can be worse than selecting many semantically relevant frames.

Initial safety classification for benchmarking:

| Defect / check family | Initial selector posture | Why |
| --- | --- | --- |
| Required object/content (`mustShow`) | query-aware candidate | Often localized and semantically queryable |
| Forbidden object/content (`mustNotShow`) | hybrid/global | Absence can only be supported by broad coverage |
| Required visible text | query-aware + temporal anchors | OCR-like evidence may be brief |
| Product/logo consistency | hybrid | Relevance helps, but comparisons require temporal coverage |
| Character/wardrobe continuity | hybrid | Requires comparison across distant moments |
| Narration/visual mismatch | hybrid | Needs transcript-time alignment plus visual evidence |
| Unexpected object/content | hybrid/global | Selector query may not name the unexpected event |
| Black/blank frames | uniform/global deterministic gate | Semantic relevance is the wrong signal |
| Frozen imagery | uniform/global temporal gate | Requires adjacent-time comparison |
| Repeated imagery | uniform/global temporal gate | Requires coverage and cross-time comparison |
| Pacing | uniform/global | Temporal density is the signal |
| Scene-transition defects | uniform/global boundary-aware | Brief boundary events are easy to discard |
| Missing visuals | uniform/global | Relevance selection can hide absence |
| General visual artifacts | hybrid | Salient artifacts may score poorly against semantic query |

This table is a hypothesis to test. It is acceptable—and likely—for some production checks never to use FOCUS.

## 10. Hybrid safety floor

A likely safe architecture, if query-aware selection proves useful at all, is:

1. reserve a fixed temporal-coverage floor across the full video;
2. add query-relevant frames using the remaining budget;
3. preserve first/last evidence and scene/transition boundaries where detectable;
4. never let query relevance remove the coverage floor.

This should be benchmarked rather than assumed.

## 11. Experimental variants

Budgets must be derived from baseline/provider behavior and corpus duration, not invented solely as percentages.

Required variants:

- **A — baseline:** current native S3 video + current Bedrock path.
- **B — FOCUS-style conservative:** selected-frame path with generous retained evidence.
- **C — FOCUS-style medium:** meaningful reduction.
- **D — FOCUS-style aggressive:** limit-finding only.
- **E — hybrid:** uniform/global temporal floor plus query-aware additions, if early evidence justifies it.

For every run record primary and verifier costs separately where measurable.

## 12. Metrics and decision rule

Generic VideoQA accuracy is not the production criterion.

The experiment must report:

- true defects detected
- defects missed
- false positives
- false negatives
- category
- timestamp error / localization quality
- source frames considered
- frames retained
- downstream visual/token usage where exposed
- VLM calls
- selection compute
- selector latency
- inference latency
- end-to-end latency
- GPU/CPU usage where measurable
- estimated selector cost
- downstream inference cost
- net cost/compute reduction

For every baseline-detected defect missed by smart selection, record:

1. expected timestamp;
2. whether the relevant frame/moment was retained;
3. why it was discarded or lost in representation;
4. failure class;
5. whether hybrid temporal coverage would have prevented it.

A reduction in frames alone is not a win. Selection cost must be subtracted from downstream savings.

Completion classification remains:

- **REJECT** — meaningful QA degradation or insufficient net economic benefit.
- **PROMISING** — useful savings with unresolved validation risk.
- **CANDIDATE FOR CONTROLLED INTEGRATION** — defect detection preserved, false negatives acceptable against the agreed gate, and net savings meaningful.

Nothing in this experiment may promote itself automatically.

## 13. Isolation requirements

This branch must not:

- change the default `/v1/analyze` behavior;
- alter the production Bedrock path without an explicit experimental flag;
- deploy automatically;
- change RapidAPI pricing/security/settings;
- combine frame selection with native-vLLM token pruning;
- weaken the existing coverage or compliance gates merely to make the experiment pass.

The first comparison is strictly:

```
normal frames/native video + normal Bedrock path
vs
FOCUS-style selected input + normal Bedrock path
```

Only after independent evidence exists for both experiments should a combined FOCUS + vLLM-pruning benchmark be designed.
