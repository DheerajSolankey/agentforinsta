import { Router } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import { assertProjectId } from '../paths.js';
import { getProject, projectDir, readTimeline } from '../store.js';
import { requestRender, renderStatus, cancelRender, activeRenders } from '../queue.js';
import { runQc } from '../qc.js';

const router = Router();

router.post('/projects/:id/render', async (req, res) => {
  assertProjectId(req.params.id);
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const quality = req.body?.quality === 'preview' ? 'preview' : 'final';
  try {
    const result = await requestRender(project.id, quality);
    res.status(202).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:id/render', (req, res) => {
  assertProjectId(req.params.id);
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({
    job: project.renderJob || null,
    qc: project.last_qc || null,
    has_preview: existsSync(join(projectDir(project.id), 'previews', 'preview.mp4')),
    has_final: existsSync(join(projectDir(project.id), 'exports', 'final.mp4')),
  });
});

router.post('/projects/:id/render/cancel', (req, res) => {
  assertProjectId(req.params.id);
  res.json(cancelRender(req.params.id));
});

/** Re-run QC on an existing final render. */
router.post('/projects/:id/qc', async (req, res) => {
  assertProjectId(req.params.id);
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const file = join(projectDir(project.id), 'exports', 'final.mp4');
  if (!existsSync(file)) return res.status(404).json({ error: 'No final render yet' });
  const qc = await runQc(project.id, file, { expectDuration: project.duration || null });
  const p = getProject(project.id);
  p.last_qc = qc;
  const { saveProject } = await import('../store.js');
  saveProject(p);
  res.json({ qc });
});

router.get('/renders', (_req, res) => {
  res.json(activeRenders());
});

export default router;
