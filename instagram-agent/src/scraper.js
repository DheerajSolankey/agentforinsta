import axios from 'axios';
import * as cheerio from 'cheerio';
import { writeFileSync, readFileSync, existsSync } from 'fs';

const BASE_URL = process.env.WEBSITE_URL || 'https://www.couplesexposition.com';
const CACHE_FILE = './config/positions-cache.json';

export async function scrapeAllPositions() {
  console.log('Scraping all positions from website...');
  
  const positions = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    try {
      const url = page === 1 ? `${BASE_URL}/positions` : `${BASE_URL}/positions?page=${page}`;
      const { data } = await axios.get(url, { timeout: 15000 });
      const $ = cheerio.load(data);

      const links = $('a[href^="/positions/"]').toArray();
      const uniqueLinks = [...new Set(links.map(l => $(l).attr('href')).filter(h => h && h !== '/positions'))];

      if (uniqueLinks.length === 0) {
        hasMore = false;
        break;
      }

      for (const link of uniqueLinks) {
        if (!positions.find(p => p.url === link)) {
          positions.push({ url: link });
        }
      }

      page++;
      if (page > 20) break;
    } catch (err) {
      console.error(`Error scraping page ${page}:`, err.message);
      hasMore = false;
    }
  }

  console.log(`Found ${positions.length} position URLs. Scraping details...`);

  const detailedPositions = [];
  for (const pos of positions) {
    try {
      const detail = await scrapePositionDetail(pos.url);
      if (detail) {
        detailedPositions.push(detail);
        console.log(`  ✓ ${detail.title}`);
      }
      await sleep(500);
    } catch (err) {
      console.error(`  ✗ Error scraping ${pos.url}:`, err.message);
    }
  }

  writeFileSync(CACHE_FILE, JSON.stringify(detailedPositions, null, 2));
  console.log(`\nSaved ${detailedPositions.length} positions to cache.`);
  return detailedPositions;
}

export async function scrapePositionDetail(path) {
  const url = `${BASE_URL}${path}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  const $ = cheerio.load(data);

  const title = $('h1').first().text().trim();
  const description = $('h1').first().next('p').text().trim() ||
    $('meta[name="description"]').attr('content') || '';

  const imageUrl = $('img[src*="/images/positions/"]').first().attr('src') ||
    $('meta[property="og:image"]').attr('content') || '';
  const fullImageUrl = imageUrl.startsWith('http') ? imageUrl : `${BASE_URL}${imageUrl}`;

  const aboutSection = $('h2:contains("About")').nextUntil('h2').text().trim() ||
    $('p').filter((i, el) => $(el).text().length > 50).first().text().trim();

  const tags = [];
  $('a[href*="category="], a[href*="difficulty="], a[href*="stimulation="]').each((i, el) => {
    const tag = $(el).text().trim();
    if (tag) tags.push(tag);
  });

  const metaDescription = $('meta[name="description"]').attr('content') || '';

  return {
    title,
    slug: path.replace('/positions/', ''),
    url,
    imageUrl: fullImageUrl,
    description: description || metaDescription,
    about: aboutSection || description,
    tags,
    scrapedAt: new Date().toISOString()
  };
}

export function loadCachedPositions() {
  if (existsSync(CACHE_FILE)) {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
  }
  return [];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

if (process.argv[1] && process.argv[1].includes('scraper')) {
  scrapeAllPositions().catch(console.error);
}
