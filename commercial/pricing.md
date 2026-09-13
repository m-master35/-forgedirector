# Launch pricing — ForgeDirector Video Creative Intelligence API

Goal: reach paid validation quickly while protecting AWS/Bedrock spend and keeping the offer easy to understand.

## Current RapidAPI plans

| Tier | Monthly price | RapidAPI requests | Approx. maximum full video analyses* | Purpose |
| --- | ---: | ---: | ---: | --- |
| BASIC | $0 | 20 | ~10 | Let a developer test real videos end-to-end. |
| PRO | $19 | 200 | ~100 | Solo builders and production prototypes. |
| ULTRA | $49 | 1,000 | ~500 | Creator tools, ad workflows, and regular production use. |
| MEGA | $99 | 3,000 | ~1,500 | Heavier SaaS and automation integrations. |

\* A normal full-analysis flow uses one API request to create the temporary upload URL and one API request to analyze the uploaded asset. The direct PUT to S3 is not a ForgeDirector API request. Planning/revision/QA calls also consume requests under the simple launch quota.

ULTRA is the recommended launch plan.

## Cost protection and measured unit economics

ForgeDirector currently limits videos to 30 MiB and declares a 120-second short-form duration ceiling. Successfully analyzed videos are deleted immediately. Abandoned uploads remain private and are removed by the storage lifecycle. Identical repeated analyses can be served from the private analysis cache with zero additional model tokens.

Live production usage probe on 2026-09-13:

| Operation | Model calls / path | Input tokens | Output tokens | Total observed tokens |
| --- | ---: | ---: | ---: | ---: |
| Normal plan | 2 | 3,089 | 826 | 3,915 |
| Weak-prompt plan | 3 | 4,131 | 1,210 | 5,341 |
| Fresh 12s video — primary analysis | Nova 2 Lite | 4,788 | 1,419 | 6,207 |
| Fresh 12s video — compliance verification | Nova Pro + Nova 2 Lite | 12,128 | 840 | 12,968 |
| Fresh 12s video — total observed | mixed | 16,916 | 2,259 | 19,175 |

For launch margin protection, use a deliberately conservative cost ceiling: price **all observed tokens as though they were charged at the more expensive EU Nova Pro rate**. Using a 2026-09 regional reference of approximately $1.05/M input and $4.20/M output, that gives:

- normal plan: **< $0.007** Bedrock inference;
- weak-prompt plan: **< $0.010**;
- fresh 12-second verified video analysis: **< $0.028**;
- cached repeat of the same video + normalized analysis request: **$0 additional model inference**.

The real mixed-model video cost is lower than the all-Pro ceiling. Lambda, S3, data transfer, PayPal and tax are not included in these figures, so the ceiling is not a complete accounting cost.

Rapid's current marketplace fee is 25% of API Hub payments. At the launch plans below, even the deliberately pessimistic all-Pro video cost leaves positive inference contribution if every possible full-analysis credit is consumed:

| Tier | Price | Provider revenue after 25% Rapid fee* | Max full analyses | Conservative Bedrock ceiling | Remaining before Lambda/S3/PayPal/tax |
| --- | ---: | ---: | ---: | ---: | ---: |
| BASIC | $0 | $0 | ~10 | ~$0.28 | -$0.28 acquisition cost |
| PRO | $19 | $14.25 | ~100 | ~$2.80 | ~$11.45 |
| ULTRA | $49 | $36.75 | ~500 | ~$14.00 | ~$22.75 |
| MEGA | $99 | $74.25 | ~1,500 | ~$42.00 | ~$32.25 |

\* Before payout fees, AWS non-model costs and tax.

This is intentionally conservative because two RapidAPI requests are required per complete video analysis, many customers will consume some quota on cheaper planning/QA calls, and repeated identical video analyses can hit cache.

Do not increase quotas without rerunning `Benchmark Unit Economics` and representative 10–60 second video benchmarks.

## Launch rules

- Keep hard monthly RapidAPI request limits.
- No automatic overages at initial launch.
- Keep BASIC useful enough to validate the full upload → analyze → gate workflow, but too small for production use.
- Do not market scores as predictions of views, retention, sales, ROAS, or virality.
- Benchmark at least 20 representative 10–60 second videos before changing quotas.
- If video analysis becomes the dominant paid usage, migrate from generic request quotas to a dedicated `Video Analyses` billing object so upload-ticket calls do not consume customer analysis credits.
- Keep uploaded media private and ephemeral.

## R5,000/month target

Rapid currently retains 25% of API Hub payments before provider payout, so the commercial target should be reached with a small number of paid integrations rather than high free volume.

At the current price points, roughly ten ULTRA customers produce $490 gross monthly marketplace revenue before RapidAPI fees, AWS, PayPal, and tax. The increased quotas are deliberate: current competing creative-scoring APIs make low-cost trials easy, while full native video analysis and production-spec QA justify materially higher per-analysis pricing than text-only or single-frame scoring.

The commercial thesis is now stronger than the original prompt-wrapper version: paid users are buying a repeatable video-ingestion and creative-analysis contract, not merely a system prompt.

## Repricing trigger

Do not change the user-facing plans again until both are true:

1. Real video-analysis calls have been benchmarked for cost and latency.
2. At least one external developer has used the output and confirmed which fields are valuable enough to integrate.

If users mostly consume `/v1/analyze`, consider a later plan structure based on analysis credits rather than raw requests.
