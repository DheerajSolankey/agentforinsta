import axios from 'axios';
import * as cheerio from 'cheerio';
import { writeFileSync } from 'fs';

const BASE_URL = 'https://www.couplesexposition.com';
const CACHE_FILE = './config/positions-cache.json';

const POSITION_SLUGS = [
  'missionary', 'doggy-style', 'cowgirl', 'sixty-nine', 'prone-bone',
  'reverse-cowgirl', 'amazon', 'lotus', 'butterfly', 'spooning',
  'scissor', 'cat', 'helicopter', 'pretzel', 'full-nelson',
  'piledriver', 'wheelbarrow', 'eiffel-tower', 'reverse-cowboy', 'legs-on-shoulders',
  'butter-churner', 'crab', 'bridge', 'anvil', 'spider',
  'splitting-bamboo', 'catapult', 'flatiron', 'downward-dog', 'london-bridge',
  'corkscrew', 't-square', 'bow', 'mermaid', 'seesaw',
  'plow', 'scorpion', 'dolphin', 'frog', 'eagle',
  'lotus-flower', 'flying-squirrel', 'praying-mantis', 'triceratops', 'spider-monkey',
  'leopard', 'dragon', 'tamer', 'jackhammer', 'throwdown',
  'crouching-tiger', 'submissive', 'nun', 'fall', 'rider',
  'backshot', 'spread-eagle', 'lap-dance', 'octopus', 'yin-yang',
  'workout', 'lazy-dog', 'symphony', 'shell', 'glory-hole',
  'knot', 'rocking-chair', 'captain', 'emperor', 'princess',
  'rock-and-roll', 'seashell', 'propeller', 'fantasy', 'russian-roulette',
  'doggy-on-the-edge', 'exotic-foreplay', 'side-saddle', 'lizard', 'wild-yoga',
  'tight-vagina', 'hottest-lover', 'x-factor', 'throat-swab', 'flying-dutchman',
  'necktie', 'shameless', 'plumber', 'iron-throne', 'apollo'
];

async function scrapePosition(slug) {
  try {
    const url = `${BASE_URL}/positions/${slug}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    const $ = cheerio.load(data);

    const title = $('h1').first().text().trim();
    const description = $('meta[name="description"]').attr('content') || '';
    const imageUrl = `${BASE_URL}/images/positions/${slug}.png`;

    const aboutText = $('h2:contains("About")').nextUntil('h2').text().trim();
    const about = aboutText || description;

    const tags = [];
    $('a[href*="category="], a[href*="difficulty="]').each((i, el) => {
      const tag = $(el).text().trim();
      if (tag) tags.push(tag);
    });

    return {
      title,
      slug,
      url,
      imageUrl,
      description,
      about,
      tags,
      scrapedAt: new Date().toISOString()
    };
  } catch (err) {
    console.error(`  Error scraping ${slug}: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log(`Scraping ${POSITION_SLUGS.length} positions...`);
  
  const positions = [];
  for (let i = 0; i < POSITION_SLUGS.length; i++) {
    const slug = POSITION_SLUGS[i];
    const pos = await scrapePosition(slug);
    if (pos) {
      positions.push(pos);
      console.log(`  [${i+1}/${POSITION_SLUGS.length}] ✓ ${pos.title}`);
    }
    if (i % 10 === 9) await new Promise(r => setTimeout(r, 200));
  }

  writeFileSync(CACHE_FILE, JSON.stringify(positions, null, 2));
  console.log(`\nSaved ${positions.length} positions to cache.`);
}

main().catch(console.error);
