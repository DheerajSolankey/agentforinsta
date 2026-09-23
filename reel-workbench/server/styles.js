import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { SHARED_DIR } from './config.js';
import { DIRS, ensureDirs } from './store.js';

/**
 * Styles = simple JSON recipe files.
 *   built-ins: shared/builtin-styles.json (read-only)
 *   user:      data/styles/*.json        (CRUD)
 * Templates (narrative structure, separate concept): shared/builtin-templates.json
 */

const USER_STYLE_EXT = '.json';

function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'style'
  );
}

export function loadBuiltinStyles() {
  const file = join(SHARED_DIR, 'builtin-styles.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  return (data.styles || []).map((s) => ({ ...s, builtin: true, locked: true }));
}

export function loadTemplates() {
  const file = join(SHARED_DIR, 'builtin-templates.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  return data.templates || [];
}

export function listUserStyles() {
  ensureDirs();
  if (!existsSync(DIRS.styles)) return [];
  return readdirSync(DIRS.styles)
    .filter((f) => f.endsWith(USER_STYLE_EXT))
    .map((f) => {
      try {
        const style = JSON.parse(readFileSync(join(DIRS.styles, f), 'utf8'));
        return { ...style, file: f, builtin: false };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function listAllStyles() {
  return [...loadBuiltinStyles(), ...listUserStyles()];
}

export function userStyleFile(idOrFile) {
  const base = String(idOrFile).replace(/\.json$/, '');
  if (!/^[a-z0-9-]{1,80}$/.test(base)) throw new Error(`Invalid style id: ${idOrFile}`);
  return join(DIRS.styles, `${base}${USER_STYLE_EXT}`);
}

export function getUserStyle(idOrFile) {
  const file = userStyleFile(idOrFile);
  if (!existsSync(file)) return null;
  return { ...JSON.parse(readFileSync(file, 'utf8')), file: `${String(idOrFile).replace(/\.json$/, '')}.json`, builtin: false };
}

export function saveUserStyle(style) {
  ensureDirs();
  const name = String(style.name || '').trim();
  if (!name) throw new Error('Style name is required');
  const id = style.id ? slugify(style.id) : slugify(name);
  const record = {
    id,
    name,
    version: Number(style.version) || 1,
    description: String(style.description || ''),
    locked: !!style.locked,
    created_at: style.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pacing: style.pacing || {},
    cuts: style.cuts || {},
    transitions: style.transitions || [],
    motion: style.motion || {},
    captions: style.captions || {},
    typography: style.typography || {},
    audio: style.audio || {},
    visual: style.visual || {},
    structure: style.structure || {},
    notes: style.notes || [],
  };
  const file = userStyleFile(id);
  writeFileSync(file, JSON.stringify(record, null, 2));
  return { ...record, file: `${id}.json`, builtin: false };
}

export function deleteUserStyle(idOrFile) {
  const file = userStyleFile(idOrFile);
  if (!existsSync(file)) throw new Error('Style not found');
  rmSync(file, { force: true });
}

export function duplicateStyle(idOrFile, newName) {
  const src = idOrFile ? (isBuiltin(idOrFile) ? loadBuiltinStyles().find((s) => slugify(s.name) === slugify(idOrFile)) : getUserStyle(idOrFile)) : null;
  if (!src) throw new Error('Style not found');
  return saveUserStyle({
    ...src,
    id: undefined,
    name: newName || `${src.name} copy`,
    builtin: undefined,
    locked: false,
    version: 1,
    created_at: undefined,
  });
}

export function isBuiltin(idOrName) {
  const key = slugify(String(idOrName).replace(/\.json$/, ''));
  return loadBuiltinStyles().some((s) => slugify(s.name) === key || slugify(s.id || '') === key);
}

export function findStyle(ref) {
  if (!ref) return null;
  const key = String(ref);
  try {
    const user = getUserStyle(key.replace(/\.json$/, ''));
    if (user) return user;
  } catch {
    /* not a valid user-style id (e.g. display name with spaces) — fall through */
  }
  const builtin = loadBuiltinStyles().find(
    (s) => slugify(s.name) === slugify(key) || slugify(s.id || '') === slugify(key) || s.name === key
  );
  return builtin || null;
}
