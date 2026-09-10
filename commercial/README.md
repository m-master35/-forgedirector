# ForgeDirector Commercial API — launch runbook

This folder packages the ForgeDirector creative-director engine for distribution through RapidAPI.

## Product

**ForgeDirector Video Creative Intelligence API**

Launch endpoints:

- `POST /v1/plan` — creative brief → structured production manifest
- `POST /v1/revise` — existing manifest + instruction → revision-aware updated manifest
- `POST /v1/qa` — deterministic production QA without an AI-model call
- `GET /health` — health and endpoint discovery

The commercial Lambda handler is `backend/commercial.mjs`. It reuses the ForgeDirector Bedrock prompt layer while keeping marketplace routing, security, and QA isolated from the hackathon-facing handler.

## Deployment architecture

```text
RapidAPI consumer
      ↓
Rapid Runtime
      ↓  X-RapidAPI-Proxy-Secret
AWS Lambda Function URL
      ↓
commercial.mjs
  ├── /v1/plan ─────┐
  ├── /v1/revise ───┼── Amazon Bedrock
  ├── /v1/qa ───────┴── deterministic QA
  └── /health
```

Infrastructure is defined in `../commercial-template.yaml` using AWS SAM.

## Before deployment

1. AWS account must be active.
2. Amazon Bedrock model access must be available in the deployment region.
3. Choose the model/inference profile and record its model ID or ARN.
4. Deploy `commercial-template.yaml`.
5. Record the `CommercialApiBaseUrl` stack output.
6. Test `/health`, `/v1/plan`, `/v1/revise`, and `/v1/qa` directly before locking the endpoint to RapidAPI.

## RapidAPI setup

1. Create a provider API project in RapidAPI Studio.
2. Import `openapi.yaml`.
3. Set the AWS `CommercialApiBaseUrl` as the base URL.
4. Configure BASIC / PRO / ULTRA / MEGA using `pricing.md`.
5. Use `listing.md` for the marketplace copy and examples.
6. Copy the API-specific `X-RapidAPI-Proxy-Secret` from RapidAPI's security configuration.
7. Redeploy the AWS stack with `RapidApiProxySecret` set to that value.
8. Confirm direct calls without the secret receive `401` while RapidAPI test-console calls succeed.
9. Publish only after all three product endpoints return valid example responses.

## Cost controls

- Start with hard RapidAPI quotas and no paid overages.
- `/v1/qa` is deterministic and incurs no Bedrock inference call.
- Plan and revise calls are capped to a 6,000-character instruction and 120 KB request body.
- Bedrock output is capped to 3,200 tokens.
- The Lambda is ARM64 with 512 MB memory and a 40-second timeout.
- Add AWS Budgets / billing alerts before opening paid plans to the public.

## Launch success metrics

Track weekly:

- listing views
- BASIC subscriptions
- first successful request rate
- free → paid conversion
- paid MRR
- requests per paid subscriber
- average Bedrock cost per plan/revise request
- QA usage rate
- cancellation rate

Initial business target: get the first paying developer, then iterate toward approximately R5,000/month recurring revenue. Do not optimize for raw request volume at the expense of margin.
