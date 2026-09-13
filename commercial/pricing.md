# Launch pricing — ForgeDirector Video Creative Intelligence API

Goal: reach paid validation quickly while protecting AWS/Bedrock spend and keeping the offer easy for developers to understand.

## Recommended Rapid launch plans

Use **two quota objects** on every plan:

1. the mandatory Rapid `Requests` object for all API traffic;
2. a custom **Video Analyses** object associated **only** with `POST /v1/analyze`.

Both objects should use **Hard Limits**. Do not enable launch overages.

| Tier | Monthly price | Requests / month | Video Analyses / month | Purpose |
| --- | ---: | ---: | ---: | --- |
| BASIC | $0 | 20 | 5 | Real end-to-end evaluation without meaningful free production volume. |
| PRO | $25 | 250 | 50 | Solo developers and prototypes. |
| ULTRA | $75 | 1,000 | 200 | Creator tools, ad workflows and regular production use. |
| MEGA | $150 | 3,000 | 500 | Heavier SaaS and automation integrations. |

**ULTRA is the recommended launch plan.**

A complete video-analysis flow consumes:
- one normal API request for `POST /v1/uploads`;
- one normal API request for `POST /v1/analyze`;
- one **Video Analyses** quota unit because `/v1/analyze` is the only endpoint associated with that custom object;
- the direct PUT to S3 does not consume a Rapid API request.

Planning, revision and deterministic QA consume only normal Requests quota.

Rapid's current public guidance generally recommends BASIC free, PRO $25, ULTRA $75 and MEGA $150 as a starting tier distribution. The prices above follow that guidance while using ForgeDirector-specific quota limits.

## Why the separate Video Analyses quota is required

Fresh video analysis cost scales materially with video duration and compliance verification. Raw request limits therefore do not provide a reliable cost guardrail.

Measured production results on the current full-duration verifier:

| Video duration | Fresh latency | Input tokens | Output tokens | Total observed tokens | Conservative all-Nova-Pro ceiling* |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 12s | 19.2s | 17,117 | 2,203 | 19,320 | ~$0.0207 |
| 30s | 23.7s | 36,201 | 1,909 | 38,110 | ~$0.0351 |
| 60s | 30.1s | 66,821 | 2,191 | 69,012 | ~$0.0605 |
| 90s | 56.5s | 101,962 | 2,238 | 104,200 | ~$0.0887 |
| 120s | 66.8s | 136,013 | 2,480 | 138,493 | ~$0.1167 |

\* Deliberately pessimistic: every observed token is priced at the standard Nova Pro reference rate ($0.80/M input and $3.20/M output), even though production uses a cheaper mixed-model path. This is a launch-safety ceiling, not the expected bill.

All five duration cases returned HTTP 200 with full-duration compliance coverage in production.

Identical repeated video + normalized analysis requests can be served from the private analysis cache with zero additional model tokens. In the repeatability benchmark, cached responses were generally ~0.3–0.4 seconds.

## Plan margin stress test

Rapid currently retains 25% of API Hub payments before provider payout. At the recommended launch plans, provider subscription revenue before PayPal/AWS/tax is:

- PRO: $18.75
- ULTRA: $56.25
- MEGA: $112.50

If **every Video Analyses credit were exhausted using fresh 120-second requirement-bearing videos**, the deliberately pessimistic Bedrock ceilings are:

| Tier | Provider revenue after Rapid fee | Video Analyses | 120s all-Pro inference ceiling | Remaining before normal-request inference, Lambda/S3/PayPal/tax |
| --- | ---: | ---: | ---: | ---: |
| BASIC | $0 | 5 | ~$0.58 | -$0.58 acquisition cost |
| PRO | $18.75 | 50 | ~$5.84 | ~$12.91 |
| ULTRA | $56.25 | 200 | ~$23.35 | ~$32.90 |
| MEGA | $112.50 | 500 | ~$58.37 | ~$54.13 |

Normal planning/revision calls are far cheaper. A measured normal plan used 3,089 input + 826 output tokens; a weak-prompt recovery used 4,131 input + 1,210 output tokens.

This plan structure remains inference-positive even under an intentionally severe 120-second worst-case assumption and leaves substantially more protection than the old request-only quotas.

## Cost protection

- Maximum uploaded video size: 30 MiB.
- Declared short-form duration ceiling: 120 seconds.
- Successfully analyzed videos are deleted immediately.
- Rejected tested analysis uploads are deleted.
- Abandoned uploads remain private and are lifecycle-cleaned.
- Analysis cache is private; logically expires after 24 hours.
- Identical cached repeats consume zero additional model tokens.
- Model escalation is bounded.
- Use hard monthly limits for both Requests and Video Analyses.
- No launch overages.

## R5,000/month target

At a 25% Rapid marketplace fee:

- each ULTRA subscription contributes $56.25 before AWS, PayPal and tax;
- at a recent USD/ZAR reference around R16.10/$1, that is roughly R906 before infrastructure;
- six ULTRA customers therefore produce roughly R5,434 before AWS/PayPal/tax.

Under the deliberately pessimistic case where each ULTRA customer exhausts all 200 Video Analyses on fresh 120-second videos, maximum modeled Bedrock inference is about $23.35 per ULTRA account, leaving about $32.90 before other infrastructure and payout/tax costs. That extreme utilization would require materially more than six accounts to net R5,000.

Real usage is expected to be a mix of shorter videos, cheap planning/QA requests and cached repeats. Until real customer distribution is known, use **roughly 8–12 ULTRA-equivalent paid customers** as the safer planning range for the R5,000/month contribution goal rather than assuming every subscription contributes its full post-Rapid revenue.

## Repricing trigger

Do not increase Video Analyses quotas until all of the following are true:

1. Real customer duration distribution is known.
2. Real AWS bills agree with the token-derived cost model.
3. At least one external developer has confirmed which response fields are valuable enough to integrate.
4. Cache-hit rates and repeat-analysis behavior are understood.

If most users analyze <=30-second video, quotas can later be increased or duration-weighted plans can be tested. If long videos dominate, keep the analysis-credit caps or introduce separate long-video pricing.
