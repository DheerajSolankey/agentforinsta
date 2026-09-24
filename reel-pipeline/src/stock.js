import axios from 'axios';
import { createWriteStream, mkdirSync, existsSync, statSync, readFileSync, readdirSync } from 'fs';
import { join, dirname, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import { loadNiche } from './niche.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STOCK_DIR = join(ROOT, 'stock');
const WORKBENCH_ROOT = process.env.WORKBENCH_ROOT || '../reel-workbench';
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi']);

export function hasPexelsKey() {
  return Boolean(process.env.PEXELS_API_KEY?.trim());
}

function workbenchPort() {
  const settingsPath = join(ROOT, WORKBENCH_ROOT, 'data', 'settings.json');
  try {
    if (existsSync(settingsPath)) {
      return JSON.parse(readFileSync(settingsPath, 'utf8')).port || 4173;
    }
  } catch { /* default */ }
  return 4173;
}

async function pexelsSearch(query, perPage) {
  const key = process.env.PEXELS_API_KEY;
  if (!key?.trim()) {
    throw new Error(
      'Pexels optional/not configured. Drop your own clips into stock/ then run: node src/index.js import-stock'
    );
  }
  const { data } = await axios.get('https://api.pexels.com/videos/search', {
    params: { query, per_page: perPage, orientation: 'portrait', size: 'medium' },
    headers: { Authorization: key.trim() },
    timeout: 20000,
  });
  return data.videos || [];
}

function pickBestFile(video) {
  const files = video.video_files || [];
  const sorted = [...files].sort((a, b) => {
    const score = (f) => {
      const h = f.height || 0;
      const w = f.width || 0;
      const ratio = w && h ? Math.abs(w / h - 9 / 16) : 1;
      return Math.abs(h - 1920) / 1000 + ratio;
    };
    return score(a) - score(b);
  });
  return sorted[0] || null;
}

async function download(url, dest) {
  const resp = await axios.get(url, { responseType: 'stream', timeout: 60000 });
  await pipeline(resp.data, createWriteStream(dest));
}

/** Optional Pexels fetch. Skips cleanly if key missing. */
export async function fetchStock(keyword, count = 5) {
  if (!hasPexelsKey()) {
    console.log('Pexels not configured (optional).');
    console.log('Your path: put movie/cinematic clips in stock/ → run: node src/index.js import-stock');
    return [];
  }

  const niche = loadNiche();
  let query = keyword;
  if (!query) {
    const pool = Object.values(niche.stockKeywords || {}).flat();
    query = pool[Math.floor(Math.random() * pool.length)] || 'cinematic motivation';
  }

  mkdirSync(STOCK_DIR, { recursive: true });
  console.log(`Pexels search: "${query}" × ${count}`);

  const videos = await pexelsSearch(query, count);
  if (!videos.length) {
    console.log('No results.');
    return [];
  }

  const saved = [];
  for (const v of videos) {
    const file = pickBestFile(v);
    if (!file?.link) continue;
    const id = `pexels-${v.id}`;
    const dest = join(STOCK_DIR, `${id}.mp4`);
    if (existsSync(dest) && statSync(dest).size > 0) {
      console.log(`  = skip (exists) ${id}`);
      saved.push({ id, path: dest, source: 'pexels' });
      continue;
    }
    try {
      await download(file.link, dest);
      console.log(`  ✓ ${id} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
      saved.push({ id, path: dest, source: 'pexels' });
    } catch (err) {
      console.error(`  ✗ ${id}: ${err.message}`);
    }
  }

  await importIntoWorkbench(saved, 'stock');
  return saved;
}

/**
 * Import local files from stock/ (or a given folder) into reel-workbench.
 * Use this for your own movie/cinematic clips — no Pexels needed.
 */
export async function importLocalStock(dir = STOCK_DIR) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`Created empty folder: ${dir}`);
    console.log('Drop .mp4/.mov files there, then re-run import-stock.');
    return [];
  }

  const files = readdirSync(dir).filter((f) => VIDEO_EXT.has(extname(f).toLowerCase()));
  if (!files.length) {
    console.log(`No video files in ${dir}`);
    console.log('Drop your clips there (.mp4/.mov), then: node src/index.js import-stock');
    return [];
  }

  const items = files.map((f) => ({
    id: basename(f).replace(/\.[^.]+$/, ''),
    path: join(dir, f),
    source: 'local',
  }));

  console.log(`Importing ${items.length} local clip(s) from ${dir}…`);
  return importIntoWorkbench(items, 'OWNED');
}

async function importIntoWorkbench(items, rightsTag) {
  if (!items.length) return [];
  const port = workbenchPort();
  const base = `http://127.0.0.1:${port}/api/media`;
  console.log(`Importing into reel-workbench on :${port}…`);

  const imported = [];
  for (const item of items) {
    try {
      const form = new FormData();
      const buf = readFileSync(item.path);
      const filename = `${item.id}${extname(item.path) || '.mp4'}`;
      form.append('files', new Blob([buf], { type: 'video/mp4' }), filename);
      form.append('category', 'video');
      const resp = await fetch(base, { method: 'POST', body: form });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.error(`  ✗ ${item.id}: ${body.error || resp.status} (is reel-workbench running? npm start)`);
        continue;
      }
      const asset = body.media?.[0];
      if (asset) {
        const rights = rightsTag === 'OWNED' ? 'OWNED' : 'LICENSED';
        await fetch(`${base}/${asset.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rights_status: rights,
            purpose: 'production',
            tags: [item.source || 'local', rights.toLowerCase()],
          }),
        });
        console.log(`  ✓ ${asset.id} (${rights}) — ${filename}`);
        imported.push(asset);
      }
    } catch (err) {
      console.error(`  ✗ ${item.id}: ${err.message}`);
    }
  }
  return imported;
}
