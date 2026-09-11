# RapidAPI listing copy — ForgeDirector AI Video QA & Creative Intelligence

## API name
ForgeDirector AI Video QA & Creative Intelligence

## Short description
Automated QA for AI-generated short-form video: upload a clip and get an accept/revise/regenerate verdict, creative scores, production-spec compliance, timeline issues, and exact regeneration prompts.

## Category
Artificial Intelligence / Machine Learning.

## Long description
ForgeDirector is an automated video-QA layer for developers building AI video generators, ad-generation workflows, creator software, social-media products, and creative automation.

The flagship workflow is **generated video → automated QA gate → exact corrective action**.

Upload a short-form video, call `/v1/analyze`, and receive standardized JSON containing:

- weighted overall creative score
- first-three-second hook analysis
- pacing and clarity scores
- visual-quality and continuity assessment
- CTA quality
- platform fit
- conversion-readiness heuristic
- timestamped timeline analysis
- ranked retention risks
- prioritized fixes by impact and effort
- production-ready prompts for segments that should be regenerated
- deterministic `accept`, `revise`, or `regenerate` quality gate for automation
- explicit creative-spec compliance checks (`mustShow`, `mustNotShow`, required text, continuity rules, CTA requirement)
- objective-specific scoring weights for engagement, conversion, awareness, education, app installs, and lead generation
- TikTok, Reels, and Shorts repurposing guidance

Scores are creative-quality heuristics, not predictions or guarantees of views, retention, sales, ROAS, or virality.

ForgeDirector also keeps its production-orchestration layer:

- `/v1/plan` converts a natural-language brief into a structured production manifest.
- `/v1/revise` updates requested decisions while preserving unrelated campaign state.
- `/v1/qa` runs deterministic production checks without consuming a model call.

This creates a full production loop:

**PLAN → CREATE → QA → ACCEPT / REVISE / REGENERATE**

### Built for
- AI video-generation products
- ad-creative generation and QA
- video editors and creator tools
- social scheduling products
- UGC platforms
- marketing automation
- AI agents that need to decide whether to accept or regenerate video
- internal agency and creative-ops tooling

### Why use ForgeDirector instead of a raw multimodal-model call
A raw multimodal-model call gives you an opinion. ForgeDirector gives your application a repeatable video-production QA contract:

- secure temporary video ingestion
- multimodal video understanding
- standardized scoring
- first-three-second analysis
- timeline-level diagnostics
- ranked edit decisions
- continuity and CTA evaluation
- regeneration prompts
- platform-specific repurposing guidance
- structured schemas suitable for automation
- planning, revision, and deterministic QA in the same API

## Endpoint one-liners

**POST /v1/uploads** — Get a temporary private upload URL for a short-form video.

**POST /v1/analyze** — Turn an uploaded video into structured creative intelligence and actionable fixes.

**POST /v1/plan** — Create a complete production manifest from a creative brief.

**POST /v1/revise** — Modify an existing campaign while preserving unrelated decisions.

**POST /v1/qa** — Validate timing, continuity, prompt completeness, voiceover density, and scene structure.

**GET /health** — Check API status, limits, and available endpoints.

## Suggested search keywords
ai video qa api, generated video qa, video generation qa, ai video analysis, creative compliance api, ad creative qa, video quality gate, accept revise regenerate, tiktok video qa, reels video qa, shorts video qa, hook analysis, continuity qa, regeneration prompts, creative intelligence api

## Recommended marketplace spotlight
### Put a quality gate after your video generator
Feed ForgeDirector an AI-generated ad, UGC clip, Reel, TikTok, or Short. Receive a machine-readable answer to three questions:

1. Does this output meet the brief and explicit production rules?
2. Should the system accept it, revise it, or regenerate it?
3. What exact segment and prompt should change next?

## BASIC plan message
Test the complete workflow on real short-form videos before upgrading.

## PRO plan message
For solo developers and prototypes adding video creative intelligence.

## ULTRA plan message
For creator tools, ad workflows, and production applications with regular analysis volume.

## MEGA plan message
For SaaS products and heavier integrations using ForgeDirector as an automated video-review layer.

## Upload request
```json
{
  "contentType": "video/mp4",
  "sizeBytes": 8421300
}
```

Upload the video with HTTP PUT to the returned `upload.uploadUrl` using the returned Content-Type header.

## Analyze request
```json
{
  "assetId": "8f0f6a79-14c8-4cc9-9bde-272d25dd7070",
  "platform": "TikTok",
  "objective": "conversion",
  "audience": "Young professionals",
  "durationSeconds": 30,
  "context": "Premium productivity app. Keep recommendations credible and direct."
}
```

For exact spoken-word analysis, optionally include a supplied transcript.

## Planning request
```json
{
  "brief": "Create a premium 30-second vertical ad for a magnesium supplement aimed at young professionals. Keep the language credible and restrained.",
  "constraints": {
    "platform": "TikTok",
    "aspectRatio": "9:16",
    "durationSeconds": 30
  }
}
```
