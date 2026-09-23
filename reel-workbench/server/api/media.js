import { Router } from 'express';
import multer from 'multer';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync, createWriteStream } from 'fs';
import { join, extname } from 'path';
import { pipeline } from 'stream/promises';
import {
  listMedia, getMedia, saveMedia, deleteMedia, nextMediaId, DIRS, getSettings, listProjects, readTimeline,
} from '../store.js';
import { assertMediaId, safeFilename, PathError } from '../paths.js';
import { probeMedia, categoryFromFilename, subcategory, SUPPORTED_UPLOAD_EXT } from '../probe.js';
import { generateThumbnail } from '../thumbnails.js';
import { resolveFfmpeg, resolveFfprobe } from '../config.js';
import { run } from '../ffmpeg.js';
import { log } from '../logger.js';

const router = Router();

const settings = getSettings();
mkdirSync(DIRS.mediaFiles, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DIRS.mediaFiles),
  filename: (_req, file, cb) => cb(null, `incoming-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extname(file.originalname).toLowerCase()}`),
});
const upload = multer({
  storage,
  limits: { fileSize: (settings.maxUploadMb || 2048) * 1024 * 1024, files: 20 },
});

function publicView(asset) {
  if (!asset) return null;
  return {
    ...asset,
    url: `/api/media/${asset.id}/file`,
    thumb: asset.thumb_rel ? `/api/media/${asset.id}/thumb` : null,
    abs_path: join(DIRS.media, asset.rel_path),
  };
}

function categorize(filename, mime, forceCategory) {
  const base = categoryFromFilename(filename);
  const cat = forceCategory || subcategory(base, filename, mime) || base;
  return { base, category: forceCategory || (base === 'audio' ? cat : base) };
}

async function ingest(tempPath, originalName, { asReference = false, forceCategory = null, derivedFrom = null } = {}) {
  const s = getSettings();
  const id = nextMediaId();
  const safe = safeFilename(originalName);
  const ext = extname(safe).toLowerCase();
  const rel = join('files', `${id}${ext || ''}`);
  const finalPath = join(DIRS.media, rel);
  mkdirSync(DIRS.media, { recursive: true });

  // move into place
  try {
    const { renameSync } = await import('fs');
    renameSync(tempPath, finalPath);
  } catch {
    const { copyFileSync } = await import('fs');
    copyFileSync(tempPath, finalPath);
    rmSync(tempPath, { force: true });
  }

  let meta = null;
  let probeError = null;
  try {
    meta = (await probeMedia(resolveFfprobe(s), finalPath)).meta;
  } catch (err) {
    probeError = err.message;
  }

  const { category } = categorize(safe, null, forceCategory || (asReference ? 'reference' : null));
  const asset = {
    id,
    filename: safe.replace(/\.[^.]+$/, '') || id,
    original_filename: originalName,
    ext,
    category: asReference ? 'reference' : category === 'other' ? (extname(safe) ? 'other' : 'other') : category,
    kind: meta?.category || categoryFromFilename(safe),
    size: existsSync(finalPath) ? statSync(finalPath).size : 0,
    duration: meta?.duration ?? null,
    width: meta?.width ?? null,
    height: meta?.height ?? null,
    fps: meta?.fps ?? null,
    videoCodec: meta?.videoCodec ?? null,
    audioCodec: meta?.audioCodec ?? null,
    hasAudio: meta?.hasAudio ?? null,
    hasVideo: meta?.hasVideo ?? null,
    meta,
    probe_error: probeError,
    purpose: asReference ? 'reference' : 'production',
    rights_status: asReference ? 'REFERENCE_ONLY' : 'OWNED',
    tags: [],
    derived_from: derivedFrom,
    created_at: new Date().toISOString(),
    rel_path: rel,
    thumb_rel: null,
  };

  // thumbnail (async-ish but await for a complete first response; fast single frame)
  if (asset.hasVideo || asset.kind === 'image') {
    try {
      const thumbAbs = await generateThumbnail(
        resolveFfmpeg(s),
        finalPath,
        `${id}.jpg`,
        asset.kind === 'image' ? 0 : Math.min(0.5, (asset.duration || 1) / 2)
      );
      asset.thumb_rel = join('thumbs', `${id}.jpg`);
      void thumbAbs;
    } catch (err) {
      log({ stage: 'thumb', status: 'ERROR', error: err.message, asset: id });
    }
  }

  saveMedia(asset);
  log({ stage: 'import', status: 'PASS', asset: id, file: safe });
  return asset;
}

/* ---------------- list / search ---------------- */

router.get('/', (req, res) => {
  let items = listMedia();
  const { category, q } = req.query;
  if (category && category !== 'all') items = items.filter((m) => m.category === category);
  if (q) {
    const needle = String(q).toLowerCase();
    items = items.filter(
      (m) =>
        m.filename.toLowerCase().includes(needle) ||
        (m.tags || []).some((t) => String(t).toLowerCase().includes(needle))
    );
  }
  res.json({ media: items.map(publicView) });
});

/* ---------------- import ---------------- */

router.post('/', (req, res) => {
  upload.array('files', 20)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds upload size limit' : err.message });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });
    const asReference = req.body?.asReference === 'true' || req.body?.asReference === '1';
    const forceCategory = req.body?.category || null;

    const results = [];
    const failures = [];
    for (const f of files) {
      const ext = extname(f.originalname).toLowerCase().replace('.', '');
      if (ext && !SUPPORTED_UPLOAD_EXT.has(ext)) {
        rmSync(f.path, { force: true });
        failures.push({ file: f.originalname, error: `Unsupported format .${ext}` });
        continue;
      }
      try {
        const asset = await ingest(f.path, f.originalname, { asReference, forceCategory });
        if (asset.probe_error) failures.push({ file: f.originalname, error: `Imported but probe failed: ${asset.probe_error}` });
        results.push(publicView(asset));
      } catch (e) {
        rmSync(f.path, { force: true });
        failures.push({ file: f.originalname, error: e.message });
      }
    }
    res.status(results.length ? 201 : 400).json({ media: results, failures });
  });
});

/** Direct-URL import — plain HTTP(S) file download only. No platform bypass. */
router.post('/url', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  const asReference = req.body?.asReference !== 'false';
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Only http(s) URLs are supported' });
  if (req.body?.confirmDirectFile !== true && req.body?.confirmDirectFile !== 'true') {
    return res.status(400).json({
      error:
        'Direct file URLs only (must return a media file). No platform pages, logins, DRM or bypasses. Pass confirmDirectFile:true to proceed.',
    });
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  const nameGuess = decodeURIComponent(parsed.pathname.split('/').pop() || 'download');
  const temp = join(DIRS.mediaFiles, `incoming-url-${Date.now()}${extname(nameGuess) || ''}`);
  try {
    const resp = await fetch(parsed, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!resp.ok) return res.status(400).json({ error: `Download failed (HTTP ${resp.status})` });
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      return res.status(400).json({ error: 'URL returned HTML, not a media file. Download the file yourself and use Import.' });
    }
    const maxBytes = (getSettings().maxUploadMb || 2048) * 1024 * 1024;
    const size = Number(resp.headers.get('content-length') || 0);
    if (size > maxBytes) return res.status(400).json({ error: 'Remote file exceeds size limit' });
    const { Readable } = await import('stream');
    await pipeline(Readable.fromWeb(resp.body), createWriteStream(temp));
    const asset = await ingest(temp, nameGuess, { asReference });
    res.status(201).json({ media: publicView(asset) });
  } catch (err) {
    rmSync(temp, { force: true });
    res.status(400).json({ error: `Download failed: ${err.message}` });
  }
});

/* ---------------- update / delete ---------------- */

router.get('/:id', (req, res) => {
  assertMediaId(req.params.id);
  const asset = getMedia(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Media not found' });
  res.json({ media: publicView(asset) });
});

router.patch('/:id', (req, res) => {
  assertMediaId(req.params.id);
  const asset = getMedia(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Media not found' });
  const { filename, tags, rights_status, category, purpose } = req.body || {};
  if (filename != null) {
    const name = safeFilename(String(filename).replace(/\.[^.]+$/, ''));
    if (!name) return res.status(400).json({ error: 'Invalid name' });
    asset.filename = name;
  }
  if (Array.isArray(tags)) asset.tags = tags.map((t) => String(t).slice(0, 40)).slice(0, 30);
  if (rights_status != null) {
    const allowed = ['OWNED', 'LICENSED', 'USER_PROVIDED_WITH_PERMISSION', 'PUBLIC_DOMAIN_OR_PERMITTED', 'REFERENCE_ONLY', 'UNKNOWN'];
    if (!allowed.includes(rights_status)) return res.status(400).json({ error: 'Invalid rights_status' });
    if (asset.rights_status === 'REFERENCE_ONLY' && rights_status !== 'REFERENCE_ONLY' && asset.category === 'reference') {
      return res.status(400).json({ error: 'Reference assets stay REFERENCE_ONLY. Import a permitted copy for production use.' });
    }
    asset.rights_status = rights_status;
  }
  if (category != null) {
    const allowed = ['video', 'image', 'music', 'voice', 'sfx', 'audio', 'font', 'reference', 'export', 'other'];
    if (!allowed.includes(category)) return res.status(400).json({ error: 'Invalid category' });
    asset.category = category;
    if (category === 'reference') {
      asset.rights_status = 'REFERENCE_ONLY';
      asset.purpose = 'reference';
    }
  }
  if (purpose != null) {
    if (!['production', 'reference', 'both'].includes(purpose)) return res.status(400).json({ error: 'Invalid purpose' });
    if (purpose === 'production' && asset.rights_status === 'REFERENCE_ONLY') {
      return res.status(400).json({ error: 'REFERENCE_ONLY assets cannot be marked for production' });
    }
    asset.purpose = purpose;
  }
  res.json({ media: publicView(saveMedia(asset)) });
});

function projectsUsing(id) {
  const used = [];
  for (const p of listProjects()) {
    const tl = readTimeline(p.id);
    if (!tl) continue;
    for (const t of tl.tracks) {
      if (t.clips.some((c) => c.assetId === id)) {
        used.push(p.name);
        break;
      }
    }
  }
  return used;
}

router.delete('/:id', (req, res) => {
  assertMediaId(req.params.id);
  const asset = getMedia(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Media not found' });
  const used = projectsUsing(asset.id);
  if (used.length && req.query.force !== 'true') {
    return res.status(409).json({ error: `Used on timeline of: ${used.join(', ')}`, used });
  }
  deleteMedia(asset.id);
  const file = join(DIRS.media, asset.rel_path);
  const thumb = asset.thumb_rel ? join(DIRS.media, asset.thumb_rel) : null;
  try { rmSync(file, { force: true }); } catch { /* ignore */ }
  try { if (thumb) rmSync(thumb, { force: true }); } catch { /* ignore */ }
  res.json({ ok: true, removed_from: used });
});

/* ---------------- file / thumb ---------------- */

router.get('/:id/file', (req, res) => {
  assertMediaId(req.params.id);
  const asset = getMedia(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Media not found' });
  const file = join(DIRS.media, asset.rel_path);
  if (!existsSync(file)) return res.status(404).json({ error: 'File missing on disk' });
  res.sendFile(file); // express handles Range requests for <video>
});

router.get('/:id/thumb', (req, res) => {
  assertMediaId(req.params.id);
  const asset = getMedia(req.params.id);
  if (!asset?.thumb_rel) return res.status(404).json({ error: 'No thumbnail' });
  const file = join(DIRS.media, asset.thumb_rel);
  if (!existsSync(file)) return res.status(404).json({ error: 'Thumbnail missing' });
  res.sendFile(file);
});

/* ---------------- extract audio / frames ---------------- */

router.post('/:id/extract-audio', async (req, res) => {
  assertMediaId(req.params.id);
  const asset = getMedia(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Media not found' });
  if (asset.hasAudio === false) return res.status(400).json({ error: 'This asset has no audio stream' });
  const s = getSettings();
  const id = nextMediaId();
  const rel = join('files', `${id}.wav`);
  const out = join(DIRS.media, rel);
  const src = join(DIRS.media, asset.rel_path);
  try {
    await run(resolveFfmpeg(s), ['-y', '-i', src, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', out], {
      timeoutMs: 600000,
    });
  } catch (err) {
    rmSync(out, { force: true });
    return res.status(500).json({ error: err.message });
  }
  const meta = (await probeMedia(resolveFfprobe(s), out)).meta;
  const child = {
    id,
    filename: `${asset.filename}-audio`,
    original_filename: `${asset.filename}.wav`,
    ext: '.wav',
    category: asset.rights_status === 'REFERENCE_ONLY' ? 'reference' : 'voice',
    kind: 'audio',
    size: statSync(out).size,
    duration: meta.duration,
    width: null, height: null, fps: null,
    videoCodec: null, audioCodec: meta.audioCodec,
    hasAudio: true, hasVideo: false,
    meta,
    purpose: asset.rights_status === 'REFERENCE_ONLY' ? 'reference' : 'production',
    rights_status: asset.rights_status, // rights inherit from parent
    tags: [...(asset.tags || []), 'extracted'],
    derived_from: asset.id,
    created_at: new Date().toISOString(),
    rel_path: rel,
    thumb_rel: null,
  };
  saveMedia(child);
  res.status(201).json({ media: publicView(child) });
});

router.post('/:id/extract-frames', async (req, res) => {
  assertMediaId(req.params.id);
  const asset = getMedia(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Media not found' });
  if (!asset.hasVideo && asset.kind !== 'image') return res.status(400).json({ error: 'No video stream to sample' });
  const count = Math.max(1, Math.min(12, Number(req.body?.count) || 6));
  const s = getSettings();
  const created = [];
  const duration = asset.duration || 1;
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? duration / 2 : (duration * i) / count;
    const id = nextMediaId();
    const rel = join('files', `${id}.jpg`);
    const out = join(DIRS.media, rel);
    try {
      await run(resolveFfmpeg(s), [
        '-y', '-ss', String(t.toFixed(3)), '-i', join(DIRS.media, asset.rel_path),
        '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', out,
      ], { timeoutMs: 60000 });
      const thumbRel = join('thumbs', `${id}.jpg`);
      await generateThumbnail(resolveFfmpeg(s), out, `${id}.jpg`, 0, { width: 360 });
      const meta = (await probeMedia(resolveFfprobe(s), out)).meta;
      const child = {
        id,
        filename: `${asset.filename}-frame-${i + 1}`,
        original_filename: `${asset.filename}-frame-${i + 1}.jpg`,
        ext: '.jpg',
        category: asset.rights_status === 'REFERENCE_ONLY' ? 'reference' : 'image',
        kind: 'image',
        size: statSync(out).size,
        duration: null,
        width: meta.width, height: meta.height, fps: null,
        videoCodec: null, audioCodec: null,
        hasAudio: false, hasVideo: true,
        meta,
        purpose: asset.rights_status === 'REFERENCE_ONLY' ? 'reference' : 'production',
        rights_status: asset.rights_status,
        tags: [...(asset.tags || []), 'frame'],
        derived_from: asset.id,
        created_at: new Date().toISOString(),
        rel_path: rel,
        thumb_rel: thumbRel,
      };
      saveMedia(child);
      created.push(publicView(child));
    } catch (err) {
      log({ stage: 'frames', status: 'ERROR', error: err.message, asset: id });
    }
  }
  if (!created.length) return res.status(500).json({ error: 'Frame extraction failed' });
  res.status(201).json({ media: created });
});

export { publicView };
export default router;
