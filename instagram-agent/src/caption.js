const HASHTAG_POOLS = {
  primary: [
    '#couplesgoals', '#intimacy', '#relationshipgoals', '#lovelife',
    '#couplestips', '#betterintimacy', '#spiceitup', '#relationshipadvice',
    '#coupleswhoexplore', '#intimatemoments'
  ],
  niche: [
    '#sexpositions', '#kamasutra', '#bedroomtips', '#pleasureguide',
    '#coupleswellness', '#intimacyenhancement', '#relationshipgoals2026',
    '#lovelifetips', '#passionproject', '#bedroomadventure'
  ],
  engagement: [
    '#couplegoals', '#loveconnection', '#intimatehealth', '#relationshipmatters',
    '#marriagetips', '#datingtips', '#romancetips'
  ],
  trending: [
    '#trending', '#viral', '#explorepage', '#fyp', '#reels',
    '#instagood', '#photooftheday', '#love', '#instalike'
  ]
};

export function generateCaption(position, options = {}) {
  const { maxLength = 2200, includeCTA = true } = options;

  const parts = [];

  const openers = [
    `✨ ${position.title} ✨`,
    `🔥 ${position.title}`,
    `💕 Try This: ${position.title}`,
    `🌸 Position Spotlight: ${position.title}`,
    `💑 ${position.title}`,
    `💫 Discover: ${position.title}`
  ];
  parts.push(openers[Math.floor(Math.random() * openers.length)]);

  if (position.description) {
    parts.push('');
    parts.push(position.description);
  }

  if (position.about) {
    const shortAbout = position.about.substring(0, 150);
    if (shortAbout.length < position.about.length) {
      parts.push('');
      parts.push(`${shortAbout}...`);
    }
  }

  if (position.tags && position.tags.length > 0) {
    parts.push('');
    parts.push(`🏷️ ${position.tags.slice(0, 4).join(' • ')}`);
  }

  if (includeCTA) {
    parts.push('');
    const ctas = [
      '💬 Would you try this? Tag your partner! 👇',
      '💾 Save this for later & try tonight!',
      '👆 Double tap if you love this position!',
      '❤️ Tag someone who needs to see this!',
      '🔄 Share with your partner tonight!'
    ];
    parts.push(ctas[Math.floor(Math.random() * ctas.length)]);
  }

  parts.push('');
  parts.push('━━━━━━━━━━━━━━━━━');
  parts.push('🌐 www.couplesexposition.com');
  parts.push('🔗 400+ positions & guides on our website');
  parts.push('👆 Link in bio');

  let caption = parts.join('\n');

  const hashtags = generateHashtags(position, 15);
  if (`${caption}\n\n${hashtags}`.length <= maxLength) {
    caption += `\n\n${hashtags}`;
  }

  return caption;
}

function generateHashtags(position, count = 15) {
  const tags = new Set();

  const pick = (arr, n) => {
    const shuffled = [...arr].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, n);
  };

  pick(HASHTAG_POOLS.primary, 5).forEach(t => tags.add(t));
  pick(HASHTAG_POOLS.niche, 4).forEach(t => tags.add(t));
  pick(HASHTAG_POOLS.engagement, 3).forEach(t => tags.add(t));
  pick(HASHTAG_POOLS.trending, 2).forEach(t => tags.add(t));

  if (position.tags) {
    position.tags.slice(0, 3).forEach(tag => {
      const formatted = `#${tag.toLowerCase().replace(/\s+/g, '')}`;
      tags.add(formatted);
    });
  }

  if (position.title) {
    const titleTag = `#${position.title.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '')}`;
    tags.add(titleTag);
  }

  return [...tags].slice(0, count).join(' ');
}
