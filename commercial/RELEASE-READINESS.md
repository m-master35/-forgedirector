# ForgeDirector — Release Readiness Gate

Status date: 2026-09-13

This file is the authoritative pre-publication checklist for ForgeDirector AI Video QA & Creative Intelligence.

## Automated product gates

### Director / planning reliability — PASS
- Focused live robustness: 13/13 representative bad/good/revision prompts.
- Broad adversarial + stochastic stress: 41/41 live calls on the frozen production build.
- Malformed-input fuzz suite: 250 cases in CI.
- Prompt injection, contradictory constraints, multilingual input, typo-heavy scoped revisions, claim traps and zero-signal prompts covered.
- Plan/revise responses expose authoritative `meta.qualityGate`.
- Model escalation is bounded and can recover through a validated deterministic production blueprint.

### Video compliance accuracy — PASS
Latest labeled benchmark on the current contiguous-window verifier runtime:
- 52/52 compliance checks correct.
- 29/29 full-duration coverage.
- 28/28 no-speech hallucination checks.
- 0 technical failures.
- Coverage contract requires >=95% contiguous timeline coverage, opening evidence, final-5% evidence, and duration-scaled minimum segmentation.
- Media prompt-injection and context/transcript-injection controls rejected correctly.
- Primary full-duration evidence + independent blind verification consensus is required for authoritative requirement decisions; disagreement becomes `needs_review`.

### Real-video repeatability / idempotence — PASS
Latest repeated genuine/generated-video benchmark on the same current runtime:
- 6 clips × 5 analyses = 30/30 successful.
- First call per unique normalized analysis request is fresh.
- Repeated identical requests return the exact cached analysis.
- Overall score range: 0 for all six clips after caching.
- Hook score range: 0 for all six clips.
- Quality-gate span: 0 for all six clips.
- Cached responses return in about 0.3–0.4 seconds in the current-runtime benchmark and consume zero additional model tokens.

### Performance / concurrency — PASS
Representative live production benchmark:
- Normal plan p95 approximately 4–5 seconds.
- Weak prompt p95 approximately 6–7 seconds.
- Zero-signal prompt approximately 1.5–2.5 seconds.
- 8 concurrent mixed requests all returned valid quality-gated responses; observed p95 approximately 7–11 seconds across recent runs.
- Load-aware recovery bounds model-call escalation and avoids retry storms.

### API negative contract / security — PASS
- 17/17 malformed/unauthorized client cases return predictable 4xx JSON errors with request IDs.
- No tested malformed request becomes an unexpected 5xx.
- Gateway bypass without RapidAPI proxy secret returns 401.
- Exact upload `sizeBytes` is required and bound to presigned Content-Length.
- N+1 byte upload against an N-byte presign is rejected.
- Temporary video objects are deleted after successful analysis and after tested pre-model analysis rejection.
- Uploaded media is private and lifecycle-cleaned.

### Production smoke / infrastructure — PASS
- Health endpoint.
- RapidAPI gateway lock.
- Bedrock planning path.
- S3 upload path.
- Real-video intelligence path.
- Compliance verifier path.
- AWS deployment / SAM smoke checks.

## Unit economics — PASS FOR LAUNCH

Measured live production planning:
- Normal plan: 3,089 input + 826 output tokens; 2 model calls.
- Weak-prompt plan: 4,131 input + 1,210 output tokens; 3 model calls.

Measured fresh verified-video duration profile on the current contiguous-window verifier:

| Duration | Total observed tokens | Fresh latency | Conservative all-Nova-Pro ceiling |
| ---: | ---: | ---: | ---: |
| 12s | 19,320 | 19.2s | ~$0.0207 |
| 30s | 38,110 | 23.7s | ~$0.0351 |
| 60s | 69,012 | 30.1s | ~$0.0605 |
| 90s | 104,200 | 56.5s | ~$0.0887 |
| 120s | 138,493 | 66.8s | ~$0.1167 |

All five duration cases returned HTTP 200 and full-duration coverage.

Launch cost guardrail:
- keep the mandatory Rapid `Requests` object;
- add a custom **Video Analyses** object associated only with `POST /v1/analyze`;
- BASIC: $0 / 20 Requests / 5 Video Analyses;
- PRO: $25 / 250 Requests / 50 Video Analyses;
- ULTRA: $75 / 1,000 Requests / 200 Video Analyses;
- MEGA: $150 / 3,000 Requests / 500 Video Analyses;
- both objects use Hard Limits;
- no launch overages.

Rapid marketplace fee: 25% of API Hub payments as of 2026-09.

At the deliberately pessimistic 120-second all-Pro ceiling, fully exhausting the Video Analyses quota implies roughly $5.84 PRO / $23.35 ULTRA / $58.37 MEGA of Bedrock inference. That remains below post-Rapid subscription revenue of $18.75 / $56.25 / $112.50 respectively, before normal-request inference, Lambda/S3, PayPal and tax.

Identical cached repeat analyses consume zero additional model tokens and returned in roughly 0.3–0.4 seconds in the latest repeatability gate.

See `commercial/pricing.md`, `Benchmark Unit Economics`, and `Benchmark Duration Unit Economics` for detailed assumptions and evidence.

## Public API contract — PASS
- Runtime / OpenAPI contract: v1.3.0.
- Endpoints:
  - GET `/health`
  - POST `/v1/plan`
  - POST `/v1/revise`
  - POST `/v1/qa`
  - POST `/v1/uploads`
  - POST `/v1/analyze`
- Upload contract documents exact Content-Type and Content-Length.
- Planning/revision documents authoritative quality gate and recovery metadata.
- Video analysis documents compliance, coverage, cache, verifier and scoring metadata.
- Scores are explicitly described as heuristic creative assessments, not predictions of views, sales, retention, ROAS or virality.

## Manual RapidAPI gates — CONSUMER FLOW VERIFIED

RapidAPI Hub consumer-flow validation passed on 2026-09-13 against the live ForgeDirector AWS backend. No AWS deployment, CloudFormation/IAM, RapidAPI billing, pricing, security, gateway-secret, or visibility changes were made during this validation.

### 2026-09-13 RapidAPI Hub validation evidence

- `GET /health` returned HTTP 200 through RapidAPI Hub.
- `POST /v1/plan` returned HTTP 200 through RapidAPI Hub with the supplied JSON body forwarded as `application/json`; the response reflected TikTok, 9:16, 30 seconds, a young-professionals productivity-app brief, no `missing_brief`, and `meta.qualityGate.passed == true`.
- `POST /v1/uploads` returned HTTP 200 through RapidAPI Hub and produced a fresh asset ID plus signed PUT URL for an MP4 upload ticket.
- The signed PUT upload of the unmodified MP4 returned HTTP 200 using the exact requested content length.
- `POST /v1/analyze` returned HTTP 200 through RapidAPI Hub using the same fresh asset ID and included `analysis.qualityGate`, scores, compliance, hook, timeline, and CTA output.

RapidAPI Studio/Provider Dashboard checklist:

- [x] All six endpoints above are visible and point to the live AWS base URL.
- [x] `POST /v1/uploads` requires `contentType` and exact `sizeBytes`.
- [x] `POST /v1/analyze` shows the current request example and requirement fields.
- [ ] API name is **ForgeDirector AI Video QA & Creative Intelligence**.
- [ ] Short description and long listing copy match `commercial/listing.md`.
- [ ] Logo / marketplace image is present.
- [ ] BASIC / PRO / ULTRA / MEGA prices and Requests quotas match `commercial/pricing.md`.
- [ ] Custom **Video Analyses** object exists and is associated only with `POST /v1/analyze`.
- [ ] Video Analyses monthly quotas are BASIC 5 / PRO 50 / ULTRA 200 / MEGA 500.
- [ ] Both Requests and Video Analyses use **Hard Limits**, not soft overage limits.
- [ ] No unintended overage fee is enabled.
- [ ] Payout/PayPal setup is valid.
- [x] API is public after owner-led publication; no visibility change was made during validation.
- [x] Hub test: `GET /health` returns 200.
- [x] Hub test: `POST /v1/plan` returns 200 and `meta.qualityGate.passed == true`.
- [x] Hub test: upload-ticket request returns a valid asset ID + signed PUT URL.
- [x] Hub test: signed PUT upload to the returned URL returns 200.
- [x] Hub test: `POST /v1/analyze` returns 200 with `analysis.qualityGate`, scores, compliance, hook, timeline, and CTA.
- [x] Hub consumer flow has been tested through RapidAPI rather than only directly against AWS.
- [ ] Final publication approval has been given by the owner.

## Release decision

Automated engineering status: **GO**.

RapidAPI Hub consumer-flow status: **GO** as of 2026-09-13.

Marketplace/publication status: **LIVE / VALIDATED** for the current launch stage. Remaining unchecked dashboard/commercial items should still be re-audited before changing pricing, billing, payout, visibility, security, gateway settings, or marketplace copy.

Do not weaken automated quality/security gates merely to clear the manual marketplace checklist.
