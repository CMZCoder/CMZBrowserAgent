# BrowserAgent Extension

Chrome MV3 side panel + service worker runtime for BrowserAgent.

## Build

```bash
cd /home/void/BrowserAgent
pnpm install
pnpm --filter @browser-agent/extension run build
```

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `/home/void/BrowserAgent/extension/build`

## Superpowers

- One-click workflow runner:
  - GitHub Actions (repo)
  - GitHub Secrets (repo)
  - Vercel project settings
  - Ops control room tabs (GitHub + Vercel + Cloudflare + Neon)
- Live command timeline with per-step status
- Memory lab (inspect/reset autonomous memory patterns)
- Quick actions:
  - Full-page snapshot
  - Diagnostics extraction
  - Focus automation tab
- Session transcript export to Markdown
