import axios from 'axios';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const URLS_FILE = join(ROOT, 'config', 'reference-urls.txt');
const BOARD_FILE = join(ROOT, 'config', 'research-board.json');
const INBOX_DIR = join(ROOT, 'references', 'inbox');

function loadUrls() {
  if (!existsSync(URLS_FILE)) return [];
  return readFileSync(URLS_FILE, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('instagram.com'));
}

function loadBoard() {
  if (!existsSync(BOARD_FILE)) return [];
  try {
    return JSON.parse(readFileSync(BOARD_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function shortCode(url) {
  const m = url.match(/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/**
 * Research-only discovery: fetch oEmbed metadata for curated URLs.
 * Does NOT download video. Manual igexport downloads go to references/inbox/
 * and are imported into reel-workbench as REFERENCE_ONLY.
 */
export async function discover() {
  const urls = loadUrls();
  if (!urls.length) {
    console.log('No Instagram URLs in config/reference-urls.txt');
    return [];
  }

  mkdirSync(INBOX_DIR, { recursive: true });
  const board = loadBoard();
  const seen = new Set(board.map((b) => b.url));

  console.log(`Discovering ${urls.length} URL(s)…`);

  for (const url of urls) {
    if (seen.has(url)) continue;
    const code = shortCode(url);
    const entry = {
      url,
      shortCode: code,
      fetchedAt: new Date().toISOString(),
      status: 'pending',
      author: null,
      title: null,
      thumbnail: null,
      error: null,
      note: 'Reference only — never render. Download manually to references/inbox/ if needed for Analyze.',
    };

    try {
      const oembed = 'https://graph.facebook.com/v19.0/instagram_oembed';
      const { data } = await axios.get(oembed, {
        params: { url, omit_script: true, access_token: process.env.INSTAGRAM_ACCESS_TOKEN || 'embed' },
        timeout: 15000,
      });
      entry.author = data.author_name || null;
      entry.title = data.title || null;
      entry.thumbnail = data.thumbnail_url || null;
      entry.status = 'ok';
    } catch (err) {
      // Fallback: public oembed endpoint (no token)
      try {
        const { data } = await axios.get('https://graph.facebook.com/v19.0/instagram_oembed', {
          params: { url, omit_script: true },
          timeout: 15000,
        });
        entry.author = data.author_name || null;
        entry.title = data.title || null;
        entry.thumbnail = data.thumbnail_url || null;
        entry.status = 'ok';
      } catch (err2) {
        entry.status = 'error';
        entry.error = err2.response?.data?.error?.message || err2.message;
      }
    }

    board.push(entry);
    seen.add(url);
    console.log(`  ${entry.status === 'ok' ? '✓' : '✗'} ${code || url} — ${entry.title || entry.error || ''}`);
  }

  writeFileSync(BOARD_FILE, JSON.stringify(board, null, 2));
  console.log(`\nResearch board: ${board.length} entries → config/research-board.json`);
  console.log(`Drop manual downloads into: references/inbox/`);
  return board;
}
