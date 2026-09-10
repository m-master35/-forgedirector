# ForgeDirector Hackathon Friction Log

This log records real build and onboarding friction encountered while developing ForgeDirector for the Amazon Developer Hackathon. It is intentionally concise and factual so it can support final product feedback and judging notes.

## 2026-09-10 — GitHub Pages setup

**Goal:** Publish the Alexa+ simulation as a public judgeable demo.

**Friction:** The deployment workflow initially failed because GitHub Pages had not yet been enabled for the repository, even though the workflow itself was valid.

**Resolution:** Enabled Pages with GitHub Actions as the publishing source, then re-ran the failed deployment. The site deployed successfully.

**Product feedback:** A deployment workflow that detects disabled Pages could provide a clearer direct action or guided enablement path instead of failing at `configure-pages`.

## 2026-09-10 — AWS hackathon credits

**Goal:** Prepare for an Amazon Bedrock-backed director while keeping development cost near zero.

**Friction:** Promotional credits require a separate request after hackathon registration and AWS account creation.

**Resolution:** AWS account created and the hackathon promotional-credit request submitted.

**Product feedback:** Linking hackathon registration, AWS account state, and credit eligibility in one guided flow would reduce setup uncertainty for first-time AWS builders.

## 2026-09-10 — Simulation-to-cloud architecture

**Goal:** Keep the public demo usable before cloud credentials and credits are available.

**Decision:** ForgeDirector uses a deterministic browser simulation by default and a runtime-configured cloud adapter for the Bedrock-backed version.

**Benefit:** Judges can always open and understand the experience, while the same UI can switch to the real cloud director by setting one API URL after deployment.
