import { Router } from 'express';
import multer from 'multer';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync, createWriteStream, renameSync, copyFileSync } from 'fs';
import { join, extname } from 'path';
import { pipeline } from 'stream/promises';
import {
  listMedia, getMedia, saveMedia, deleteMedia, nextMediaId, DIRS, getSettings, listProjects, readTimeline,
} from '../store.js';
import { assertMediaId, safeFilename, PathError, MEDIA_ID_RE } from '../paths.js';
import { probeMedia, categoryFromFilename, subcategory, SUPPORTED_UPLOAD_EXT } from '../probe.js';
import { generateThumbnail } from '../thumbnails.js';
import { resolveFfmpeg, resolveFfprobe } from '../config.js';
import { run } from '../ffmpeg.js';
import { log } from '../logger.js';

const router = Router();

mkdirSync(DIRS.mediaFiles, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DIRS.mediaFiles),
  filename: (_req, file, cb) => cb(null, `incoming-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extname(file.originalname).toLowerCase()}`),
});

function uploadLimitMb() {
  return Math.max(16, Number(getSettings().maxUploadMb) || 51200);
}

function upload() {
  return multer({
    storage,
    limits: { fileSize: uploadLimitMb() * 1024 * 1024, files: 20 },
  }).array('files', 20);
}

/** Formats the image editor can write (canvas exports + safe raster round-trips). */
const IMAGE_EDIT_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif']);

function singleUpload(maxMb) {
  return multer({ storage, limits: { fileSize: maxMb * 1024 * 1024, files: 1 } }).single('file');
}

function moveInto(tempPath, finalPath) {
  try {
    renameSync(tempPath, finalPath);
  } catch {
    copyFileSync(tempPath, finalPath);
    rmSync(tempPath, { force: true });
  }
}

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
  upload()(req, res, async (err) => {
    if (err) {
      const error = err.code === 'LIMIT_FILE_SIZE'
        ? `File exceeds upload size limit of ${uploadLimitMb()} MB (change maxUploadMb in Settings)`
        : err.message;
      return res.status(400).json({ error });
    }
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });
    const asReference = req.body?.asReference === 'true' || req.body?.asReference === '1';
    const forceCategory = req.body?.category || null;
    const derivedFrom = req.body?.derivedFrom && MEDIA_ID_RE.test(String(req.body.derivedFrom)) && getMedia(String(req.body.derivedFrom))
      ? String(req.body.derivedFrom)
      : null;

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
        const asset = await ingest(f.path, f.originalname, { asReference, forceCategory, derivedFrom });
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
  const maxBytes = uploadLimitMb() * 1024 * 1024;
  const timeoutMs = Math.min(2 * 60 * 60 * 1000, Math.max(120000, Math.ceil(maxBytes / (1024 * 1024)) * 1000));
  try {
    const resp = await fetch(parsed, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return res.status(400).json({ error: `Download failed (HTTP ${resp.status})` });
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      return res.status(400).json({ error: 'URL returned HTML, not a media file. Download the file yourself and use Import.' });
    }
    const size = Number(resp.headers.get('content-length') || 0);
    if (size > maxBytes) return res.status(400).json({ error: `Remote file exceeds size limit of ${uploadLimitMb()} MB` });
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
  res.set('Cache-Control', 'no-store'); // edits must show up immediately
  res.sendFile(file); // express handles Range requests for <video>
});

router.get('/:id/thumb', (req, res) => {
  assertMediaId(req.params.id);
  const asset = getMedia(req.params.id);
  if (!asset?.thumb_rel) return res.status(404).json({ error: 'No thumbnail' });
  const file = join(DIRS.media, asset.thumb_rel);
  if (!existsSync(file)) return res.status(404).json({ error: 'Thumbnail missing' });
  res.set('Cache-Control', 'no-store');
  res.sendFile(file);
});

/* ---------------- image / thumbnail editing ---------------- */

/** Replace an image asset's pixels in place (image editor "Save changes"). Re-probes + regenerates the thumb. */
router.post('/:id/replace', (req, res) => {
  assertMediaId(req.params.id);
  const asset = getMedia(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Media not found' });
  if (asset.kind !== 'image' && asset.category !== 'image') {
    return res.status(400).json({ error: 'Only image assets can be replaced. Use "Edit thumbnail" for videos.' });
  }
  singleUpload(uploadLimitMb())(req, res, async (err) => {
    if (err) {
      const error = err.code === 'LIMIT_FILE_SIZE'
        ? `File exceeds upload size limit of ${uploadLimitMb()} MB`
        : err.message;
      return res.status(400).json({ error });
    }
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'No file uploaded' });
    const ext = extname(f.originalname).toLowerCase().replace('.', '');
    if (!IMAGE_EDIT_EXT.has(ext)) {
      rmSync(f.path, { force: true });
      return res.status(400).json({ error: `Unsupported image format .${ext}` });
    }
    const rel = join('files', `${asset.id}.${ext}`);
    const finalPath = join(DIRS.media, rel);
    const oldPath = join(DIRS.media, asset.rel_path);
    const oldThumbPath = asset.thumb_rel ? join(DIRS.media, asset.thumb_rel) : null;
    try {
      moveInto(f.path, finalPath);
      if (oldPath !== finalPath) rmSync(oldPath, { force: true });
    } catch (e) {
      rmSync(f.path, { force: true });
      return res.status(500).json({ error: e.message });
    }

    const s = getSettings();
    let meta = null;
    let probeError = null;
    try {
      meta = (await probeMedia(resolveFfprobe(s), finalPath)).meta;
    } catch (e) {
      probeError = e.message;
    }
    asset.ext = `.${ext}`;
    asset.rel_path = rel;
    try { asset.size = statSync(finalPath).size; } catch { asset.size = 0; }
    if (meta) {
      asset.width = meta.width;
      asset.height = meta.height;
      asset.fps = meta.fps;
      asset.duration = meta.duration;
      asset.videoCodec = meta.videoCodec;
      asset.audioCodec = meta.audioCodec;
      asset.hasAudio = meta.hasAudio;
      asset.hasVideo = meta.hasVideo;
      asset.meta = meta;
      asset.kind = 'image';
      asset.probe_error = null;
    } else {
      asset.probe_error = probeError;
    }

    asset.thumb_rel = null;
    try {
      await generateThumbnail(resolveFfmpeg(s), finalPath, `${asset.id}.jpg`, 0);
      asset.thumb_rel = join('thumbs', `${asset.id}.jpg`);
      if (oldThumbPath && oldThumbPath !== join(DIRS.media, asset.thumb_rel)) rmSync(oldThumbPath, { force: true });
    } catch (e) {
      log({ stage: 'replace', status: 'ERROR', error: e.message, asset: asset.id });
      if (oldThumbPath) rmSync(oldThumbPath, { force: true }); // stale pixels — drop it
    }

    asset.edited_at = new Date().toISOString();
    saveMedia(asset);
    log({ stage: 'replace', status: 'PASS', asset: asset.id });
    res.json({ media: publicView(asset) });
  });
});

/** Save a custom thumbnail (thumbnail editor). Any media kind; written to thumbs/<id>.<ext>. */
router.put('/:id/thumb', (req, res) => {
  assertMediaId(req.params.id);
  const asset = getMedia(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Media not found' });
  singleUpload(64)(req, res, (err) => {
    if (err) {
      const error = err.code === 'LIMIT_FILE_SIZE' ? 'Thumbnail exceeds 64 MB limit' : err.message;
      return res.status(400).json({ error });
    }
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'No file uploaded' });
    const ext = extname(f.originalname).toLowerCase().replace('.', '');
    if (!IMAGE_EDIT_EXT.has(ext)) {
      rmSync(f.path, { force: true });
      return res.status(400).json({ error: `Unsupported image format .${ext}` });
    }
    mkdirSync(DIRS.mediaThumbs, { recursive: true });
    const rel = join('thumbs', `${asset.id}.${ext}`);
    const finalPath = join(DIRS.media, rel);
    const oldThumbPath = asset.thumb_rel ? join(DIRS.media, asset.thumb_rel) : null;
    try {
      moveInto(f.path, finalPath);
      if (oldThumbPath && oldThumbPath !== finalPath) rmSync(oldThumbPath, { force: true });
    } catch (e) {
      rmSync(f.path, { force: true });
      return res.status(500).json({ error: e.message });
    }
    asset.thumb_rel = rel;
    asset.thumb_edited = true;
    asset.edited_at = new Date().toISOString();
    saveMedia(asset);
    log({ stage: 'thumb', status: 'PASS', asset: asset.id });
    res.json({ media: publicView(asset) });
  });
});

/* ---------------- extract audio / frames / cut / convert ---------------- */

/** Parse "90" | "1:30" | "01:02:03.5" → seconds. Throws on garbage. */
function parseTimecode(v) {
  if (v == null || v === '') throw new PathError('Time required');
  const s = String(v).trim();
  if (!/^\d{1,3}(:\d{1,2}){0,2}(\.\d{1,3})?$/.test(s)) {
    throw new PathError(`Invalid time "${v}" — use seconds or HH:MM:SS.mmm`);
  }
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new PathError(`Invalid time "${v}"`);
  }
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return sec;
}

function evenDim(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < 16 || v > 7680) {
    throw new PathError('Width/height must be 16–7680');
  }
  return v % 2 === 0 ? v : v + 1;
}

async function saveDerivedAsset(outPath, source, { originalName, categoryOverride = null, tags = [], probeError = null }) {
  const s = getSettings();
  const id = nextMediaId();
  const ext = extname(outPath).toLowerCase() || '.mp4';
  const rel = join('files', `${id}${ext}`);
  const finalPath = join(DIRS.media, rel);
  try {
    const { renameSync } = await import('fs');
    renameSync(outPath, finalPath);
  } catch {
    const { copyFileSync } = await import('fs');
    copyFileSync(outPath, finalPath);
    rmSync(outPath, { force: true });
  }

  let meta = null;
  let pe = probeError;
  if (!pe) {
    try {
      meta = (await probeMedia(resolveFfprobe(s), finalPath)).meta;
    } catch (err) {
      pe = err.message;
    }
  }

  const safe = safeFilename(originalName);
  const asset = {
    id,
    filename: safe.replace(/\.[^.]+$/, '') || id,
    original_filename: originalName,
    ext,
    category: categoryOverride || source.category,
    kind: meta?.category || source.kind,
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
    probe_error: pe,
    purpose: source.purpose,
    rights_status: source.rights_status, // inherit — refs stay refs
    tags: [...new Set([...(source.tags || []), ...tags])].slice(0, 30),
    derived_from: source.id,
    created_at: new Date().toISOString(),
    rel_path: rel,
    thumb_rel: null,
  };

  if (asset.hasVideo || asset.kind === 'image') {
    try {
      await generateThumbnail(
        resolveFfmpeg(s),
        finalPath,
        `${id}.jpg`,
        asset.kind === 'image' ? 0 : Math.min(0.5, (asset.duration || 1) / 2)
      );
      asset.thumb_rel = join('thumbs', `${id}.jpg`);
    } catch (err) {
      log({ stage: 'thumb', status: 'ERROR', error: err.message, asset: id });
    }
  }

  saveMedia(asset);
  return asset;
}

/** Cut [start, end) from a video/audio asset into a new library item. */
router.post('/:id/cut', async (req, res) => {
  assertMediaId(req.params.id);
  const asset = getMedia(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Media not found' });
  if (!asset.hasVideo && !asset.hasAudio && asset.kind === 'image') {
    return res.status(400).json({ error: 'Cannot cut an image' });
  }
  const s = getSettings();
  let start;
  let end;
  try {
    start = parseTimecode(req.body?.start);
    end = parseTimecode(req.body?.end);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const total = asset.duration || 0;
  if (!(start >= 0)) return res.status(400).json({ error: 'Start must be >= 0' });
  if (!(end > start)) return res.status(400).json({ error: 'End must be after Start' });
  if (total > 0 && start >= total) {
    return res.status(400).json({ error: `Start is past end of media (${total.toFixed(1)}s)` });
  }
  if (total > 0 && end > total + 0.05) {
    return res.status(400).json({ error: `End exceeds media duration (${total.toFixed(1)}s)` });
  }
  const segLen = end - start;
  if (segLen < 0.1) return res.status(400).json({ error: 'Segment must be at least 0.1s' });

  const precise = req.body?.mode === 'precise';
  const ffmpeg = resolveFfmpeg(s);
  if (!ffmpeg) return res.status(500).json({ error: 'FFmpeg not found' });

  const src = join(DIRS.media, asset.rel_path);
  const isAudioOnly = !asset.hasVideo;
  // copy mode keeps the source container (instant remux); precise re-encodes to mp4/m4a
  const outExt = isAudioOnly
    ? '.m4a'
    : precise
      ? (asset.hasVideo ? '.mp4' : '.m4a')
      : (asset.ext && /^\.[a-z0-9]{2,5}$/.test(asset.ext) ? asset.ext : '.mp4');
  const outPath = join(DIRS.mediaFiles, `cut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${outExt}`);

  const argv = ['-y'];
  if (!precise) {
    // fast path: seek before input + stream copy (keyframe-aligned; instant on multi-GB files)
    argv.push('-ss', String(start.toFixed(3)), '-i', src, '-t', String(segLen.toFixed(3)), '-c', 'copy');
    if (asset.hasVideo && !isAudioOnly) argv.push('-avoid_negative_ts', 'make_zero');
  } else {
    argv.push('-ss', String(start.toFixed(3)), '-i', src, '-t', String(segLen.toFixed(3)));
    if (asset.hasVideo && !isAudioOnly) {
      argv.push(
        '-c:v', s.export?.videoCodec || 'libx264',
        '-preset', 'veryfast',
        '-crf', String(s.export?.crf ?? 20),
        '-pix_fmt', 'yuv420p'
      );
    }
    if (asset.hasAudio) {
      argv.push('-c:a', s.export?.audioCodec || 'aac', '-b:a', String(s.export?.audioBitrate || '192k'));
    } else {
      argv.push('-an');
    }
    if (outExt === '.mp4' || outExt === '.m4a' || outExt === '.mov') argv.push('-movflags', '+faststart');
  }
  argv.push(outPath);
  // copy can be slow to finalize on huge inputs; re-encode bounded by job timeout
  const timeoutMs = precise
    ? Math.max(60_000, Math.min(s.jobTimeoutMs || 1_800_000, Math.ceil(segLen * 4000)))
    : Math.max(120_000, Math.min(600_000, Math.ceil(segLen * 2000) + 60_000));

  try {
    await run(ffmpeg, argv, { timeoutMs });
  } catch (err) {
    rmSync(outPath, { force: true });
    return res.status(500).json({ error: err.message });
  }
  if (!existsSync(outPath)) {
    return res.status(500).json({ error: 'Cut produced no output file' });
  }

  const mmss = (sec) => {
    const m = Math.floor(sec / 60);
    const r = Math.floor(sec % 60);
    return `${m}m${String(r).padStart(2, '0')}s`;
  };
  const base = (asset.filename || asset.id).replace(/\.[^.]+$/, '');
  try {
    const child = await saveDerivedAsset(outPath, asset, {
      originalName: `${base} [${mmss(start)}-${mmss(end)}]${outExt}`,
      tags: ['cut'],
    });
    log({ stage: 'cut', status: 'PASS', asset: child.id, from: start, to: end, mode: precise ? 'precise' : 'copy' });
    res.status(201).json({ media: publicView(child) });
  } catch (e) {
    rmSync(outPath, { force: true });
    res.status(500).json({ error: e.message });
  }
});

/** Convert a video/image to a new resolution (stretch | pad | crop), optional rotation first. */
router.post('/:id/convert', async (req, res) => {
  assertMediaId(req.params.id);
  const asset = getMedia(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Media not found' });
  if (asset.hasAudio && !asset.hasVideo && asset.kind !== 'image') {
    return res.status(400).json({ error: 'Audio-only assets have no resolution to convert' });
  }
  const s = getSettings();
  let w;
  let h;
  try {
    w = evenDim(req.body?.width);
    h = evenDim(req.body?.height);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const mode = ['stretch', 'pad', 'crop'].includes(req.body?.mode) ? req.body.mode : 'stretch';
  const rotateRaw = Number(req.body?.rotate ?? 0);
  const rotate = [0, 90, 180, 270].includes(rotateRaw) ? rotateRaw : 0;
  const ffmpeg = resolveFfmpeg(s);
  if (!ffmpeg) return res.status(500).json({ error: 'FFmpeg not found' });

  const src = join(DIRS.media, asset.rel_path);
  const isImage = asset.kind === 'image';
  const outExt = isImage ? '.png' : asset.ext && asset.ext !== '.mkv' ? asset.ext : '.mp4';
  const outPath = join(DIRS.mediaFiles, `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${outExt}`);

  // rotation first (transpose = lossless pixel rotate), then fit to WxH
  const rotFf =
    rotate === 90 ? 'transpose=1,' // 90° CW
    : rotate === 180 ? 'transpose=1,transpose=1,' // 180°
    : rotate === 270 ? 'transpose=2,' // 90° CCW
    : '';

  let vf;
  if (mode === 'pad') {
    vf = `${rotFf}scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  } else if (mode === 'crop') {
    vf = `${rotFf}scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
  } else {
    vf = `${rotFf}scale=${w}:${h},setsar=1`;
  }

  const argv = ['-y', '-i', src];
  if (isImage) {
    argv.push('-vf', vf, '-frames:v', '1', outPath);
  } else {
    argv.push(
      '-vf', vf,
      '-c:v', s.export?.videoCodec || 'libx264',
      '-preset', s.export?.preset || 'medium',
      '-crf', String(s.export?.crf ?? 20),
      '-pix_fmt', 'yuv420p'
    );
    if (asset.hasAudio) {
      argv.push('-c:a', s.export?.audioCodec || 'aac', '-b:a', String(s.export?.audioBitrate || '192k'));
    } else {
      argv.push('-an');
    }
    if (outExt === '.mp4' || outExt === '.mov') argv.push('-movflags', '+faststart');
    argv.push(outPath);
  }

  const dur = asset.duration || 0;
  const timeoutMs = isImage
    ? 120_000
    : Math.max(120_000, Math.min(s.jobTimeoutMs || 1_800_000, Math.ceil(dur * 3000) + 120_000));

  try {
    await run(ffmpeg, argv, { timeoutMs });
  } catch (err) {
    rmSync(outPath, { force: true });
    return res.status(500).json({ error: err.message });
  }
  if (!existsSync(outPath)) {
    return res.status(500).json({ error: 'Convert produced no output file' });
  }

  const base = (asset.filename || asset.id).replace(/\.[^.]+$/, '');
  try {
    const rotTag = rotate ? ` r${rotate}` : '';
    const child = await saveDerivedAsset(outPath, asset, {
      originalName: `${base} ${w}x${h}${rotTag}${outExt}`,
      categoryOverride: isImage ? 'image' : asset.category,
      tags: rotate ? ['convert', `rotate-${rotate}`] : ['convert'],
    });
    log({ stage: 'convert', status: 'PASS', asset: child.id, w, h, mode, rotate });
    res.status(201).json({ media: publicView(child) });
  } catch (e) {
    rmSync(outPath, { force: true });
    res.status(500).json({ error: e.message });
  }
});

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
