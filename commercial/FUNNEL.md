# ForgeDirector — Commercial Funnel Tracker

Status date: 2026-09-13

This is the lightweight source of truth for the first-customer funnel. Update it from known evidence only; use `—` when a number has not been verified. Do not infer RapidAPI subscribers, successful analyses, paid conversions, or MRR from page visits or outreach activity.

## Snapshot

| Stage | Current | Source / update rule |
| --- | ---: | --- |
| Prospects contacted | 13 | Sent rows in `ACQUISITION.md` |
| Replies | 1 | Direct prospect replies recorded in `ACQUISITION.md` |
| RapidAPI subscribers | — | RapidAPI provider dashboard |
| Successful customer analyses | — | Count distinct customer-owned `/v1/analyze` successes; exclude owner tests and benchmark runs |
| Paid conversions | — | RapidAPI/provider billing evidence |
| MRR | — | Recurring revenue actually active; record currency explicitly |

## Conversion rates

Calculate only when both inputs are known:

| Conversion | Formula | Current |
| --- | --- | ---: |
| Outreach → reply | Replies ÷ prospects contacted | 7.7% (1 ÷ 13) |
| Reply → subscriber | RapidAPI subscribers ÷ replies | — |
| Subscriber → successful analysis | Customers with ≥1 successful analysis ÷ RapidAPI subscribers | — |
| Successful analysis → paid | Paid conversions ÷ customers with ≥1 successful analysis | — |

## Event ledger

Add one row per material funnel event. Avoid names, email addresses, API keys, asset IDs, or other sensitive data; use the prospect name already recorded in `ACQUISITION.md` or a neutral account label.

| Date | Account / prospect | Event | Quantity / value | Evidence | Notes |
| --- | --- | --- | ---: | --- | --- |
| 2026-09-13 | Initial outreach batch | Prospects contacted | 13 | `ACQUISITION.md` | Existing outreach only; no new messages sent in this work |
| 2026-09-13 | MakeUGC | Reply | 1 | `ACQUISITION.md` | Soft no / future maybe |

Suggested event values: `contacted`, `reply`, `subscriber`, `first_successful_analysis`, `paid_conversion`, `mrr_change`, `churn`.

## Weekly review

| Week ending | Contacted | Replies | Subscribers | Successful analyses | Paid conversions | MRR | Primary learning / next action |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2026-09-13 | 13 | 1 | — | — | — | — | Commercial demo and example analysis added; qualify the next batch before requesting outreach approval. |

## Counting rules

- A prospect is counted once when the first external message is sent.
- A reply is counted once per prospect that responds, not once per email in a thread.
- A subscriber is counted only from provider-side evidence.
- A successful analysis is a customer-owned `/v1/analyze` call that returns success; exclude internal validation, benchmark, cache, and owner test calls.
- A paid conversion is counted once when a customer first enters an active paid plan.
- MRR is active recurring monthly revenue, not annual contract value, pipeline, credits, or one-time revenue.
- If a customer churns or downgrades, add a dated ledger entry and update the snapshot; do not erase history.

