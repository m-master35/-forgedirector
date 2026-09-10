# Launch pricing — ForgeDirector Video Creative Intelligence API

Goal: reach the first paid users quickly while protecting AWS/Bedrock spend during validation.

RapidAPI supports up to four subscription tiers. Launch with hard monthly limits rather than overage billing until real request costs and conversion behaviour are measured.

| Tier | Monthly price | Included requests | Purpose |
| --- | ---: | ---: | --- |
| BASIC | $0 | 10 | Let a developer test the API end-to-end. |
| PRO | $19 | 150 | Solo builders and small automation workflows. |
| ULTRA | $49 | 600 | Production prototypes, agencies, and creator tools. |
| MEGA | $99 | 1,500 | Heavier integrations and SaaS products. |

## Launch rules

- Use hard limits on every tier initially. No automatic overages.
- Count `/v1/plan`, `/v1/revise`, and `/v1/qa` as billable requests at launch for simplicity.
- `/health` should not be used as the quota object.
- Revisit quotas after at least 30 days of real request-cost data.
- Do not reduce prices for the first few users unless marketplace data shows a clear conversion problem.

## R5,000/month target

The revenue target is deliberately achievable without large scale. Examples before marketplace fees, payment fees, tax, and cloud costs:

- 7 ULTRA + 1 PRO = $362 MRR.
- 4 ULTRA + 6 PRO = $310 MRR.
- 2 MEGA + 3 ULTRA = $345 MRR.

The objective is not to maximize call volume. It is to acquire a small number of developers for whom structured creative planning and revision-aware state save meaningful development time.
