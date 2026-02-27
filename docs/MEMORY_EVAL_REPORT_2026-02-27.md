# BrowserAgent Memory Evaluation Report

Date: February 27, 2026
Command: `pnpm run memory:eval`

## Summary Metrics

- Retrieval precision proxy: `0.85`
- Retrieval recall proxy: `0.8542`
- Wrong-memory rate: `0.00`
- Action success uplift (proxy): `+4.00%`
- User-interrupt reduction (proxy): `+50.00%`

## Sample Sizes

- Intents: `4`
- Mutating intents: `4`
- Memory cards generated: `10`

## Notes

- This harness is deterministic and synthetic by design, so values are trend indicators for regression checks, not production KPI truth.
- The wrong-memory rate result indicates the current ranking/filtering logic avoided cross-domain retrieval mistakes in this run.
- User-interrupt reduction improved after intent-specific false-memory prevention was added to policy gating.
