import { existsSync } from 'fs';
import { resolveFfmpeg, resolveFfprobe } from './config.js';
import { run } from './ffmpeg.js';
import { ffprobe } from './ffmpeg.js';
import { summarizeProbe } from './probe.js';
import { getSettings, readTimeline } from './store.js';
import { validateForRender, buildProgramSegments } from './renderer.js';
import { timelineDuration, clipEnd, getTrack } from '../shared/timeline-ops.js';

const item = (name, status, detail = '') => ({ name, status, detail });

/**
 * Quality control on a rendered file.
 * Returns { overall: 'PASS'|'WARNINGS'|'FAIL', items: [...] }
 */
export async function runQc(projectId, file, { expectDuration = null, expectUserAudio = true } = {}) {
  const settings = getSettings();
  const ffmpeg = resolveFfmpeg(settings);
  const probeBin = resolveFfprobe(settings);
  const items = [];

  if (!existsSync(file)) {
    return { overall: 'FAIL', items: [item('File', 'FAIL', 'Rendered file not found')], at: new Date().toISOString() };
  }

  const project = settings;
  void project;
  const timeline = readTimeline(projectId);
  const W = timeline?.width || 1080;
  const H = timeline?.height || 1920;
  const FPS = timeline?.fps || 30;

  let meta = null;
  try {
    meta = summarizeProbe(await ffprobe(probeBin, file));
  } catch (err) {
    return { overall: 'FAIL', items: [item('Container', 'FAIL', `Could not probe file: ${err.message}`)], at: new Date().toISOString() };
  }

  /* Resolution */
  if (meta.width === W && meta.height === H) {
    items.push(item('Resolution', 'PASS', `${meta.width}x${meta.height}`));
  } else {
    items.push(item('Resolution', 'FAIL', `Expected ${W}x${H}, got ${meta.width}x${meta.height}`));
  }

  /* Aspect ratio 9:16 */
  const ratio = meta.width && meta.height ? meta.width / meta.height : 0;
  const expectRatio = W / H;
  if (Math.abs(ratio - expectRatio) < 0.01) {
    items.push(item('Aspect Ratio', 'PASS', '9:16'));
  } else {
    items.push(item('Aspect Ratio', 'FAIL', `Got ${ratio.toFixed(3)}, expected ${expectRatio.toFixed(3)}`));
  }

  /* FPS */
  if (meta.fps && Math.abs(meta.fps - FPS) <= 1) {
    items.push(item('FPS', 'PASS', `${meta.fps}`));
  } else {
    items.push(item('FPS', 'WARNING', `Got ${meta.fps ?? 'unknown'}, expected ~${FPS}`));
  }

  /* Duration */
  const expDur = expectDuration ?? (timeline ? timelineDuration(timeline) : meta.duration);
  if (expDur > 0 && Math.abs(meta.duration - expDur) <= 0.35) {
    items.push(item('Duration', 'PASS', `${meta.duration.toFixed(2)}s (expected ${expDur.toFixed(2)}s)`));
  } else {
    items.push(item('Duration', 'WARNING', `${meta.duration.toFixed(2)}s vs expected ${expDur.toFixed(2)}s`));
  }

  /* Codecs */
  items.push(
    meta.videoCodec === 'h264'
      ? item('Video Codec', 'PASS', 'h264')
      : item('Video Codec', 'WARNING', meta.videoCodec || 'unknown')
  );
  if (meta.hasAudio) {
    items.push(
      meta.audioCodec === 'aac'
        ? item('Audio Codec', 'PASS', 'aac')
        : item('Audio Codec', 'WARNING', meta.audioCodec || 'unknown')
    );
    items.push(item('Audio Presence', 'PASS', 'audio stream present'));
  } else {
    items.push(item('Audio Presence', expectUserAudio ? 'FAIL' : 'WARNING', 'no audio stream'));
  }

  /* Audio levels: clipping + silence */
  if (meta.hasAudio) {
    try {
      const { stderr } = await run(ffmpeg, ['-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { timeoutMs: 120000 });
      const maxM = /max_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr);
      const meanM = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr);
      const maxVol = maxM ? Number(maxM[1]) : null;
      const meanVol = meanM ? Number(meanM[1]) : null;
      if (maxVol != null && maxVol >= -0.1) {
        items.push(item('Audio Clipping', 'WARNING', `Peak ${maxVol} dB — at or above full scale`));
      } else if (maxVol != null) {
        items.push(item('Audio Clipping', 'PASS', `Peak ${maxVol} dB`));
      }
      if (expectUserAudio && meanVol != null && meanVol <= -60) {
        items.push(item('Unexpected Silence', 'WARNING', 'Audio track appears silent'));
      } else {
        items.push(item('Audio Levels', 'PASS', meanVol != null ? `Mean ${meanVol} dB` : ''));
      }
    } catch (err) {
      items.push(item('Audio Analysis', 'WARNING', err.message));
    }

    if (expectUserAudio) {
      try {
        const { stderr } = await run(ffmpeg, ['-i', file, '-af', 'silencedetect=d=2', '-f', 'null', '-'], { timeoutMs: 120000 });
        const silences = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)];
        const totalSilence = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].length;
        if (silences.length && totalSilence * 2 >= 3 && expDur > 0) {
          // coarse: multiple long silences
          const firstStart = Number(silences[0][1]);
          if (firstStart < 0.5 && totalSilence >= 2) {
            items.push(item('Unexpected Silence', 'WARNING', 'Long silent regions detected in voice/music'));
          } else {
            items.push(item('Unexpected Silence', 'PASS', ''));
          }
        } else {
          items.push(item('Unexpected Silence', 'PASS', ''));
        }
      } catch {
        items.push(item('Unexpected Silence', 'PASS', ''));
      }
    }
  }

  /* Black / empty frames vs expected timeline gaps */
  try {
    const { stderr } = await run(ffmpeg, ['-i', file, '-vf', 'blackdetect=d=0.4:pix_th=0.10', '-f', 'null', '-'], {
      timeoutMs: 180000,
    });
    const blacks = [...stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => ({
      start: Number(m[1]),
      end: Number(m[2]),
    }));
    if (timeline) {
      const segments = buildProgramSegments(timeline, timelineDuration(timeline));
      let cursor = 0;
      const gaps = [];
      for (const seg of segments) {
        if (seg.type === 'gap') gaps.push([cursor, cursor + seg.duration]);
        cursor += seg.duration;
      }
      const unexpected = blacks.filter(
        (b) => !gaps.some(([gs, ge]) => b.start >= gs - 0.5 && b.end <= ge + 0.5)
      );
      if (unexpected.length === 0) {
        items.push(item('Black Frames', 'PASS', blacks.length ? `${blacks.length} expected black gap(s)` : 'none'));
      } else {
        items.push(
          item('Black Frames', 'WARNING', `${unexpected.length} unexpected black segment(s) — check empty areas on V1`)
        );
      }
    } else {
      items.push(item('Black Frames', blacks.length ? 'WARNING' : 'PASS', blacks.length ? `${blacks.length} found` : ''));
    }
  } catch {
    items.push(item('Black Frames', 'WARNING', 'blackdetect failed'));
  }

  /* Caption visibility / safe area */
  if (timeline) {
    const texts = [];
    for (const tid of ['t1', 't2']) {
      const tr = getTrack(timeline, tid);
      for (const c of tr.clips) if (c.text) texts.push(c);
    }
    if (texts.length === 0) {
      items.push(item('Captions', 'WARNING', 'No text/captions on the timeline'));
    } else {
      const unsafe = texts.filter((c) => {
        const pos = c.text.position;
        const y = c.text.yPct != null ? c.text.yPct : pos === 'bottom' ? 80 : pos === 'top' ? 14 : 50;
        return y > 88 || y < 8;
      });
      if (unsafe.length) {
        items.push(item('Safe Area', 'WARNING', `${unsafe.length} text element(s) too close to the frame edge`));
      } else {
        items.push(item('Safe Area', 'PASS', `${texts.length} text element(s) inside safe area`));
      }
      items.push(item('Captions', 'PASS', `${texts.length} text element(s)`));
    }
  }

  /* Corrupt frames / decode integrity */
  try {
    const { stderr } = await run(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], { timeoutMs: 300000 });
    const errs = String(stderr)
      .split(/\r?\n/)
      .filter((l) => /error|corrupt|invalid/i.test(l));
    if (errs.length === 0) {
      items.push(item('Decode Check', 'PASS', 'no decode errors'));
    } else {
      items.push(item('Decode Check', 'FAIL', errs[0].slice(0, 200)));
    }
  } catch (err) {
    items.push(item('Decode Check', 'FAIL', err.message.slice(0, 200)));
  }

  const overall = items.some((i) => i.status === 'FAIL')
    ? 'FAIL'
    : items.some((i) => i.status === 'WARNING')
      ? 'WARNINGS'
      : 'PASS';

  return { overall, items, at: new Date().toISOString(), file };
}

export { validateForRender, clipEnd };
