# ForgeDirector — Early Customer Outreach

Status date: 2026-09-13

Goal: acquire the first paying or integration customer for ForgeDirector by targeting developer-facing AI-video products where a post-generation QA gate can slot directly into an existing API, webhook, SDK, MCP, or multi-model pipeline.

## Positioning

ForgeDirector is an automated post-generation QA gate for AI-generated short-form video.

Core integration:
```text
GENERATE → FORGEDIRECTOR QA → ACCEPT / REVISE / REGENERATE
```

Primary value:
- full-clip review rather than isolated-frame checking;
- explicit production-rule verification;
- machine-readable accept/revise/regenerate action;
- ranked fixes and regeneration prompts;
- model-agnostic QA across different video generators.

## Outreach pipeline

| Prospect | Fit | Contact | Status | Notes |
| --- | --- | --- | --- | --- |
| EzUGC | AI UGC API + MCP | hello@ezugc.ai | SENT | Strong direct post-render QA fit. |
| Prizmad | AI UGC/ad generation + API/MCP | hello@prizmad.com | SENT | Post-render drift/compliance QA. |
| agent-media | REST + SDKs + CLI + MCP + webhooks | support@agent-media.ai | SENT | Developer-first; strong automation fit. |
| UGC Copilot | Multi-engine REST API + webhooks + SDKs | support@ugccopilot.ai | SENT | Has existing product-ad QC; pitch external generalized QA. |
| StoryShort | Short-form generation/publishing API | hello@storyshort.ai | SENT | QA before automatic publishing. |
| Reeloop | REST + SDKs + MCP + webhooks | support@reeloop.ai | SENT | QA before publish/delivery. |
| AdGPT | Programmatic AI ad generation | support@adgpt.com | SENT | High-volume ad QA use case. |
| MakeUGC | Platform API + MCP + webhook generation | help@makeugc.ai | SOFT NO / FUTURE MAYBE | Replied that they are pursuing a different internal route; keep on file and do not chase in the live-link follow-up. |
| Reviral | AI image/video API + UGC workflows | support@reviral.ai | SENT | Model-agnostic QA after render. |
| Wireflow | Multi-model video workflows + webhooks | andrew@wireflow.ai | SENT | Strong workflow-level QA integration. |
| VideoGenAPI | Unified multi-model video API | support@videogenapi.com | SENT | QA as optional layer across 17 models. |
| AI Video API | Unified multi-model video generation API | support@aivideoapi.ai | SENT | Consistent QA contract across generators. |
| VisionStory | REST + SDK + CLI + MCP + agent workflows | collabs@visionstory.ai | SENT | QA for avatar/AI-video agent workflows. |

## Current outreach rule

Do not send a new batch without owner approval. Once sent:
- record SENT date;
- watch for direct replies;
- tailor replies to the prospect's integration model;
- do not offer custom enterprise commitments, discounts, exclusivity, or roadmap guarantees without explicit owner approval.

## Live RapidAPI follow-up readiness

RapidAPI Hub consumer-flow validation passed on 2026-09-13. The live RapidAPI follow-up is ready for the 12 still-open prospects below, but must not be sent without owner approval.

Live API link for the prepared follow-up:
https://rapidapi.com/mmaster35/api/forgedirector-video-creative-intelligence

Follow-up list, excluding MakeUGC:
- EzUGC — hello@ezugc.ai
- Prizmad — hello@prizmad.com
- agent-media — support@agent-media.ai
- UGC Copilot — support@ugccopilot.ai
- StoryShort — hello@storyshort.ai
- Reeloop — support@reeloop.ai
- AdGPT — support@adgpt.com
- Reviral — support@reviral.ai
- Wireflow — andrew@wireflow.ai
- VideoGenAPI — support@videogenapi.com
- AI Video API — support@aivideoapi.ai
- VisionStory — collabs@visionstory.ai

## Evidence used in outreach

Current recorded production release benchmark:
- 52/52 labeled compliance checks;
- 29/29 full-duration coverage checks;
- 28/28 no-speech hallucination checks;
- 30/30 repeated real-video analyses;
- cached repeats consume zero additional model tokens.

Authoritative engineering evidence remains in `commercial/RELEASE-READINESS.md`.
