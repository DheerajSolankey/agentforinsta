import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { DATA_DIR, DEFAULT_SETTINGS } from './config.js';
import { assertProjectId, safeFilename } from './paths.js';

/**
 * Plain JSON file store — no database.
 *   data/settings.json
 *   data/media/index.json  (+ files/, thumbs/)
 *   data/projects/<id>/project.json + timeline.json (+ inbox, styles, previews, exports)
 * Single process, synchronous atomic writes (tmp + rename).
 */

export const DIRS = {
  data: DATA_DIR,
  media: join(DATA_DIR, 'media'),
  mediaFiles: join(DATA_DIR, 'media', 'files'),
  mediaThumbs: join(DATA_DIR, 'media', 'thumbs'),
  projects: join(DATA_DIR, 'projects'),
  styles: join(DATA_DIR, 'styles'),
  work: join(DATA_DIR, 'work'),
  logs: join(DATA_DIR, 'logs'),
};

export function ensureDirs() {
  for (const dir of Object.values(DIRS)) mkdirSync(dir, { recursive: true });
}

function atomicWrite(file, data) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/* ---------------- settings ---------------- */

const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

export function getSettings() {
  ensureDirs();
  const saved = readJson(SETTINGS_FILE, {});
  return deepMerge(structuredClone(DEFAULT_SETTINGS), saved);
}

export function updateSettings(patch = {}) {
  const next = deepMerge(getSettings(), patch);
  atomicWrite(SETTINGS_FILE, next);
  return next;
}

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else base[k] = v;
  }
  return base;
}

/* ---------------- media index ---------------- */

const MEDIA_INDEX = join(DIRS.media, 'index.json');

export function listMedia() {
  ensureDirs();
  return readJson(MEDIA_INDEX, []);
}

export function getMedia(id) {
  return listMedia().find((m) => m.id === id) || null;
}

export function saveMedia(asset) {
  const list = listMedia();
  const idx = list.findIndex((m) => m.id === asset.id);
  if (idx === -1) list.unshift(asset);
  else list[idx] = asset;
  atomicWrite(MEDIA_INDEX, list);
  return asset;
}

export function saveMediaList(list) {
  atomicWrite(MEDIA_INDEX, list);
  return list;
}

export function deleteMedia(id) {
  const list = listMedia().filter((m) => m.id !== id);
  atomicWrite(MEDIA_INDEX, list);
}

export function nextMediaId() {
  const ids = listMedia()
    .map((m) => Number(String(m.id).replace('media-', '')))
    .filter(Number.isFinite);
  const next = (ids.length ? Math.max(...ids) : 0) + 1;
  return `media-${String(next).padStart(4, '0')}`;
}

/* ---------------- projects (one folder each) ---------------- */

export function projectDir(id) {
  assertProjectId(id);
  return join(DIRS.projects, id);
}

export function projectFile(id) {
  return join(projectDir(id), 'project.json');
}

export function timelineFile(id) {
  return join(projectDir(id), 'timeline.json');
}

export function ensureProjectDirs(id) {
  const dir = projectDir(id);
  for (const sub of ['', 'inbox', 'styles', 'previews', 'exports', 'assets']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return dir;
}

export function listProjects() {
  ensureDirs();
  if (!existsSync(DIRS.projects)) return [];
  const out = [];
  for (const entry of readdirSync(DIRS.projects)) {
    if (!/^project-\d{3,6}$/.test(entry)) continue;
    const p = readJson(join(DIRS.projects, entry, 'project.json'), null);
    if (p) out.push(p);
  }
  out.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  return out;
}

export function getProject(id) {
  try {
    return readJson(projectFile(id), null);
  } catch {
    return null;
  }
}

export function saveProject(project) {
  ensureProjectDirs(project.id);
  project.updated_at = new Date().toISOString();
  atomicWrite(projectFile(project.id), project);
  return project;
}

export function deleteProject(id) {
  assertProjectId(id);
  rmSync(projectDir(id), { recursive: true, force: true });
}

export function readTimeline(id) {
  return readJson(timelineFile(id), null);
}

export function writeTimeline(id, timeline) {
  ensureProjectDirs(id);
  atomicWrite(timelineFile(id), timeline);
  return timeline;
}

export function timelineMtime(id) {
  try {
    return statSync(timelineFile(id)).mtimeMs;
  } catch {
    return 0;
  }
}

export function nextProjectId() {
  ensureDirs();
  const ids = readdirSync(DIRS.projects)
    .filter((e) => /^project-\d{3,6}$/.test(e))
    .map((e) => Number(e.replace('project-', '')))
    .filter(Number.isFinite);
  const next = (ids.length ? Math.max(...ids) : 0) + 1;
  return `project-${String(next).padStart(3, '0')}`;
}

/** Create a fresh project with a default timeline. */
export function createProject({ name, width, height, fps, createTimeline }) {
  const id = nextProjectId();
  ensureProjectDirs(id);
  const now = new Date().toISOString();
  const timeline = createTimeline({ width, height, fps });
  const project = {
    id,
    name: name || `Reel ${id.replace('project-', '')}`,
    description: '',
    status: 'draft',
    created_at: now,
    updated_at: now,
    width,
    height,
    fps,
    duration: 0,
    style_id: null,
    style_name: null,
    template_id: null,
    thumbnail: null,
    media_ids: [],
    reference_ids: [],
    applied_style: null,
    renderJob: null,
    last_qc: null,
  };
  atomicWrite(projectFile(id), project);
  atomicWrite(timelineFile(id), timeline);
  return { project, timeline };
}

export function touchProject(id, patch = {}) {
  const p = getProject(id);
  if (!p) return null;
  Object.assign(p, patch);
  return saveProject(p);
}

export function mediaAbsolutePath(asset) {
  if (!asset || !asset.rel_path) return null;
  return join(DIRS.media, asset.rel_path);
}

export function thumbAbsolutePath(asset) {
  if (!asset || !asset.thumb_rel) return null;
  return join(DIRS.media, asset.thumb_rel);
}

export { safeFilename };
