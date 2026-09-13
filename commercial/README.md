# ForgeDirector Commercial API — launch runbook

This folder packages the ForgeDirector creative-director engine for distribution through RapidAPI.

## Product

**ForgeDirector Video Creative Intelligence API**

Launch endpoints:

- `POST /v1/plan` — creative brief → structured production manifest
- `POST /v1/revise` — existing manifest + instruction → revision-aware updated manifest
- `POST /v1/qa` — deterministic production QA without an AI-model call
- `POST /v1/uploads` — create a short-lived private video upload ticket
- `POST /v1/analyze` — analyze uploaded video and return creative/compliance intelligence
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
  ├── /v1/analyze ──┘
  ├── /v1/uploads ───── private S3 upload ticket
  ├── /v1/qa ───────── deterministic QA
  └── /health
```

Infrastructure is defined in `../commercial-template.yaml` using AWS SAM.

## Before deployment

1. AWS account must be active.
2. Amazon Bedrock model access must be available in the deployment region.
3. Choose the model/inference profile and record its model ID or ARN.
4. Deploy `commercial-template.yaml`.
5. Record the `CommercialApiBaseUrl` stack output.
6. Test all six endpoints directly before locking the endpoint to RapidAPI, including the private upload → analyze video flow.

## RapidAPI setup

1. Open the existing ForgeDirector provider project in RapidAPI Studio.
2. Preserve the current AWS base URL and `X-RapidAPI-Proxy-Secret` configuration; that gateway lock is already proven live.
3. Use `openapi.yaml` as the contract/reference for endpoint schemas. Do **not** replace the entire existing API by importing it unless you have confirmed Rapid will preserve the working gateway/security configuration.
4. Add or verify the six endpoints listed above, especially `POST /v1/uploads` and `POST /v1/analyze`.
5. Configure BASIC / PRO / ULTRA / MEGA using `pricing.md`.
6. Configure both the mandatory Requests quota and the custom **Video Analyses** quota from `pricing.md`; associate Video Analyses only with `POST /v1/analyze`.
7. Use `listing.md` for the marketplace identity, copy, examples and keywords.
8. Confirm direct calls without the proxy secret receive `401` while RapidAPI Hub test-console calls succeed.
9. Keep the API PRIVATE until every item in `RAPIDAPI-FINISH.md` and `RELEASE-READINESS.md` is checked.
10. Publish only after explicit owner approval.

## Cost controls

- Use hard limits for both RapidAPI Requests and Video Analyses; no launch overages.
- Associate Video Analyses only with `POST /v1/analyze`.
- `/v1/qa` is deterministic and incurs no Bedrock inference call.
- Plan and revise calls are capped to a 6,000-character instruction and 120 KB request body.
- Bedrock output is capped to 3,200 tokens.
- The commercial Lambda is ARM64 with 1024 MB memory and a 120-second timeout.
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
