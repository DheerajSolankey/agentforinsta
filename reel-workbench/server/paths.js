import { existsSync, realpathSync } from 'fs';
import { isAbsolute, join, normalize, resolve, sep } from 'path';
import { DATA_DIR } from './config.js';

export class PathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathError';
  }
}

/** True if the string contains any C0/C1 control character (incl. NUL) or DEL. */
export function hasControlChars(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127 || (c >= 0x80 && c <= 0x9f)) return true;
  }
  return false;
}

/**
 * Resolve a user-supplied *relative* path strictly inside `root`.
 * Rejects absolute paths, traversal, control chars and (when the target exists) symlink escapes.
 */
export function resolveInRoot(root, relative) {
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new PathError('Path is required');
  }
  if (hasControlChars(relative)) throw new PathError('Path contains illegal characters');
  if (isAbsolute(relative)) throw new PathError('Absolute paths are not allowed');
  const cleaned = normalize(relative).replace(/^([/\\])+/, '');
  if (cleaned === '..' || cleaned.startsWith(`..${sep}`) || cleaned.includes(`..${sep}`)) {
    throw new PathError('Path traversal is not allowed');
  }
  const rootResolved = resolve(root);
  const full = resolve(rootResolved, cleaned);
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
    throw new PathError('Path escapes its root directory');
  }
  if (existsSync(full)) {
    const realRoot = existsSync(rootResolved) ? realpathSync(rootResolved) : rootResolved;
    const realFull = realpathSync(full);
    if (realFull !== realRoot && !realFull.startsWith(realRoot + sep)) {
      throw new PathError('Resolved path escapes its root directory');
    }
  }
  return full;
}

export function dataPath(...parts) {
  return resolveInRoot(DATA_DIR, join(...parts));
}

export function assertInsideData(absolutePath, label = 'path') {
  if (typeof absolutePath !== 'string' || !absolutePath) throw new PathError(`${label} is required`);
  if (hasControlChars(absolutePath)) throw new PathError(`${label} contains illegal characters`);
  const root = resolve(DATA_DIR);
  const full = resolve(absolutePath);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new PathError(`${label} must be inside the application data directory`);
  }
  return full;
}

const ILLEGAL_FILE_CHARS = '<>:"/\\|?*';

export function safeFilename(name, fallback = 'file') {
  let base = '';
  const s = String(name == null ? '' : name) || fallback;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c === 127 || ILLEGAL_FILE_CHARS.includes(ch)) base += '_';
    else base += ch;
  }
  base = base.trim().replace(/\s+/g, ' ').slice(0, 120);
  return base || fallback;
}

export const PROJECT_ID_RE = /^project-\d{3,6}$/;
export const MEDIA_ID_RE = /^media-\d{4,8}$/;
export const JOB_ID_RE = /^job-\d{3,8}$/;

export function assertProjectId(id) {
  if (!PROJECT_ID_RE.test(String(id))) throw new PathError(`Invalid project id: ${id}`);
  return id;
}
export function assertMediaId(id) {
  if (!MEDIA_ID_RE.test(String(id))) throw new PathError(`Invalid media id: ${id}`);
  return id;
}
export function assertJobId(id) {
  if (!JOB_ID_RE.test(String(id))) throw new PathError(`Invalid job id: ${id}`);
  return id;
}
