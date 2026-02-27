# BrowserAgent Memory Automation Architecture

Date: February 27, 2026

## Goals

- Preserve high-signal operational context across sessions.
- Improve command safety and execution success over time.
- Keep memory auditable, user-controllable, and testable.
- Prevent unsafe autonomy drift and secret leakage.

## Memory Taxonomy

1. `ephemeral_session`
- Short-lived context from current run.
- Auto-decays and can be disabled when stale.

2. `durable_project`
- Project-level checkpoints and workflow facts.
- Domain-scoped and merged by semantic dedupe keys.

3. `durable_operator`
- Stable user preferences and operating style.
- Captured from explicit preference language.

4. `policy`
- Reliability-weighted action policy memory.
- Used by command gate before execution.

5. `outcome`
- Action outcome memory (`success`/`failure`).
- Reinforces or suppresses future policy confidence.

## Engine Data Model

- `memory_cards`: typed memory units with scope/status/domain/intent/reliability/confidence.
- `memory_settings`: governance toggles (`no_store`).
- `memory_decisions`: "why I did this" decision trace.
- `memory_audit_events`: read/write/update/delete audit stream.
- Existing `memory_patterns` remains for deterministic auto-approve compatibility.

## Capture Pipeline

1. Prompt capture
- Inputs: prompts from CLI/extension.
- Extract explicit checkpoint blocks (`[MEMORY_CHECKPOINT]...[/MEMORY_CHECKPOINT]`) and existing manual tags (`[USER_ACTION_REQUIRED]...`).
- Classify scope (`durable_project`, `durable_operator`, or `ephemeral_session`).

2. Outcome capture
- Inputs: command results + approval source.
- Write both `outcome` and `policy` cards.
- Merge via dedupe key to avoid duplicate growth.

3. Safety pass before persistence
- Redact sensitive keys and token-like strings.
- Skip memory writes in `no_store` mode.
- Skip secret-fill command payload persistence.

## Retrieval Pipeline

- Trigger: command enqueue (pre-dispatch policy check).
- Query: active cards filtered by domain/status/expiry.
- Rank: reliability + confidence + recency + domain match + intent match + scope weight.
- Read tracking: retrieval increments read counts and appends read audit events.

## Governance

- Memory cards are visible and editable from extension UI.
- Cards can be disabled or deleted.
- No-store toggle provides incognito-style mode:
  - retrieval and writes are skipped by policy layer.
- Decision feed explains policy outcomes (`high_risk_requires_confirmation`, `policy_check_passed`, etc).

## Policy Enforcement Hooks

- Runs inside `SessionManager.enqueueCommand` before queueing.
- High-risk commands (`evaluate`, `auth_fill_secret`, and sensitive typed fields) require explicit confirmation.
- Negative policy memory can require confirmation even for otherwise automatable commands.
- Existing autonomous auto-approve is preserved for deterministic `click/select` patterns.

## Learning Loop

- Positive results increase reliability and success counters.
- Negative outcomes reduce reliability and increase failure counters.
- Stale memories decay with deterministic rules (`decayStaleMemory`).
- Low-value stale ephemeral cards can be disabled.

## Threat Model

Assets:
- User credentials and secret references.
- Command execution authority in live browser sessions.
- Stored operational memory and audit history.

Trust boundaries:
- Extension <-> Engine WebSocket boundary.
- Engine storage boundary (SQLite persistence).
- CLI/operator inputs crossing into memory capture.

Key abuse paths and controls:
1. Prompt injection to poison memory
- Control: semantic dedupe, confidence/reliability scoring, human-editable cards, decision/audit logs.

2. Secret exfiltration via memory persistence
- Control: pre-persist redaction, sensitive key filtering, skipped persistence for secret-fill payloads.

3. Silent autonomy drift from stale memories
- Control: policy gate + high-risk confirmation + stale decay + disable/delete controls.

4. Hidden unsafe decisions
- Control: `memory_decisions` + sidepanel "Why I did this" feed.

Residual risk:
- Heuristic redaction may miss novel secret formats; continuous pattern hardening and adversarial tests remain required.
