# Reel Workbench

Personal, local-first workbench for creating Instagram Reels — import media, analyze reference Reels into style recipes, edit a 9:16 timeline, preview, render with FFmpeg, export.

**Not a SaaS.** No auth, no cloud, no AI backend. **OpenCode in your terminal is the AI/operator** — it reads/writes project files (see `AGENTS.md`).

## Requirements

- Node ≥ 20
- FFmpeg + ffprobe on PATH (or set `FFMPEG_PATH` / `FFPROBE_PATH`)
- A system font for text overlays (auto-detected: Arial / DejaVu / Segoe)

## Quick start

```bash
cd reel-workbench
npm install
npm start          # → http://127.0.0.1:4173
```

Optional:

```bash
npm run fixtures   # generate synthetic test clips under fixtures/
npm test           # node --test (timeline, security, renderer, integration)
npm run smoke      # in-process server → import → render final → ffprobe assert
npm run dev        # node --watch
```

## UI

Nav: **Projects · Media · References · Styles · Editor · Exports** (+ gear → Settings).

1. **Projects** — create/open/duplicate/delete (1080×1920 @ 30fps default).
2. **Media** — import videos/images/audio; tag rights; extract audio/frames.
3. **References** — upload reference Reels (`REFERENCE_ONLY`) → **Analyze** (local FFmpeg) → draft style JSON.
4. **Styles** — built-in + user style recipes; apply to a project; import/export JSON. Templates scaffold narrative text clips (Hook → CTA).
5. **Editor** — drag media to the 8-track timeline, trim/split/move, text inspector, preview playback, **OpenCode Director** panel (instruction inbox + Copy prompt), Preview / Final render with live progress + QC.
6. **Exports** — download `final.mp4`, thumbnail, `captions.srt`, QC report.

## OpenCode loop

1. In the Editor, type an instruction → **Save to inbox** (writes `data/projects/<id>/inbox/*.md`) or **Copy prompt**.
2. Run OpenCode in the terminal; it reads `AGENTS.md` and edits `timeline.json` (validate with `shared/timeline-ops.js`).
3. UI polls mtime → **Timeline changed on disk — Reload** → tweak → Render → Export.

## Architecture

See `ARCHITECTURE.md`. Summary:

- Express single process, plain JSON files under `data/` (gitignored), path sandbox, in-process render queue (one at a time).
- FFmpeg via `execFile` argv arrays only (never a shell).
- Shared pure module `shared/timeline-ops.js` for schema + mutations (server validation, client editing, tests).
- Rights guard: `REFERENCE_ONLY` media **fails render validation**.

## Data layout

```
data/
  settings.json
  media/{index.json, files/, thumbs/}
  styles/*.json
  projects/<id>/{project.json, timeline.json, inbox/, styles/, previews/, exports/}
  logs/  work/
```

## Tests

```bash
npm test
```

- `tests/timeline.test.js` — split/trim/move/overlap/undo/validate
- `tests/security.test.js` — path traversal, injection-shaped names, REFERENCE_ONLY shape
- `tests/renderer.test.js` — program segments, SRT, collectors, RenderError
- `tests/integration.test.js` — full HTTP API + real FFmpeg render + ffprobe assert (1080×1920/30/h264/aac)

## License / scope

Personal tool. Out of scope forever: accounts, billing, cloud, Instagram automation/bots, generative video.
