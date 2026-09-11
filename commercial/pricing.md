# Launch pricing — ForgeDirector Video Creative Intelligence API

Goal: reach paid validation quickly while protecting AWS/Bedrock spend and keeping the offer easy to understand.

## Current RapidAPI plans

| Tier | Monthly price | RapidAPI requests | Approx. maximum full video analyses* | Purpose |
| --- | ---: | ---: | ---: | --- |
| BASIC | $0 | 10 | ~5 | Let a developer test real videos end-to-end. |
| PRO | $19 | 100 | ~50 | Solo builders and production prototypes. |
| ULTRA | $49 | 500 | ~250 | Creator tools, ad workflows, and regular production use. |
| MEGA | $99 | 1,500 | ~750 | Heavier SaaS and automation integrations. |

\* A normal full-analysis flow uses one API request to create the temporary upload URL and one API request to analyze the uploaded asset. The direct PUT to S3 is not a ForgeDirector API request. Planning/revision/QA calls also consume requests under the simple launch quota.

ULTRA is the recommended launch plan.

## Cost protection

ForgeDirector currently limits videos to 30 MiB and declares a 120-second short-form duration ceiling. Successfully analyzed videos are deleted immediately. Abandoned uploads remain private and are removed by the existing storage lifecycle.

Amazon Nova 2 Lite samples short videos at roughly one frame per second. AWS documentation estimates about 2,880 input tokens for a 10-second video and 8,640 input tokens for a 30-second video. At the published Nova 2 Lite text/video token rates used for launch modeling, video-input cost is small relative to the returned analysis text.

Use the actual Bedrock `usage` object returned in ForgeDirector responses to measure production cost before changing quotas.

## Launch rules

- Keep hard monthly RapidAPI request limits.
- No automatic overages at initial launch.
- Keep BASIC intentionally small.
- Do not market scores as predictions of views, retention, sales, ROAS, or virality.
- Benchmark at least 20 representative 10–60 second videos before changing quotas.
- If video analysis becomes the dominant paid usage, migrate from generic request quotas to a dedicated `Video Analyses` billing object so upload-ticket calls do not consume customer analysis credits.
- Keep uploaded media private and ephemeral.

## R5,000/month target

RapidAPI currently retains a marketplace fee from provider revenue, so the commercial target should be reached with a small number of paid integrations rather than high free volume.

At the current price points, roughly ten ULTRA customers produce $490 gross monthly marketplace revenue before RapidAPI fees, AWS, PayPal, and tax.

The commercial thesis is now stronger than the original prompt-wrapper version: paid users are buying a repeatable video-ingestion and creative-analysis contract, not merely a system prompt.

## Repricing trigger

Do not change the user-facing plans again until both are true:

1. Real video-analysis calls have been benchmarked for cost and latency.
2. At least one external developer has used the output and confirmed which fields are valuable enough to integrate.

If users mostly consume `/v1/analyze`, consider a later plan structure based on analysis credits rather than raw requests.
