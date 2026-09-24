# SceneVerse Reels

Personal local stack for an Indian **movies / motivational / quotes** Instagram page.

| App | Role |
|---|---|
| [`reel-workbench/`](./reel-workbench/) | Edit & render 9:16 Reels (FFmpeg) |
| [`reel-pipeline/`](./reel-pipeline/) | Queue & publish to Instagram (Graph API) |

## Full guide

→ **[KT.md](./KT.md)** — beginner-friendly knowledge transfer (setup, daily flow, commands, troubleshooting).

## Quick start

```bat
:: Terminal 1 — editor
cd reel-workbench
npm install
npm start

:: Terminal 2 — poster
cd reel-pipeline
npm install
npm run check-auth
```

Daily loop:

```bat
cd reel-pipeline
npm run import-stock
:: … edit + Render final in the browser editor …
npm run ready
node src/index.js queue add <projectId>
npm run post
```

Auto-post (10:00 & 19:00 IST):

```bat
cd reel-pipeline
npm run scheduler
```

## Scope

- Local-only personal tool (no accounts/billing/cloud for the workbench)
- Content: **own/licensed clips only** — reference Reels are for style research, never re-uploaded
- Secrets live in `reel-pipeline/.env` (not committed)
