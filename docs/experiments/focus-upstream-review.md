# FOCUS upstream review and ForgeDirector adaptation decision

Status: **verified upstream review; no external code vendored yet**  
FOCUS snapshot reviewed: `NUS-HPC-AI-Lab/FOCUS@d469757cd89976117467294fd1f177026d1a627d`  
Review date: 2026-09-16

This document records the upstream facts that constrain the experiment. Published VideoQA claims are treated as hypotheses only. ForgeDirector defect detection, false negatives, net compute, and cost are the decision criteria.

## 1. What the released FOCUS implementation actually is

FOCUS partitions a video into temporal regions ("arms"), samples a coarse set, scores sampled frames against the query, estimates an optimistic arm score using empirical statistics/confidence, zooms into promising arms for finer sampling, and finally allocates a fixed keyframe budget.

The released implementation is usefully split:

- `focus.py` contains the selector logic and accepts an injected `similarity_fn(video, query, frame_indices)`.
- `select_keyframe.py` is the research runner: video I/O, BLIP image-text scoring, Ray workers, GPU setup, dataset plumbing, and output files.

This separation is important. ForgeDirector can evaluate the selection concept without adopting the entire research runtime.

The reference runner records useful experiment metadata:

- coarse frame indexes and scores
- fine frame indexes and scores
- temporal arm information
- arm-selection probabilities
- final selected frames
- video duration / frame count / fps
- scoring-budget usage
- total GPU-worker time

ForgeDirector should preserve the spirit of that observability even if its implementation is native.

## 2. Reference defaults

The released defaults include:

- coarse interval: 16 seconds
- fine interval: 1 second
- zoom ratio: 0.25
- minimum final arms: 4
- maximum final arms: 32
- minimum coarse segments: 8
- minimum zoomed segments: 4
- extra samples per region: 2
- fine uniform ratio: 0.5
- interpolation: nearest
- top-ranked ratio: 0.2
- softmax temperature: 0.06
- random seed: 42

These are **not** ForgeDirector defaults. They were designed for long-video benchmarks and must not be copied as arbitrary production budgets.

ForgeDirector currently accepts videos up to 120 seconds. FOCUS's headline research setting is long-video understanding, including videos far longer than ForgeDirector's current maximum. The selector's own scoring overhead can therefore be a much larger fraction of total work for ForgeDirector than it is for a 20+ minute benchmark video.

## 3. Actual scoring stack in the reference runner

The FOCUS runner uses Salesforce LAVIS:

```
load_model_and_preprocess(
  "blip_image_text_matching",
  "base" | "large",
  ...
)
```

For each sampled frame it runs BLIP image-text matching and uses the positive ITM probability as the relevance score.

The research runner assumes:

- CUDA
- PyTorch
- LAVIS / BLIP
- Decord
- NumPy
- SciPy
- Pillow
- tqdm
- Ray

Each Ray worker requests one GPU and the runner can use up to eight GPU workers.

The repository's own `requirements.txt` contains only:

- `opencv-python`
- `ray`
- `scikit-learn`

That file is therefore not a complete standalone declaration of the environment needed by the committed source. The README explicitly says to set up the AKS environment first.

**ForgeDirector consequence:** do not add the upstream environment wholesale to the 1024 MB Node Lambda. Any real relevance scorer should initially live in an experiment harness or separately deployable selector boundary so its overhead can be measured honestly.

## 4. Paper/released-code discrepancy

Upstream issue #8 is open as of this review and has no maintainer resolution.

The issue identifies a concrete difference in final arm selection:

- the paper describes recommendation using the unbiased empirical arm mean;
- the released `_select_remaining_frames()` sorts final arms by `focus_score`, the optimistic/confidence-aware score.

The currently committed released code does indeed sort by:

```python
key=lambda x: x[1]['focus_score']
```

rather than `mean_sim`.

ForgeDirector must not silently choose one interpretation and call it "the FOCUS algorithm."

If this distinction survives into the benchmark, the selector configuration must explicitly identify the final-arm policy, for example:

- `released_optimistic`
- `paper_empirical_mean`

The first experimental implementation should make this policy inspectable and deterministic. If the two variants produce materially different defect recall, both results belong in the report.

## 5. Licensing findings

### FOCUS repository

The FOCUS repository contains the Apache License 2.0.

Practical implications if ForgeDirector copies/adapts source:

- commercial use is permitted under the license;
- copyright/license notices must be preserved;
- modified files must carry a notice that they were changed;
- Apache-2.0 patent terms apply;
- no FOCUS `NOTICE` file is present at the reviewed repository root.

No FOCUS source is copied in this commit.

### LAVIS / BLIP code

Salesforce LAVIS is BSD-3-Clause. The BLIP image-text-matching implementation and its base/large model configuration files carry the same BSD-3-Clause identifier.

The configs used by LAVIS point to COCO-finetuned BLIP retrieval checkpoints.

Salesforce's published Hugging Face model pages for `blip-itm-base-coco` and `blip-itm-large-coco` identify the model license as BSD-3-Clause.

If an actual BLIP checkpoint is used in a commercial benchmark, the experiment should pin a named artifact with an explicit model-card license rather than relying only on an opaque download URL.

### AKS

FOCUS's README instructs users to follow the AKS repository installation first. The reviewed AKS repository root contains no LICENSE file.

Absence of a license is not permission to copy or redistribute its source.

**Decision:** the ForgeDirector experiment must not copy/vendor AKS code. AKS may be read as research background, but no AKS implementation should enter this repository unless its licensing status is independently clarified.

### Transitive dependency posture

The practical licensing risk is not a reason to import the whole research environment. The experiment can avoid most of it by:

1. keeping FOCUS logic behind an injected scorer;
2. writing ForgeDirector-native integration/test code;
3. using an explicitly licensed scorer artifact only for offline benchmarking;
4. recording exact package/model versions before any commercial integration.

No external model or research dependency belongs in the production path until that manifest exists.

## 6. Why wholesale vendoring is the wrong first move

The released FOCUS runner is optimized as a research pipeline:

- dataset-specific file layouts
- Ray distribution
- one-GPU workers
- CUDA gate
- LAVIS BLIP loading
- LongVideoBench / VideoMME assumptions
- merged per-rank output files

ForgeDirector is a serverless API with short uploaded videos, S3 lifecycle controls, bounded Bedrock calls, strict cache identity, and defect-specific quality gates.

Vendoring the runner would create coupling to infrastructure ForgeDirector does not currently have and make selector cost difficult to separate from downstream savings.

The preferred adaptation is:

```
FrameSelectionStrategy
  -> deterministic selection kernel
  -> injected relevance scorer
  -> no knowledge of Bedrock/S3/API
```

with a separate experiment adapter for video decode/scoring/input representation.

## 7. Query construction must be defect-specific

Generic QA asks one semantic question. ForgeDirector checks heterogeneous failure modes.

A single query like "find defects" is too weak and can bias selection toward visually salient content while suppressing anomalies.

Experimental query sets should be derived from the check family, for example:

### Localizable semantic checks

For `mustShow`, `mustIncludeText`, product/logo checks, and known expected content:

- literal rule text
- normalized object/entity terms
- scene/product context only when it cannot leak the expected verdict

These are plausible FOCUS candidates.

### Global/comparative checks

Continuity, character consistency, product consistency, and narration/visual alignment require evidence from separated moments.

These should use query-aware selection only on top of a temporal coverage floor.

### Non-semantic temporal/technical checks

Black/blank frames, frozen imagery, pacing, repetition, transition defects, and missing visuals are poor fits for BLIP relevance.

They should remain uniform/global or use dedicated deterministic temporal signals. FOCUS should not displace a cheaper detector when semantic similarity is unrelated to the defect.

### Unexpected content

"Unexpected object" cannot always be queried by name because the unexpected object is not known in advance.

This category is intrinsically dangerous for purely query-aware pruning and should retain global/hybrid coverage.

## 8. Cost model for this experiment

The selector has two separate costs:

```
selection cost
  = decode cost
  + candidate-frame extraction
  + relevance-model inference
  + arm/statistical selection
  + selected-input construction

downstream savings
  = baseline multimodal inference cost
  - selected-input multimodal inference cost

net savings
  = downstream savings
  - selection cost
```

Frame reduction is only a proxy and must not be reported as net compute reduction.

For a 6–120 second ForgeDirector clip, BLIP scoring can plausibly dominate the savings at conservative budgets. This has to be measured.

## 9. Experimental implementation choice

The first implementation should **not** add BLIP/LAVIS/Ray to the production package.

Instead:

1. create a small ForgeDirector-native `FrameSelectionStrategy` contract;
2. implement deterministic `UniformFrameSelector`;
3. implement a FOCUS-style selection kernel with an injected relevance scorer;
4. expose the paper-vs-released final-arm policy explicitly;
5. implement `HybridFrameSelector` only after the temporal safety floor is defined;
6. exercise deterministic unit tests with a fake scorer;
7. keep real BLIP scoring in an offline benchmark harness;
8. add no production dependency until real-video evidence shows a useful net benefit.

If the experiment later copies non-trivial Apache-licensed FOCUS code, add the required attribution/license notices in the same commit.

## 10. Initial go/no-go hypotheses

The experiment starts with the following falsifiable hypotheses:

- **H1:** localizable semantic checks can use fewer downstream visual inputs without increasing false negatives.
- **H2:** purely query-aware selection will be unsafe for at least some global/temporal defect classes.
- **H3:** a hybrid temporal floor will recover some or all of those misses at lower downstream cost than baseline.
- **H4:** on short ForgeDirector videos, selector overhead may eliminate the economic value even if downstream frames/tokens fall.
- **H5:** the released optimistic final-arm policy and paper empirical-mean policy may differ enough that the choice must remain versioned in cache/metadata.

No hypothesis is accepted until the existing ForgeDirector corpus and controlled defect fixtures support it.
