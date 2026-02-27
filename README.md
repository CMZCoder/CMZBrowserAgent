# BrowserAgent (Standalone)

BrowserAgent is a local bridge that lets an AI agent operate your Windows Chrome session from WSL with a single persistent session and human-in-the-loop control.

## Repository Layout

- `engine/`: local bridge runtime (HTTP + WS, command queue, session lock, autopilot guard, memory)
- `extension/`: Chrome MV3 extension (service worker + side panel + content runtime)

## Superpowers (v2)

- One-click workflows for GitHub, Vercel, Cloudflare, and Neon tabs
- Live command timeline in side panel (queued, running, success, error)
- Memory control panel (view/reset learned autonomous patterns)
- Quick actions (snapshot, diagnostics extract, focus current automation tab)
- Session export to Markdown

## Autonomous Memory Automation (v3)

- Typed memory taxonomy:
  - `ephemeral_session`
  - `durable_project`
  - `durable_operator`
  - `policy`
  - `outcome`
- Structured capture from checkpoints, prompts, and command outcomes
- Task-intent retrieval with domain-aware ranking and reliability weighting
- Policy gate before dispatch with decision traces ("Why I did this")
- Memory governance controls (view/edit/disable/delete + reset + no-store mode)
- Deterministic memory evaluation harness for regression tracking

## Setup

```bash
cd /home/void/BrowserAgent
pnpm install
pnpm run check
pnpm run test
pnpm --filter @browser-agent/engine run memory:eval
```

## Start Engine

```bash
pnpm run dev:engine
```

By default, engine runs on `http://127.0.0.1:8787`.

## Build Extension

```bash
pnpm run build:extension
```

Load unpacked extension from:

```text
/home/void/BrowserAgent/extension/build
```

## Domain Allowlist

Default allowed domains:

- `github.com`
- `vercel.com`
- `cloudflare.com`
- `neon.tech`
- `comerzio.ch`

Override with:

```bash
BROWSER_AGENT_ALLOWED_DOMAINS=github.com,vercel.com,cloudflare.com,neon.tech,comerzio.ch
```

## Memory Operations

Engine endpoints:

- `GET /v1/memory/cards`
- `POST /v1/memory/cards/:memoryCardId`
- `POST /v1/memory/cards/:memoryCardId/delete`
- `GET /v1/memory/decisions`
- `GET /v1/memory/settings`
- `POST /v1/memory/settings/no-store`
- `POST /v1/memory/patterns/reset`

Extension sidepanel:

- `Memory Lab` shows memory health, cards, and decision reasons.
- `No-store mode` disables memory retrieval and persistence (incognito memory behavior).

## Privacy and Safety Controls

- Secret and token-shaped values are redacted before persistence.
- `auth_fill_secret` payloads are excluded from memory persistence.
- High-risk commands require explicit confirmation policy.
- Memory read/write/update/delete actions are audited in engine storage.
- Memory can be reset without affecting pairing/session tables.
