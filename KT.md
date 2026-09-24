# SceneVerse Reels — Project Guide (KT)

**Knowledge Transfer document** — everything you need to run this project, written for a beginner.

---

## 1. What is this?

A personal system to **make and post Instagram Reels** for the **SceneVerse** account  
(niche: movies · motivational · quotes · India).

```
Your clips  →  Edit in Reel Workbench  →  Queue  →  Auto/Manual Post to Instagram
```

No cloud. No SaaS. Runs on **this PC only**.

---

## 2. Folders (what each one does)

| Folder | What it is | Open it when… |
|---|---|---|
| **`reel-workbench/`** | Video **editor** (timeline, text, render MP4) | You want to **make** a Reel |
| **`reel-pipeline/`** | **Poster** (queue + upload to Instagram) | You want to **post** a finished Reel |
| **`instagram-agent/`** | Old/legacy agent (couple site) — **ignore** | Never (for this project) |
| **`insta cred.txt`** | Old notes — **ignore** | Never |

**Everyday you only touch: `reel-workbench` + `reel-pipeline`.**

---

## 3. One-time setup (new computer)

### A. Install tools
1. **Node.js 20+** — https://nodejs.org → LTS → install
2. **FFmpeg** — install and make sure `ffmpeg` works in terminal  
   (or set `FFMPEG_PATH` in workbench settings)
3. Open **PowerShell** or **Command Prompt**

### B. Install project
```bat
cd E:\agentforinsta\reel-workbench
npm install

cd E:\agentforinsta\reel-pipeline
npm install
```

### C. Secrets file (`.env`)
File: `reel-pipeline\.env` (**not shared on GitHub** — copy from `.env.example`)

Must contain:

| Line | Meaning |
|---|---|
| `INSTAGRAM_ACCESS_TOKEN=...` | Instagram API token |
| `INSTAGRAM_USER_ID=...` | Instagram business id |
| `FACEBOOK_APP_ID=...` | Meta app id |
| `FACEBOOK_APP_SECRET=...` | Meta app secret |
| `PEXELS_API_KEY=` | Leave empty (optional) |

**Never paste the token in chat/email.**

### D. Check login works
```bat
cd E:\agentforinsta\reel-pipeline
npm run check-auth
```
Expect: **`✅ Auth OK`** and `@sceneverse_you`

Token dies every ~60 days. Refresh:
```bat
node src/index.js check-auth refresh
```
Copy the new token into `.env` → save.

---

## 4. Daily workflow (the real routine)

### Step 1 — Start the editor
```bat
cd E:\agentforinsta\reel-workbench
npm start
```
Open browser: **http://127.0.0.1:4173**

### Step 2 — Put clips in
- Put your `.mp4` files in:  
  `E:\agentforinsta\reel-pipeline\stock\`
- Then (while editor is running):
```bat
cd E:\agentforinsta\reel-pipeline
npm run import-stock
```
Or in the editor UI: **Media → Import**

### Step 3 — Edit the Reel
In the editor:
1. **Projects** → create/open a project (1080×1920)
2. Drag video to timeline (track V1)
3. Add **text** (hook, quote, CTA) on text tracks
4. Optional: music on audio track
5. **Preview** → fix until it looks good
6. **Render final** → creates `exports/final.mp4`

### Step 4 — Queue it
```bat
cd E:\agentforinsta\reel-pipeline
npm run ready
```
Shows projects with a finished render, e.g. `[READY] project-005`

```bat
node src/index.js queue add project-005
```
(Use **your** project id from the list.)

### Step 5 — Post it
**Post now (1 reel):**
```bat
npm run post
```

**Or auto-post at 10:00 & 19:00 IST:**
```bat
npm run scheduler
```
Leave that window open (or run in a second terminal).

### Check status anytime
```bat
npm run status
npm run queue
```

---

## 5. Command cheat sheet

| I want to… | Command (run inside `reel-pipeline`) |
|---|---|
| Check Instagram login | `npm run check-auth` |
| Refresh token (60 days) | `node src/index.js check-auth refresh` |
| Import my clips | `npm run import-stock` |
| List finished videos | `npm run ready` |
| Queue a video | `node src/index.js queue add project-005` |
| Post 1 reel now | `npm run post` |
| Post 2 reels | `node src/index.js post 2` |
| Auto schedule | `npm run scheduler` |
| See counts/limits | `npm run status` |
| See queue | `npm run queue` |
| Research other reels | `npm run discover` |
| Help | `node src/index.js help` |

| I want to… | Command (run inside `reel-workbench`) |
|---|---|
| Open editor | `npm start` → http://127.0.0.1:4173 |
| Tests | `npm test` |

---

## 6. Rules & limits (keep the account safe)

| Rule | Value |
|---|---|
| Posts per day (our setting) | **2** (warm-up: **1** for first 7 posts) |
| Gap between posts | **180 minutes** |
| Instagram API hard limit | 25 / 24 hours |
| Reel format | 9:16 · 1080×1920 · 30fps · H.264+AAC |
| Max length | 15 minutes (we use short: 7–30s) |

### Content rules (important)
- Use **your own** or **licensed** clips in the editor
- **Do not** download other people’s Reels and re-upload them  
  (strikes → ban → lose the account)
- Reference Reels (for learning style only) stay `REFERENCE_ONLY` — editor will refuse to render them
- Music: royalty-free only

---

## 7. How posting works (simple diagram)

```
[Editor] Render final.mp4
        │
        ▼
[reel-pipeline] queue add  →  config/queue.json (pending)
        │
        ▼
post / scheduler
        │
        ▼
Instagram API:
  1. Create REELS container
  2. Upload file from PC
  3. Wait until ready
  4. Publish
        │
        ▼
config/posted-history.json  (counts for the day)
```

History files (don’t hand-edit unless you know why):
- `reel-pipeline/config/queue.json`
- `reel-pipeline/config/posted-history.json`

---

## 8. Config files you may edit

| File | Purpose |
|---|---|
| `reel-pipeline/.env` | Secrets + schedule + daily limit |
| `reel-pipeline/config/niche.json` | Hashtags, CTA lines, keywords |
| `reel-pipeline/config/reference-urls.txt` | Reel URLs for research (one per line) |

Schedule example (in `.env`):
```
MAX_POSTS_PER_DAY=2
MIN_GAP_MINUTES=180
POST_SCHEDULE=0 10,19 * * *    ← 10:00 and 19:00
TIMEZONE=Asia/Kolkata
```

---

## 9. Troubleshooting

| Problem | Fix |
|---|---|
| `check-auth` fails | Token expired → `check-auth refresh` → paste new token in `.env` |
| `queue add` says no render | Open editor → **Render final** first |
| `import-stock` can’t reach editor | Start workbench (`npm start`) then retry |
| Post fails “permission” | Token missing `instagram_content_publish` → regenerate in Graph API Explorer |
| Post fails “container” | Video too big / bad format → re-render in workbench |
| Scheduler does nothing | Queue empty, or daily limit hit, or window closed |
| FFmpeg not found | Install FFmpeg or set path in workbench settings |
| Wrong Instagram account | Confirm `INSTAGRAM_USER_ID` = `17841427775311490` |

---

## 10. Accounts & IDs (SceneVerse)

| Item | Value |
|---|---|
| Instagram | `@sceneverse_you` (Professional) |
| Facebook Page | SceneVerse |
| IG User ID | `17841427775311490` |
| Page ID | `1336440046226630` |
| Meta App ID | `969410618802947` (SceneVerse) |
| Repo root | `E:\agentforinsta` |

Credentials live in `reel-pipeline\.env` (git-ignored).

---

## 11. 10-minute KT session (walkthrough script)

**Trainer → Trainee:**

1. Show folder tree (section 2). Say: *“We only use workbench + pipeline.”*
2. Open terminal → `npm start` in workbench → show editor UI.
3. Show one finished project: timeline with video + big quote text.
4. Point to **Render final** → then `exports/final.mp4`.
5. New terminal → `reel-pipeline` → `npm run ready` → `queue add …` → `npm run post`.
6. Show `npm run status` (counts).
7. Show `.env` location — *“Don’t share this file.”*
8. Show schedule command `npm run scheduler`.
9. Repeat the **content rules** (section 6) — no stealing other Reels.
10. Let them run: ready → add → post on a **test** render.

**They can do the daily loop alone after:**
import → edit → render → ready → add → post/scheduler.

---

## 12. Project map (for developers)

```
agentforinsta/
├── KT.md                    ← this document
├── README.md                ← short overview
├── reel-workbench/          ← Express + FFmpeg editor
│   ├── server/  public/  shared/  data/
│   └── data/projects/<id>/exports/final.mp4
└── reel-pipeline/           ← Node CLI poster
    ├── .env                 ← secrets (not in git)
    ├── config/              ← queue, history, niche, research
    ├── stock/               ← drop clips here
    ├── references/inbox/    ← style research only
    └── src/
        ├── index.js         ← CLI entry
        ├── publisher.js     ← Instagram resumable REELS upload
        ├── queue.js         ← workbench exports → queue
        ├── scheduler.js     ← cron 10:00 & 19:00 IST
        ├── igauth.js        ← check/refresh token
        ├── discovery.js     ← research URLs (oEmbed)
        ├── stock.js         ← import local clips (Pexels optional)
        ├── caption.js       ← captions + hashtags
        ├── history.js       ← daily limits
        └── niche.js         ← load niche.json
```

---

## 13. Who does what (system roles)

| Part | Job |
|---|---|
| **You (human)** | Pick clips, write quotes, hit Render, approve what posts |
| **Reel Workbench** | Edit + render MP4 (FFmpeg) |
| **reel-pipeline** | Queue + upload to Instagram + respect limits |
| **Instagram Graph API** | Actually publish the Reel |

There is **no AI cloud** in the middle. OpenCode (optional) can help edit project JSON if you ask it inside the workbench.

---

## 14. First week checklist

- [ ] `npm run check-auth` → Auth OK  
- [ ] Token refreshed (long-lived)  
- [ ] Editor opens at `http://127.0.0.1:4173`  
- [ ] One clip imported  
- [ ] One Reel rendered (`final.mp4` exists)  
- [ ] `queue ready` shows it  
- [ ] First post: `npm run post` (warm-up = 1/day)  
- [ ] Scheduler running on PC during day  
- [ ] Saved this KT.md somewhere both of you can open  

---

*End of KT. When stuck: `node src/index.js help` or re-read section 9 (Troubleshooting).*
