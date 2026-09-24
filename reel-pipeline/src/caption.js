import { loadNiche } from './niche.js';

/**
 * Caption for movies / motivational / quotes niche (India).
 * Prefers project caption.txt content when provided; wraps with CTA + hashtags.
 */
export function generateCaption(item, options = {}) {
  const { maxLength = 2200, includeCTA = true } = options;
  const niche = loadNiche();
  const body = (item?.caption || '').trim();

  const parts = [];

  if (body) {
    parts.push(body);
  } else {
    const title = item?.projectName || 'Daily motivation';
    const openers = [`🔥 ${title}`, `⚡ ${title}`, `💫 ${title}`, `🎬 ${title}`];
    parts.push(openers[Math.floor(Math.random() * openers.length)]);
  }

  if (includeCTA && Array.isArray(niche.cta) && niche.cta.length) {
    parts.push('');
    parts.push(niche.cta[Math.floor(Math.random() * niche.cta.length)]);
  }

  let caption = parts.join('\n');
  const hashtags = pickHashtags(niche, 12);
  if (`${caption}\n\n${hashtags}`.length <= maxLength) {
    caption += `\n\n${hashtags}`;
  } else if (caption.length > maxLength) {
    caption = caption.slice(0, maxLength - 1) + '…';
  }

  return caption;
}

function pickHashtags(niche, count = 12) {
  const pools = niche.hashtags || {};
  const tags = new Set();
  const pick = (arr, n) => {
    const shuffled = [...(arr || [])].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, n);
  };
  pick(pools.primary, 4).forEach((t) => tags.add(t));
  pick(pools.niche, 4).forEach((t) => tags.add(t));
  pick(pools.india, 3).forEach((t) => tags.add(t));
  pick(pools.trending, 2).forEach((t) => tags.add(t));
  return [...tags].slice(0, count).join(' ');
}
