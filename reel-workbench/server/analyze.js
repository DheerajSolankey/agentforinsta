import { existsSync } from 'fs';
import { resolveFfmpeg, resolveFfprobe } from './config.js';
import { run, ffprobe } from './ffmpeg.js';
import { summarizeProbe } from './probe.js';
import { getSettings } from './store.js';
import { log } from './logger.js';

/**
 * Local FFmpeg reference analysis — no model training, no cloud.
 * Produces a DRAFT style profile with confidence notes that the user (or OpenCode) can refine.
 */

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function freqFromShot(avgShot) {
  if (avgShot <= 1.0) return 'very_high';
  if (avgShot <= 1.8) return 'high';
  if (avgShot <= 3.2) return 'medium';
  if (avgShot <= 5.5) return 'low';
  return 'very_low';
}

export async function analyzeReference(filePath, { name = 'Analyzed Style' } = {}) {
  if (!existsSync(filePath)) throw new Error('Reference file not found');
  const settings = getSettings();
  const ffmpeg = resolveFfmpeg(settings);
  const probeBin = resolveFfprobe(settings);

  const notes = [];
  const push = (note) => notes.push(note);

  /* --- basic format --- */
  const probe = summarizeProbe(await ffprobe(probeBin, filePath));
  const duration = probe.duration || 0;
  if (duration <= 0) throw new Error('Could not determine reference duration');
  push(`Format: ${probe.width}x${probe.height} @ ${probe.fps ?? '?'}fps, ${duration.toFixed(1)}s`);

  /* --- scene cuts --- */
  let cutTimes = [];
  try {
    const { stderr } = await run(
      ffmpeg,
      ['-i', filePath, '-vf', "select='gt(scene,0.30)',metadata=print:file=-", '-an', '-f', 'null', '-'],
      { timeoutMs: Math.min(600000, 60000 + duration * 1000) }
    );
    cutTimes = [...String(stderr).matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])).filter((n) => Number.isFinite(n));
    cutTimes = [...new Set(cutTimes.map((t) => Math.round(t * 100) / 100))].sort((a, b) => a - b);
  } catch (err) {
    push(`Scene detection unavailable: ${err.message}`);
  }

  const sceneCount = cutTimes.length + 1;
  const avgShot = cutTimes.length ? duration / sceneCount : duration;
  const cutFreq = freqFromShot(avgShot);
  push(`Detected ${sceneCount} shot(s), avg shot ${avgShot.toFixed(2)}s → cut frequency "${cutFreq}"`);

  /* --- transition heuristics from cut deltas --- */
  const transitions = new Set(['hard_cut']);
  // Scene detection finds hard boundaries; fades/crossfades show as gradual scene scores —
  // we cannot classify transition type reliably without deeper CV, so we note the limitation.
  push('Transition type detail (fade/whip/zoom) requires frame-level review — OpenCode can refine the style JSON.');

  /* --- brightness / contrast / saturation (signalstats, sampled) --- */
  let visual = { contrast: 'medium', saturation: 'medium', brightness: 'medium', temperature: 'unknown', grain: 'unknown', vignette: 'unknown' };
  try {
    const { stderr } = await run(
      ffmpeg,
      ['-i', filePath, '-vf', 'fps=2,signalstats,metadata=print:file=-', '-an', '-f', 'null', '-'],
      { timeoutMs: Math.min(600000, 60000 + duration * 1000) }
    );
    const yAvg = [...String(stderr).matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
    const uAvg = [...String(stderr).matchAll(/lavfi\.signalstats\.UAVG=([\d.]+)/g)].map((m) => Number(m[1]));
    const vAvg = [...String(stderr).matchAll(/lavfi\.signalstats\.VAVG=([\d.]+)/g)].map((m) => Number(m[1]));
    const yStd = [...String(stderr).matchAll(/lavfi\.signalstats\.YDIF=([\d.]+)/g)].map((m) => Number(m[1]));
    const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

    const y = mean(yAvg);
    const u = mean(uAvg);
    const v = mean(vAvg);
    const ydif = mean(yStd);
    if (y != null) {
      visual.brightness = y < 85 ? 'dark' : y > 175 ? 'bright' : 'balanced';
    }
    if (ydif != null) {
      visual.contrast = ydif < 25 ? 'low' : ydif > 55 ? 'high' : 'medium';
    }
    if (u != null && v != null) {
      // chroma deviation from 128 ≈ saturation feel (crude but honest)
      const chroma = Math.abs(u - 128) + Math.abs(v - 128);
      visual.saturation = chroma < 12 ? 'low' : chroma > 32 ? 'high' : 'medium';
      visual.temperature = v > u + 4 ? 'warm' : u > v + 4 ? 'cool' : 'neutral';
    }
    push(`Visual stats: brightness=${visual.brightness}, contrast=${visual.contrast}, saturation=${visual.saturation}`);
  } catch (err) {
    push(`Signalstats unavailable: ${err.message}`);
  }

  /* --- audio: presence, loudness, silence density --- */
  const audio = {
    hasAudio: probe.hasAudio,
    musicIntensity: 'unknown',
    beatSync: false,
    sfxDensity: 'unknown',
    voiceMusic: 'unknown',
    silenceRatio: null,
  };
  if (probe.hasAudio) {
    try {
      const { stderr: volErr } = await run(ffmpeg, ['-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'], {
        timeoutMs: Math.min(300000, 40000 + duration * 500),
      });
      const meanM = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(volErr);
      if (meanM) {
        const meanVol = Number(meanM[1]);
        audio.musicIntensity = meanVol > -18 ? 'high' : meanVol > -28 ? 'medium' : 'low';
        push(`Audio mean level ${meanVol} dB → intensity "${audio.musicIntensity}"`);
      }
    } catch (err) {
      push(`volumedetect failed: ${err.message}`);
    }
    try {
      const { stderr: silErr } = await run(ffmpeg, ['-i', filePath, '-af', 'silencedetect=d=1.5', '-f', 'null', '-'], {
        timeoutMs: Math.min(300000, 40000 + duration * 500),
      });
      let silenceSec = 0;
      const starts = [...silErr.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
      const ends = [...silErr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
      for (let i = 0; i < ends.length; i++) {
        const s = starts[i] ?? 0;
        silenceSec += Math.max(0, ends[i] - s);
      }
      audio.silenceRatio = duration > 0 ? Math.round((silenceSec / duration) * 100) / 100 : null;
      if (audio.silenceRatio != null) {
        audio.voiceMusic = audio.silenceRatio > 0.35 ? 'sparse/voice-led' : 'continuous/music-led';
        push(`Silence ratio ${audio.silenceRatio} → ${audio.voiceMusic}`);
      }
    } catch (err) {
      push(`silencedetect failed: ${err.message}`);
    }
    push('Beat-sync detection needs local beat analysis (Phase 3) or OpenCode review.');
  } else {
    push('No audio stream in reference.');
  }

  /* --- structure heuristic --- */
  const structure = [
    { id: 'hook', label: 'Hook', window: [0, Math.min(2, duration * 0.12)], confidence: 0.5 },
    { id: 'context', label: 'Context', window: [Math.min(2, duration * 0.12), duration * 0.35], confidence: 0.35 },
    { id: 'build', label: 'Build', window: [duration * 0.35, duration * 0.7], confidence: 0.35 },
    { id: 'payoff', label: 'Payoff', window: [duration * 0.7, duration * 0.9], confidence: 0.3 },
    { id: 'ending', label: 'Ending / CTA', window: [duration * 0.9, duration], confidence: 0.3 },
  ];
  push('Structure windows are duration-based estimates — refine manually or with OpenCode.');

  const shotMin = Math.max(0.3, avgShot * 0.6);
  const shotMax = Math.max(shotMin + 0.5, avgShot * 1.6);

  const style = {
    id: undefined,
    name,
    version: 1,
    description: `Draft style extracted from reference (${duration.toFixed(1)}s, ${sceneCount} shots, ${cutFreq} cuts).`,
    source: { analyzedAt: new Date().toISOString(), duration, sceneCount },
    pacing: {
      targetDuration: { min: Math.max(8, Math.round(duration * 0.8)), max: Math.round(duration * 1.1) || 20 },
      averageShotDuration: Math.round(avgShot * 100) / 100,
      cutFrequency: cutFreq,
      hookDuration: { min: 0, max: Math.round(Math.min(2.5, duration * 0.12) * 10) / 10 },
      sceneCount,
      cutTimes: cutTimes.slice(0, 80),
      confidence: clamp01(cutTimes.length ? 0.75 : 0.3),
    },
    cuts: { frequency: cutFreq === 'very_high' || cutFreq === 'high' ? 'high' : cutFreq === 'low' || cutFreq === 'very_low' ? 'low' : 'medium', beatSync: audio.beatSync },
    shotDuration: { min: Math.round(shotMin * 100) / 100, max: Math.round(shotMax * 100) / 100 },
    transitions: [...transitions],
    motion: { zoom: 'unknown', shake: 'unknown', note: 'Motion traits not auto-detected in Phase 1 — refine with OpenCode.' },
    captions: { style: 'unknown', position: 'center', animation: 'unknown', note: 'Caption traits need visual review or Phase 3 OCR.' },
    typography: {},
    audio: {
      beatSync: audio.beatSync,
      musicIntensity: audio.musicIntensity,
      sfxDensity: audio.sfxDensity,
      voiceMusic: audio.voiceMusic,
      silenceRatio: audio.silenceRatio,
      hasAudio: audio.hasAudio,
    },
    visual: {
      contrast: visual.contrast,
      saturation: visual.saturation,
      brightness: visual.brightness,
      temperature: visual.temperature,
      grain: visual.grain,
      vignette: visual.vignette,
      confidence: 0.55,
    },
    structure,
    notes,
  };

  log({ stage: 'analyze', status: 'PASS', message: `${name}: ${sceneCount} scenes, ${avgShot.toFixed(2)}s avg shot` });
  return style;
}
