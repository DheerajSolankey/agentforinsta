import { Router } from 'express';
import {
  listAllStyles, loadBuiltinStyles, listUserStyles, getUserStyle, saveUserStyle,
  deleteUserStyle, duplicateStyle, loadTemplates, findStyle, isBuiltin,
} from '../styles.js';
import { analyzeReference } from '../analyze.js';
import { getMedia } from '../store.js';
import { join } from 'path';
import { DIRS } from '../store.js';

const router = Router();

/* ---- styles ---- */

router.get('/styles', (_req, res) => {
  res.json({
    styles: listAllStyles().map((s) => ({ ...s, locked: s.builtin ? true : !!s.locked })),
    builtin_count: loadBuiltinStyles().length,
    user_count: listUserStyles().length,
  });
});

router.post('/styles', (req, res) => {
  try {
    const style = saveUserStyle(req.body || {});
    res.status(201).json({ style });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/styles/:id', (req, res) => {
  const id = String(req.params.id).replace(/\.json$/, '');
  const style = findStyle(id);
  if (!style) return res.status(404).json({ error: 'Style not found' });
  if (req.query.download === '1' || req.query.download === 'true') {
    const slug = String(style.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.json"`);
    return res.json(style);
  }
  res.json({ style });
});

router.patch('/styles/:id', (req, res) => {
  const id = String(req.params.id).replace(/\.json$/, '');
  if (isBuiltin(id)) return res.status(400).json({ error: 'Built-in styles are read-only. Duplicate it first.' });
  const existing = getUserStyle(id);
  if (!existing) return res.status(404).json({ error: 'Style not found' });
  if (existing.locked && req.body?.unlock !== true) {
    return res.status(400).json({ error: 'Style is locked. Unlock it first.' });
  }
  try {
    const style = saveUserStyle({ ...existing, ...req.body, id: existing.id || id });
    res.json({ style });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/styles/:id', (req, res) => {
  const id = String(req.params.id).replace(/\.json$/, '');
  if (isBuiltin(id)) return res.status(400).json({ error: 'Built-in styles cannot be deleted' });
  try {
    deleteUserStyle(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post('/styles/:id/duplicate', (req, res) => {
  const id = String(req.params.id).replace(/\.json$/, '');
  try {
    const style = duplicateStyle(id, req.body?.name);
    res.status(201).json({ style });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Import a pasted/uploaded style JSON. */
router.post('/styles/import', (req, res) => {
  const raw = req.body?.style || req.body;
  if (!raw || typeof raw !== 'object' || !raw.name) return res.status(400).json({ error: 'Style JSON with a "name" is required' });
  try {
    const style = saveUserStyle({ ...raw, locked: false, builtin: undefined });
    res.status(201).json({ style });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ---- templates ---- */

router.get('/templates', (_req, res) => {
  res.json({ templates: loadTemplates() });
});

/* ---- reference analysis (local FFmpeg → draft style) ---- */

router.post('/analyze', async (req, res) => {
  const mediaId = String(req.body?.mediaId || '');
  const asset = getMedia(mediaId);
  if (!asset) return res.status(404).json({ error: 'Media not found' });
  const name = String(req.body?.name || '').trim() || `Style from ${asset.filename}`;
  try {
    const style = await analyzeReference(join(DIRS.media, asset.rel_path), { name });
    res.json({ style });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
