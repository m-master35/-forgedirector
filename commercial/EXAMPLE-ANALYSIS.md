# ForgeDirector — Representative Short-Form Ad Analysis

> **Representative, sanitized example.** The product, asset ID, observations, scores, and response below are illustrative. This is not presented as a copied or verified live API response. Field names follow the current public contract; clients should still treat their live response and `commercial/openapi.yaml` as the source of truth.

This example shows how ForgeDirector can sit between video generation and delivery:

```text
GENERATE → UPLOAD → ANALYZE → ACCEPT / REVISE / REGENERATE
```

## Example asset

A fictional 24-second, 9:16 TikTok ad for **Northstar**, a fictional productivity app. The edit follows one young professional from an overloaded task list to a simplified product workflow, then closes on a product lock-up.

## Input requirements

| Input | Example value |
| --- | --- |
| File | MP4, 4.8 MiB |
| Declared duration | 24 seconds |
| Platform | TikTok |
| Objective | Conversion |
| Audience | Busy young professionals |
| Must show | Northstar logo; product interface |
| Must not show | Competitor logos |
| Required on-screen text | `Start free` |
| Continuity | Same lead character throughout |
| CTA | Required |

When exact spoken-word verification matters, also provide a transcript. ForgeDirector's visual analysis should not be treated as exact audio transcription without one.

## 1. Create an upload ticket

```http
POST /v1/uploads
Content-Type: application/json
```

```json
{
  "contentType": "video/mp4",
  "sizeBytes": 5033165
}
```

The API returns a private `assetId` and short-lived signed PUT URL. Upload the unmodified bytes using the returned Content-Type and Content-Length requirements.

## 2. Analyze the uploaded asset

```http
POST /v1/analyze
Content-Type: application/json
```

```json
{
  "assetId": "asset_demo_northstar_24s",
  "platform": "TikTok",
  "objective": "conversion",
  "audience": "Busy young professionals",
  "durationSeconds": 24,
  "context": "Fictional productivity-app ad. Keep recommendations credible, direct, and optimized for mobile viewing.",
  "requirements": {
    "mustShow": ["Northstar logo", "Product interface"],
    "mustNotShow": ["Competitor logos"],
    "mustIncludeText": ["Start free"],
    "continuityRules": ["Use the same lead character throughout"],
    "ctaRequired": true
  }
}
```

## 3. Representative analysis response

### Quality-gate decision

```json
{
  "qualityGate": {
    "action": "revise",
    "confidence": "high",
    "blockers": ["explicit_requirement_failed"],
    "reasons": [
      "1 explicit production requirement failed.",
      "The opening delays its first meaningful visual change.",
      "The required CTA text is not held at a mobile-readable size long enough."
    ],
    "thresholds": {
      "acceptOverall": 75,
      "acceptMinimumDimension": 55
    }
  }
}
```

The downstream action is `revise`: keep the usable render, replace or edit the weak sections, then analyze the new cut. `qualityGate.action` is the authoritative branch field in the current contract.

### Scores

Scores are heuristic creative-quality assessments, not predictions or guarantees of views, retention, conversions, sales, or ROAS.

| Dimension | Score / 100 | Readout |
| --- | ---: | --- |
| Overall | 72 | Usable foundation; not ready to ship under the supplied rules |
| Hook | 58 | Recognizable problem, but the visual interruption arrives late |
| Pacing | 74 | Clear progression after the opening pause |
| Clarity | 82 | Product value is easy to understand |
| Visual quality | 86 | Clean, coherent commercial finish |
| Continuity | 91 | Lead, wardrobe, and setting remain consistent |
| CTA | 46 | Correct idea, weak legibility and message match |
| Platform fit | 78 | Strong vertical composition and mobile-first rhythm after 3s |
| Conversion readiness | 68 | Demo is persuasive; closing action needs repair |

### Compliance

| Requirement | Status | Representative evidence |
| --- | --- | --- |
| Show Northstar logo | Pass | Fictional logo is visible on the product UI at 9.1s and on the end card at 21.2s |
| Show product interface | Pass | Interface interaction is clearly visible from 7.2–12.8s |
| Do not show competitor logos | Pass | No competitor marks are observed across the reviewed timeline |
| Include `Start free` | **Fail** | Text appears at 21.9s, but is too small and disappears by 23.2s; it is not reliably legible on mobile |
| Same lead throughout | Pass | Face, hair, navy overshirt, desk, and lighting remain consistent |
| CTA required | Pass | A visual end-card CTA and spoken action are both present, though they do not match exactly |

Summary: `status: "fail"`, `failedCount: 1`, `uncertainCount: 0`.

### Hook

```json
{
  "firstThreeSeconds": "A static overhead desk holds for 1.8 seconds before notification cards multiply and the lead reacts.",
  "spokenHook": "Too many tabs. Still nothing finished?",
  "onScreenHook": "TOO MUCH TO DO?",
  "verdict": "mixed",
  "issues": [
    "The first meaningful motion begins at 1.8 seconds.",
    "The spoken and on-screen hooks arrive after the static setup rather than at frame one."
  ]
}
```

### Full-clip timeline

| Time | Purpose | Observation | Recommended action |
| --- | --- | --- | --- |
| 0.0–3.0s | Hook | Static desk setup delays the pattern interrupt; problem text appears late | Begin on the multiplying notifications and lead reaction |
| 3.0–8.0s | Problem | Lead confronts an overloaded task list; the pain point reads clearly | Keep; trim roughly 0.3s before the product reveal |
| 8.0–15.0s | Demo | Product UI groups tasks into a simple sequence; logo and interface are legible | Keep; preserve this sequence in revisions |
| 15.0–21.0s | Benefit | Before/after rhythm lands; identity, wardrobe, and setting remain consistent | Keep |
| 21.0–24.0s | CTA | Product lock-up is clean, but `Start free` is too small and held for only about 1.3s; spoken line says `Try it today` | Increase CTA size, hold for at least 2s, and match spoken copy |

Representative coverage summary: 24.0 of 24.0 seconds covered; analysis begins at the opening, reaches the final segment, and reviews the full declared duration.

### CTA assessment

```json
{
  "present": true,
  "type": "both",
  "clarity": "weak",
  "issue": "The required visual CTA is undersized and too brief, while the spoken CTA uses different wording.",
  "recommendedCta": "Start free"
}
```

### Ranked fixes

1. **Move the interruption into frame one** — remove the 1.8-second static desk hold and open on the multiplying notifications. _High impact, low effort._
2. **Rebuild the end card for mobile readability** — hold `Start free` for at least 2 seconds and increase its size and contrast. _High impact, low effort._
3. **Match spoken and visual CTA language** — replace `Try it today` with `Start free`. _Medium impact, low effort._

### Regeneration-ready prompt

Replacement segment: **0.0–3.0 seconds**

> Vertical 9:16 commercial opening. Begin immediately on the same late-20s lead at the same desk, preserving the same face, navy overshirt, hairstyle, product styling, lighting direction, palette, and lens language. At frame one, notifications multiply across the laptop and phone while the lead reacts with controlled frustration. Use a fast 0.5-second push-in, crisp screen readability, realistic hand motion, and no logos other than Northstar. Land the on-screen line “TOO MUCH TO DO?” within the first 0.5 seconds. End on a clean match cut into the existing product-demo shot at exactly 3.0 seconds.

This prompt targets only the weak opening and explicitly preserves continuity with the usable remainder of the render.

## 4. Automation branch

```js
const { action } = result.analysis.qualityGate;

if (action === "accept") ship(result);
else if (action === "revise") queueTargetedEdits(result.analysis.fixes);
else if (action === "regenerate") regenerate(result.analysis.regenerationPrompts);
else sendForHumanReview(result);
```

Try the live API on [RapidAPI](https://rapidapi.com/mmaster35/api/forgedirector-video-creative-intelligence), or follow the [5-minute integration kit](INTEGRATION-KIT.md).

