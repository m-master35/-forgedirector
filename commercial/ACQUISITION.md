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

RapidAPI Hub consumer-flow validation passed on 2026-09-13. A live RapidAPI follow-up was sent to the 12 still-open prospects, followed by a second demo-page follow-up after the public commercial demo went live.

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

## Researched batch 3 — not contacted

Research date: 2026-09-13

This batch is deliberately limited to companies whose own documentation confirms a programmable video-generation/render path and at least one integration seam such as a REST API, SDK, callback, webhook, workflow, or automated delivery. It excludes the 13 prospects already in the outreach pipeline above. No outreach was sent while preparing this list.

Priority guide:

- **A** — direct short-form, ad, UGC, or avatar-video workflow with a clear post-render callback/status seam;
- **B** — strong developer video-generation or high-volume rendering infrastructure, but a broader or less ad-specific buyer.

| Priority | Prospect | Verified integration evidence | ForgeDirector fit | Status |
| --- | --- | --- | --- | --- |
| A | Creatify | Official API generates product/ad videos and accepts a per-job `webhook_url`: [product-to-video endpoint](https://docs.creatify.ai/api-reference/product_to_video/post-apiproduct_to_videos-gen_video) | Insert QA when the generated ad URL becomes available; return targeted fixes or a replacement prompt before customer delivery. | SENT |
| A | JoggAI | Official docs expose avatar/product video creation and completion events: [webhook guide](https://docs.jogg.ai/api-reference/v2/API%20Documentation/WebhookIntegration) | Trigger ForgeDirector on `generated_*_video_success`, especially for batch UGC/ad creation. | SENT |
| A | Tavus | `POST /v2/videos` generates replica video and accepts a `callback_url`: [Generate Video](https://docs.tavus.io/api-reference/video-request/create-video) | QA personalized/replica renders for CTA, continuity, required text, and delivery readiness. | SENT |
| A | D-ID | `POST /talks` creates a talking-avatar video and supports a webhook: [Create a talk](https://docs.d-id.com/reference/createtalk) | Post-render visual/CTA/brand compliance for avatar clips before they enter campaign or support workflows. | SENT |
| A | Synthesia | Official REST API creates videos, supports templates, and documents completion webhooks: [API introduction](https://docs.synthesia.io/reference/introduction) | Quality gate for personalized videos at scale, with explicit checks against template/campaign requirements. | SENT |
| A | Colossyan | Programmable video creation, templates, custom avatars, and callback notifications are documented: [API overview](https://docs.colossyan.com/) | Validate generated training, sales, and marketing videos before automated distribution. | SENT |
| A | Elai | Story API builds video from text/HTML/URL; render completion or failure arrives by webhook: [prompt-to-video walkthrough](https://elai.readme.io/reference/prompt-to-video-walkthrough) | Check automatically assembled stories for full-clip pacing, continuity, CTA, and required elements. | SENT |
| A | Hour One | Official API docs describe REST-based blueprint and dynamic video generation: [Hour One API](https://hourone.gitbook.io/api-docs) | Add release QA to automated personalized/avatar-video production, especially template-variable campaigns. | SENT |
| A | Akool | Talking Avatar API creates video and supports `webhookUrl` or status polling: [Talking Avatar](https://docs.akool.com/ai-tools-suite/talking-avatar) | Check avatar, brand, text, and CTA requirements when the asynchronous render completes. | SENT |
| A | Creatomate | REST API renders video and recommends completion webhooks: [API reference](https://creatomate.com/docs/api/reference/introduction) | Natural callback-to-QA handoff for automated, templated social/ad variants. | SENT |
| A | JSON2Video | REST API submits movies and supports webhook destinations after rendering: [API endpoints](https://json2video.com/docs/v2/reference/api-endpoints), [webhooks](https://json2video.com/docs/v2/reference/webhooks) | Analyze the final movie URL before its export/distribution pipeline continues. | SENT |
| A | Shotstack | JSON/REST video render API with completion callbacks and output URLs: [API reference](https://shotstack.io/docs/api/), [webhooks](https://shotstack.io/docs/guide/architecting-an-application/webhooks/) | Add an optional creative QA stage between render completion and Serve/destination delivery. | SENT |
| A | Plainly | REST API triggers asynchronous template renders and supports final-state webhooks: [developer guide](https://help.plainlyvideos.com/docs/developer-guide), [renders API](https://help.plainlyvideos.com/docs/developer-guide/renders-api) | QA high-volume personalized/template outputs before webhook-driven delivery. | SENT |
| A | Bannerbear | Video-generation API plus per-asset and project-level `video_created` webhooks: [API reference](https://developers.bannerbear.com/v2/) | Run QA after programmatic social/video assets render and before campaign publication. | SENT |
| B | Runway | Official API supports text/image/video-to-video, product-ad and product-UGC recipes, task management, and workflows: [API reference](https://docs.dev.runwayml.com/api/) | Offer generator-independent QA after Runway tasks/workflows finish; especially relevant to product-ad recipes. | RESEARCHED — NOT CONTACTED |
| B | Luma AI | Dream Machine API generates text/image-to-video and accepts a status callback URL: [video generation guide](https://docs.lumalabs.ai/docs/video-generation) | Evaluate generated clips at callback time and feed scoped prompts into a regenerate/extend loop. | RESEARCHED — NOT CONTACTED |
| B | fal | Multi-model video API with queue webhooks specifically documented for long-running video generation: [Video Generation API](https://fal.ai/docs/model-api-reference/video-generation-api/overview), [webhooks](https://fal.ai/docs/documentation/model-apis/inference/webhooks) | A single QA contract across many underlying generators is a strong platform-level differentiator. | RESEARCHED — NOT CONTACTED |
| B | Replicate | Predictions API runs video models and supports terminal webhooks and model pipelines: [HTTP API](https://replicate.com/docs/reference/http), [webhooks](https://replicate.com/docs/topics/webhooks) | Add ForgeDirector as a post-prediction step for teams composing multi-model video pipelines. | RESEARCHED — NOT CONTACTED |

### Recommended first outreach slice — SENT 2026-09-13

Sent tailored outreach to **Creatify, JoggAI, Tavus, Creatomate, JSON2Video, and Plainly** on 2026-09-13, linking the public commercial demo and RapidAPI listing. They combine a visible asynchronous completion seam with ad, social, UGC, personalized, or automated video workflows where a release decision is easy to explain and integrate.

Before any outreach:

1. Re-check the official source and current contact route on the day of sending.
2. Tailor the pitch to the documented callback/render lifecycle; do not imply an existing partnership.
3. Link the public commercial demo and the 5-minute integration kit.
4. Do not offer discounts, exclusivity, custom roadmap commitments, or enterprise terms without owner approval.


### Outreach batch 4 — SENT 2026-09-13

Sent tailored outreach with the live demo and RapidAPI listing to:
- D-ID — support@d-id.com
- Synthesia — support@synthesia.io
- Colossyan — support@colossyan.com
- Elai — support@elai.io
- Hour One — support@hourone.ai
- Akool — info@akool.com
- Shotstack — sales@shotstack.io
- Bannerbear — support@bannerbear.com

This batch was selected from the researched list because each has a programmable or asynchronous video-generation path where a post-render QA gate can be explained clearly.
