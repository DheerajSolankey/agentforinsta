import { getProject, saveProject } from './store.js';
import { renderProject, RenderError } from './renderer.js';
import { runQc } from './qc.js';
import { log, formatUserError } from './logger.js';

/**
 * Minimal personal-tool queue: one render at a time, state kept in project.json.
 * No job database — the project file IS the status.
 */

let active = null; // { projectId, controller }
const waiting = []; // [{ projectId, quality, resolve, reject }]

export function renderStatus(projectId) {
  const p = getProject(projectId);
  return p?.renderJob || null;
}

export function requestRender(projectId, quality = 'final') {
  const project = getProject(projectId);
  if (!project) return { status: 'error', error: 'Project not found' };

  if (project.renderJob && (project.renderJob.status === 'processing' || project.renderJob.status === 'queued')) {
    if (project.renderJob.projectId === projectId || active?.projectId === projectId || waiting.some((w) => w.projectId === projectId)) {
      return { status: 'already_running', job: project.renderJob };
    }
  }

  const job = {
    id: `${projectId}-${Date.now()}`,
    projectId,
    quality,
    status: 'queued',
    progress: 0,
    stage: 'queued',
    message: 'Waiting for renderer…',
    error: null,
    outputs: null,
    startedAt: null,
    finishedAt: null,
  };
  project.renderJob = job;
  saveProject(project);

  return new Promise((resolve, reject) => {
    waiting.push({ projectId, quality, resolve, reject, jobId: job.id });
    // Resolve as soon as the job is queued (HTTP must not block behind other renders).
    resolve(job);
    pump();
  }).then((result) => ({ status: 'queued', job: result }));
}

function pump() {
  if (active || waiting.length === 0) return;
  const next = waiting.shift();
  void runOne(next);
}

async function runOne(entry) {
  const { projectId, quality, resolve, reject, jobId } = entry;
  const controller = new AbortController();
  active = { projectId, controller, jobId };

  const project = getProject(projectId);
  if (!project) {
    active = null;
    reject(new RenderError('Project not found.'));
    pump();
    return;
  }
  project.renderJob = {
    ...(project.renderJob || {}),
    id: jobId,
    projectId,
    quality,
    status: 'processing',
    progress: 0,
    stage: 'validate',
    message: 'Starting…',
    error: null,
    outputs: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  saveProject(project);

  try {
    const result = await renderProject({
      projectId,
      quality,
      signal: controller.signal,
      onProgress: ({ stage, overallPct, message }) => {
        const p = getProject(projectId);
        if (!p?.renderJob) return;
        p.renderJob.status = 'processing';
        p.renderJob.stage = stage;
        p.renderJob.progress = overallPct;
        p.renderJob.message = message || stage;
        saveProject(p);
      },
    });

    let qc = null;
    if (quality === 'final') {
      const p = getProject(projectId);
      p.renderJob.stage = 'qc';
      p.renderJob.message = 'Running quality control…';
      saveProject(p);
      qc = await runQc(projectId, result.outFile, {
        expectDuration: result.duration,
        expectUserAudio: result.hasUserAudio,
      });
    }

    const p = getProject(projectId);
    p.renderJob = {
      ...p.renderJob,
      status: 'completed',
      progress: 100,
      stage: 'done',
      message: 'Render complete',
      error: null,
      outputs: result.outputs,
      outRel: result.outRel,
      duration: result.duration,
      finishedAt: new Date().toISOString(),
    };
    p.status = quality === 'final' ? 'rendered' : p.status || 'draft';
    if (quality === 'final') {
      p.last_qc = qc;
      p.thumbnail = result.outputs.includes('thumbnail.jpg') ? 'exports/thumbnail.jpg' : p.thumbnail;
      p.duration = result.duration;
    } else {
      p.thumbnail = 'previews/preview-thumb.jpg';
      p.duration = result.duration;
    }
    if (!Array.isArray(p.renderHistory)) p.renderHistory = [];
    p.renderHistory.unshift({
      quality,
      qc: qc?.overall || null,
      duration: result.duration,
      outputs: result.outputs,
      finishedAt: p.renderJob.finishedAt,
      status: 'completed',
    });
    p.renderHistory = p.renderHistory.slice(0, 20);
    saveProject(p);
    log({ job: projectId, stage: 'queue', status: 'PASS', quality, qc: qc?.overall || null });
    return qc;
  } catch (err) {
    const p = getProject(projectId);
    if (p) {
      const cancelled = controller.signal.aborted;
      p.renderJob = {
        ...(p.renderJob || {}),
        status: cancelled ? 'cancelled' : 'failed',
        stage: p.renderJob?.stage || 'error',
        error: formatUserError(err),
        detail: err?.detail || String(err?.stderr || '').slice(-4000) || '',
        finishedAt: new Date().toISOString(),
      };
      if (!cancelled) p.status = 'failed';
      saveProject(p);
    }
    log({ job: projectId, stage: 'queue', status: 'FAIL', error: String(err?.message || err) });
    return null;
  } finally {
    active = null;
    pump();
  }
}

export function cancelRender(projectId) {
  if (active && active.projectId === projectId) {
    active.controller.abort();
    return { status: 'cancelling' };
  }
    const idx = waiting.findIndex((w) => w.projectId === projectId);
    if (idx >= 0) {
      const [entry] = waiting.splice(idx, 1);
      const p = getProject(projectId);
      if (p?.renderJob) {
        p.renderJob.status = 'cancelled';
        p.renderJob.finishedAt = new Date().toISOString();
        saveProject(p);
      }
      // Job promise already resolved when queued; cancellation is surfaced via project.renderJob.
      return { status: 'cancelled' };
    }
  return { status: 'not_running' };
}

export function activeRenders() {
  return {
    active: active ? { projectId: active.projectId } : null,
    queued: waiting.map((w) => ({ projectId: w.projectId, quality: w.quality })),
  };
}
