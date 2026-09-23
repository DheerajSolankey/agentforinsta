import { Router } from 'express';
import { getSettings, updateSettings } from '../store.js';
import { detectFfmpeg, detectFfprobe, detectFontFile } from '../config.js';
import { run } from '../ffmpeg.js';

const router = Router();

router.get('/settings', async (_req, res) => {
  const settings = getSettings();
  let ffmpegVersion = null;
  let font = detectFontFile();
  try {
    const { stdout } = await run(detectFfmpeg(), ['-version'], { timeoutMs: 10000 });
    ffmpegVersion = String(stdout).split('\n')[0];
  } catch {
    ffmpegVersion = null;
  }
  res.json({
    settings,
    environment: {
      ffmpeg: detectFfmpeg(),
      ffprobe: detectFfprobe(),
      ffmpegVersion,
      ffmpeg_ok: !!ffmpegVersion,
      font,
      font_ok: !!font,
      node: process.version,
      platform: process.platform,
    },
  });
});

router.put('/settings', (req, res) => {
  const allowed = ['port', 'ffmpegPath', 'ffprobePath', 'defaultWidth', 'defaultHeight', 'defaultFps', 'export', 'renderConcurrency', 'maxUploadMb'];
  const patch = {};
  for (const key of allowed) {
    if (req.body?.[key] !== undefined) patch[key] = req.body[key];
  }
  if (patch.export && typeof patch.export === 'object') {
    patch.export = {
      crf: Number(patch.export.crf) || 20,
      preset: String(patch.export.preset || 'medium'),
      audioBitrate: String(patch.export.audioBitrate || '192k'),
      videoCodec: 'libx264',
      audioCodec: 'aac',
    };
  }
  if (patch.defaultWidth) patch.defaultWidth = Math.max(16, Math.min(4096, Number(patch.defaultWidth)));
  if (patch.defaultHeight) patch.defaultHeight = Math.max(16, Math.min(4096, Number(patch.defaultHeight)));
  if (patch.defaultFps) patch.defaultFps = Math.max(1, Math.min(120, Number(patch.defaultFps)));
  if (patch.maxUploadMb) patch.maxUploadMb = Math.max(16, Number(patch.maxUploadMb));
  res.json({ settings: updateSettings(patch) });
});

export default router;
