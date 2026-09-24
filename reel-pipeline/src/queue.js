import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QUEUE_FILE = join(ROOT, 'config', 'queue.json');
const WORKBENCH_DATA = () =>
  join(ROOT, process.env.WORKBENCH_ROOT || '../reel-workbench', 'data', 'projects');

export function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return { pending: [], posted: [], failed: [] };
  try {
    const q = JSON.parse(readFileSync(QUEUE_FILE, 'utf8'));
    return {
      pending: Array.isArray(q.pending) ? q.pending : [],
      posted: Array.isArray(q.posted) ? q.posted : [],
      failed: Array.isArray(q.failed) ? q.failed : [],
    };
  } catch {
    return { pending: [], posted: [], failed: [] };
  }
}

export function saveQueue(q) {
  mkdirSync(dirname(QUEUE_FILE), { recursive: true });
  writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));
}

export function resolveExportPaths(projectId) {
  const dir = join(WORKBENCH_DATA(), projectId);
  const videoPath = join(dir, 'exports', 'final.mp4');
  const thumbPath = join(dir, 'exports', 'thumbnail.jpg');
  const captionPath = join(dir, 'exports', 'caption.txt');
  const projectPath = join(dir, 'project.json');

  if (!existsSync(videoPath)) {
    throw new Error(`No render found: ${videoPath} (render final first in reel-workbench)`);
  }

  let caption = null;
  if (existsSync(captionPath)) {
    caption = readFileSync(captionPath, 'utf8').trim();
  }

  let projectName = projectId;
  let lastQc = null;
  if (existsSync(projectPath)) {
    try {
      const p = JSON.parse(readFileSync(projectPath, 'utf8'));
      projectName = p.name || projectId;
      lastQc = p.last_qc?.overall || null;
    } catch { /* ignore */ }
  }

  return {
    projectId,
    projectName,
    videoPath,
    coverPath: existsSync(thumbPath) ? thumbPath : null,
    caption,
    lastQc,
    queuedAt: new Date().toISOString(),
  };
}

export function addToQueue(projectId) {
  const q = loadQueue();
  if (q.pending.some((x) => x.projectId === projectId)) {
    console.log('Already pending.');
    return q;
  }
  if (q.posted.some((x) => x.projectId === projectId)) {
    throw new Error('Already posted — duplicate blocked');
  }
  const item = resolveExportPaths(projectId);
  q.pending.push(item);
  saveQueue(q);
  return q;
}

export function drainOne() {
  const q = loadQueue();
  if (!q.pending.length) return null;
  const item = q.pending.shift();
  saveQueue(q);
  return item;
}

export function listQueue() {
  const q = loadQueue();
  console.log(`Pending (${q.pending.length}):`);
  q.pending.forEach((x, i) => {
    console.log(`  ${i + 1}. ${x.projectId} — ${x.projectName || ''} QC=${x.lastQc || '-'}`);
  });
  if (q.failed.length) {
    console.log(`Failed (${q.failed.length}):`);
    q.failed.forEach((x) => console.log(`  ! ${x.projectId} — ${x.error || ''}`));
  }
  console.log(`Posted (${q.posted.length})`);
}

/** Workbench projects with exports/final.mp4 ready to queue. */
export function listReadyProjects() {
  const root = WORKBENCH_DATA();
  const q = loadQueue();
  const pendingIds = new Set(q.pending.map((x) => x.projectId));
  const postedIds = new Set(q.posted.map((x) => x.projectId));

  if (!existsSync(root)) {
    console.log(`No workbench projects at ${root}`);
    return [];
  }

  const ready = [];
  for (const name of readdirSync(root)) {
    const video = join(root, name, 'exports', 'final.mp4');
    if (!existsSync(video)) continue;
    let projectName = name;
    let lastQc = null;
    try {
      const p = JSON.parse(readFileSync(join(root, name, 'project.json'), 'utf8'));
      projectName = p.name || name;
      lastQc = p.last_qc?.overall || null;
    } catch { /* ignore */ }
    const state = pendingIds.has(name)
      ? 'PENDING'
      : postedIds.has(name)
        ? 'POSTED'
        : 'READY';
    ready.push({ id: name, projectName, lastQc, state });
    console.log(`  [${state}] ${name} — ${projectName} QC=${lastQc || '-'}`);
  }

  if (!ready.length) {
    console.log('No rendered finals yet. Open reel-workbench → Render final first.');
  } else {
    console.log('\nQueue one: node src/index.js queue add <projectId>');
  }
  return ready;
}
