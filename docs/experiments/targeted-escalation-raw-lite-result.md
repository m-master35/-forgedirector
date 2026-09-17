# Targeted escalation: two-case raw-Lite diagnostic result

## Scope and provenance

This report audits the already completed diagnostic. It does not rerun inference, expand the corpus, retune extraction, or promote the experiment.

- Repository: `m-master35/-forgedirector`.
- Branch: `experiment/targeted-pro-escalation`.
- Draft PR: [#4](https://github.com/m-master35/-forgedirector/pull/4).
- Diagnostic/evidence HEAD: `6b3eff36d151ca87586c110b46b928e33d2a41d9`.
- Validated diagnostic revision before arming: `0f51ab14a4a27d731b3d823496bd1c7178e23b5d`.
- Earlier syntax fix: `b29f9df8462484e7d11718b4e97d58241ed0c4d4`.
- Earlier CI syntax-gate addition: `47017d7a170878ffb63d0488a619641c5f732507`.
- Baseline main at inspection: `174ab63d395e61a70ccd4e3eaaba56a2e1eef175`.
- Completed diagnostic: [Actions run 35204983436](https://github.com/m-master35/-forgedirector/actions/runs/35204983436), 2026-09-17, 09:24:53-09:26:12 UTC.
- Saved result timestamp: `2026-09-17T09:26:08.144Z`.
- New paid calls in this audit continuation: **zero**.

The branch was two commits ahead of the previously cited CI-gate commit: the conditional-Pro/evidence diagnostic revision and its run-token commit. The resulting completed run was retrieved rather than repeated.

## Decision

**Do not advance the current Lite-localization configuration to a larger targeted-escalation benchmark or controlled integration.**

The returned Nova 2 Lite analyses failed to detect and localize both known positive controls. Neither generated an eligible interval. Therefore the conditional Pro stage correctly did not run. There is no demonstrated defect-preserving duration reduction, latency improvement, or cost saving.

This is a negative feasibility result for this configuration on these two inputs, not proof that Nova Lite can never localize defects or that every targeted-escalation design is ineffective. One observation per case cannot establish reliability or a population failure rate.

## Validation and execution evidence

The completed diagnostic job records, in order, successful syntax parsing, targeted routing unit tests, corpus generation, and the bounded diagnostic. No syntax-failure run is counted as a model result.

The validated pre-run revision also passed normal ForgeDirector CI and experiment CI. The run-token commit changed only `.github/targeted-escalation-raw-lite-run-token`, not the diagnostic code. At the evidence HEAD, normal ForgeDirector CI and experiment CI were green.

Relevant runs:

- Pre-run normal CI: `35204817416`.
- Pre-run experiment CI: `35204817519`.
- Evidence-HEAD normal CI: `35204986915`.
- Evidence-HEAD experiment CI: `35204986831`.
- Paid diagnostic job: `105148432893`, successful.

The diagnostic selects exactly `visible-text-defect` and `localized-artifact` from `fd-targeted-corpus-v1`. Both probed source durations were 20 seconds; both controlled defects occupy the nominal 8-10 second window.

The Lite request uses empty requirements and omits the structured `durationSeconds` field while stating the actual duration in its textual context. This avoids the declared-duration coverage-recovery branch and avoids independent requirement-verifier calls. This is an experimental diagnostic request, not a recommendation to omit production coverage protections.

### Important limit of the raw-Lite isolation claim

The harness is still a client of the existing `/v1/analyze` endpoint. It is **not** a direct, provider-level Lite-only adapter with every possible Pro fallback disabled. Omitting declared duration disables the coverage-triggered recovery condition; technical-failure and non-substantive-result recovery remain in the unchanged endpoint.

The harness rejects a returned non-Lite model and reported fallback/coverage recovery. In these two actual records, the model ID was the exact intended Lite ID and all recorded recovery flags were false. The inspected analysis code switches to Pro on fallback and reports the selected final model; it does not switch a successful Pro analysis back to Lite. This supports attribution of these returned analyses to Lite rather than silently accepted Pro output.

There is no independent provider invocation trace, raw Bedrock transcript, or AWS billing audit in this artifact. Unreported same-model transport retries cannot be excluded from the saved response metadata. Do not turn response-level evidence into a stronger provider-level guarantee.

## Raw-Lite results

| Measurement | Visible-text defect | Rendering-artifact defect |
|---|---|---|
| Fixture | `visible-text-defect.mp4` | `localized-artifact.mp4` |
| Source duration | 20 s | 20 s |
| Controlled defect | `START FREE` changes to yellow `STATR FREE` | Time-enabled injected noise, `noise=alls=70:allf=t+u` |
| Ground truth | Nominal 8-10 s | Nominal 8-10 s |
| Returned model | `eu.amazon.nova-2-lite-v1:0` | `eu.amazon.nova-2-lite-v1:0` |
| Known defect detected | No | No |
| Known defect localized | No | No |
| Defect timestamp returned | None | None |
| Boundary error for known defect | Not computable: no matched prediction | Not computable: no matched prediction |
| Eligible merged windows | 0 | 0 |
| Useful Lite-driven short segment | No | No |
| Analyze-request latency | 5,291.06 ms | 11,693.39 ms |
| Reported input tokens | 6,759 | 6,757 |
| Reported output tokens | 558 | 1,250 |
| Reported total tokens | 7,317 | 8,007 |

### Visible text

The returned analysis says the text remains unchanged throughout the video. Its sole timeline entry spans 0-20 seconds and identifies `START FREE`, with no timeline issues, retention risks, or regeneration prompts. The known misspelling is absent from the saved full normalized analysis, not merely missed by the experiment's category matcher. The returned normalized quality gate is `accept` with high confidence.

### Rendering artifact

The returned analysis describes colorful vertical stripes, moving geometric shapes, dotted lines and a checkered pattern, but does not identify the injected noise at 8-10 seconds. All three timeline entries have empty issue lists.

The collector produces two generic `unlocalized_issue` findings associated with 0-3 seconds: a suggestion to make the hook more recognizable and a low-severity concern about audience appeal. These are not detections of the known rendering defect. It would be misleading to label their timestamps as localization of the injected noise or assign them a boundary-error score for that defect.

### Quality interpretation

For the two known positive defects, the observed detection counts are **0 true positives and 2 false negatives** at the Lite stage. Both are marked critical in the controlled manifest. These are fixture-level diagnostic counts, not a calibrated real-world critical-defect miss rate.

There were no additional negative controls in this two-case run, so a false-positive rate or specificity is not established. Generic creative suggestions are not automatically counted as false detections of a controlled defect.

## Evidence concerning fallback and recovery

Both saved Lite records and corresponding ledger entries contain:

```json
{
  "modelId": "eu.amazon.nova-2-lite-v1:0",
  "analysisRetryUsed": false,
  "coverageRetryUsed": false,
  "fallbackModelUsed": false,
  "complianceVerificationUsed": false,
  "complianceVerificationModelIds": [],
  "complianceVerificationUsage": null
}
```

Each case has one recorded `raw-lite` analyze request with positive token usage. No Pro call appears in the diagnostic ledger. The positive usage is also inconsistent with the inspected baseline's cache-hit return path, which zeros returned usage. A complete per-attempt trace and full original response metadata were not preserved, so these are bounded conclusions from the available evidence.

## Conditional Pro stage and controls

Both cases have `liteLocalizationSuccessful: false`, `fullPro: null`, and empty `targeted.segments`.

- Targeted Pro: **not run**, for either case.
- Full-video Pro controls in this diagnostic: **not run**, because the specified conditional gate did not open.
- Recorded Pro calls: **0**.
- Recorded video sent to Pro by this diagnostic: **0 seconds**.
- Source-time mapping and segment extraction for Pro: not exercised in this run.
- Paired Lite/targeted-Pro versus full-Pro accuracy, latency and economics: not measured.

No extraction interval was manufactured from the ground-truth window. Previous production-path results are separate evidence, not replacement controls for this raw-Lite diagnostic.

### Reporting corrections without rewriting the original evidence

The original artifact is preserved unchanged. Two derived fields must not be interpreted as model benchmark results:

1. `planEvidence.avoidedFullVideoSeconds` is 20 when an empty plan selects zero seconds. This arithmetic does **not** establish 20 seconds of quality-preserving savings. There was no successful replacement analysis.
2. `targeted.grade` was computed against an empty findings array even though targeted Pro did not run. Its false/miss values are **not** observations that Pro failed. Targeted-Pro quality is **not measured**.

The correct cost-saving and quality-preserving Pro-input-saving result is **not established**, not 100% savings and not zero Pro accuracy.

## Cost accounting

The harness contains assumed rates of $0.30 per million Lite input tokens and $2.50 per million Lite output tokens. These are recorded harness assumptions, not a newly verified regional tariff or an AWS invoice.

Using the saved token counts:

- Text: `(6759 * 0.30 + 558 * 2.50) / 1,000,000 = $0.0034227`.
- Artifact: `(6757 * 0.30 + 1250 * 2.50) / 1,000,000 = $0.0051521`.
- Total: **13,516 input + 1,808 output = 15,324 reported tokens**.
- Total estimate at those assumptions: **$0.0085748**, rounded by the harness to **$0.008575**.

Directly observed: endpoint-returned token counts, saved analyze-request timings, selected model metadata, and the two-request diagnostic ledger.

Estimated: token cost calculated from those counts and the configured rate assumptions.

Not observed: direct provider billing; exhaustive per-attempt usage; any unreported same-model transport retries; independently itemized S3, network, Lambda, runner and other overhead. The response-reported cost guard is not proof of a hard cap on every unobservable end-to-end charge.

No extraction for Pro was performed, so there is no targeted extraction overhead to compare. The reported analyze latency excludes initial upload reservation/upload and is not standalone Bedrock latency or total upload-to-result latency. Two observations do not warrant p50/p95 comparisons.

The earlier approximately $0.08-$0.12 production-path figure remains separate and incomplete; it is not used as a full end-to-end baseline or as the cost of this diagnostic.

## Fixture and evidence audit

The original Actions ZIP was downloaded and its SHA-256 matched the artifact digest:

`063556d4b1df4fd4d181fde166b006e979690041b5333e605e669ff3791f9aad`

Artifact: [10489826265](https://github.com/m-master35/-forgedirector/actions/runs/35204983436/artifacts/10489826265).

Unmodified extracted files:

- `raw-lite-results.json`: SHA-256 `b014edfcf8aaeaa839ad55b358f6b021f2c07c68b1d4e15a9f1185c3475e6163`.
- `raw-lite-results.md`: SHA-256 `1e7ebfebf7c15745b7e5cafe5789101544433de1e637150dd7205e9d814936c6`.

Offline checks independently verified two rows, two calls, the expected case names and model, flags, token arithmetic, empty Pro results, absent eligible windows, and the cost calculation. The full saved normalized analyses were reviewed rather than relying only on the matcher's aggregate scores.

The two fixture recipes were reproduced locally without provider calls, using the same filters, dimensions, frame rate and encoding-quality settings, with a local encoder-thread limit. Frame samples at 7, 9 and 11 seconds visibly show the misspelling and noise in the middle sample, with unaffected surrounding samples. Both local files probe as 20-second, 720x1280, 24-fps videos.

These are reproduction checks, not the original AWS-submitted bytes. The saved artifact does not contain those MP4s or their fingerprints, so bit-identical source-media provenance cannot be retrospectively certified. The artifact preserves normalized API-returned analyses and selected metadata, not raw Bedrock response transcripts.

## What this establishes and what remains uncertain

The intended pipeline needs a usable Lite suspicion before targeted Pro can help. In these two observations that prerequisite failed before extraction or Pro inference. Altering padding, merging or segment encoding cannot rescue an absent localized finding without changing the architecture under test.

The limiting component in the observed pipeline is the **Lite-stage defect recognition/localization output**, not a measured extraction or Pro-confirmation failure. The evidence does not isolate the internal reason: temporal sampling, visual interpretation, prompting and normalization remain possible contributors. The abstract test-pattern artifact is also not equivalent to every natural-video rendering defect.

Do not run a larger targeted-escalation campaign yet. Any subsequent paid work should be a separately authorized, bounded localization investigation with provider-level model/call provenance and raw responses, not more segment tuning or a compensating ground-truth crop. No such follow-on work is started here.

## Changes in this audit continuation

Repository change: this report only, `docs/experiments/targeted-escalation-raw-lite-result.md`.

No diagnostic code, routing policy, prompts, media adapter, production code, workflow, run token, spend limit, credential, IAM, billing setting or infrastructure was changed. No deployment or merge was performed. The PR remains an isolated experiment; no production promotion is approved.

The report commit follows evidence HEAD `6b3eff36d151ca87586c110b46b928e33d2a41d9`; the evidence SHA remains fixed regardless of subsequent documentation commits.
