import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadNiche() {
  const p = join(ROOT, 'config', 'niche.json');
  if (!existsSync(p)) return { stockKeywords: {}, hashtags: {}, cta: [] };
  return JSON.parse(readFileSync(p, 'utf8'));
}
