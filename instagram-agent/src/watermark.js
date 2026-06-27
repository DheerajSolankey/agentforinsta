import sharp from 'sharp';
import axios from 'axios';
import { readFileSync, mkdirSync, readdirSync, unlinkSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import FormData from 'form-data';

const WATERMARK_DIR = './temp';
const POSTED_FILE = './config/posted-history.json';
mkdirSync(WATERMARK_DIR, { recursive: true });

export async function addWatermark(imageUrl, positionName) {
  try {
    console.log(`  🎨 Processing: ${positionName}`);
    
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const inputBuffer = Buffer.from(response.data);

    const image = sharp(inputBuffer);
    const metadata = await image.metadata();
    const { width, height } = metadata;

    const titleSize = Math.max(40, Math.floor(width / 12));
    const smallSize = Math.floor(titleSize * 0.5);
    const wmSize = Math.floor(width / 8);

    const svg = `
      <svg width="${width}" height="${height}">
        <defs>
          <linearGradient id="topGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:black;stop-opacity:0.6"/>
            <stop offset="100%" style="stop-color:black;stop-opacity:0"/>
          </linearGradient>
          <linearGradient id="botGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:black;stop-opacity:0"/>
            <stop offset="100%" style="stop-color:black;stop-opacity:0.7"/>
          </linearGradient>
        </defs>

        <!-- Top dark gradient -->
        <rect x="0" y="0" width="${width}" height="${height * 0.12}" fill="url(#topGrad)"/>
        
        <!-- Bottom dark gradient -->
        <rect x="0" y="${height * 0.88}" width="${width}" height="${height * 0.12}" fill="url(#botGrad)"/>

        <!-- Strong diagonal watermark - repeated pattern -->
        <g transform="rotate(-30, ${width/2}, ${height/2})">
          ${generateRepeatedWatermark(width, height, wmSize)}
        </g>

        <!-- Bottom name bar with black background -->
        <rect x="0" y="${height - titleSize - 30}" width="${width}" height="${titleSize + 30}" fill="rgba(0,0,0,0.85)"/>
        <text x="${width/2}" y="${height - 20}" 
              text-anchor="middle" 
              font="bold ${titleSize}px Arial, sans-serif" 
              fill="white">${positionName}</text>

        <!-- Website at bottom -->
        <text x="${width/2}" y="${height - titleSize - 10}" 
              text-anchor="middle" 
              font="${smallSize}px Arial, sans-serif" 
              fill="rgba(255,255,255,0.9)">www.couplesexposition.com</text>

        <!-- Corner brackets -->
        <rect x="10" y="10" width="40" height="3" fill="white"/>
        <rect x="10" y="10" width="3" height="40" fill="white"/>
        
        <rect x="${width-50}" y="10" width="40" height="3" fill="white"/>
        <rect x="${width-13}" y="10" width="3" height="40" fill="white"/>
        
        <rect x="10" y="${height-13}" width="40" height="3" fill="white"/>
        <rect x="10" y="${height-50}" width="3" height="40" fill="white"/>
        
        <rect x="${width-50}" y="${height-13}" width="40" height="3" fill="white"/>
        <rect x="${width-13}" y="${height-50}" width="3" height="40" fill="white"/>
      </svg>
    `;

    const outputPath = join(WATERMARK_DIR, `wm_${positionName.replace(/\s+/g, '_')}_${Date.now()}.jpg`);
    
    await image
      .modulate({ brightness: 1.1, saturation: 1.25 })
      .sharpen({ sigma: 1 })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 92 })
      .toFile(outputPath);

    console.log(`  ✅ Enhanced: ${positionName}`);
    return outputPath;
  } catch (err) {
    console.error(`  ❌ Failed: ${err.message}`);
    return null;
  }
}

function generateRepeatedWatermark(width, height, fontSize) {
  let texts = '';
  const spacing = fontSize * 8;
  const text = 'COUPLESEXPOSITION.COM';
  
  for (let y = -height; y < height * 2; y += spacing) {
    for (let x = -width; x < width * 2; x += spacing * 2) {
      texts += `<text x="${x}" y="${y}" 
        font="bold ${fontSize}px Arial, sans-serif" 
        fill="rgba(255,255,255,0.18)"
        stroke="rgba(0,0,0,0.08)"
        stroke-width="1">${text}</text>`;
    }
  }
  return texts;
}

export async function uploadImage(localPath) {
  const buffer = readFileSync(localPath);
  const b64 = buffer.toString('base64');

  // Try freeimage.host
  try {
    const form = new FormData();
    form.append('key', '6d207e02198a847aa98d0a2a901485a5');
    form.append('source', b64);
    form.append('format', 'json');

    const resp = await axios.post('https://freeimage.host/api/1/upload', form, {
      headers: form.getHeaders(),
      timeout: 30000
    });

    if (resp.data?.image?.url) {
      console.log(`    📤 Uploaded via freeimage: ${resp.data.image.url}`);
      return resp.data.image.url;
    }
  } catch (err) {
    console.log(`    ⚠ freeimage: ${err.message}`);
  }

  // Try sm.ms
  try {
    const form = new FormData();
    form.append('smfile', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });

    const resp = await axios.post('https://sm.ms/api/v2/upload', form, {
      headers: form.getHeaders(),
      timeout: 30000
    });

    if (resp.data?.data?.url) {
      console.log(`    📤 Uploaded via sm.ms: ${resp.data.data.url}`);
      return resp.data.data.url;
    }
  } catch (err) {
    console.log(`    ⚠ sm.ms: ${err.message}`);
  }

  return null;
}

export function loadPostedHistory() {
  if (existsSync(POSTED_FILE)) {
    return JSON.parse(readFileSync(POSTED_FILE, 'utf-8'));
  }
  return { posted: [], dailyCount: {}, lastDate: null };
}

export function savePostedHistory(data) {
  writeFileSync(POSTED_FILE, JSON.stringify(data, null, 2));
}

export function canPostToday(history, maxPerDay = 5) {
  const today = new Date().toDateString();
  if (history.lastDate !== today) return true;
  return (history.dailyCount[today] || 0) < maxPerDay;
}

export function markPosted(history, slug) {
  const today = new Date().toDateString();
  if (history.lastDate !== today) {
    history.lastDate = today;
    history.dailyCount = {};
  }
  history.dailyCount[today] = (history.dailyCount[today] || 0) + 1;
  if (!history.posted.includes(slug)) {
    history.posted.push(slug);
  }
  savePostedHistory(history);
}

export function cleanupTemp() {
  try {
    const files = readdirSync(WATERMARK_DIR);
    files.forEach(f => {
      try { unlinkSync(join(WATERMARK_DIR, f)); } catch {}
    });
  } catch {}
}
