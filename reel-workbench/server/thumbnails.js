import { mkdirSync } from 'fs';
import { join } from 'path';
import { run } from './ffmpeg.js';
import { DIRS } from './store.js';

export const THUMB_DIR = join(DIRS.media, 'thumbs');

/** Extract a single JPEG frame at `atSeconds`. Returns output path. */
export async function generateThumbnail(ffmpegBin, inputPath, outputName, atSeconds = 0.5, { width = 360 } = {}) {
  mkdirSync(THUMB_DIR, { recursive: true });
  const out = join(THUMB_DIR, outputName);
  await run(ffmpegBin, [
    '-y',
    '-ss', String(Math.max(0, atSeconds)),
    '-i', inputPath,
    '-frames:v', '1',
    '-vf', `scale=${width}:-2`,
    '-q:v', '4',
    out,
  ], { timeoutMs: 60 * 1000 });
  return out;
}

export function thumbUrlFor(mediaId) {
  return `/api/media/${mediaId}/thumb`;
}
