import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { detectFontFile, resolveFfmpeg, resolveFfprobe } from './config.js';
import { assertInsideData } from './paths.js';
import { run, progressSeconds } from './ffmpeg.js';
import { probeMedia } from './probe.js';
import { getSettings, getProject, saveProject, readTimeline, mediaAbsolutePath, getMedia, DIRS, ensureProjectDirs } from './store.js';
import { validateTimeline, timelineDuration, getTrack, clipEnd, round3, EPS, getLayoutMode, isSplitLayout, splitPanes, normalizeTransform, FIT_MODES, normalizeEffect, bgToFfmpeg, BG_MODES, normalizeTextAnim, normalizeTextAlign, estimateBannerLines, bannerBoxHeight, keyframeExpr, normalizeTransition } from '../shared/timeline-ops.js';
import { log } from './logger.js';
import { captionForProject } from './captions.js';

export class RenderError extends Error {
  constructor(message, { stage = 'validate', detail = '' } = {}) {
    super(message);
    this.stage = stage;
    this.detail = detail;
    this.name = 'RenderError';
  }
}

/* ------------------------------ validation ------------------------------ */

export function validateForRender(project, timeline) {
  const issues = validateTimeline(timeline);
  if (issues.length) {
    throw new RenderError(`Timeline is invalid: ${issues[0].message}`, { stage: 'validate', detail: JSON.stringify(issues, null, 2) });
  }
  const duration = timelineDuration(timeline);
  if (duration <= 0) {
    throw new RenderError('Timeline is empty. Add at least one clip before rendering.', { stage: 'validate' });
  }

  const assetIds = new Set();
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.assetId) assetIds.add(clip.assetId);
    }
  }
  const assets = {};
  for (const id of assetIds) {
    const asset = getMedia(id);
    if (!asset) throw new RenderError(`A clip references media that is no longer in the library (id ${id}).`, { stage: 'validate' });
    if (asset.rights_status === 'REFERENCE_ONLY') {
      throw new RenderError(
        `"${asset.filename}" is REFERENCE_ONLY. Reference material is for style learning — use your own or permitted media on the timeline.`,
        { stage: 'validate' }
      );
    }
    const abs = mediaAbsolutePath(asset);
    if (!abs || !existsSync(abs)) {
      throw new RenderError(`Media file is missing on disk: ${asset.filename}`, { stage: 'validate' });
    }
    assets[id] = { asset, path: abs };
  }
  return { duration, assets };
}

/* ------------------------------ helpers ------------------------------ */

function escPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function escFilterPath(p) {
  // Forward slashes work on Windows; escape filter-graph specials.
  return String(p)
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function sanitizeTextContent(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.charCodeAt(0);
    out += c < 32 && ch !== ' ' ? ' ' : ch;
  }
  return out.trim();
}

const PRESET_POS = {
  top: { x: 50, y: 14 },
  center: { x: 50, y: 50 },
  bottom: { x: 50, y: 80 },
};

function hexColor(color, fallback = '0xFFFFFF') {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(color || ''));
  return m ? `0x${m[1]}` : fallback;
}

function bgColor(bg) {
  const s = String(bg || '');
  if (!s) return null;
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return `${s.slice(1)}@0.55`;
  if (/^[a-z]+@[0-9.]+$/i.test(s) || /^[a-z]+$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{8}$/.test(s)) {
    const a = parseInt(s.slice(7, 9), 16) / 255;
    return `${s.slice(1, 7)}@${a.toFixed(2)}`;
  }
  return 'black@0.55';
}

/** Per-clip color effect (after fit). Mirrors CSS filters used in preview. */
export function buildEffectFilter(clip) {
  const effect = normalizeEffect(clip?.effect);
  switch (effect) {
    case 'bw': return 'hue=s=0';
    case 'sepia': return 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131';
    case 'warm': return 'eq=contrast=1.05:saturation=1.15:gamma_r=1.04:gamma_b=0.96';
    case 'cool': return 'eq=contrast=1.05:saturation=1.1:gamma_r=0.96:gamma_b=1.05';
    case 'vivid': return 'eq=contrast=1.18:saturation=1.35';
    case 'vintage': return 'eq=contrast=0.92:saturation=0.78:brightness=0.04:gamma=1.05,colorbalance=rs=-0.08:bs=0.08:gm=0.03';
    case 'teal': return 'eq=contrast=1.08:saturation=1.1,colorbalance=rs=0.12:gs=0.04:bs=-0.1:rm=-0.06:bm=0.1';
    case 'golden': return 'eq=contrast=1.06:saturation=1.12:gamma_r=1.1:gamma_g=1.02:gamma_b=0.9';
    case 'noir': return 'hue=s=0,eq=contrast=1.28:brightness=-0.02';
    case 'neon': return 'eq=contrast=1.15:saturation=1.55:gamma=1.04,hue=h=8';
    case 'luxury': return 'eq=contrast=1.12:saturation=1.05:gamma_r=1.06:gamma_b=0.94,colorbalance=rs=0.06:bs=-0.04';
    default: return '';
  }
}

/**
 * drawtext alpha expression for entrance animation.
 * fade / pop / bounce / zoom-in / slide-* export as alpha (and optional y offset).
 * Exported for tests.
 */
export function buildTextAlpha(anim, start, end, animDur = 0.3) {
  const a = normalizeTextAnim(anim);
  if (a === 'none') return null;
  const s = round3(Number(start) || 0);
  const e = round3(Number(end) || 0);
  const d = Math.max(0.05, round3(Number(animDur) || 0.3));
  if (e <= s + d) return null;
  if (a === 'fade') {
    return `if(lt(t,${s}),0,if(lt(t,${round3(s + d)}),(t-${s})/${d},if(lt(t,${round3(e - d)}),1,(${e}-t)/${d})))`;
  }
  // pop / bounce / zoom-in / slide: snap-in with ease, gentle out
  const dIn = Math.min(d, a === 'pop' ? 0.18 : a === 'bounce' ? 0.22 : a === 'zoom-in' ? 0.2 : 0.25);
  const dOut = Math.min(d, 0.22);
  if (e <= s + dIn + dOut) return null;
  if (a === 'pop' || a === 'bounce' || a === 'zoom-in') {
    return `if(lt(t,${s}),0,if(lt(t,${round3(s + dIn)}),((t-${s})/${dIn})*((t-${s})/${dIn}),if(lt(t,${round3(e - dOut)}),1,(${e}-t)/${dOut})))`;
  }
  // slide-up / slide-down: alpha ramps in while y moves
  return `if(lt(t,${s}),0,if(lt(t,${round3(s + d)}),(t-${s})/${d},if(lt(t,${round3(e - d)}),1,(${e}-t)/${d})))`;
}

/** Optional y-offset expression for slide-up / slide-down text anims (px). Exported for tests. */
export function buildTextY(anim, start, animDur = 0.3, baseY = '(h-text_h)*50/100') {
  const a = normalizeTextAnim(anim);
  if (a !== 'slide-up' && a !== 'slide-down') return baseY;
  const s = round3(Number(start) || 0);
  const d = Math.max(0.05, round3(Number(animDur) || 0.3));
  const dist = a === 'slide-up' ? 48 : -48;
  // offset from +dist → 0 over [s, s+d]
  return `${baseY}+${dist}*max(0,1-(t-${s})/${d})`;
}

/** Horizontal x expression for drawtext (align-aware). Exported for tests. */
export function buildTextX(align, xPct, padX) {
  const a = normalizeTextAlign(align);
  const p = Math.max(0, Math.round(Number(padX) || 0));
  if (a === 'left') return `${p}`;
  if (a === 'right') return `w-text_w-${p}`;
  const x = Math.min(100, Math.max(0, Number(xPct ?? 50)));
  return `(w-text_w)*${round3(x)}/100`;
}

/* ------------------------------ stage builders -------------------------- */

/**
 * FFmpeg filter to place a video/image source into a pw×ph pane.
 * Mirrors preview: object-fit (cover|contain|fill) + object-position + CSS scale(zoom).
 * - cover: fill pane, crop excess around focus (default)
 * - contain: fit inside, black bars, focus shifts letterbox
 * - fill: stretch to exact size
 * - scale: zoom in (>1) crops tighter; zoom out (<1) letterboxes
 */
export function buildFitFilter(clip, pw, ph) {
  const { fit, scale, posX, posY } = normalizeTransform(clip || {});
  const W = Math.max(2, Math.round(pw));
  const H = Math.max(2, Math.round(ph));
  const kf = clip?.keyframes || {};
  const zExpr = Array.isArray(kf.scale) && kf.scale.length ? keyframeExpr(kf.scale, scale, 0) : null;
  const pxExpr = Array.isArray(kf.posX) && kf.posX.length ? keyframeExpr(kf.posX, posX, 0) : null;
  const pyExpr = Array.isArray(kf.posY) && kf.posY.length ? keyframeExpr(kf.posY, posY, 0) : null;

  if (zExpr || pxExpr || pyExpr) {
    const z = zExpr || String(scale);
    const px = pxExpr || String(posX);
    const py = pyExpr || String(posY);
    if (fit === 'fill') {
      return `scale=w='max(floor(${W}*(${z})),2)':h='max(floor(${H}*(${z})),2)'`
        + `,pad=${W}:${H}:x='max(floor((${W}-iw)*(${px})/100),0)':y='max(floor((${H}-ih)*(${py})/100),0)'`
        + `,crop=${W}:${H}:x='min(max(floor((iw-${W})*(${px})/100),0),max(iw-${W},0))':y='min(max(floor((ih-${H})*(${py})/100),0),max(ih-${H},0))'`;
    }
    if (fit === 'contain') {
      return `scale=w='max(floor(${W}*(${z})),2)':h='max(floor(${H}*(${z})),2)':force_original_aspect_ratio=decrease`
        + `,pad=${W}:${H}:x='max(floor((${W}-iw)*(${px})/100),0)':y='max(floor((${H}-ih)*(${py})/100),0)'`;
    }
    return `scale=w='max(floor(${W}*(${z})),2)':h='max(floor(${H}*(${z})),2)':force_original_aspect_ratio=increase`
      + `,crop=w='min(${W},iw)':h='min(${H},ih)':x='min(max(floor((iw-${W})*(${px})/100),0),max(iw-${W},0))':y='min(max(floor((ih-${H})*(${py})/100),0),max(ih-${H},0))'`
      + `,pad=${W}:${H}:x='max(floor((${W}-iw)*(${px})/100),0)':y='max(floor((${H}-ih)*(${py})/100),0)'`;
  }

  const z = Math.max(0.25, Math.min(4, scale || 1));
  const px = Math.min(100, Math.max(0, posX));
  const py = Math.min(100, Math.max(0, posY));

  let base;
  if (fit === 'fill') {
    base = `scale=${W}:${H}`;
  } else if (fit === 'contain') {
    base = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:floor((ow-iw)*${px}/100):floor((oh-ih)*${py}/100):color=black`;
  } else {
    base = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:floor((iw-${W})*${px}/100):floor((ih-${H})*${py}/100)`;
  }
  if (Math.abs(z - 1) < 1e-6) return base;

  if (z > 1) {
    const zw = Math.round(W * z);
    const zh = Math.round(H * z);
    return `${base},scale=${zw}:${zh},crop=${W}:${H}:floor((${zw}-${W})*${px}/100):floor((${zh}-${H})*${py}/100)`;
  }
  const zw = Math.max(2, Math.round(W * z));
  const zh = Math.max(2, Math.round(H * z));
  return `${base},scale=${zw}:${zh},pad=${W}:${H}:floor((${W}-${zw})*${px}/100):floor((${H}-${zh})*${py}/100):color=black`;
}

/** FFmpeg atempo only accepts 0.5–2.0 — chain filters for wider speeds. */
export function atempoChain(speed) {
  let s = Number(speed);
  if (!Number.isFinite(s) || s <= 0 || Math.abs(s - 1) < 1e-6) return [];
  const parts = [];
  let guard = 0;
  while (s > 2.0 && guard < 8) { parts.push('atempo=2.0'); s /= 2; guard++; }
  while (s < 0.5 && guard < 8) { parts.push('atempo=0.5'); s /= 0.5; guard++; }
  if (Math.abs(s - 1) > 1e-6) parts.push(`atempo=${round3(s)}`);
  return parts;
}

/** Program segments: v1 clips + black gaps covering [0, duration]. */
export function buildProgramSegments(timeline, duration) {
  const v1 = getTrack(timeline, 'v1');
  const hidden = v1.hidden;
  const clips = hidden ? [] : [...v1.clips].sort((a, b) => a.start - b.start);
  const segments = [];
  let cursor = 0;
  for (const clip of clips) {
    if (clip.start > cursor + EPS) {
      segments.push({ type: 'gap', start: round3(cursor), duration: round3(clip.start - cursor) });
    }
    segments.push({ type: 'clip', start: clip.start, duration: clip.duration, clip });
    cursor = clipEnd(clip);
  }
  if (cursor < duration - EPS) {
    segments.push({ type: 'gap', start: round3(cursor), duration: round3(duration - cursor) });
  }
  return segments;
}

export function overlayClipsOf(timeline) {
  const split = isSplitLayout(timeline);
  const out = [];
  for (const trackId of ['v2', 'v3']) {
    // In split mode, v3 is the second pane — not a floating overlay.
    if (split && trackId === 'v3') continue;
    const track = getTrack(timeline, trackId);
    if (track.hidden) continue;
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      out.push({ trackId, clip });
    }
  }
  return out;
}

/** Split-screen sources: pane A from v1, pane B from v3 (video/image). */
export function splitPaneClipsOf(timeline) {
  if (!isSplitLayout(timeline)) return { primary: [], secondary: [] };
  const collect = (trackId) => {
    const track = getTrack(timeline, trackId);
    if (track.hidden) return [];
    return [...track.clips]
      .filter((c) => c.kind === 'video' || c.kind === 'image')
      .sort((a, b) => a.start - b.start)
      .map((clip) => ({ trackId, clip }));
  };
  return { primary: collect('v1'), secondary: collect('v3') };
}

export function textClipsOf(timeline) {
  const out = [];
  for (const trackId of ['t1', 't2']) {
    const track = getTrack(timeline, trackId);
    if (track.hidden) continue;
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      const content = sanitizeTextContent(clip.text?.content || '');
      if (content) out.push({ trackId, clip, content });
    }
  }
  return out;
}

export function audioClipsOf(timeline) {
  const out = [];
  for (const trackId of ['a1', 'a2', 'a3']) {
    const track = getTrack(timeline, trackId);
    if (track.muted) continue;
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      if (!clip.muted && clip.volume > 0) out.push({ trackId, clip });
    }
  }
  return out;
}

/** Audio extracted from video program clips (their own sound). */
export function videoClipAudios(timeline) {
  const split = isSplitLayout(timeline);
  const trackIds = split ? ['v1', 'v3'] : ['v1'];
  const out = [];
  for (const trackId of trackIds) {
    const track = getTrack(timeline, trackId);
    if (track.hidden || track.muted) continue;
    for (const c of track.clips) {
      if (c.kind === 'video' && !c.muted && c.volume > 0) out.push(c);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/* ------------------------------ main render ---------------------------- */

const STAGE_WEIGHTS = [
  ['validate', 2],
  ['media_prep', 48],
  ['composite', 45],
  ['outputs', 5],
];

/**
 * Render a project.
 * quality: 'preview' (fast/low quality) | 'final'
 * onProgress({ stage, stagePct, overallPct, message })
 * signal: AbortSignal for cancellation
 */
export async function renderProject({ projectId, quality = 'final', onProgress = () => {}, signal = null }) {
  const settings = getSettings();
  const ffmpegBin = resolveFfmpeg(settings);
  const started = Date.now();
  const project = getProject(projectId);
  if (!project) throw new RenderError('Project not found.', { stage: 'validate' });
  ensureProjectDirs(projectId);

  const timeline = readTimeline(projectId);
  if (!timeline) throw new RenderError('timeline.json is missing or unreadable.', { stage: 'validate' });

  const stageIndex = Object.fromEntries(STAGE_WEIGHTS.map(([s], i) => [s, i]));
  let completedWeight = 0;
  const stageStarted = {};
  const report = (stage, stagePct, message = '') => {
    const weight = STAGE_WEIGHTS.find(([s]) => s === stage)?.[1] ?? 0;
    const prior = STAGE_WEIGHTS.slice(0, stageIndex[stage]).reduce((a, [, w]) => a + w, 0);
    const overall = Math.min(99, Math.round(prior + (weight * Math.min(1, Math.max(0, stagePct))) ));
    onProgress({ stage, stagePct: Math.round(stagePct * 100), overallPct: overall, message });
  };
  const beginStage = (stage) => {
    stageStarted[stage] = Date.now();
    log({ job: projectId, stage, status: 'START', quality });
    report(stage, 0);
  };
  const endStage = (stage, status = 'PASS') => {
    log({ job: projectId, stage, status, durationMs: Date.now() - (stageStarted[stage] || Date.now()) });
  };

  const workDir = join(DIRS.work, `${projectId}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  try {
    /* --- validate --- */
    beginStage('validate');
    const { duration, assets } = validateForRender(project, timeline);
    const W = timeline.width || project.width;
    const H = timeline.height || project.height;
    const FPS = timeline.fps || project.fps;
    const layoutMode = getLayoutMode(timeline);
    const panes = splitPanes(W, H, layoutMode);
    const split = !!panes;
    endStage('validate');

    const isPreview = quality === 'preview';
    const outDir = isPreview ? join(projectDirOf(projectId), 'previews') : join(projectDirOf(projectId), 'exports');
    mkdirSync(outDir, { recursive: true });
    const outFile = isPreview ? join(outDir, 'preview.mp4') : join(outDir, 'final.mp4');
    assertInsideData(outFile, 'output');

    /* --- media prep --- */
    beginStage('media_prep');
    const inputArgs = [];      // shared input list for composite
    const segmentInputs = [];  // { kind: 'file'|'lavfi', index }
    let inputCount = 0;

    const crfPrep = '18';
    /** Encode one media clip to an intermediate sized for a pane (or full frame). */
    const prepPaneClip = async (clip, pane, tag) => {
      const { path } = assets[clip.assetId];
      const pw = Math.max(2, pane ? pane.w : W);
      const ph = Math.max(2, pane ? pane.h : H);
      const inter = join(workDir, `pane-${tag}-${clip.id}.mp4`);
      const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
      const srcDur = Math.max(0.05, clip.duration * speed);
      const fit = buildFitFilter(clip, pw, ph);
      const fx = buildEffectFilter(clip);
      const opacityKfs = clip.keyframes?.opacity;
      const tr = normalizeTransition(clip.transitionIn);
      let alpha = '';
      if (Array.isArray(opacityKfs) && opacityKfs.length) {
        // Local t (after setpts) → clip-local times; bake opacity toward black on yuv.
        alpha = `,geq=y='clip(floor(lum(X,Y)*(${keyframeExpr(opacityKfs, 1, 0)})),0,255)':cb='cb(X,Y)':cr='cr(X,Y)'`;
      } else if (tr !== 'none') {
        const d = 0.3;
        if (tr === 'flash') alpha = `,fade=t=in:st=0:d=${d}:color=white`;
        else if (tr === 'fade' || tr === 'dip') alpha = `,fade=t=in:st=0:d=${d}`;
        else if (tr === 'zoom' || tr === 'slide') alpha = `,fade=t=in:st=0:d=0.15`;
      }
      // Order: fit → effect → setpts (speed) → opacity/transition → fps/format.
      const mid = [];
      if (clip.kind !== 'image' && speed !== 1) mid.push(`setpts=PTS/${speed}`);
      const chain = [fit, fx, ...mid].filter(Boolean).join(',') + alpha;
      const vf = `${chain},fps=${FPS},setsar=1,format=yuv420p`;
      const args =
        clip.kind === 'image'
          ? ['-y', '-loop', '1', '-t', String(clip.duration), '-i', path, '-an',
             '-vf', vf, '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', crfPrep, inter]
          : ['-y', '-ss', String(clip.srcIn), '-t', String(srcDur), '-i', path, '-an',
             '-vf', vf, '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', crfPrep, inter];
      await run(ffmpegBin, args, { timeoutMs: settings.jobTimeoutMs, signal });
      return inter;
    };

    // Split: black base + pane-sized clips for v1 (A) and v3 (B).
    // Full mode: classic v1 program segments (concat).
    const splitPrep = { primary: [], secondary: [] };
    if (split) {
      inputArgs.push('-f', 'lavfi', '-t', String(duration), '-i', `color=c=black:s=${W}x${H}:r=${FPS}`);
      segmentInputs.push({ kind: 'lavfi' });
      inputCount = 1;

      const { primary, secondary } = splitPaneClipsOf(timeline);
      const paneA = panes[0];
      const paneB = panes[1];
      for (let i = 0; i < primary.length; i++) {
        if (signal?.aborted) throw new RenderError('Render cancelled.', { stage: 'media_prep' });
        const { clip } = primary[i];
        const inter = await prepPaneClip(clip, paneA, 'a');
        splitPrep.primary.push({ clip, inter, pane: paneA });
        report('media_prep', 0.15 + 0.35 * ((i + 1) / Math.max(1, primary.length + secondary.length)));
      }
      for (let i = 0; i < secondary.length; i++) {
        if (signal?.aborted) throw new RenderError('Render cancelled.', { stage: 'media_prep' });
        const { clip } = secondary[i];
        const inter = await prepPaneClip(clip, paneB, 'b');
        splitPrep.secondary.push({ clip, inter, pane: paneB });
        report('media_prep', 0.15 + 0.7 * ((primary.length + i + 1) / Math.max(1, primary.length + secondary.length)));
      }
      // intermediates become composite inputs (after black base)
      for (const item of [...splitPrep.primary, ...splitPrep.secondary]) {
        inputArgs.push('-i', item.inter);
        item.inputIndex = inputCount++;
        segmentInputs.push({ kind: 'file' });
      }
      // segmentInputs[0] is black; pane inputs follow — composite must not concat panes as program.
      // Mark that program concat should only use the black base (index 0).
    } else {
      const segments = buildProgramSegments(timeline, duration);
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (signal?.aborted) throw new RenderError('Render cancelled.', { stage: 'media_prep' });
        if (seg.type === 'gap') {
          inputArgs.push('-f', 'lavfi', '-t', String(seg.duration), '-i', `color=c=black:s=${W}x${H}:r=${FPS}`);
          segmentInputs.push({ kind: 'lavfi' });
        } else {
          const inter = await prepPaneClip(seg.clip, null, 'seg');
          inputArgs.push('-i', inter);
          segmentInputs.push({ kind: 'file' });
        }
        inputCount++;
        report('media_prep', (i + 1) / segments.length);
      }
    }

    // audio wavs: program video audio + A1/A2/A3 clips
    const audioPlan = []; // { inputIndex, start, }
    const pushWav = async (clip, assetPath, label) => {
      const wav = join(workDir, `aud-${label}-${clip.id}.wav`);
      const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
      const srcDur = Math.max(0.05, clip.duration * speed);
      const af = [];
      if (speed !== 1) af.push(...atempoChain(speed));
      const volKfs = clip.keyframes?.volume;
      if (Array.isArray(volKfs) && volKfs.length) {
        // After atempo, timeline local t starts at 0 for this wav.
        af.push(`volume=volume='${keyframeExpr(volKfs, clip.volume, 0)}':eval=frame`);
      } else {
        af.push(`volume=${clip.volume}`);
      }
      const fi = Math.max(0, Number(clip.fadeIn) || 0);
      const fo = Math.max(0, Number(clip.fadeOut) || 0);
      if (fi > 0) af.push(`afade=t=in:st=0:d=${round3(fi)}`);
      if (fo > 0) af.push(`afade=t=out:st=${round3(Math.max(0, clip.duration - fo))}:d=${round3(fo)}`);
      await run(ffmpegBin, [
        '-y', '-ss', String(clip.srcIn), '-t', String(srcDur), '-i', assetPath,
        '-af', af.join(','),
        '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', wav,
      ], { timeoutMs: settings.jobTimeoutMs, signal });
      inputArgs.push('-i', wav);
      audioPlan.push({ index: inputCount++, start: clip.start });
    };

    for (const clip of videoClipAudios(timeline)) {
      const a = assets[clip.assetId];
      if (a.asset.hasAudio === false) continue;
      // verify quickly that audio stream exists
      if (a.asset.meta && a.asset.meta.hasAudio === false) continue;
      await pushWav(clip, a.path, 'prog');
      report('media_prep', 0.9);
    }
    for (const clip of audioClipsOf(timeline)) {
      const a = assets[clip.assetId];
      await pushWav(clip, a.path, clip.kind === 'audio' ? 'aud' : 'aud');
      report('media_prep', 0.95);
    }

    let hasUserAudio = audioPlan.length > 0;
    if (!hasUserAudio) {
      inputArgs.push('-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=48000:cl=stereo');
      audioPlan.push({ index: inputCount++, start: 0, silence: true });
    }
    endStage('media_prep');

    /* --- composite: concat + overlays + drawtext + audio mix --- */
    beginStage('composite');
    const filters = [];
    let videoLabel = 'vc';

    const addFloatingOverlay = (clip, baseLabel) => {
      const { path } = assets[clip.assetId];
      const ov = clip.overlay || { xPct: 50, yPct: 50, widthPct: 30 };
      const targetW = Math.max(16, Math.round((W * ov.widthPct) / 100));
      const idx = inputCount++;
      if (clip.kind === 'image') {
        inputArgs.push('-loop', '1', '-t', String(clip.duration), '-i', path);
        filters.push(
          `[${idx}:v]scale=${targetW}:-2,format=rgba,fps=${FPS},setsar=1,setpts=PTS-STARTPTS+${clip.start}/TB[ov${idx}]`
        );
      } else {
        inputArgs.push('-ss', String(clip.srcIn), '-t', String(clip.duration), '-i', path);
        filters.push(
          `[${idx}:v]trim=0:${clip.duration},setpts=PTS-STARTPTS,scale=${targetW}:-2,format=rgba,fps=${FPS},setsar=1,setpts=PTS+${clip.start}/TB[ov${idx}]`
        );
      }
      filters.push(
        `[${baseLabel}][ov${idx}]overlay=x=(main_w-overlay_w)*${ov.xPct}/100:y=(main_h-overlay_h)*${ov.yPct}/100:eof_action=pass[vo${idx}]`
      );
      return `vo${idx}`;
    };

    if (split) {
      // Black base (input 0) → [vc]; overlay pane intermediates at 50/50 rects.
      filters.push(`[0:v]fps=${FPS},setsar=1,format=yuv420p[vc]`);
      videoLabel = 'vc';
      let n = 0;
      const placePane = (items) => {
        for (const item of items) {
          const { clip, pane, inputIndex } = item;
          const start = round3(clip.start);
          const end = round3(clipEnd(clip));
          filters.push(
            `[${inputIndex}:v]trim=0:${round3(clip.duration)},setpts=PTS-STARTPTS+${start}/TB,format=rgba,fps=${FPS},setsar=1[pn${n}]`
          );
          filters.push(
            `[${videoLabel}][pn${n}]overlay=${pane.x}:${pane.y}:eof_action=pass:enable='between(t,${start},${end})'[po${n}]`
          );
          videoLabel = `po${n}`;
          n++;
        }
      };
      placePane(splitPrep.primary);
      placePane(splitPrep.secondary);
      // Floating PiP overlays: only v2 in split mode (v3 is pane B)
      for (const { clip } of overlayClipsOf(timeline)) {
        videoLabel = addFloatingOverlay(clip, videoLabel);
      }
    } else {
      // normalize + concat program segments
      segmentInputs.forEach((seg, k) => {
        filters.push(`[${k}:v]fps=${FPS},setsar=1,format=yuv420p,setsar=1[p${k}]`);
      });
      if (segmentInputs.length === 0) {
        inputArgs.unshift('-f', 'lavfi', '-t', String(duration), '-i', `color=c=black:s=${W}x${H}:r=${FPS}`);
        for (const ap of audioPlan) ap.index += 1;
        segmentInputs.push({ kind: 'lavfi' });
        inputCount++;
        filters.push(`[0:v]fps=${FPS},setsar=1,format=yuv420p[p0]`);
        videoLabel = 'p0';
      } else if (segmentInputs.length === 1) {
        filters.push(`[p0]null[vc]`);
        videoLabel = 'vc';
      } else {
        const inputs = segmentInputs.map((_, k) => `[p${k}]`).join('');
        filters.push(`${inputs}concat=n=${segmentInputs.length}:v=1:a=0[vc]`);
        videoLabel = 'vc';
      }

      for (const { clip } of overlayClipsOf(timeline)) {
        videoLabel = addFloatingOverlay(clip, videoLabel);
      }
    }

    // text / captions
    const textClips = textClipsOf(timeline);
    if (textClips.length && !detectFontFile()) {
      throw new RenderError('No usable font file found for text rendering. Install a system font (e.g. Arial, DejaVu Sans).', { stage: 'composite' });
    }
    textClips.forEach((t, i) => {
      const txtFile = join(workDir, `txt-${i}.txt`);
      const rawContent = t.content || '';
      const spec = t.clip.text || {};
      const fontFile = detectFontFile(spec.font) || detectFontFile();
      if (!fontFile) {
        throw new RenderError(`No font file found for "${spec.font || 'Arial'}".`, { stage: 'composite' });
      }
      const content = spec.uppercase ? rawContent.toUpperCase() : rawContent;
      writeFileSync(txtFile, content, 'utf8');
      const preset = PRESET_POS[spec.position] || PRESET_POS.center;
      const xPct = spec.xPct != null ? spec.xPct : preset.x;
      const yPct = spec.yPct != null ? spec.yPct : preset.y;
      const size = Math.round(Number(spec.size) || 64);
      const start = t.clip.start;
      const end = clipEnd(t.clip);
      const enable = `enable='between(t,${start},${end})'`;
      const bgMode = BG_MODES.includes(spec.bgMode) ? spec.bgMode : (spec.bg ? 'inline' : 'none');
      const box = bgColor(spec.bg) || (bgMode === 'full' ? 'white' : null);
      const padX = Math.max(0, Math.round(Number(spec.padX) ?? (bgMode === 'full' ? 40 : 14)));
      const padY = Math.max(0, Math.round(Number(spec.padY) ?? (bgMode === 'full' ? 22 : 10)));
      const align = normalizeTextAlign(spec.align);
      const strokeW = Math.max(0, Math.min(16, Math.round(Number(spec.strokeWidth) || 0)));
      const ls = Math.max(0, Math.round(Number(spec.letterSpacing) || 0));
      const alphaExpr = buildTextAlpha(spec.anim, start, end, spec.animDur);
      const yBase = `(h-text_h)*${round3(yPct)}/100`;
      const yExpr = buildTextY(spec.anim, start, spec.animDur, yBase);

      const drawCommon = [
        `fontfile='${escFilterPath(fontFile)}'`,
        `textfile='${escFilterPath(txtFile)}'`,
        `fontsize=${size}`,
        `fontcolor=${hexColor(spec.color)}`,
        // stroke/outline (premium meme look)
        `borderw=${strokeW > 0 ? strokeW : (spec.bold === false ? 0 : 0)}`,
        `bordercolor=${strokeW > 0 ? hexColor(spec.strokeColor, '0x000000') : 'black@0'}`,
        // soft drop shadow
        spec.shadow ? 'shadowx=3' : 'shadowx=0',
        spec.shadow ? 'shadowy=3' : 'shadowy=0',
        spec.shadow ? `shadowcolor=${hexColor(spec.strokeColor, '0x000000')}@0.75` : 'shadowcolor=black@0',
        `line_spacing=${Math.round(size * 0.12)}`,
        `x=${buildTextX(align, xPct, bgMode === 'full' ? padX : 8)}`,
        `y=${yExpr}`,
        enable,
      ];
      // note: this FFmpeg 9.0.2 build has no drawtext letter_spacing option — keep spacing in preview only
      void ls;
      if (alphaExpr) drawCommon.push(`alpha='${alphaExpr}'`);

      // Full-width top/banner strip: drawbox sized to real word-wrap, then text.
      if (bgMode === 'full' && box) {
        const widthPct = Math.min(100, Math.max(10, Number(spec.widthPct) || 100));
        const boxW = Math.max(24, Math.round((W * widthPct) / 100));
        // Left-align with canvas for widthPct=100; otherwise center on xPct.
        const boxX = widthPct >= 99.5 ? 0 : Math.round((W - boxW) * Math.min(100, Math.max(0, Number(xPct ?? 50))) / 100);
        const lines = estimateBannerLines(content, size, boxW, padX, ls);
        const bannerH = bannerBoxHeight(lines, size, padY);
        // Anchor strip so text's optical center sits at yPct (preview matches).
        const boxY = `floor(h*${round3(yPct)}/100 - ${bannerH}/2)`;
        const boxColor = box.includes('@') ? box : `${box}@1`;
        filters.push(
          `[${videoLabel}]drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${bannerH}:color=${boxColor}:t=fill:${enable}[bx${i}]`
        );
        videoLabel = `bx${i}`;
        // Horizontal: keep text inside the strip (not full canvas).
        let xCommon;
        if (widthPct >= 99.5) {
          xCommon = `x=${buildTextX(align, xPct, padX)}`;
        } else if (align === 'left') {
          xCommon = `x=${boxX + padX}`;
        } else if (align === 'right') {
          xCommon = `x=${boxX + boxW}-text_w-${padX}`;
        } else {
          xCommon = `x=${boxX}+(boxW-text_w)*50/100`.replace('boxW', String(boxW));
        }
        // Vertical: center text in the strip (more reliable than pure yPct when multi-line).
        const slideOff = (spec.anim === 'slide-up' || spec.anim === 'slide-down')
          ? `+${spec.anim === 'slide-up' ? 48 : -48}*max(0,1-(t-${round3(start)})/${Math.max(0.05, round3(Number(spec.animDur) || 0.3))})`
          : '';
        const opts = drawCommon.map((o) => {
          if (o.startsWith('y=')) return `y=${boxY}+(${bannerH}-text_h)/2${slideOff}`;
          if (o.startsWith('x=')) return xCommon;
          return o;
        });
        filters.push(`[${videoLabel}]drawtext=${opts.join(':')}[tx${i}]`);
        videoLabel = `tx${i}`;
        return;
      }

      const opts = [...drawCommon];
      if (box && bgMode === 'inline') {
        opts.push('box=1', `boxcolor=${box}`, `boxborderw=${Math.max(6, padY)}`);
      }
      // Without explicit stroke, classic bold outline via thin black border.
      if (strokeW === 0 && spec.bold !== false && bgMode === 'none') {
        const bw = Math.max(2, Math.round(size * 0.045));
        opts[4] = `borderw=${bw}`;
        opts[5] = 'bordercolor=black@0.92';
      }
      filters.push(`[${videoLabel}]drawtext=${opts.join(':')}[tx${i}]`);
      videoLabel = `tx${i}`;
    });
    if (videoLabel === 'vc' || videoLabel === 'p0') {
      filters.push(`[${videoLabel}]null[vout]`);
    } else {
      filters.push(`[${videoLabel}]null[vout]`);
    }

    // audio mix
    let audioLabel;
    if (audioPlan.length === 1 && audioPlan[0].silence) {
      filters.push(`[${audioPlan[0].index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad[aout]`);
      audioLabel = 'aout';
    } else {
      const parts = audioPlan.map((ap) => {
        const delayMs = Math.round(ap.start * 1000);
        if (ap.silence) return `[${ap.index}:a]`;
        return `[${ap.index}:a]adelay=delays=${delayMs}:all=1[a${ap.index}]`;
      });
      // rewrite with labels
      const labeled = audioPlan.map((ap) => {
        if (ap.silence) return `[${ap.index}:a]`;
        const delayMs = Math.round(ap.start * 1000);
        filters.push(`[${ap.index}:a]adelay=delays=${delayMs}:all=1[ad${ap.index}]`);
        return `[ad${ap.index}]`;
      });
      filters.push(
        `${labeled.join('')}amix=inputs=${labeled.length}:normalize=0:duration=longest,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad[aout]`
      );
      audioLabel = 'aout';
      void parts;
    }

    const exp = settings.export || {};
    const outArgs = [
      ...inputArgs,
      '-filter_complex', filters.join(';'),
      '-map', '[vout]',
      '-map', `[${audioLabel}]`,
      '-c:v', exp.videoCodec || 'libx264',
      '-preset', isPreview ? 'ultrafast' : exp.preset || 'medium',
      '-crf', String(isPreview ? 32 : exp.crf ?? 20),
      '-pix_fmt', 'yuv420p',
      '-r', String(FPS),
      '-c:a', exp.audioCodec || 'aac',
      '-b:a', isPreview ? '128k' : exp.audioBitrate || '192k',
      '-ar', '48000',
      '-t', String(duration),
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      '-nostats',
      '-y',
      outFile,
    ];

    await run(ffmpegBin, outArgs, {
      timeoutMs: settings.jobTimeoutMs,
      signal,
      onProgress: (map) => {
        const sec = progressSeconds(map);
        if (sec != null && duration > 0) report('composite', sec / duration);
      },
    });
    endStage('composite');
    report('composite', 1);

    /* --- outputs: thumbnail, captions.srt, timeline copy, qc (final only) --- */
    beginStage('outputs');
    const outputs = [isPreview ? 'preview.mp4' : 'final.mp4'];

    if (!isPreview) {
      const thumbOut = join(outDir, 'thumbnail.jpg');
      const tSec = Math.min(Math.max(duration / 2, 0.3), 2);
      await run(ffmpegBin, ['-y', '-ss', String(tSec), '-i', outFile, '-frames:v', '1', '-vf', `scale=${W}:-2`, '-q:v', '3', thumbOut], {
        timeoutMs: 60 * 1000,
        signal,
      });
      outputs.push('thumbnail.jpg');

      const srt = buildSrt(textClips.filter((t) => t.trackId === 't2' || t.clip.text?.role === 'caption' || t.clip.text?.role === 'subtitle'));
      const srtFile = join(outDir, 'captions.srt');
      writeFileSync(srtFile, srt, 'utf8');
      outputs.push('captions.srt');

      writeFileSync(join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2), 'utf8');
      outputs.push('timeline.json');

      const caption = captionForProject(project, timeline);
      writeFileSync(join(outDir, 'caption.txt'), caption, 'utf8');
      outputs.push('caption.txt');
    } else {
      outputs.push('thumbnail.jpg');
      await run(ffmpegBin, ['-y', '-i', outFile, '-frames:v', '1', '-vf', `scale=${W}:-2`, '-q:v', '4', join(outDir, 'preview-thumb.jpg')], {
        timeoutMs: 60 * 1000,
        signal,
      });
    }

    const meta = await probeMedia(resolveFfprobe(settings), outFile);
    endStage('outputs');

    log({ job: projectId, stage: 'render', status: 'PASS', quality, durationMs: Date.now() - started, outFile });
    return {
      quality,
      outFile,
      outRel: isPreview ? 'previews/preview.mp4' : 'exports/final.mp4',
      outputs,
      duration: round3(duration),
      meta: meta.meta,
      fileDuration: meta.meta.duration,
      hasUserAudio,
      wallMs: Date.now() - started,
    };
  } catch (err) {
    log({ job: projectId, stage: 'render', status: 'FAIL', quality, error: String(err?.message || err), detail: err?.detail || '' });
    // keep work dir on failure for debugging? clean to avoid disk fill; logs hold stderr.
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  } finally {
    try {
      if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

function projectDirOf(id) {
  return join(DIRS.projects, id);
}

export function buildSrt(entries) {
  const fmt = (sec) => {
    const ms = Math.max(0, Math.round(sec * 1000));
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    const mm = String(ms % 1000).padStart(3, '0');
    return `${h}:${m}:${s},${mm}`;
  };
  const lines = [];
  entries.forEach((e, i) => {
    lines.push(String(i + 1));
    lines.push(`${fmt(e.clip.start)} --> ${fmt(clipEnd(e.clip))}`);
    lines.push(e.content);
    lines.push('');
  });
  return lines.join('\n');
}

/** Quick single-frame preview image of a timeline second (cheap server-side poster). */
export async function frameAt(projectId, seconds, outFile) {
  const settings = getSettings();
  const timeline = readTimeline(projectId);
  const segments = buildProgramSegments(timeline, timelineDuration(timeline));
  // find which segment covers `seconds` — render from source directly when it's a program clip
  let cursor = 0;
  for (const seg of segments) {
    const end = cursor + seg.duration;
    if (seconds >= cursor && seconds < end) {
      if (seg.type === 'gap') {
        await run(resolveFfmpeg(settings), [
          '-y', '-f', 'lavfi', '-i', `color=c=black:s=1080x1920:r=30`, '-frames:v', '1', '-ss', '0', outFile,
        ], { timeoutMs: 30000 });
        return outFile;
      }
      const clip = seg.clip;
      const sp = clip.speed > 0 ? clip.speed : 1;
      const at = clip.srcIn + (seconds - cursor) * sp;
      const asset = getMedia(clip.assetId);
      const path = mediaAbsolutePath(asset);
      await run(resolveFfmpeg(settings), [
        '-y', '-ss', String(at), '-i', path, '-frames:v', '1',
        '-vf', [buildFitFilter(clip, 1080, 1920), buildEffectFilter(clip)].filter(Boolean).join(','),
        '-q:v', '4', outFile,
      ], { timeoutMs: 30000 });
      return outFile;
    }
    cursor = end;
  }
  // outside program: black frame
  await run(resolveFfmpeg(settings), [
    '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1080x1920', '-frames:v', '1', outFile,
  ], { timeoutMs: 30000 });
  return outFile;
}

export { execFileSync, readFileSync, readdirSync, unlinkSync };
