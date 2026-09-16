# Targeted Nova Pro Escalation Experiment

Status: isolated experiment only  
Experiment version: `fd-targeted-escalation-v1`  
Routing policy: `fd-targeted-routing-v1`

## Production baseline verified from code

ForgeDirector's commercial video endpoint resolves the uploaded private S3 object and passes that object to Amazon Bedrock as a native `video` content block.

Primary model default:

- `eu.amazon.nova-2-lite-v1:0`

Fallback model default:

- `eu.amazon.nova-pro-v1:0`

The current analysis invocation uses:

```js
video: {
  format: asset.format,
  source: {
    s3Location: {
      uri: asset.uri,
    },
  },
}
```

The fallback branches change the model ID and prompt, but not the media source.

### Exact current Pro media behavior

When the analysis path escalates to Nova Pro today, Nova Pro receives the same original `asset.uri` supplied to Nova Lite: the full uploaded source video.

This is true for:

1. primary-model invocation failure followed by fallback;
2. empty/non-substantive analysis recovery;
3. full-duration coverage recovery;
4. continuity-sensitive requests, which currently select the fallback model before the first analysis call.

There is no existing segment extraction step in the production video-analysis path.

There is also a separate blind compliance verification path. When requirements are present it iterates the configured verifier models in the order `[VIDEO_FALLBACK_MODEL_ID, MODEL_ID]`. Each verifier receives the same full original `asset.uri`. With the commercial defaults, that means a full-video Nova Pro compliance-verifier call is normally attempted even when the primary Lite analysis succeeds.

## Important implication for this experiment

The production fallback is not currently triggered because Lite found a localized defect. It is predominantly triggered when Lite failed technically, returned insufficient output, failed coverage, or when continuity rules force the stronger model.

Those conditions often provide no trustworthy Lite localization. A targeted segment cannot safely replace the whole-video fallback in those cases.

Therefore the experiment must report Pro usage by call class:

- analysis fallback;
- analysis coverage recovery;
- continuity-sensitive direct Pro;
- blind compliance verification;
- targeted experimental confirmation.

Savings must not be claimed by silently excluding unchanged full-video Pro verification calls.

## Insertion seam

The safest experimental seam is after a successful, substantive, full-duration Lite result has been normalized and before any new experimental Pro confirmation is attempted.

The experiment must:

1. preserve the successful Lite result;
2. derive suspicious intervals from existing structured evidence;
3. route only localization-compatible defect classes to targeted Pro;
4. keep global/unlocalized/context-dependent findings on the whole-video path;
5. return experimental diagnostics separately;
6. never mutate the baseline cache entry;
7. require both an environment gate and request opt-in.

No default `/v1/analyze` behavior changes are permitted.

## Initial routing policy

### Eligible for targeted escalation when localized

- observed forbidden-content presence;
- localized visible-text defect;
- localized visual artifact;
- localized product/logo/object mismatch;
- localized transition defect.

### Whole-video in v1

- pacing;
- repetition across distant scenes;
- full-duration coverage;
- global consistency;
- audio/video synchronization;
- missing global content;
- unlocalized findings;
- continuity/character inconsistency that requires comparison with another time range.

Continuity and character inconsistency may become eligible only if later benchmark evidence justifies paired-context escalation.

## Suspicion evidence sources

Use existing Lite output first:

- compliance check `timestampSeconds`;
- timeline `startSeconds` / `endSeconds` and issues;
- regeneration-prompt start/end intervals;
- retention-risk timestamps only when the defect classifier determines the issue is genuinely local.

No extra localization model is added in v1.

## Padding strategies

The benchmark exposes:

- conservative: 10 seconds each side;
- medium: 5 seconds each side;
- aggressive: 2 seconds each side;
- hybrid: medium padding for eligible findings, existing whole-video fallback otherwise.

All padding is clamped to the actual/declared duration.

## Interval merging

Padded windows are sorted and deterministically merged when overlapping or separated by no more than the configured merge gap. The benchmark records pre-merge windows, merged windows, and avoided Pro calls.

## Segment extraction

The experiment uses a dedicated ffmpeg adapter. Production currently ships no ffmpeg dependency, so the adapter requires an explicitly configured executable and is never activated by baseline requests.

The initial accurate mode uses decode/re-encode seeking so the requested start time is frame-accurate enough for source-time mapping. A stream-copy mode remains available for comparison, but its keyframe rounding must be measured before relying on its source mapping.

Segment-equivalence controls are mandatory because re-encoding can itself affect visual evidence.

## Source-time mapping

Each extracted segment records:

- requested source start/end;
- actual extraction start/end when measurable;
- local segment duration;
- representation mode/version.

A Pro-local timestamp is mapped as:

`source_seconds = actual_source_start_seconds + pro_local_seconds`

Mapping is clamped to the segment/source bounds and tested independently.

## Cache isolation

Experimental identity includes at least:

- experiment version;
- routing-policy version;
- strategy;
- padding;
- merge gap;
- primary model;
- Pro model;
- prompt versions;
- source fingerprint;
- extracted/merged intervals;
- media representation version.

Baseline cache keys remain untouched.

## Spend safety

The experiment enforces configurable hard ceilings for:

- maximum Pro calls;
- maximum total escalated source duration;
- maximum individual segment duration.

If targeted escalation is not safe or possible, hybrid mode records the reason and uses the existing whole-video behavior only when that fallback is already permitted by the baseline semantics. The experiment never creates an unbounded fan-out of Pro calls.

## Benchmark decision rule

A reduction in Pro video seconds is not sufficient.

The experiment must report:

- baseline vs targeted true/false positives and false negatives;
- critical misses;
- localization error;
- Pro confirmation accuracy;
- total Pro calls;
- full-video vs targeted Pro seconds;
- Lite cost;
- Pro cost;
- extraction overhead;
- total cost per analysis and source minute;
- latency;
- root cause of every baseline-positive / targeted-negative case.

Final classification remains one of:

- REJECT
- PROMISING
- CANDIDATE FOR CONTROLLED INTEGRATION

No production promotion is automatic.
