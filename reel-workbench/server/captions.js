/**
 * Generic caption / hashtag builder for exported reels.
 * Ported pattern from instagram-agent caption.js — no Instagram API, no scraping,
 * no hardcoded external brand/site pools. Tags come from project content only.
 */

const DEFAULT_CTAS = [
  'Save this for later.',
  'Follow for more like this.',
  'Share with someone who needs it.',
  'Comment your take below.',
];

function slugTag(s) {
  return `#${String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40)}`;
}

function uniqueTags(list, limit) {
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw) continue;
    let t = String(raw).trim();
    if (!t) continue;
    if (!t.startsWith('#')) t = `#${t}`;
    t = t.replace(/\s+/g, '');
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    if (t.length < 2) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/** Pull short text lines from a timeline's text clips (t1/t2). */
export function textLinesFromTimeline(timeline, { max = 6, maxLen = 80 } = {}) {
  if (!timeline?.tracks) return [];
  const lines = [];
  const seen = new Set();
  for (const track of timeline.tracks) {
    if (track.type !== undefined && track.type !== 'text' && !String(track.id).startsWith('t')) continue;
    if (track.hidden) continue;
    for (const clip of [...(track.clips || [])].sort((a, b) => a.start - b.start)) {
      const content = String(clip.text?.content || '').replace(/\s+/g, ' ').trim();
      if (!content) continue;
      const key = content.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(content.length > maxLen ? `${content.slice(0, maxLen - 1)}…` : content);
      if (lines.length >= max) return lines;
    }
  }
  return lines;
}

/**
 * Build a caption string.
 * @param {object} opts
 * @param {string} opts.projectName
 * @param {string} [opts.description]
 * @param {string[]} [opts.textLines]  hook / title / CTA lines from the edit
 * @param {string} [opts.styleName]
 * @param {string[]} [opts.tags]       extra hashtags (project keywords)
 * @param {boolean} [opts.includeCTA]
 * @param {boolean} [opts.includeHashtags]
 * @param {number}  [opts.maxLength]   Instagram caption cap (default 2200)
 * @param {string}  [opts.cta]         override CTA line
 */
export function buildCaption({
  projectName = '',
  description = '',
  textLines = [],
  styleName = '',
  tags = [],
  includeCTA = true,
  includeHashtags = true,
  maxLength = 2200,
  cta = '',
} = {}) {
  const parts = [];
  const title = String(projectName || '').trim();

  if (title) parts.push(title);

  const lines = (textLines || [])
    .map((l) => String(l || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  // Prefer the first timeline line as a hook if it isn't already the title
  const hook = lines.find((l) => l.toLowerCase() !== title.toLowerCase());
  if (hook && hook.toLowerCase() !== title.toLowerCase()) {
    parts.push('');
    parts.push(hook);
  }

  const body = String(description || '').trim();
  if (body) {
    parts.push('');
    parts.push(body);
  }

  // Remaining timeline lines (titles/captions) as short beats
  const rest = lines.filter((l) => l !== hook).slice(0, 4);
  if (rest.length) {
    parts.push('');
    parts.push(rest.join(' · '));
  }

  if (styleName) {
    parts.push('');
    parts.push(`Style: ${String(styleName).trim()}`);
  }

  if (includeCTA) {
    const line = String(cta || '').trim() || DEFAULT_CTAS[Math.abs(hash(title)) % DEFAULT_CTAS.length];
    parts.push('');
    parts.push(line);
  }

  let caption = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  if (includeHashtags) {
    const seed = [
      'reels',
      'reel',
      'explore',
      ...tags,
      ...title.split(/[\s_-]+/).filter((w) => w.length > 2),
      ...lines.join(' ').split(/[\s_-]+/).filter((w) => w.length > 3),
      ...(styleName ? styleName.split(/[\s_-]+/) : []),
    ];
    const hashtags = uniqueTags(seed.map((t) => (String(t).startsWith('#') ? t : slugTag(t))), 15);
    if (hashtags.length) {
      const block = `\n\n${hashtags.join(' ')}`;
      if ((caption + block).length <= maxLength) caption += block;
      else {
        // trim body to fit tags
        const room = maxLength - block.length - 1;
        if (room > 40) caption = `${caption.slice(0, room).trimEnd()}…${block}`;
      }
    }
  }

  if (caption.length > maxLength) caption = `${caption.slice(0, maxLength - 1)}…`;
  return caption;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Convenience: build from project + timeline records. */
export function captionForProject(project, timeline, extra = {}) {
  return buildCaption({
    projectName: project?.name || '',
    description: project?.description || '',
    textLines: textLinesFromTimeline(timeline),
    styleName: project?.style_name || '',
    tags: Array.isArray(extra.tags) ? extra.tags : [],
    includeCTA: extra.includeCTA !== false,
    includeHashtags: extra.includeHashtags !== false,
    cta: extra.cta || '',
    maxLength: extra.maxLength || 2200,
  });
}
