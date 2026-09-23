import { ffprobe } from './ffmpeg.js';

/** Extract normalized media metadata from ffprobe JSON. */
export function summarizeProbe(probe) {
  const streams = probe.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1) || null;
  const audio = streams.find((s) => s.codec_type === 'audio') || null;
  const format = probe.format || {};

  let fps = null;
  if (video?.r_frame_rate && video.r_frame_rate !== '0/0') {
    const [n, d] = video.r_frame_rate.split('/').map(Number);
    if (d) fps = Math.round((n / d) * 1000) / 1000;
  }
  const duration = Number(format.duration || video?.duration || audio?.duration || 0) || 0;

  let category = 'other';
  const mime = String(format.format_name || '');
  const ext = String(format.filename || '').split('.').pop()?.toLowerCase();
  if (video && (mime.includes('image') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'].includes(ext))) {
    category = 'image';
  } else if (video && audio) category = 'video';
  else if (video) category = 'video';
  else if (audio) {
    category = 'audio';
    const name = String(format.format_name || '').toLowerCase();
    if (/mp3/.test(name)) category = 'music';
  }

  return {
    duration: Math.round(duration * 1000) / 1000,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps,
    hasVideo: !!video,
    hasAudio: !!audio,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    sampleRate: audio ? Number(audio.sample_rate) : null,
    channels: audio?.channels ?? null,
    bitrate: Number(format.bit_rate) || null,
    size: Number(format.size) || null,
    formatName: format.format_name || null,
    category,
  };
}

export async function probeMedia(ffprobeBin, filePath) {
  const raw = await ffprobe(ffprobeBin, filePath);
  return { raw, meta: summarizeProbe(raw) };
}

const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'mkv', 'm4v', 'avi', 'mpg', 'mpeg', 'ts', '3gp']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'wma']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg']);

export function categoryFromFilename(filename) {
  const ext = String(filename).split('.').pop()?.toLowerCase() || '';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'other';
}

export function kindForTrack(category) {
  if (category === 'video') return 'video';
  if (category === 'image') return 'image';
  if (category === 'audio' || category === 'music' || category === 'voice' || category === 'sfx') return 'audio';
  return null;
}

export const SUPPORTED_UPLOAD_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT]);

export function subcategory(category, filename, mime) {
  if (category !== 'audio') return category;
  const n = String(filename).toLowerCase();
  if (/voice|vo|narrat|speak/.test(n)) return 'voice';
  if (/sfx|whoosh|impact|riser|hit|click/.test(n)) return 'sfx';
  if (/logo/.test(n)) return 'logo';
  if (/music|beat|song|track|bgm/.test(n)) return 'music';
  if (mime && /mpeg/.test(mime)) return 'music';
  return 'music';
}
