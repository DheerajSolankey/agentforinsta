import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'config', 'posted-history.json');
const QUEUE_FILE = join(ROOT, 'config', 'queue.json');

export function loadHistory() {
  if (!existsSync(FILE)) return { posted: [], dailyCount: {}, lastDate: null };
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return { posted: [], dailyCount: {}, lastDate: null };
  }
}

function saveHistory(h) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(h, null, 2));
}

export function canPostToday(history, maxPerDay = 2, minGapMinutes = 0) {
  const today = new Date().toDateString();
  const count = history.lastDate === today ? history.dailyCount[today] || 0 : 0;
  if (count >= maxPerDay) return false;

  if (minGapMinutes > 0 && history.lastPostedAt) {
    const last = new Date(history.lastPostedAt).getTime();
    if (Date.now() - last < minGapMinutes * 60_000) return false;
  }
  return true;
}

export function markPosted(history, item, mediaId) {
  const today = new Date().toDateString();
  if (history.lastDate !== today) {
    history.lastDate = today;
    history.dailyCount = {};
  }
  history.dailyCount[today] = (history.dailyCount[today] || 0) + 1;
  history.lastPostedAt = new Date().toISOString();
  history.posted.push({
    projectId: item.projectId,
    mediaId,
    at: history.lastPostedAt,
  });
  saveHistory(history);

  // Move from pending → posted in queue file
  if (existsSync(QUEUE_FILE)) {
    try {
      const q = JSON.parse(readFileSync(QUEUE_FILE, 'utf8'));
      q.posted = q.posted || [];
      q.posted.push({ projectId: item.projectId, mediaId, at: history.lastPostedAt });
      writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));
    } catch { /* ignore */ }
  }
}
