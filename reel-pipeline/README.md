# reel-pipeline

**Discover → Import → Queue → Publish** for an Indian movies / motivational / quotes Reels page. Works with `reel-workbench` (editor).

```
your clips (stock/) ──► import-stock ──► reel-workbench edit ──► Render final
reference-urls.txt ──► discover (research only)
                                              │
                         queue add <id> ◄─────┘
                              │
                         post / start (scheduler)
                              │
                    Instagram REELS (resumable upload)
```

Pexels is **optional**. Default path = your own movie/cinematic clips.

## Setup

```bash
cd reel-pipeline
npm install
# .env already required:
#   INSTAGRAM_ACCESS_TOKEN
#   INSTAGRAM_USER_ID
#   FACEBOOK_APP_ID / FACEBOOK_APP_SECRET  (for refresh)
```

## Commands

| Command | What |
|---|---|
| `npm run check-auth` | Verify token + account |
| `node src/index.js check-auth refresh` | 60-day token |
| `npm run discover` | Research board from reference URLs |
| `npm run import-stock` | Import clips from `stock/` → workbench |
| `npm run ready` | List rendered projects ready to queue |
| `npm run queue` | Pending / failed / posted |
| `node src/index.js queue add project-005` | Queue a render |
| `npm run post` | Publish next 1 (respects daily limit) |
| `npm run scheduler` | Auto 10:00 & 19:00 IST |
| `npm run status` | Queue + limits + auth |

## Daily flow

1. Drop clips → `E:\agentforinsta\reel-pipeline\stock\*.mp4`
2. `npm run import-stock` (workbench must be running)
3. Edit in reel-workbench → **Render final**
4. `npm run ready` → `node src/index.js queue add <projectId>`
5. `npm run post`  **or** leave `npm run scheduler` running

## Config

- `.env` — token, user id, schedule (Pexels optional)
- `config/niche.json` — hashtags, CTAs, stock keywords
- `config/reference-urls.txt` — research URLs
- `config/queue.json` — pending / posted / failed
- `config/posted-history.json` — daily counts

## Limits

- Default **2/day**, min gap 180 min, warm-up 1/day for first 7 posts
- API hard limit 25/24h
- Reels: 1080×1920 30fps H.264+AAC (workbench default)

## Not in scope

Reposting other creators' reels as production content, auth/cloud, generative video.
