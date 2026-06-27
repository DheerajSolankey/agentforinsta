import dotenv from 'dotenv';
import { loadCachedPositions } from './scraper.js';
import { generateCaption } from './caption.js';
import { InstagramPublisher } from './publisher.js';
import { addWatermark, uploadImage, loadPostedHistory, canPostToday, markPosted, cleanupTemp } from './watermark.js';

dotenv.config();

const CONFIG = {
  accessToken: process.env.INSTAGRAM_ACCESS_TOKEN,
  userId: process.env.INSTAGRAM_USER_ID,
  maxPerDay: 5
};

let publisher;

function init() {
  if (!CONFIG.accessToken || !CONFIG.userId) {
    console.error('❌ Missing credentials in .env');
    process.exit(1);
  }
  publisher = new InstagramPublisher(CONFIG.accessToken, CONFIG.userId);
}

async function postDaily(count = 5) {
  init();

  const history = loadPostedHistory();
  
  if (!canPostToday(history, CONFIG.maxPerDay)) {
    const todayCount = history.dailyCount[new Date().toDateString()] || 0;
    console.log(`\n⛔ Already posted ${todayCount}/${CONFIG.maxPerDay} today. Try again tomorrow.\n`);
    return;
  }

  let positions = loadCachedPositions();
  if (positions.length === 0) {
    console.error('❌ No positions cached. Run: node src/index.js scrape');
    return;
  }

  const unposted = positions.filter(p => !history.posted.includes(p.slug));
  
  if (unposted.length === 0) {
    console.log('\n🎉 All positions have been posted! Resetting history...\n');
    history.posted = [];
    savePostedHistory(history);
    return postDaily(count);
  }

  const remainingToday = CONFIG.maxPerDay - (history.dailyCount[new Date().toDateString()] || 0);
  const toPostCount = Math.min(count, remainingToday, unposted.length);
  const toPost = unposted.sort(() => 0.5 - Math.random()).slice(0, toPostCount);

  console.log(`\n📸 Posting ${toPostCount} images today (${history.posted.length} total posted before)\n`);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < toPost.length; i++) {
    const pos = toPost[i];
    console.log(`\n[${i + 1}/${toPostCount}] ${pos.title}`);
    console.log(`  🔗 ${pos.imageUrl}`);

    try {
      const watermarkedPath = await addWatermark(pos.imageUrl, pos.title);
      
      let finalUrl = pos.imageUrl;
      if (watermarkedPath) {
        const uploadedUrl = await uploadImage(watermarkedPath);
        if (uploadedUrl) finalUrl = uploadedUrl;
        try { unlinkSync(watermarkedPath); } catch {}
      }

      const caption = generateCaption(pos);
      const mediaId = await publisher.publishImageDirect(finalUrl, caption, pos.slug);

      if (mediaId) {
        console.log(`  ✅ Posted! ID: ${mediaId}`);
        markPosted(history, pos.slug);
        success++;
      }
    } catch (err) {
      console.log(`  ❌ Failed: ${err.message}`);
      failed++;
    }

    if (i < toPost.length - 1) {
      console.log('  ⏳ Waiting 3 seconds...');
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`📊 Today: ${success} posted, ${failed} failed`);
  console.log(`📊 Total posted: ${history.posted.length} positions`);
  console.log(`📊 Remaining: ${positions.length - history.posted.length} positions`);
  console.log(`${'═'.repeat(40)}\n`);

  cleanupTemp();
}

async function showStatus() {
  const history = loadPostedHistory();
  const positions = loadCachedPositions();
  const today = new Date().toDateString();

  console.log(`\n${'═'.repeat(40)}`);
  console.log('📊 POSTING STATUS');
  console.log(`${'═'.repeat(40)}`);
  console.log(`Total positions scraped: ${positions.length}`);
  console.log(`Total posted: ${history.posted.length}`);
  console.log(`Remaining: ${positions.length - history.posted.length}`);
  console.log(`Today posted: ${history.dailyCount[today] || 0}/${CONFIG.maxPerDay}`);
  console.log(`${'═'.repeat(40)}\n`);

  if (history.posted.length > 0) {
    console.log('Posted positions:');
    history.posted.forEach((slug, i) => {
      console.log(`  ${i + 1}. ${slug}`);
    });
  }
}

const cmd = process.argv[2];
const count = parseInt(process.argv[3]) || 5;

if (cmd === 'post') {
  postDaily(count).catch(console.error);
} else if (cmd === 'status') {
  showStatus();
} else {
  console.log(`
📸 Instagram Agent - Daily Poster

Commands:
  node src/index.js post [count]   Post images (default: 5, max: 5/day)
  node src/index.js status         Show posting status

Examples:
  node src/index.js post           Post 5 images
  node src/index.js post 3         Post 3 images
  node src/index.js status         Check what's been posted
  `);
}
