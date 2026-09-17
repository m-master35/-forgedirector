# Targeted Nova Pro escalation benchmark design

Experiment: `fd-targeted-escalation-v1`

## Question

Can ForgeDirector preserve real defect detection while materially reducing the amount of source video submitted to Nova Pro, with net paid-inference savings large enough to justify the added routing and media-extraction complexity?

## Control matrix

### A — Existing production analysis route

Use the current ForgeDirector decision logic as the descriptive baseline:

- ordinary successful analysis starts with the configured primary model (commercial default: Nova 2 Lite);
- continuity-rule requests currently select the configured fallback model before the first analysis call;
- primary technical failure, empty/non-substantive output, or failed full-duration coverage can route to the fallback model;
- every such fallback/recovery still receives the original full source video;
- requirement-bearing analyses additionally run blind full-video compliance verification across the configured verifier models.

A is not modified by this experiment.

### B — Explicit full-video Pro control

For benchmark comparability, send the entire source video to Nova Pro using ForgeDirector's existing full-video analysis contract. This gives a consistent full-Pro quality/cost control even for cases where production would not normally escalate.

### C — Targeted Pro, conservative context

Lite full-video analysis -> localized eligible finding -> ±10 second padding -> deterministic merge -> extracted segment -> targeted Pro confirmation.

### D — Targeted Pro, medium context

Same as C with ±5 second padding.

### E — Targeted Pro, aggressive context

Same as C with ±2 second padding.

### F — Hybrid

Use the medium targeted plan only when all findings that require Pro confirmation are localization-compatible and targeted execution stays inside hard limits. If a global/context-sensitive finding exists, localization is missing, extraction fails, or a spend/duration ceiling would be exceeded, use the existing whole-video Pro behavior.

For benchmark accounting, a whole-video result already obtained for B may be reused as the F control result so the benchmark does not pay twice merely to duplicate identical full-video evidence. The simulated F cost must still charge the full-video Pro call.

## Segment-equivalence control

For each timestamp-controlled localized defect, extract the exact known ground-truth defect interval and send that interval to the targeted Pro verifier.

This distinguishes:

- Lite localization failure;
- padding/window failure;
- routing failure;
- extraction failure;
- genuine context dependency;
- model variance even when the correct evidence is present.

A defect that Nova Pro cannot confirm from the exact ground-truth interval is not evidence that Lite localization is the problem.

## Corpus

The v1 corpus combines timestamp-controlled synthetic fixtures with real-video controls already used by ForgeDirector's live video benchmark.

Synthetic categories:

- localized forbidden content;
- visible text defect;
- object/product mismatch;
- localized visual artifact;
- transition issue;
- global continuity control;
- global pacing control;
- no-defect control.

Real-video controls:

- motorcycle video already used by the ForgeDirector live benchmark;
- Camber tumbler UGC/product video already used by the live benchmark.

The FOCUS experiment may independently use some of the same fixture concepts or source assets, but this experiment does not import or call FOCUS implementation code.

## Quality metrics

Record per case and per strategy:

- true positives;
- false negatives;
- critical-defect misses;
- localization overlap with timestamp ground truth;
- Pro confirmation status;
- no-defect false positives where ground truth is controlled;
- defect category;
- whether targeted routing was eligible;
- whether hybrid fell back to whole video.

Every targeted false negative must be assigned a root-cause category:

- `localization_miss`;
- `window_too_narrow`;
- `context_dependency`;
- `extraction_failure`;
- `routing_failure`;
- `model_variance_or_context`;
- `unclassified` only when the evidence does not support a safer classification.

## Efficiency metrics

Record:

- Lite calls;
- Pro calls by call class;
- source-video seconds submitted to full-video Pro;
- segment seconds submitted to targeted Pro;
- percentage Pro-duration reduction;
- padded intervals;
- merged intervals;
- Pro calls avoided by merging;
- full-video fallbacks avoided;
- full-video fallbacks retained for safety.

## Cost metrics

Use observed Bedrock token usage where available and keep the price snapshot configurable via environment variables.

Report separately:

- Lite input/output usage and estimated cost;
- full-video Pro input/output usage and estimated cost;
- targeted Pro input/output usage and estimated cost;
- extraction latency/CPU overhead (not misrepresented as zero operational cost in production);
- total model cost per analysis;
- cost per source-video minute;
- absolute saving and percentage saving versus B;
- saving on cases that actually need Pro confirmation;
- saving averaged across the corpus.

The existing production blind compliance-verifier overhead must be called out separately. Targeted escalation must not claim that cost as saved unless a later experiment explicitly and safely changes that verifier path.

## Latency metrics

Record:

- Lite inference latency;
- extraction latency;
- targeted Pro latency;
- full-video Pro latency;
- end-to-end strategy latency;
- p50/p95 when sample size is large enough to make those summaries useful.

## Spend and execution safety

Normal PR CI never performs paid inference.

The paid benchmark is `workflow_dispatch` only and requires the literal confirmation string `RUN_PAID_BENCHMARK` plus existing repository AWS configuration. It does not deploy or change IAM, secrets, billing, provider settings, or infrastructure.

Hard benchmark caps:

- maximum corpus cases;
- maximum Bedrock calls;
- maximum cumulative Pro video-seconds;
- maximum observed token-cost estimate.

Experiment routing itself also has per-analysis ceilings for Pro calls, total escalated duration, and individual interval duration.

## Decision gate

### REJECT

Use when any of the following dominates the result:

- critical-defect misses are introduced by targeted routing;
- Lite localization is too unreliable for the eligible classes;
- exact segment-equivalence controls frequently fail;
- safe hybrid routing collapses to full-video Pro so often that savings are negligible;
- extraction/latency/operational complexity outweighs model savings.

### PROMISING

Use when:

- material Pro-duration and model-cost savings are demonstrated;
- most quality is preserved;
- but one or more defect classes, padding sizes, or context-dependent cases still require refinement.

### CANDIDATE FOR CONTROLLED INTEGRATION

Only if all are demonstrated:

1. no unacceptable critical-defect regression;
2. false negatives remain within an explicitly accepted bound;
3. routing decisions are reliable;
4. Pro video duration falls materially;
5. net model-cost savings are meaningful after accounting for extraction;
6. latency and operational complexity are reasonable;
7. fallback behavior is safe.

Even then, production promotion is a separate decision and is not performed by this experiment.

## Next-experiment selection

- Choose **paired-context escalation** if exact local segments work but continuity/identity defects require comparison windows.
- Choose **TimePLE temporal localization** if Pro succeeds on exact segments but Lite localization is the dominant failure.
- Choose **FOCUS + targeted escalation** only if targeted Pro works and upstream frame selection independently demonstrates safe pre-inference reduction.
- Choose **native vLLM pruning + targeted escalation** only if that separate experiment demonstrates a deployable compatible runtime and targeted escalation quality is already sound.
- Choose **no further work in this direction** if exact-segment Pro quality or economics are poor.
