import express from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import { PUBLIC_DIR, SHARED_DIR } from './config.js';
import { ensureDirs } from './store.js';
import { PathError } from './paths.js';
import { TimelineError } from '../shared/timeline-ops.js';
import { RenderError } from './renderer.js';
import { formatUserError, log } from './logger.js';
import projectsRouter from './api/projects.js';
import mediaRouter from './api/media.js';
import stylesRouter from './api/styles.js';
import renderRouter from './api/render.js';
import settingsRouter from './api/settings.js';
import { listMedia, getMedia, listProjects } from './store.js';

export function createApp() {
  ensureDirs();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '20mb' }));

  // static SPA + shared modules for the client (no-cache so UI fixes show immediately)
  app.use((req, res, next) => {
    if (/\.(js|css|html|json)$/.test(req.path) || req.path === '/') {
      res.set('Cache-Control', 'no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
    }
    next();
  });
  app.use(express.static(PUBLIC_DIR));
  app.use('/shared', express.static(SHARED_DIR));

  app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'reel-workbench' }));

  app.use('/api/projects', projectsRouter);
  app.use('/api/media', mediaRouter);
  app.use('/api', stylesRouter);
  app.use('/api', renderRouter);
  app.use('/api', settingsRouter);

  // lightweight home payload (media count etc.) — no dashboard charts
  app.get('/api/summary', (_req, res) => {
    const media = listMedia();
    const projects = listProjects();
    res.json({
      projects: projects.length,
      media: media.length,
      references: media.filter((m) => m.category === 'reference' || m.rights_status === 'REFERENCE_ONLY').length,
      rendering: projects.filter((p) => p.renderJob && ['queued', 'processing'].includes(p.renderJob.status)).length,
      recent: projects.slice(0, 5).map((p) => p.id),
    });
  });

  // SPA fallback
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(join(PUBLIC_DIR, 'index.html'));
  });

  // errors
  app.use((err, _req, res, _next) => {
    if (err instanceof PathError || err instanceof TimelineError) {
      return res.status(400).json({ error: err.message, code: err.code || 'BAD_REQUEST' });
    }
    if (err instanceof RenderError) {
      return res.status(422).json({ error: err.message, stage: err.stage, detail: err.detail });
    }
    if (err?.name === 'MulterError') {
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large' : err.message });
    }
    log({ scope: 'api', status: 'ERROR', error: String(err?.message || err), stack: err?.stack?.slice(0, 2000) });
    res.status(500).json({ error: formatUserError(err), detail: process.env.REEL_STUDIO_VERBOSE ? String(err?.stack || '') : undefined });
  });

  return app;
}
