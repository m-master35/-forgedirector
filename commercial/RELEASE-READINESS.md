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
Latest unchanged labeled benchmark:
- 52/52 compliance checks correct.
- 29/29 full-duration coverage.
- 28/28 no-speech hallucination checks.
- 0 technical failures.
- Media prompt-injection and context/transcript-injection controls rejected correctly.
- Primary full-duration evidence + independent blind verification consensus is required for authoritative requirement decisions; disagreement becomes `needs_review`.

### Real-video repeatability / idempotence — PASS
Latest repeated genuine/generated-video benchmark:
- 6 clips × 5 analyses = 30/30 successful.
- First call per unique normalized analysis request is fresh.
- Repeated identical requests return the exact cached analysis.
- Overall score range: 0 for all six clips after caching.
- Hook score range: 0 for all six clips.
- Quality-gate span: 0 for all six clips.
- Cached responses return in about 0.27–0.33 seconds in the benchmark and consume zero additional model tokens.

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

Measured live production workload:
- Normal plan: 3,089 input + 826 output tokens; 2 model calls.
- Weak-prompt plan: 4,131 input + 1,210 output tokens; 3 model calls.
- Fresh 12s verified video:
  - primary: 4,788 input + 1,419 output tokens;
  - compliance verification: 12,128 input + 840 output tokens;
  - total observed: 19,175 tokens.

Conservative margin policy:
- Price all observed inference at the more expensive EU Nova Pro rate when checking launch safety, even though production uses a cheaper mixed-model path.
- Conservative fresh-video Bedrock ceiling: under about $0.028 per measured 12-second analysis.
- Cached identical repeat: zero additional model tokens.
- Rapid marketplace fee: 25% of API Hub payments as of 2026-09.

Current public-plan proposal remains positive on Bedrock inference even at full video-heavy utilization:
- BASIC $0 / 20 requests.
- PRO $19 / 200 requests.
- ULTRA $49 / 1,000 requests.
- MEGA $99 / 3,000 requests.
- Hard limits; no launch overages.

See `commercial/pricing.md` and `Benchmark Unit Economics` for the detailed assumptions.

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

## Manual RapidAPI gates — NOT YET VERIFIED

Do not make the API public until every item below is checked in RapidAPI Studio/Provider Dashboard:

- [ ] All six endpoints above are visible and point to the live AWS base URL.
- [ ] `POST /v1/uploads` requires `contentType` and exact `sizeBytes`.
- [ ] `POST /v1/analyze` shows the current request example and requirement fields.
- [ ] API name is **ForgeDirector AI Video QA & Creative Intelligence**.
- [ ] Short description and long listing copy match `commercial/listing.md`.
- [ ] Logo / marketplace image is present.
- [ ] BASIC / PRO / ULTRA / MEGA prices and monthly request quotas match `commercial/pricing.md`.
- [ ] Every plan uses a **Hard Limit**, not a soft overage limit.
- [ ] No unintended overage fee is enabled.
- [ ] Payout/PayPal setup is valid.
- [ ] API remains PRIVATE while these checks are performed.
- [ ] Hub test: `GET /health` returns 200.
- [ ] Hub test: `POST /v1/plan` returns 200 and `meta.qualityGate.passed == true`.
- [ ] Hub test: upload-ticket request returns a valid asset ID + signed PUT URL.
- [ ] Hub consumer flow has been tested through RapidAPI rather than only directly against AWS.
- [ ] Final publication approval has been given by the owner.

## Release decision

Automated engineering status: **GO**.

Marketplace/publication status: **HOLD** until the manual RapidAPI gates are verified and explicit publication approval is given.

Do not weaken automated quality/security gates merely to clear the manual marketplace checklist.
