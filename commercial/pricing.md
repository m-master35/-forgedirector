# Launch pricing — ForgeDirector Video Creative Intelligence API

Goal: reach paid validation quickly while protecting AWS/Bedrock spend and keeping the offer easy to understand.

## Current RapidAPI plans

| Tier | Monthly price | RapidAPI requests | Approx. maximum full video analyses* | Purpose |
| --- | ---: | ---: | ---: | --- |
| BASIC | $0 | 10 | ~5 | Let a developer test real videos end-to-end without creating a large free-compute exposure. |
| PRO | $19 | 80 | ~40 | Solo builders and production prototypes. |
| ULTRA | $49 | 250 | ~125 | Creator tools, ad workflows, and regular production use. |
| MEGA | $99 | 600 | ~300 | Heavier SaaS and automation integrations. |

\* A normal full-analysis flow uses one API request to create the temporary upload URL and one API request to analyze the uploaded asset. The direct PUT to S3 is not a ForgeDirector API request. Planning/revision/QA calls also consume requests under the simple launch quota.

ULTRA is the recommended launch plan.

## Cost protection and measured unit economics

ForgeDirector currently limits videos to 30 MiB and declares a 120-second short-form duration ceiling. Successfully analyzed videos are deleted immediately. Abandoned uploads remain private and are removed by the storage lifecycle. Identical repeated analyses can be served from the private analysis cache with zero additional model tokens.

Live production cost-profile probe on 2026-09-13:

| Operation | Duration | Conservative upper model cost |
| --- | ---: | ---: |
| Normal plan | — | $0.0054 |
| Weak-prompt plan | — | $0.0086 |
| Fresh plain video analysis | 12s | $0.0050 |
| Fresh verified video analysis | 12s | $0.0229 |
| Fresh verified video analysis | 30s | $0.0409 |
| Fresh verified video analysis | 60s | $0.0572 |
| Fresh verified video analysis | 120s | **$0.1360** |
| Identical cached repeat | same request | $0 additional model inference |

The 120-second measurement is the launch quota-sizing case. This is intentionally much more conservative than pricing from the typical 10–30 second workload.

The real mixed-model video cost is lower than the all-Pro ceiling. Lambda, S3, data transfer, PayPal and tax are not included in these figures, so the ceiling is not a complete accounting cost.

Measured duration profile on the current verifier runtime:

- 12s with requirements: **~$0.019–$0.023** conservative upper model cost;
- 30s with requirements: **~$0.034–$0.041**;
- 60s with requirements: **~$0.057–$0.070**;
- 120s with requirements: **~$0.135–$0.136**.

The paid launch quotas were therefore tightened from the earlier experimental 200/1,000/3,000 request levels to **100/300/600** for PRO/ULTRA/MEGA. This protects margin even if a subscriber disproportionately consumes fresh maximum-duration analyses.

Rapid's current marketplace fee is 25% of API Hub payments. At the launch plans below, even the deliberately pessimistic all-Pro video cost leaves positive inference contribution if every possible full-analysis credit is consumed:

| Tier | Price | Provider revenue after 25% Rapid fee* | Max full analyses | 120s worst-case model spend | Remaining before Lambda/S3/PayPal/tax |
| --- | ---: | ---: | ---: | ---: | ---: |
| BASIC | $0 | $0 | ~5 | ~$0.68 | -$0.68 acquisition cost |
| PRO | $19 | $14.25 | ~40 | ~$5.44 | ~$8.81 |
| ULTRA | $49 | $36.75 | ~125 | ~$17.00 | ~$19.75 |
| MEGA | $99 | $74.25 | ~300 | ~$40.80 | ~$33.45 |

\* Before payout fees, AWS non-model costs and tax.

This is intentionally conservative because two RapidAPI requests are required per complete video analysis, many customers will consume some quota on cheaper planning/QA calls, and repeated identical video analyses can hit cache.

Do not increase quotas without rerunning `Benchmark Unit Economics` and the 12/30/60/120-second cost profile.

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

At $49/month, ten ULTRA customers produce $490 gross marketplace revenue. After Rapid's current 25% marketplace fee that is $367.50 before AWS, PayPal and tax.

Using the safer launch quota of ~125 maximum complete video analyses on ULTRA, the measured cost profile gives a more defensible range at a 2026-09-13 USD/ZAR reference near R16.10/$1:

- predominantly cached/light usage: about **9 ULTRA customers** for R5,000 contribution before payout fees/tax;
- predominantly 12–30 second fresh verified videos: about **10 ULTRA customers**;
- predominantly 60-second fresh verified videos: about **11 ULTRA customers**;
- pathological case where every included analysis is a fresh 120-second verified video: about **16 ULTRA customers**.

These counts are before Lambda/S3, PayPal payout fees and tax. For launch planning, use **10–16 ULTRA customers** as the realistic protected range, with 16 representing deliberate worst-case quota exhaustion rather than expected customer behavior.

The reduced launch quotas are deliberate. They protect margin even when customers use the full 120-second limit. If real usage clusters around 10–30 seconds, the measured economics will support increasing quotas later without changing price.

The commercial thesis is now stronger than the original prompt-wrapper version: paid users are buying a repeatable video-ingestion and creative-analysis contract, not merely a system prompt.

## Repricing trigger

Do not change the user-facing plans again until both are true:

1. Real video-analysis calls have been benchmarked for cost and latency.
2. At least one external developer has used the output and confirmed which fields are valuable enough to integrate.

If users mostly consume `/v1/analyze`, consider a later plan structure based on analysis credits rather than raw requests.
