import 'dotenv/config';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { discover } from './discovery.js';
import { fetchStock, importLocalStock, hasPexelsKey } from './stock.js';
import { InstagramPublisher } from './publisher.js';
import {
  loadQueue, addToQueue, listQueue, drainOne, saveQueue, listReadyProjects,
} from './queue.js';
import { generateCaption } from './caption.js';
import { startScheduler } from './scheduler.js';
import { checkAuth } from './igauth.js';
import { loadHistory, canPostToday, markPosted } from './history.js';

const HELP = `
reel-pipeline — Discover → Import → Queue → Publish

Commands:
  check-auth [refresh]     Verify Instagram token (refresh → long-lived)
  discover                 config/reference-urls.txt → research board
  import-stock [folder]    Import your clips from stock/ (or folder) → workbench
  stock [keyword] [n]      Optional Pexels download (only if PEXELS_API_KEY set)
  queue                    List pending / posted / failed
  queue ready              List rendered workbench projects you can queue
  queue add <projectId>    Queue a rendered project
  queue remove <projectId> Remove from pending
  post [n]                 Publish next n queued Reels (default 1)
  start                    Cron scheduler (default 10:00 & 19:00 IST)
  status                   Queue + daily limits + auth summary
  help                     This help

Flow:
  edit in reel-workbench → Render final → queue ready → queue add <id> → post
`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case 'check-auth':
      await checkAuth(args[0] === 'refresh' ? 'refresh' : 'check');
      break;

    case 'discover':
      await discover();
      break;

    case 'import-stock': {
      const folder = args[0];
      await importLocalStock(folder);
      break;
    }

    case 'stock': {
      if (!hasPexelsKey() && !args[0]) {
        await fetchStock(undefined, 5);
        break;
      }
      const keyword = /^\d+$/.test(args[0] || '') ? undefined : args[0];
      const n = /^\d+$/.test(args[0] || '') ? Number(args[0]) : Number(args[1]) || 5;
      await fetchStock(keyword, n);
      break;
    }

    case 'queue': {
      const sub = args[0];
      if (sub === 'add') {
        const projectId = args[1];
        if (!projectId) throw new Error('Usage: queue add <projectId>');
        addToQueue(projectId);
        console.log(`Queued ${projectId}`);
      } else if (sub === 'remove') {
        const projectId = args[1];
        if (!projectId) throw new Error('Usage: queue remove <projectId>');
        const q = loadQueue();
        q.pending = q.pending.filter((x) => x.projectId !== projectId);
        saveQueue(q);
        console.log(`Removed ${projectId}`);
      } else if (sub === 'ready') {
        listReadyProjects();
      } else {
        listQueue();
      }
      break;
    }

    case 'post': {
      const n = Number(args[0]) || 1;
      await postNext(n);
      break;
    }

    case 'start':
      startScheduler();
      break;

    case 'status':
      showStatus();
      break;

    case 'help':
    case undefined:
      console.log(HELP);
      break;

    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

async function postNext(n) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const userId = process.env.INSTAGRAM_USER_ID;
  if (!token || !userId) throw new Error('Missing INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_USER_ID in .env');

  const maxPerDay = Number(process.env.MAX_POSTS_PER_DAY) || 2;
  const warmupMax = Number(process.env.WARMUP_FIRST_WEEK_MAX) || 0;
  const history = loadHistory();
  const minGap = Number(process.env.MIN_GAP_MINUTES) || 180;

  const effectiveMax =
    history.posted.length < 7 && warmupMax > 0 ? Math.min(maxPerDay, warmupMax) : maxPerDay;

  if (!canPostToday(history, effectiveMax, minGap)) {
    console.log('Daily limit or min-gap reached — nothing posted.');
    return;
  }

  const publisher = new InstagramPublisher(token, userId);
  const today = new Date().toDateString();
  const alreadyToday = history.lastDate === today ? history.dailyCount[today] || 0 : 0;
  const remaining = effectiveMax - alreadyToday;
  const toPost = Math.min(n, remaining);

  let success = 0;
  for (let i = 0; i < toPost; i++) {
    const item = drainOne();
    if (!item) {
      console.log('Queue empty.');
      break;
    }
    if (!item.videoPath) {
      console.error(`❌ ${item.projectId}: no videoPath`);
      continue;
    }
    try {
      const caption = item.caption || generateCaption(item);
      console.log(`Posting ${item.projectId} — ${item.projectName || ''}`);
      const mediaId = await publisher.publishReel(item.videoPath, caption, item.coverPath);
      console.log(`✅ Posted → ${mediaId}`);
      markPosted(loadHistory(), item, mediaId);
      success++;
    } catch (err) {
      console.error(`❌ Failed ${item.projectId}: ${err.response?.data?.error?.message || err.message}`);
      const q = loadQueue();
      q.failed.push({ ...item, error: err.message, failedAt: new Date().toISOString() });
      saveQueue(q);
    }
    if (i < toPost - 1) await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(`Done: ${success} posted.`);
}

function showStatus() {
  const history = loadHistory();
  const q = loadQueue();
  const today = new Date().toDateString();
  const maxPerDay = Number(process.env.MAX_POSTS_PER_DAY) || 2;
  const warmupMax = Number(process.env.WARMUP_FIRST_WEEK_MAX) || 0;
  const effectiveMax =
    history.posted.length < 7 && warmupMax > 0 ? Math.min(maxPerDay, warmupMax) : maxPerDay;
  const count = history.lastDate === today ? history.dailyCount[today] || 0 : 0;
  const tokenOk = Boolean(process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_USER_ID);

  console.log(`Auth: ${tokenOk ? 'configured' : 'MISSING .env'} | Pexels: ${hasPexelsKey() ? 'on' : 'off (optional)'}`);
  console.log(`Pending: ${q.pending.length} | Posted: ${q.posted.length} | Failed: ${q.failed.length}`);
  console.log(`Today: ${count}/${effectiveMax} | Last: ${history.lastPostedAt || 'never'}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
