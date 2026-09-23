import { Router } from 'express';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  listProjects, getProject, saveProject, deleteProject, createProject, readTimeline, writeTimeline,
  timelineMtime, ensureProjectDirs, projectDir, getSettings, listMedia,
} from '../store.js';
import { assertProjectId, resolveInRoot, PathError } from '../paths.js';
import { loadTemplates, findStyle } from '../styles.js';
import { captionForProject } from '../captions.js';
import {
  createTimeline, validateTimeline, timelineDuration, getTrack, addClip, removeClip, clearTimeline, uid, round3,
  normalizeTransition, EFFECTS,
} from '../../shared/timeline-ops.js';

const router = Router();

/* ---------------- projects CRUD ---------------- */

router.get('/', (_req, res) => {
  const projects = listProjects().map((p) => ({
    ...p,
    dir: projectDir(p.id),
    has_preview: existsSync(join(projectDir(p.id), 'previews', 'preview.mp4')),
    has_final: existsSync(join(projectDir(p.id), 'exports', 'final.mp4')),
  }));
  res.json({ projects });
});

router.post('/', (req, res) => {
  const s = getSettings();
  const { name } = req.body || {};
  const { project, timeline } = createProject({
    name: typeof name === 'string' && name.trim() ? name.trim() : undefined,
    width: s.defaultWidth,
    height: s.defaultHeight,
    fps: s.defaultFps,
    createTimeline,
  });
  res.status(201).json({ project, timeline, dir: projectDir(project.id) });
});

router.get('/:id', (req, res) => {
  assertProjectId(req.params.id);
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const tl = readTimeline(project.id);
  res.json({
    project: {
      ...project,
      dir: projectDir(project.id),
      timeline_mtime: timelineMtime(project.id),
      has_preview: existsSync(join(projectDir(project.id), 'previews', 'preview.mp4')),
      has_final: existsSync(join(projectDir(project.id), 'exports', 'final.mp4')),
    },
    timeline: tl,
  });
});

router.patch('/:id', (req, res) => {
  assertProjectId(req.params.id);
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const allowed = ['name', 'description', 'style_id', 'style_name', 'template_id', 'media_ids', 'reference_ids', 'status'];
  for (const key of Object.keys(req.body || {})) {
    if (!allowed.includes(key)) return res.status(400).json({ error: `Cannot update ${key}` });
  }
  if (req.body.name != null) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
    project.name = name.slice(0, 120);
  }
  if (req.body.description != null) project.description = String(req.body.description).slice(0, 2000);
  if (req.body.style_id !== undefined) project.style_id = req.body.style_id;
  if (req.body.style_name !== undefined) project.style_name = req.body.style_name;
  if (req.body.template_id !== undefined) project.template_id = req.body.template_id;
  if (Array.isArray(req.body.media_ids)) project.media_ids = req.body.media_ids.filter((x) => typeof x === 'string');
  if (Array.isArray(req.body.reference_ids)) project.reference_ids = req.body.reference_ids.filter((x) => typeof x === 'string');
  if (typeof req.body.status === 'string') project.status = req.body.status;
  res.json({ project: saveProject(project) });
});

router.delete('/:id', (req, res) => {
  assertProjectId(req.params.id);
  if (!getProject(req.params.id)) return res.status(404).json({ error: 'Project not found' });
  deleteProject(req.params.id);
  res.json({ ok: true });
});

router.post('/:id/duplicate', (req, res) => {
  assertProjectId(req.params.id);
  const src = getProject(req.params.id);
  if (!src) return res.status(404).json({ error: 'Project not found' });
  const { project, timeline } = createProject({
    name: `${src.name} copy`,
    width: src.width,
    height: src.height,
    fps: src.fps,
    createTimeline: () => readTimeline(src.id) || createTimeline({ width: src.width, height: src.height, fps: src.fps }),
  });
  project.style_id = src.style_id;
  project.style_name = src.style_name;
  project.template_id = src.template_id;
  project.media_ids = [...(src.media_ids || [])];
  project.reference_ids = [...(src.reference_ids || [])];
  project.applied_style = src.applied_style ? JSON.parse(JSON.stringify(src.applied_style)) : null;
  project.duration = timelineDuration(timeline);
  saveProject(project);
  res.status(201).json({ project, timeline, dir: projectDir(project.id) });
});

/* ---------------- timeline ---------------- */

router.get('/:id/timeline', (req, res) => {
  assertProjectId(req.params.id);
  const tl = readTimeline(req.params.id);
  if (!tl) return res.status(404).json({ error: 'timeline.json not found' });
  res.json({ timeline: tl, mtime: timelineMtime(req.params.id) });
});

router.get('/:id/timeline/meta', (req, res) => {
  assertProjectId(req.params.id);
  if (!getProject(req.params.id)) return res.status(404).json({ error: 'Project not found' });
  res.json({ mtime: timelineMtime(req.params.id), duration: timelineDuration(readTimeline(req.params.id) || createTimeline()) });
});

router.put('/:id/timeline', (req, res) => {
  assertProjectId(req.params.id);
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const timeline = req.body?.timeline;
  const issues = validateTimeline(timeline);
  if (issues.length) {
    return res.status(400).json({ error: 'Timeline failed validation', issues });
  }
  timeline.version = timeline.version || 1;
  writeTimeline(project.id, timeline);
  project.duration = timelineDuration(timeline);
  saveProject(project);
  res.json({ ok: true, mtime: timelineMtime(project.id), duration: project.duration });
});

/* ---------------- apply style / template ---------------- */

router.post('/:id/apply-style', (req, res) => {
  assertProjectId(req.params.id);
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const style = findStyle(req.body?.style);
  if (!style) return res.status(404).json({ error: 'Style not found' });

  // Snapshot the recipe into the project folder (plain JSON, per project structure).
  ensureProjectDirs(project.id);
  const snapName = `${style.builtin ? slug(style.name) : (style.id || slug(style.name))}-v${style.version || 1}.json`;
  writeFileSync(join(projectDir(project.id), 'styles', snapName), JSON.stringify(style, null, 2));

  // Write real timeline props from the style (not metadata-only).
  const tl = readTimeline(project.id);
  const applied = applyStyleToTimeline(tl, style);
  if (tl) writeTimeline(project.id, tl);

  project.style_id = style.builtin ? slug(style.name) : style.id;
  project.style_name = style.name;
  project.applied_style = { ...style, applied_at: new Date().toISOString() };
  if (tl) project.duration = timelineDuration(tl);
  saveProject(project);
  res.json({ project, snapshot: `styles/${snapName}`, applied, timeline: tl || null });
});

/** Map style recipe fields onto timeline clips (effect / music volume / captions / transitions). */
function applyStyleToTimeline(tl, style) {
  const applied = { effects: 0, musicVolumes: 0, captionAnims: 0, transitions: 0 };
  if (!tl || !style) return applied;
  const effect = effectFromStyleVisual(style.visual);
  const musicVol = style.audio?.musicVolume;
  const capAnim = captionAnimFromStyle(style.captions?.animation);
  const trans = transitionFromStyle(style.transitions);

  for (const track of tl.tracks) {
    if (track.locked) continue;
    if (track.type === 'video') {
      for (const clip of track.clips) {
        if ((clip.kind === 'video' || clip.kind === 'image') && effect && EFFECTS.includes(effect)) {
          clip.effect = effect;
          applied.effects++;
        }
        if (trans && (track.id === 'v1' || track.id === 'v3')) {
          // First clip on a program track keeps a hard entry; later clips get the style transition.
          const sorted = [...track.clips].sort((a, b) => a.start - b.start);
          if (sorted[0] && clip.id !== sorted[0].id) {
            clip.transitionIn = normalizeTransition(trans);
            applied.transitions++;
          }
        }
      }
    } else if (track.type === 'audio' && track.id === 'a2' && musicVol != null) {
      const v = Math.max(0, Math.min(4, Number(musicVol)));
      if (Number.isFinite(v)) {
        for (const clip of track.clips) {
          clip.volume = v;
          applied.musicVolumes++;
        }
      }
    } else if ((track.id === 't1' || track.id === 't2') && capAnim) {
      for (const clip of track.clips) {
        if (clip.text) {
          clip.text.anim = capAnim;
          applied.captionAnims++;
        }
      }
    }
  }
  return applied;
}

function effectFromStyleVisual(visual) {
  if (!visual) return null;
  if (visual.preset === 'dark') return 'cool';
  const con = visual.contrast;
  const sat = visual.saturation;
  if (con === 'high' && sat === 'high') return 'vivid';
  if (con === 'high') return 'warm';
  if (sat === 'low') return 'bw';
  if (sat === 'high') return 'vivid';
  return null;
}

function captionAnimFromStyle(anim) {
  if (!anim) return null;
  const a = String(anim).toLowerCase();
  if (a.includes('pop')) return 'pop';
  if (a.includes('fade') || a.includes('emphasis') || a.includes('word')) return 'fade';
  return null;
}

function transitionFromStyle(transitions) {
  if (!transitions) return null;
  const primary = normalizeTransition(
    transitions.primary === 'hard_cut' ? 'none' : transitions.primary
  );
  if (primary !== 'none') return primary;
  const secondary = normalizeTransition(transitions.secondary);
  if (secondary === 'flash' || secondary === 'zoom' || secondary === 'fade') return secondary;
  return null;
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

router.post('/:id/apply-template', (req, res) => {
  assertProjectId(req.params.id);
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const tl = readTimeline(project.id);
  if (!tl) return res.status(404).json({ error: 'timeline.json not found' });

  const templates = loadTemplates();
  const ref = String(req.body?.template || '');
  const template = templates.find((t) => t.name === ref || slug(t.name) === slug(ref) || t.id === ref);
  if (!template) return res.status(400).json({ error: `Unknown template: ${ref}` });

  const overwrite = req.body?.overwrite !== false;
  const t1 = getTrack(tl, 't1');
  if (overwrite) {
    for (const c of [...t1.clips]) removeClip(tl, 't1', c.id);
  }

  const total = timelineDuration(tl) || Number(req.body?.duration) || 25;
  let cursor = 0;
  const created = [];
  for (const section of template.sections) {
    const dur = Math.max(0.5, round3(total * section.weight));
    const start = round3(cursor);
    if (start + dur <= total + 0.01) {
      try {
        const clip = addClip(tl, 't1', {
          kind: 'text',
          start,
          duration: Math.min(dur, total - start),
          text: { content: `${section.label}`, role: section.id === 'cta' ? 'cta' : section.id === 'hook' ? 'hook' : 'title', position: 'center', size: 64 },
        });
        created.push(clip.id);
      } catch { /* slot conflict — skip */ }
    }
    cursor += dur;
  }
  writeTimeline(project.id, tl);
  project.template_id = template.name;
  project.duration = timelineDuration(tl);
  saveProject(project);
  res.json({ project, timeline: tl, created: created.length });
});

/* ---------------- OpenCode inbox ---------------- */

router.get('/:id/inbox', (req, res) => {
  assertProjectId(req.params.id);
  ensureProjectDirs(req.params.id);
  const dir = join(projectDir(req.params.id), 'inbox');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({
      file: f,
      mtime: statSync(join(dir, f)).mtimeMs,
      content: readFileSync(join(dir, f), 'utf8'),
    }));
  res.json({ files });
});

router.post('/:id/inbox', (req, res) => {
  assertProjectId(req.params.id);
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const instruction = String(req.body?.instruction || '').trim();
  if (!instruction) return res.status(400).json({ error: 'Instruction is required' });

  ensureProjectDirs(project.id);
  const dir = join(projectDir(project.id), 'inbox');
  const existing = readdirSync(dir).filter((f) => f.endsWith('.md'));
  const n = String(existing.length + 1).padStart(3, '0');

  const tl = readTimeline(project.id);
  const media = listMedia();
  const used = new Set();
  for (const t of tl?.tracks || []) for (const c of t.clips) if (c.assetId) used.add(c.assetId);
  const mediaRows = media
    .map((m) => `| ${m.id} | ${m.filename} | ${m.category} | ${m.duration ?? ''} | ${m.rights_status} | ${used.has(m.id) ? 'ON TIMELINE' : ''} |`)
    .join('\n');

  const content = [
    `# Instruction for OpenCode — ${project.name} (${project.id})`,
    '',
    `**User instruction:**`,
    '',
    `> ${instruction.replace(/\n/g, '\n> ')}`,
    '',
    `**Project dir:** \`${projectDir(project.id).replace(/\\/g, '/')}\``,
    `**Timeline file:** \`${join(projectDir(project.id), 'timeline.json').replace(/\\/g, '/')}\``,
    `**Style:** ${project.style_name || '(none)'} | **Template:** ${project.template_id || '(none)'}`,
    `**Canvas:** ${project.width}x${project.height} @ ${project.fps}fps | **Duration:** ${timelineDuration(tl)}s`,
    '',
    `**Media library** (edit timeline by referencing these asset ids; REFERENCE_ONLY assets cannot be rendered):`,
    '',
    '| id | filename | category | duration | rights | usage |',
    '|---|---|---|---|---|---|',
    mediaRows || '| (no media) | | | | | |',
    '',
    `**How to fulfill:** read AGENTS.md in the workbench root, edit timeline.json (and project.json if needed) with validated operations from shared/timeline-ops.js, then tell the user to hit Reload in the OpenCode panel.`,
    '',
    `---`,
    `Saved: ${new Date().toISOString()}`,
    '',
  ].join('\n');

  const filename = `${n}-${slug(instruction).slice(0, 40) || 'instruction'}.md`;
  writeFileSync(join(dir, filename), content, 'utf8');
  res.status(201).json({ file: filename, path: join(dir, filename) });
});

/* ---------------- caption (export helper) ---------------- */

/** Generate/refresh exports/caption.txt from the current project + timeline. */
router.post('/:id/caption', (req, res) => {
  assertProjectId(req.params.id);
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const tl = readTimeline(project.id);
  if (!tl) return res.status(404).json({ error: 'timeline.json not found' });

  const extra = {
    tags: Array.isArray(req.body?.tags) ? req.body.tags : [],
    includeCTA: req.body?.includeCTA !== false,
    includeHashtags: req.body?.includeHashtags !== false,
    cta: typeof req.body?.cta === 'string' ? req.body.cta : '',
    maxLength: Number(req.body?.maxLength) || 2200,
  };
  const caption = captionForProject(project, tl, extra);

  ensureProjectDirs(project.id);
  const file = join(projectDir(project.id), 'exports', 'caption.txt');
  writeFileSync(file, caption, 'utf8');
  res.json({
    caption,
    file,
    url: `/api/projects/${project.id}/exports/caption.txt`,
    length: caption.length,
  });
});

/** Preview caption without writing (dry-run). */
router.get('/:id/caption', (req, res) => {
  assertProjectId(req.params.id);
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const tl = readTimeline(project.id);
  if (!tl) return res.status(404).json({ error: 'timeline.json not found' });
  const stored = join(projectDir(project.id), 'exports', 'caption.txt');
  if (existsSync(stored) && req.query.refresh !== '1') {
    return res.json({ caption: readFileSync(stored, 'utf8'), stored: true, url: `/api/projects/${project.id}/exports/caption.txt` });
  }
  res.json({ caption: captionForProject(project, tl), stored: false });
});

/* ---------------- exports & downloads ---------------- */

router.get('/:id/exports', (req, res) => {
  assertProjectId(req.params.id);
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const dir = projectDir(req.params.id);
  const read = (sub, urlBase) => {
    const d = join(dir, sub);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => !f.startsWith('.'))
      .map((f) => {
        const st = statSync(join(d, f));
        return { file: f, size: st.size, mtime: st.mtimeMs, url: `${urlBase}/${encodeURIComponent(f)}` };
      })
      .sort((a, b) => b.mtime - a.mtime);
  };
  res.json({
    exports: read('exports', `/api/projects/${project.id}/exports`),
    previews: read('previews', `/api/projects/${project.id}/exports`),
    absolute_dir: join(dir, 'exports'),
  });
});

router.get('/:id/exports/:file', (req, res) => {
  assertProjectId(req.params.id);
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const dir = projectDir(req.params.id);
  let file;
  try {
    file = resolveInRoot(join(dir, 'exports'), req.params.file);
    if (!existsSync(file)) file = resolveInRoot(join(dir, 'previews'), req.params.file);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!existsSync(file)) return res.status(404).json({ error: 'File not found' });
  res.download(file);
});

/** Poster frame for UI (cached). */
router.get('/:id/poster', async (req, res) => {
  assertProjectId(req.params.id);
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const t = Math.max(0, Number(req.query.t) || 0);
  const cache = join(projectDir(req.params.id), 'previews', `poster-${Math.round(t * 10)}.jpg`);
  if (!existsSync(cache)) {
    const { frameAt } = await import('../renderer.js');
    mkdirSync(join(projectDir(req.params.id), 'previews'), { recursive: true });
    try {
      await frameAt(project.id, t, cache);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  res.sendFile(cache);
});

export default router;
