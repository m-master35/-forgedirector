# ForgeDirector

**A conversational AI production director for the Amazon Developer Hackathon — Alexa+ Track.**

ForgeDirector turns a short campaign brief into a structured video-production manifest, then maintains project state as the user revises individual scenes, audiences, formats, durations, and continuity constraints through conversation.

> Example: “Create a premium 30-second ad for a magnesium supplement aimed at young professionals.”
>
> Follow-up: “Make scene 2 darker.” → “Change the audience to gym users.” → “Keep the same actor and make a 15-second TikTok version.”

Instead of restarting the creative process on every prompt, ForgeDirector treats the campaign as a persistent production object and modifies only what the user asks to change.

## Why this fits Alexa+

This repository currently follows the hackathon's **simulated Alexa+ experience** path. The experience is designed around natural conversational direction, multi-step orchestration, state retention, and revision-aware execution rather than single-turn Q&A.

The submission roadmap adds an Amazon Bedrock-backed director layer so the same interface can turn free-form requests into validated production manifests while retaining deterministic project-state controls.

## Current prototype

The v0.1 prototype includes:

- Conversational campaign creation
- Stateful project memory within a session
- Scene-specific revisions without rebuilding the whole campaign
- Platform and aspect-ratio changes
- Duration restructuring
- Lead-character continuity locking
- Production-ready scene fields: visual direction, voiceover, and generation prompt
- Exportable JSON production manifest
- Responsive mobile/desktop UI
- One-click judging/demo sequence


## Commercial video-intelligence API

The commercial API now extends ForgeDirector beyond planning into **video creative intelligence**.

The intended production loop is:

```text
PLAN → CREATE → ANALYZE → FIX → REGENERATE
```

Commercial endpoints:

- `POST /v1/uploads` — create a short-lived private upload URL for a video.
- `POST /v1/analyze` — analyze an uploaded short-form video with Amazon Nova multimodal understanding.
- `POST /v1/plan` — create a structured production manifest from a brief.
- `POST /v1/revise` — revise selected campaign decisions while preserving unrelated state.
- `POST /v1/qa` — run deterministic production QA.
- `GET /health` — inspect API status and limits.

`/v1/analyze` returns standardized creative scores, first-three-second hook analysis, timestamped timeline diagnostics, retention risks, continuity and CTA assessment, ranked fixes, production-ready regeneration prompts, and platform-specific repurposing guidance.

Video scores are heuristic creative-quality assessments. They are not predictions or guarantees of views, retention, sales, ROAS, or virality.

Uploaded media is stored privately; successfully analyzed assets are deleted immediately, while abandoned uploads are removed by the existing storage lifecycle. Exact spoken-word analysis can be improved by supplying a transcript because Nova video understanding analyzes visual frames rather than the video's audio track.

See `commercial/openapi.yaml` for the API contract.

## Run locally

No build step is required.

1. Clone or download this repository.
2. Open `index.html` in a modern browser.

For a local web server:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

## Project architecture

```text
User conversational brief
        ↓
Intent + revision parser
        ↓
Persistent campaign state
        ↓
Production orchestrator
        ↓
Campaign manifest
  ├─ audience / platform / duration
  ├─ continuity constraints
  └─ scenes
      ├─ visual direction
      ├─ voiceover
      └─ generation prompt
        ↓
Revision-aware updates
        ↓
Exportable execution manifest
```

## Competition roadmap

### Phase 1 — Working simulation ✅
A complete browser-based Alexa+ simulation that demonstrates the interaction model and persistent production state.

### Phase 2 — Bedrock director
Add an Amazon Bedrock-backed agent for natural-language intent extraction, creative planning, structured output generation, and revision planning.

### Phase 3 — Production actions
Introduce pluggable tools for storyboard generation, asset requirements, variant creation, production QA, and export to downstream video-generation systems.

### Phase 4 — Demo + submission
Deploy the public demo, record a sub-3-minute English demonstration, complete product feedback, and prepare the Devpost submission.

## Design principle

**The user directs outcomes, not software.**

ForgeDirector is intended to let a user say what should change while the system preserves every unrelated production decision automatically.

## Hackathon track

- Primary track: **Alexa+**
- Path: **Simulated Alexa+ experience**
- Planned mini-challenge: **AWS Builder** via Amazon Bedrock integration
- Open-source mini-challenge candidate: **Yes**

## License

MIT License. See [LICENSE](LICENSE).
