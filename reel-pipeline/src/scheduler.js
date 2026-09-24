import cron from 'node-cron';
import { loadHistory, canPostToday } from './history.js';
import { loadQueue } from './queue.js';
import { InstagramPublisher } from './publisher.js';
import { generateCaption } from './caption.js';
import { markPosted } from './history.js';
import { loadQueue as lq, saveQueue } from './queue.js';

async function runPostCycle() {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const userId = process.env.INSTAGRAM_USER_ID;
  if (!token || !userId) {
    console.error('Missing INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_USER_ID');
    return;
  }

  const maxPerDay = Number(process.env.MAX_POSTS_PER_DAY) || 2;
  const warmupMax = Number(process.env.WARMUP_FIRST_WEEK_MAX) || 0;
  const minGap = Number(process.env.MIN_GAP_MINUTES) || 180;
  const history = loadHistory();

  // Simple warm-up: if account has < 7 posted entries, cap lower
  const effectiveMax = history.posted.length < 7 && warmupMax > 0
    ? Math.min(maxPerDay, warmupMax)
    : maxPerDay;

  if (!canPostToday(history, effectiveMax, minGap)) {
    console.log('[scheduler] limit/gap — skip');
    return;
  }

  const q = loadQueue();
  if (!q.pending.length) {
    console.log('[scheduler] queue empty — skip');
    return;
  }

  const publisher = new InstagramPublisher(token, userId);
  const item = q.pending[0];

  // Peek without removing until success path handles drain via markPosted + re-read
  try {
    const caption = item.caption || generateCaption(item);
    const mediaId = await publisher.publishReel(item.videoPath, caption, item.coverPath);

    // remove from pending
    const fresh = lq();
    fresh.pending = fresh.pending.filter((x) => x.projectId !== item.projectId);
    saveQueue(fresh);

    markPosted(loadHistory(), item, mediaId);
    console.log(`[scheduler] posted ${item.projectId} → ${mediaId}`);
  } catch (err) {
    console.error(`[scheduler] failed ${item.projectId}: ${err.message}`);
    const fresh = lq();
    const failedItem = fresh.pending.find((x) => x.projectId === item.projectId);
    if (failedItem) {
      fresh.pending = fresh.pending.filter((x) => x.projectId !== item.projectId);
      fresh.failed = fresh.failed || [];
      fresh.failed.push({ ...failedItem, error: err.message, failedAt: new Date().toISOString() });
      saveQueue(fresh);
    }
  }
}

export function startScheduler() {
  const expr = process.env.POST_SCHEDULE || '0 10,19 * * *';
  if (!cron.validate(expr)) {
    throw new Error(`Invalid POST_SCHEDULE cron: ${expr}`);
  }

  console.log(`Scheduler armed: "${expr}" (${process.env.TIMEZONE || 'Asia/Kolkata'})`);
  console.log(`Max/day=${process.env.MAX_POSTS_PER_DAY || 2} gap=${process.env.MIN_GAP_MINUTES || 180}m`);

  cron.schedule(expr, () => {
    runPostCycle().catch((e) => console.error('[scheduler]', e.message));
  }, { timezone: process.env.TIMEZONE || 'Asia/Kolkata' });

  console.log('Running. Press Ctrl+C to stop.');
  // keep process alive
  setInterval(() => {}, 1 << 30);
}
