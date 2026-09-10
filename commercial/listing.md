# RapidAPI listing copy

## API name
ForgeDirector Video Creative Intelligence

## Short description
Turn a simple creative brief into a structured video-production manifest, revise individual decisions without rebuilding the campaign, and automatically QA the result.

## Category
Artificial Intelligence / Machine Learning (use the closest available current RapidAPI category).

## Long description
ForgeDirector is a creative-intelligence API for developers building AI video tools, ad-generation workflows, creator software, and marketing automation.

Instead of returning a loose paragraph of ideas, `/v1/plan` converts a natural-language brief into a structured production manifest with campaign direction, platform, aspect ratio, duration, continuity rules, scene timings, visual direction, voiceover, and production-grade generation prompts.

`/v1/revise` accepts the current campaign plus a natural-language change request and updates the requested decisions while preserving unrelated campaign state. This makes iterative workflows easier to build than repeatedly regenerating an entire creative plan from scratch.

`/v1/qa` runs deterministic production checks without consuming an AI-model call. It catches timing mismatches, missing scene fields, excessive voiceover density, weak prompt structure, unsupported aspect ratios, and unlocked continuity.

### Built for
- AI video and image applications
- Marketing automation products
- Ad-creative generators
- Social-content workflows
- Creator tools
- Internal agency tooling
- Prompt orchestration systems

### Why use ForgeDirector
- Structured JSON rather than unstructured creative prose
- Revision-aware campaign state
- Scene-level production direction
- Continuity constraints for multi-shot generation
- Built-in production QA
- Platform-aware short-form planning
- No invented product claims by design

## Endpoint one-liners

**POST /v1/plan** — Create a complete production manifest from a creative brief.

**POST /v1/revise** — Modify an existing campaign while preserving unrelated decisions.

**POST /v1/qa** — Validate timing, continuity, prompt completeness, voiceover density, and scene structure.

**GET /health** — Check API status and available endpoints.

## Suggested search keywords
ai video, video production, storyboard, creative automation, ad generator, video prompts, marketing ai, campaign generator, short form video, content creation, creative api

## BASIC plan message
Try the complete workflow with a small monthly allowance before upgrading.

## PRO plan message
For solo developers and prototypes that need recurring structured creative planning.

## ULTRA plan message
For creator tools, agencies, and production applications with regular usage.

## MEGA plan message
For heavier integrations and SaaS products using ForgeDirector as a creative orchestration layer.

## First demo request
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

## First revision request
Send the campaign returned by `/v1/plan` back as `campaign` with:

```json
{
  "instruction": "Make scene 2 darker and more cinematic, but preserve the actor, product identity, timing and all other scenes.",
  "campaign": {}
}
```

Replace the empty campaign object with the prior response's `campaign` object.
