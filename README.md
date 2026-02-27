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

## Setup

```bash
cd /home/void/BrowserAgent
pnpm install
pnpm run check
pnpm run test
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
