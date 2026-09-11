# RapidAPI final manual finish — ForgeDirector

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

Use hard limits and no overages initially.

| Plan | Price | Monthly RapidAPI requests | Approx. complete video analyses |
| --- | ---: | ---: | ---: |
| BASIC | $0 | 20 | ~10 |
| PRO | $19 | 200 | ~100 |
| ULTRA | $49 | 1,000 | ~500 |
| MEGA | $99 | 3,000 | ~1,500 |

A complete video-analysis workflow normally consumes two RapidAPI requests: one upload-ticket request and one analysis request. The direct PUT to the private upload URL is not a ForgeDirector API request.

## 6. Final Hub test before publishing

Use the RapidAPI Hub endpoint UI, not the separate Requests workspace.

Test:
1. `GET /health` → expect HTTP 200.
2. `POST /v1/plan` → expect HTTP 200 through RapidAPI.
3. `POST /v1/uploads` → expect HTTP 200 and an `assetId` plus `uploadUrl`.

A direct request to the AWS `/v1/*` URL without RapidAPI is supposed to return 401. That proves the gateway lock is active.

Full upload + analyze testing is already automated in GitHub Actions against the live AWS stack.

## 7. Stop before Publish

Do not publish until:
- all six endpoints are visible in the Hub,
- the plans are correct,
- the listing text is correct,
- the provider payout setup is confirmed,
- final publication approval has been given.
