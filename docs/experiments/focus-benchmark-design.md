# FOCUS frame-selection benchmark design

Status: **shadow experiment design — no production wiring and no deployment**  
Policy: `fd-defect-selection-policy-1`

This document turns the architecture/upstream review into a reproducible benchmark plan. The central rule is that the experiment changes the **visual evidence supplied to the same downstream VLM**, not the production ForgeDirector result path.

## 1. Baseline frame economics are now known

ForgeDirector's current primary model is Amazon Nova 2 Lite. AWS documents Nova video understanding as sampling video at a base rate of approximately **1 frame per second** for ForgeDirector-length clips. Existing ForgeDirector videos are capped at 120 seconds, so the provider baseline is approximately one sampled visual frame per source second.

Relevant AWS documentation:

- Nova video understanding / 1 FPS: https://docs.aws.amazon.com/nova/latest/userguide/modalities-video.html
- Nova 2 multimodal understanding: https://docs.aws.amazon.com/nova/latest/nova2-userguide/using-multimodal-models.html

This gives the experiment a meaningful candidate-frame baseline instead of inventing a decoder rate unrelated to production.

For a duration `D` seconds, use approximately `ceil(D)` 1-FPS candidates, with actual ffprobe/ffmpeg extraction metadata recorded per file.

## 2. Why the research defaults cannot simply be copied

FOCUS's released defaults include:

- coarse interval 16 seconds
- minimum coarse segments 8
- two extra samples per region
- fine interval 1 second
- minimum zoomed regions 4
- zoom ratio 0.25

On short clips, the `min_coarse_segments=8` floor combined with center + extra regional sampling can score a large fraction of all 1-FPS candidate frames before any downstream reduction is realized.

That is not automatically bad—the selector model may be much cheaper than the downstream VLM—but it means the experiment must report:

```
candidate frames
selector-scored frames
retained downstream frames
```

as three different quantities.

The experiment should first benchmark the released-style configuration. Only then may a ForgeDirector-tuned configuration reduce selector work, and that tuned configuration must get a new selector version/config identity.

## 3. Relevance scorer options

### Reference research scorer

FOCUS's committed runner uses BLIP image-text matching through Salesforce LAVIS on CUDA/Ray.

This is useful as a research reference, but importing the complete stack into ForgeDirector's Node/arm64 Lambda would be a runtime redesign.

### ForgeDirector-native shadow scorer

Amazon Titan Multimodal Embeddings G1 is available in ForgeDirector's existing `eu-west-1` region and maps text and images into the same semantic space:

- model: `amazon.titan-embed-image-v1`
- output dimensions: 256, 384, or 1024
- text limit: 256 tokens
- image limit: 25 MB / 2048×2048

AWS docs:

- https://docs.aws.amazon.com/bedrock/latest/userguide/titan-multiemb-models.html
- https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-titan-embed-mm.html

A shadow benchmark can therefore:

1. embed the selector query once;
2. embed each sampled candidate image independently;
3. cosine-compare text and image embeddings;
4. pass normalized similarity to the FOCUS-style kernel.

Do **not** send both query and image in the same Titan request for scoring: AWS documents that supplying both returns an averaged multimodal embedding. Query and frame embeddings should be generated separately so their cosine similarity remains inspectable.

Titan invocation count, image count, text token count, wall time, and estimated price must be recorded as **selection cost**.

The older AWS cost example that quoted approximately $0.00006 per Titan multimodal image is useful only as a historical cross-check; the benchmark report must use the current Bedrock price sheet available at execution time.

## 4. Downstream media representation

The selector must not fake full-duration inspection.

A selected-frame experiment cannot send a sparse subset and then let the normal ForgeDirector prompt claim it reviewed every original second.

The shadow benchmark should therefore construct a **proxy video**:

- selected source frames remain in chronological order;
- each selected frame is shown for one second;
- the image pixels are not overlaid with timestamp labels (important for text/OCR defect tests);
- a separate mapping records `proxy_second -> source_frame_index -> source_timestamp`;
- the downstream prompt is the same defect-specific question for baseline and experimental variants, plus a neutral timestamp-map instruction for the proxy;
- returned proxy evidence timestamps are mapped back to source timestamps before grading.

Why proxy video rather than a large image list:

- Bedrock Converse has generic per-message image-count limits;
- Nova 2 also documents modality-specific object limits;
- proxy video preserves the same Nova video modality and avoids a hidden image-vs-video tokenization comparison.

This is a **shadow QA benchmark**, not a replacement for the production full-duration verifier.

## 5. Defect-specific routing

Use `backend/frame-selection-policy.mjs`.

### FOCUS candidates

- required/expected object or content

### Hybrid candidates

- required visible text
- forbidden content
- narration/visual mismatch
- object/character/product/logo continuity
- unexpected content
- visual artifacts
- CTA
- incorrect visual content

### Uniform/global controls

- black/blank frames
- frozen imagery
- pacing
- repeated imagery
- scene-transition problems
- missing visuals

The baseline must still be run for every case.

If one shared frame set is demanded for a mixed task, the policy intentionally collapses to the least-aggressive safe strategy. The preferred benchmark is per defect/question so one global temporal defect does not make all semantic-selection experiments meaningless.

## 6. Budget ladder

Now that baseline sampling is understood, budgets are expressed relative to **actual baseline candidate frames**, not arbitrary fixed frame counts.

For candidate count `N`:

- **A baseline:** original video / provider-native sampling (~N frames)
- **B conservative:** retain ceil(0.75 × N)
- **C medium:** retain ceil(0.50 × N)
- **D aggressive:** retain ceil(0.25 × N)
- **E hybrid:** same retained budget as C, but reserve temporal-coverage frames before adding query-relevant frames

Safety floors:

- localizable semantic task: minimum 1 retained frame;
- comparative/coverage task: minimum 4 retained frames or all available frames when N < 4;
- budgets never exceed N.

The percentages are an experimental reduction ladder, not proposed production defaults. They are meaningful only because the production candidate rate is now known. Promotion requires actual defect recall and net-cost evidence.

For very short clips, the conservative budget may equal baseline after safety-floor rounding; record that rather than forcing an artificial reduction.

## 7. Corpus

### Reuse existing ForgeDirector evidence

Where source rights/access permit, reuse the current labeled cases and public generated-video sources already exercised by:

- `tests/run-live-video-benchmark.sh`
- `tests/run-live-video-repeatability.py`

Important existing categories include:

- CTA present/missing
- forbidden content present/absent
- required text present/missing
- continuity break
- weak/static content
- media/context prompt injection
- real motorcycle / wine content
- generated Veo and commercial product/UGC footage

### Add controlled temporal fixtures

The frame-selection experiment additionally needs timestamp-controlled defects that are underrepresented in the current corpus:

- one-second black frame near opening/middle/end
- short visual artifact near opening/middle/end
- frozen interval
- repeated imagery
- transition glitch
- product/logo change
- character/wardrobe change
- brief required text
- brief forbidden object/text
- missing expected visual interval

Each fixture must specify the exact ground-truth source window so a selector miss can be classified mechanically.

## 8. Isolation comparison

The first downstream comparison is:

```
original video + normal Nova model + defect-specific prompt
versus
FOCUS-selected proxy video + same normal Nova model + same defect-specific prompt
```

Do not enable vLLM token pruning.

A later combined FOCUS + vLLM-pruning benchmark requires a new experiment ID and new cache/result namespace.

## 9. Per-run record

Every row must include:

### Ground truth

- case ID
- source type (controlled / real)
- defect category
- query/check
- expected answer/status
- exact defect windows when controlled

### Selector

- strategy/version/config
- final-arm policy
- seed
- source duration
- candidate frames
- selector-scored frames
- selected frame indexes/timestamps
- relevance scores
- coarse/fine samples
- arm information
- requested/effective retained budget
- selection latency
- scorer calls/tokens
- scorer estimated cost

### Downstream VLM

- model/provider
- model call count
- input/output/total tokens
- inference latency
- returned answer
- returned evidence timestamp
- mapped source timestamp
- localization error
- estimated cost

### Outcome

- true positive / true negative / false positive / false negative
- baseline agreement
- frame reduction
- downstream token reduction
- downstream cost reduction
- selection cost
- **net** cost reduction
- end-to-end latency delta

## 10. False-negative drill-down

For every defect the baseline detects and a smart variant misses:

1. ground-truth timestamp/window;
2. was any defect frame retained?
3. if not, where was it lost: coarse sampling, arm ranking, fine selection, final budget, or hybrid floor?
4. if retained, did the proxy representation/VLM still fail?
5. did `paper_empirical_mean` vs `released_optimistic` change the result?
6. would the hybrid coverage floor retain the evidence?
7. category-specific disposition: reject FOCUS, require hybrid, or investigate further.

## 11. Decision gate

No aggregate average can hide a false-negative class.

- **REJECT:** meaningful defect-recall loss or selector overhead eliminates economic benefit.
- **PROMISING:** savings are real but some categories/configs still need validation.
- **CANDIDATE FOR CONTROLLED INTEGRATION:** baseline-level defect detection is preserved for the proposed routed categories, false negatives remain within the agreed gate, and net compute/cost savings remain material after selector cost.

Until the shadow VLM benchmark runs, the experiment is **not at the decision gate**.
