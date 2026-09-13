# ForgeDirector — 5-minute RapidAPI finish

Use this only after the automated release gates in `RELEASE-READINESS.md` are green.

**Do not publish during these steps. Keep visibility PRIVATE until the final approval step.**

## 1. Open the existing ForgeDirector API project

Do not create a replacement API.

Preserve:
- the existing AWS Base URL;
- the existing RapidAPI proxy-secret/security configuration.

Do not bulk-import `openapi.yaml` over the existing project unless you have explicitly confirmed the gateway/security configuration will be preserved.

## 2. Verify all six endpoints

Keep or add:

1. GET `/health`
2. POST `/v1/plan`
3. POST `/v1/revise`
4. POST `/v1/qa`
5. POST `/v1/uploads`
6. POST `/v1/analyze`

For `/v1/uploads`, the example body is:

```json
{
  "contentType": "video/mp4",
  "sizeBytes": 8421300
}
```

For `/v1/analyze`, copy the example from `commercial/RAPIDAPI-FINISH.md`.

## 3. Set public plans

Go to **Hub Listing → Monetize → Public Plans**.

Set:

| Plan | Price | Requests / month |
| --- | ---: | ---: |
| BASIC | $0 | 20 |
| PRO | $25 | 250 |
| ULTRA | $75 | 1,000 |
| MEGA | $150 | 3,000 |

Every Requests quota must be **Hard Limit**.

No overages.

## 4. Add Video Analyses quota

Still in **Hub Listing → Monetize**:

1. Click **Add Object**.
2. Name: **Video Analyses**
3. Description: **Full short-form video intelligence analyses**
4. Associated endpoint: **POST /v1/analyze only**
5. Add the object to every public plan.

Set monthly Hard Limits:

| Plan | Video Analyses |
| --- | ---: |
| BASIC | 5 |
| PRO | 50 |
| ULTRA | 200 |
| MEGA | 500 |

Do not associate uploads, plan, revise, QA or health with this object.

No overages.

## 5. Listing identity

API name:

**ForgeDirector AI Video QA & Creative Intelligence**

Short description:

**Automated QA for AI-generated short-form video: upload a clip and get an accept/revise/regenerate verdict, creative scores, production-spec compliance, timeline issues, and exact regeneration prompts.**

Use `commercial/listing.md` for the long description and keywords.

Confirm a marketplace image/logo is present.

## 6. Payout

Confirm the provider PayPal/payout setting is valid.

Do not change billing or payout details unless necessary.

## 7. Test through RapidAPI Hub

While still PRIVATE:

1. GET `/health` → HTTP 200.
2. POST `/v1/plan` → HTTP 200 and `meta.qualityGate.passed == true`.
3. POST `/v1/uploads` → HTTP 200 with `assetId` + signed PUT URL.
4. Complete one upload → analyze flow through the RapidAPI consumer path.
5. Confirm a direct AWS `/v1/*` call without Rapid's proxy secret remains 401.

## 8. Stop

Do not make the API public yet.

Return to ChatGPT with the dashboard state/screenshots if anything differs.

Publication requires explicit final owner approval.
