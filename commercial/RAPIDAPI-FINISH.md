# RapidAPI final manual finish — ForgeDirector

## 0. Preserve the working gateway configuration

The live AWS backend is already protected by the RapidAPI proxy secret, and direct `/v1/*` calls correctly return 401.

For the existing RapidAPI project, **do not replace the whole API by importing `commercial/openapi.yaml` unless you have first confirmed that the current Base URL and secret/gateway configuration will be preserved**. Rapid's current documentation warns that updating an existing version from an OpenAPI document can override existing configuration.

For the final launch pass, the safer path is:
- keep the current working Base URL;
- keep the current RapidAPI secret/gateway configuration;
- add/verify only the missing endpoint definitions and marketplace fields;
- leave visibility PRIVATE until the final publication decision.

The AWS API is already live and protected by the RapidAPI proxy secret. Do not change the AWS base URL and do not expose the proxy secret to consumers.

This checklist contains only the marketplace actions that cannot be completed from GitHub.

## 1. Keep the four existing Hub endpoints

- POST `/v1/plan` — Create Video Production Plan
- POST `/v1/revise` — Revise Video Production Plan
- POST `/v1/qa` — Run Production QA
- GET `/health` — Check API Health

Do not delete them.

## 2. Add endpoint: Create Video Upload

**Name:** Create Video Upload

**Method:** POST

**Path:** `/v1/uploads`

**Description:**
Create a short-lived private upload URL for a short-form video. Upload the video to the returned URL, then pass the returned assetId to the Analyze Video endpoint.

**Body / application-json example:**

```json
{
  "contentType": "video/mp4",
  "sizeBytes": 8421300
}
```

The response returns:
- `upload.assetId`
- `upload.uploadUrl`
- `upload.method` = `PUT`
- the required upload Content-Type header
- the required upload Content-Length header (matching `sizeBytes`)
- the URL expiry
- the maximum accepted file size

## 3. Add endpoint: Analyze Video

**Name:** Analyze Video

**Method:** POST

**Path:** `/v1/analyze`

**Description:**
Analyze an uploaded short-form video and return objective-weighted creative scores, production-spec compliance, a deterministic accept/revise/regenerate quality gate, timeline issues, ranked fixes, and generation-ready replacement prompts.

**Body / application-json example:**

```json
{
  "assetId": "8f0f6a79-14c8-4cc9-9bde-272d25dd7070",
  "platform": "TikTok",
  "objective": "conversion",
  "audience": "Young professionals",
  "durationSeconds": 30,
  "context": "Premium productivity app. Keep recommendations credible and direct.",
  "requirements": {
    "mustShow": [
      "Brand logo",
      "App interface"
    ],
    "mustNotShow": [
      "Competitor logos"
    ],
    "mustIncludeText": [
      "Start free"
    ],
    "continuityRules": [
      "Use the same lead character throughout"
    ],
    "ctaRequired": true
  }
}
```

Optional:
- `transcript` — supply exact spoken text when speech-dependent analysis matters.

Supported platforms:
- TikTok
- Instagram Reels
- YouTube Shorts
- General

Supported objectives:
- engagement
- conversion
- awareness
- education
- app-install
- lead-generation

## 4. Update marketplace identity

**API name:**
ForgeDirector AI Video QA & Creative Intelligence

**Short description:**
Automated QA for AI-generated short-form video: upload a clip and get an accept/revise/regenerate verdict, creative scores, production-spec compliance, timeline issues, and exact regeneration prompts.

Use the long description and keywords from `commercial/listing.md`.

## 5. Recommended launch plans

Use **two quota objects** on every plan and keep both as **Hard Limits** with no launch overages:

1. Rapid's mandatory `Requests` quota for all API traffic.
2. A custom **Video Analyses** quota associated **only** with `POST /v1/analyze`.

| Plan | Price | Requests / month | Video Analyses / month |
| --- | ---: | ---: | ---: |
| BASIC | $0 | 20 | 5 |
| PRO | $25 | 250 | 50 |
| ULTRA | $75 | 1,000 | 200 |
| MEGA | $150 | 3,000 | 500 |

A complete video-analysis workflow consumes one normal request for `POST /v1/uploads`, one normal request for `POST /v1/analyze`, and one **Video Analyses** unit. The direct PUT to the private S3 upload URL is not a ForgeDirector API request.

Planning, revision and deterministic QA consume normal Requests quota only.

The separate video quota is deliberate. Fresh verified-video inference cost scales materially with duration, while planning/QA calls are much cheaper and identical video analyses may be served from the private cache with zero additional model tokens. The current quota sizes remain inference-positive under the documented conservative 120-second stress case in `commercial/pricing.md`.

## 6. Final Hub test before publishing

Use the RapidAPI Hub endpoint UI, not the separate Requests workspace.

Test:
1. `GET /health` → expect HTTP 200.
2. `POST /v1/plan` → expect HTTP 200 through RapidAPI.
3. `POST /v1/uploads` → send both `contentType` and exact `sizeBytes`; expect HTTP 200 and an `assetId` plus `uploadUrl`.
4. For plan/revise responses, verify `meta.qualityGate.passed == true`. This is the authoritative production-release verdict; `meta.creativeQuality` may be advisory when a deterministic recovery path was used.

A direct request to the AWS `/v1/*` URL without RapidAPI is supposed to return 401. That proves the gateway lock is active.

Full upload + analyze testing is already automated in GitHub Actions against the live AWS stack.

## 7. Stop before Publish

Do not publish until:
- all six endpoints are visible in the Hub,
- the Requests and Video Analyses hard-limit quotas are correct,
- the listing text is correct,
- the provider payout setup is confirmed,
- final publication approval has been given.
