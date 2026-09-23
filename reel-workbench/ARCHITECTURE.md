# Reel Workbench — Architecture (personal, local-first)

Rewritten after the project-direction change. **This is a personal local Reel editing workstation, not a platform/SaaS.**

## 1. What the product is

> A local visual control panel for creating Reels: import media, analyze a reference Reel into a reusable editing style, edit on a 9:16 timeline, preview, render with FFmpeg, export.

**OpenCode (terminal) is the AI/operator.** There is no AI backend, no model hosting, no cloud. The UI exposes files, project state, timeline JSON, an instruction inbox, and local operations; OpenCode reads and edits those files and runs local tools. FFmpeg does deterministic rendering. The browser only displays and edits structured state.

Explicitly out of scope (never build): auth, users, teams, billing, cloud DB/storage/rendering, analytics platform, Instagram automation/bots, generative video models, deployment infrastructure.

## 2. Architecture

```
Browser UI (dark workbench, no build step)
   │  fetch JSON API (localhost)
   ▼
Express server (Node ESM, single process, one command: npm start)
   ├─ plain JSON files (no database)
   ├─ path sandbox (server/paths.js)
   ├─ simple in-process render queue (one render at a time)
   ├─ local FFmpeg/ffprobe (execFile, argv arrays, never a shell)
   └─ OpenCode inbox files (projects/<id>/inbox/*.md)
   ▼
Local filesystem → FFmpeg → exports/final.mp4
```

System dependencies: Node ≥ 20, FFmpeg (ffmpeg + ffprobe). npm deps: `express`, `multer` only.

## 3. File layout (no DB)

```
reel-workbench/
  ARCHITECTURE.md  README.md  AGENTS.md      ← AGENTS.md teaches OpenCode to operate the workbench
  package.json
  shared/
    timeline-ops.js        pure timeline ops (server + client + tests)
    builtin-styles.json    starter style recipes
    builtin-templates.json narrative structure templates
  server/
    index.js app.js
    config.js paths.js logger.js
    ffmpeg.js probe.js thumbnails.js
    store.js               JSON-file store (settings, media index, projects)
    styles.js              style/template JSON files (builtin + user)
    analyze.js             local FFmpeg reference analysis → style draft
    renderer.js            timeline.json → staged FFmpeg → preview/final mp4
    qc.js                  quality-control checks
    queue.js               one-at-a-time render queue, progress via project.json
    api/{projects,media,styles,render,settings}.js
  public/                  SPA: Projects · Media · References · Styles · Editor · Exports
  data/                    runtime, gitignored
    settings.json
    media/{files,thumbs}/  media/index.json
    styles/                user style recipes *.json
    projects/<id>/
      project.json  timeline.json
      styles/       references (ids recorded in project.json)
      inbox/        OpenCode instructions
      previews/     preview.mp4
      exports/      final.mp4 thumbnail.jpg captions.srt timeline.json
    logs/                  structured JSONL logs
    work/                  per-render temp (cleaned)
```

Projects **reference** media by `assetId` (media/index.json) — large files are never duplicated.

## 4. Roles: UI vs OpenCode vs FFmpeg

| Actor | Does |
|---|---|
| **UI** | import/preview/tag media, upload references, browse/save styles, edit timeline manually (trim/split/move/text/volume), preview playback, start renders, download exports, write instructions to `inbox/` |
| **OpenCode** | the AI director: analyze reference → style JSON, build/modify `timeline.json`, captions, clip selection, pacing — by editing project files directly (schema below), then user reloads in UI |
| **FFmpeg** | deterministic rendering only: `timeline.json + assets → mp4` |

OpenCode never gets shell access *through the app*; it already has the terminal. The app's job is to give it a safe, documented file contract (AGENTS.md) and validation on load (`validateTimeline`).

### OpenCode loop (no AI backend)

1. User types an instruction in the **OpenCode panel** → `[Save to Inbox]` writes `projects/<id>/inbox/NNN-….md` with full context (project path, style, media table, timeline path). `[Copy Prompt]` puts a ready-made prompt on the clipboard for pasting into the terminal.
2. User runs OpenCode; it reads the inbox file + `AGENTS.md`, edits `timeline.json` (and `project.json` as needed).
3. UI polls `timeline.json` mtime → banner “Timeline changed on disk — Reload” → editor refreshes → preview → manual tweaks → Render → Export.

## 5. Timeline (source of truth)

Same 8 tracks: `v1 v2 v3 a1 a2 a3 t1 t2`. Clip: `{id, kind, start, duration, srcIn, volume, muted, assetId?, text?}`; no overlaps within a track; all ops in `shared/timeline-ops.js` (used by server validation, client editing, tests). Autosave = debounced PUT → `timeline.json`. Undo/redo = client snapshot stacks.

## 6. Render pipeline (deterministic, staged)

`validate → media_prep (trim/scale-crop 1080×1920/fps normalize/black gap fillers) → concat → overlays+drawtext → audio mix (adelay+amix, silence if none) → mux (H.264/AAC, faststart) → thumbnail + captions.srt + QC`

- **Preview render**: same pipeline, ultrafast/CRF 30 → `previews/preview.mp4`.
- **Final render**: settings CRF/preset → `exports/final.mp4`, then `thumbnail.jpg`, `captions.srt` (from T2 clips), `timeline.json` copy, QC report in `project.json`.
- Rights guard: clips whose asset is `REFERENCE_ONLY` **fail validation** — reference material is for style learning, never silent reuse.
- Progress: parsed from `-progress` → `project.json.renderJob {status, progress, stage, error, outputs}`. Queue runs one render at a time.

## 7. Reference → Style (local, honest)

Upload (or direct file URL fetch only — no platform bypass/DRM/scraping) → stored as `REFERENCE_ONLY` in `media/`. **Analyze** runs local FFmpeg: scene-cut detection (`select=gt(scene,…)`), `signalstats` (brightness/contrast/saturation), `silencedetect`/`volumedetect` (audio presence/energy), duration/shot-length/cut-frequency heuristics → a *draft* style JSON with confidence notes. User names/saves it into `styles/*.json`. OpenCode can refine the JSON afterwards. No model training.

Style JSON = editing recipe (pacing, transitions, motion, captions, audio, visual). **Apply** = snapshot copy into project `styles/` + sets editor defaults (caption position/size, music volume). Pixel-level application of color/transitions is Phase 2 render work — Phase 1 does not pretend otherwise.

Template ≠ style: templates scaffold narrative text clips (Hook/Context/Build/Payoff/CTA) onto the timeline by proportion — a real, working operation.

## 8. Phases (smallest powerful tool)

1. **Foundation (this)**: editor UI, media import/library, preview, 9:16, timeline ops, text, audio, projects save/load/autosave, styles library CRUD, references upload + FFmpeg analysis → style, OpenCode inbox, render preview/final, QC, exports page.
2. Reel editing: transitions, zoom/pan/speed, color presets, fades, ducking, caption styling depth, safe-area warnings in QC.
3. Smart: scene thumbnails, Whisper transcripts/captions, beats, smart crop — via local tools only.
4. Nothing more unless it passes: *“Does this directly help create, edit, analyze, or export a Reel?”*

## 9. Security (kept from before — still required)

Path sandbox for every file op; FFmpeg via `execFile` argv (no shell); inputs/outputs restricted to `data/`; upload size cap; `validateTimeline` before writes; render timeout. Errors are human-readable (“A media file could not be decoded…”) with developer details in logs.

## 10. Tests

`node --test`: timeline ops (split/trim/move/delete/overlap/undo), security (traversal, injection-shaped names), renderer command construction, and an integration test that builds fixtures with FFmpeg, renders a real MP4 through the API, and asserts 1080×1920/30fps/H.264/AAC via ffprobe.
