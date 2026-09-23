/**
 * AI Reel Studio — universal timeline operations (shared: server, client, tests).
 * Pure ES module. Mutating ops validate first, then mutate. Errors: TimelineError {code}.
 */

export const MIN_CLIP = 0.1;
export const EPS = 1e-6;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
export const FIT_MODES = ['cover', 'contain', 'fill'];
export const LAYOUT_MODES = ['none', 'split-h', 'split-v'];
export const EFFECTS = ['none', 'bw', 'sepia', 'warm', 'cool', 'vivid', 'vintage', 'teal', 'golden', 'noir', 'neon', 'luxury'];
export const BG_MODES = ['none', 'inline', 'full'];
export const TEXT_ANIMS = ['none', 'fade', 'pop', 'slide-up', 'slide-down', 'bounce', 'zoom-in'];
export const TEXT_ALIGNS = ['left', 'center', 'right'];
export const TEXT_FONTS = ['Arial', 'Impact', 'Georgia', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Segoe UI', 'Courier New'];
export const TRANSITIONS = ['none', 'fade', 'dip', 'flash', 'zoom', 'slide'];
export const KEYFRAME_PROPS = ['scale', 'posX', 'posY', 'opacity', 'volume'];
export const MAX_FADE_SEC = 10;

/** One-click premium text looks (merged onto clip.text). */
export const TEXT_PRESETS = {
  meme: {
    content: 'POV: your text here', role: 'hook', position: 'top',
    size: 64, color: '#000000', bg: '#ffffff', bgMode: 'full',
    bold: true, uppercase: true, italic: false,
    align: 'center', padX: 40, padY: 22,
    strokeWidth: 0, strokeColor: '#000000', shadow: false,
    letterSpacing: 0, anim: 'fade', animDur: 0.25,
    xPct: null, yPct: null,
  },
  news: {
    content: 'BREAKING', role: 'title', position: 'top',
    size: 52, color: '#ffffff', bg: '#c41e3a', bgMode: 'full',
    bold: true, uppercase: true, italic: false,
    align: 'left', padX: 48, padY: 18,
    strokeWidth: 0, strokeColor: '#000000', shadow: false,
    letterSpacing: 2, anim: 'fade', animDur: 0.2,
    xPct: null, yPct: null,
  },
  lower: {
    content: 'Your lower-third title', role: 'subtitle', position: 'bottom',
    size: 44, color: '#ffffff', bg: 'black@0.72', bgMode: 'inline',
    bold: true, uppercase: false, italic: false,
    align: 'left', padX: 24, padY: 14,
    strokeWidth: 0, strokeColor: '#000000', shadow: true,
    letterSpacing: 0, anim: 'fade', animDur: 0.3,
    xPct: 50, yPct: 78,
  },
  outline: {
    content: 'BOLD OUTLINE', role: 'hook', position: 'center',
    size: 96, color: '#ffe600', bg: '', bgMode: 'none',
    bold: true, uppercase: true, italic: false,
    align: 'center', padX: 20, padY: 12,
    strokeWidth: 8, strokeColor: '#000000', shadow: true,
    letterSpacing: 1, anim: 'pop', animDur: 0.35,
    xPct: 50, yPct: 48,
  },
  caption: {
    content: 'Caption line', role: 'caption', position: 'bottom',
    size: 40, color: '#ffffff', bg: 'black@0.55', bgMode: 'inline',
    bold: false, uppercase: false, italic: false,
    align: 'center', padX: 18, padY: 10,
    strokeWidth: 0, strokeColor: '#000000', shadow: false,
    letterSpacing: 0, anim: 'none', animDur: 0.25,
    xPct: 50, yPct: 86,
  },
  highlight: {
    content: 'HIGHLIGHT', role: 'quote', position: 'center',
    size: 72, color: '#111111', bg: '#ffe600', bgMode: 'inline',
    bold: true, uppercase: true, italic: false,
    align: 'center', padX: 28, padY: 16,
    strokeWidth: 0, strokeColor: '#000000', shadow: false,
    letterSpacing: 1, anim: 'pop', animDur: 0.3,
    xPct: 50, yPct: 50,
  },
};

export const TRACK_DEFS = [
  { id: 'v1', type: 'video', label: 'V1 Video', accepts: ['video', 'image'] },
  { id: 'v2', type: 'video', label: 'V2 Overlay', accepts: ['image'] },
  { id: 'v3', type: 'video', label: 'V3 Images', accepts: ['image', 'video'] },
  { id: 'a1', type: 'audio', label: 'A1 Voice', accepts: ['audio'] },
  { id: 'a2', type: 'audio', label: 'A2 Music', accepts: ['audio'] },
  { id: 'a3', type: 'audio', label: 'A3 SFX', accepts: ['audio'] },
  { id: 't1', type: 'text', label: 'T1 Text', accepts: ['text'] },
  { id: 't2', type: 'text', label: 'T2 Captions', accepts: ['text'] },
];

export class TimelineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TimelineError';
    this.code = code;
  }
}

export function round3(n) {
  return Math.round(n * 1000) / 1000;
}

export function uid(prefix = 'c') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createTimeline({ width = 1080, height = 1920, fps = 30 } = {}) {
  return {
    version: 1,
    width,
    height,
    fps,
    markers: [],
    layout: { mode: 'none' },
    tracks: TRACK_DEFS.map((t) => ({
      id: t.id,
      type: t.type,
      label: t.label,
      muted: false,
      hidden: false,
      locked: false,
      clips: [],
    })),
  };
}

export function getLayoutMode(timeline) {
  const mode = timeline?.layout?.mode;
  return LAYOUT_MODES.includes(mode) ? mode : 'none';
}

export function isSplitLayout(timeline) {
  return getLayoutMode(timeline) !== 'none';
}

/** Mutate timeline.layout.mode. mode: none | split-h (left|right) | split-v (top|bottom). */
export function setLayoutMode(timeline, mode) {
  if (!LAYOUT_MODES.includes(mode)) {
    throw new TimelineError('BAD_LAYOUT', `Unknown layout mode: ${mode} (use ${LAYOUT_MODES.join(', ')})`);
  }
  if (!timeline.layout || typeof timeline.layout !== 'object') timeline.layout = { mode: 'none' };
  timeline.layout.mode = mode;
  return timeline.layout;
}

/**
 * Two equal 50/50 panes for split layouts on a W×H canvas.
 * split-h → left | right · split-v → top | bottom · none → null.
 */
export function splitPanes(width, height, mode) {
  if (mode === 'none' || !LAYOUT_MODES.includes(mode)) return null;
  const W = Math.max(1, Math.round(Number(width) || 0));
  const H = Math.max(1, Math.round(Number(height) || 0));
  if (mode === 'split-h') {
    const leftW = Math.floor(W / 2);
    return [
      { id: 'a', x: 0, y: 0, w: leftW, h: H },
      { id: 'b', x: leftW, y: 0, w: W - leftW, h: H },
    ];
  }
  const topH = Math.floor(H / 2);
  return [
    { id: 'a', x: 0, y: 0, w: W, h: topH },
    { id: 'b', x: 0, y: topH, w: W, h: H - topH },
  ];
}

export function clampSpeed(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 1;
  return round3(Math.min(MAX_SPEED, Math.max(MIN_SPEED, v)));
}

export function clampZoom(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 1;
  return round3(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v)));
}

/** Normalize clip transform: fit mode, zoom, focus point (0–100). */
export function normalizeTransform(t = {}) {
  const fit = FIT_MODES.includes(t.fit) ? t.fit : 'cover';
  return {
    fit,
    scale: clampZoom(t.scale ?? 1),
    posX: clamp(Number(t.posX ?? 50), 0, 100),
    posY: clamp(Number(t.posY ?? 50), 0, 100),
  };
}

export function normalizeEffect(effect) {
  return EFFECTS.includes(effect) ? effect : 'none';
}

export function normalizeBgMode(mode) {
  return BG_MODES.includes(mode) ? mode : 'none';
}

export function normalizeTextAnim(anim) {
  return TEXT_ANIMS.includes(anim) ? anim : 'none';
}

export function clampFade(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return round3(Math.min(MAX_FADE_SEC, v));
}

export function normalizeTransition(t) {
  return TRANSITIONS.includes(t) ? t : 'none';
}

export function normalizeKeyframes(kf) {
  if (!kf || typeof kf !== 'object') return {};
  const out = {};
  for (const prop of KEYFRAME_PROPS) {
    const arr = kf[prop];
    if (!Array.isArray(arr) || !arr.length) continue;
    const pts = [];
    for (const p of arr) {
      if (!p) continue;
      const pt = Number(p.t);
      const pv = Number(p.v);
      if (!Number.isFinite(pt) || !Number.isFinite(pv)) continue;
      pts.push({ t: round3(Math.max(0, pt)), v: pv });
    }
    pts.sort((a, b) => a.t - b.t);
    if (pts.length) out[prop] = pts;
  }
  return out;
}

/** Linear-eval a keyframe track at clip-local time `localT`. Missing track → fallback. */
export function evalKeyframes(clip, localT, prop, fallback) {
  const kfs = clip?.keyframes?.[prop];
  if (!Array.isArray(kfs) || !kfs.length) return fallback;
  const t = Number(localT);
  if (!Number.isFinite(t)) return fallback;
  const first = kfs[0];
  const last = kfs[kfs.length - 1];
  if (t <= first.t) return first.v;
  if (t >= last.t) return last.v;
  for (let i = 1; i < kfs.length; i++) {
    const a = kfs[i - 1];
    const b = kfs[i];
    if (t <= b.t) {
      const span = b.t - a.t;
      if (span <= 1e-9) return b.v;
      return a.v + (b.v - a.v) * ((t - a.t) / span);
    }
  }
  return last.v;
}

/**
 * FFmpeg expression for keyframe points (clip-local times).
 * `clipStart` shifts local→absolute timeline time (`t` in most filters).
 * Exported for renderer + tests.
 */
export function keyframeExpr(points, fallback, clipStart = 0, varName = 't') {
  if (!Array.isArray(points) || !points.length) return String(fallback);
  const pts = points
    .filter((p) => p && Number.isFinite(Number(p.t)) && Number.isFinite(Number(p.v)))
    .map((p) => ({ t: round3(Number(p.t)), v: Number(p.v) }))
    .sort((a, b) => a.t - b.t);
  if (!pts.length) return String(fallback);
  const abs = (local) => round3((Number(clipStart) || 0) + local);
  let expr = formatExprNum(pts[pts.length - 1].v);
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i];
    const b = pts[i + 1];
    const ta = abs(a.t);
    const tb = abs(b.t);
    const span = round3(tb - ta);
    const seg = span <= 1e-9
      ? formatExprNum(b.v)
      : `${formatExprNum(a.v)}+(${formatExprNum(b.v)}-${formatExprNum(a.v)})*(${varName}-${ta})/${span}`;
    expr = `if(lt(${varName},${tb}),${seg},${expr})`;
  }
  const t0 = abs(pts[0].t);
  expr = `if(lt(${varName},${t0}),${formatExprNum(pts[0].v)},${expr})`;
  return expr;
}

function formatExprNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return String(round3(v));
}

/** Audio envelope gain 0–1 from fadeIn/fadeOut at clip-local time. */
export function fadeGain(clip, localT) {
  const dur = Number(clip?.duration) || 0;
  const t = Number(localT);
  if (!Number.isFinite(t)) return 1;
  const fi = clampFade(clip?.fadeIn);
  const fo = clampFade(clip?.fadeOut);
  let g = 1;
  if (fi > 0 && t < fi) g = Math.min(g, Math.max(0, t / fi));
  if (fo > 0 && dur > 0 && t > dur - fo) g = Math.min(g, Math.max(0, (dur - t) / fo));
  return g;
}

/** Preview opacity from transitionIn + optional opacity keyframes (clip-local time). */
export function transitionGain(clip, localT) {
  const tr = normalizeTransition(clip?.transitionIn);
  if (tr === 'none') return 1;
  const d = 0.3;
  const t = Number(localT);
  if (!Number.isFinite(t) || t >= d) return 1;
  if (t < 0) return 0;
  const u = t / d;
  if (tr === 'flash') return Math.min(1, u * 1.25);
  if (tr === 'zoom' || tr === 'slide') return Math.min(1, u * 1.4);
  // fade / dip → fade through black
  return u;
}

export function normalizeTextAlign(align) {
  return TEXT_ALIGNS.includes(align) ? align : 'center';
}

function hexOr(color, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(String(color || '')) ? String(color) : fallback;
}

/** Parse bg string (#rrggbb, name, name@alpha, #rrggbbaa) → CSS color or null. */
export function bgToCss(bg) {
  const s = String(bg || '');
  if (!s) return null;
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{8}$/.test(s)) {
    const a = parseInt(s.slice(7, 9), 16) / 255;
    const r = parseInt(s.slice(1, 3), 16);
    const g = parseInt(s.slice(3, 5), 16);
    const b = parseInt(s.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a.toFixed(3)})`;
  }
  const m = /^([a-z]+)@([0-9.]+)$/i.exec(s);
  if (m) {
    const names = { black: '0,0,0', white: '255,255,255', red: '255,0,0', blue: '0,0,255', yellow: '255,255,0' };
    const rgb = names[m[1].toLowerCase()];
    if (rgb) return `rgba(${rgb},${Math.min(1, Number(m[2]) || 1)})`;
    return m[1].toLowerCase();
  }
  if (/^[a-z]+$/i.test(s)) return s.toLowerCase();
  return null;
}

/** FFmpeg-safe color for drawbox/boxcolor (name@alpha or 0xRRGGBB@alpha). */
export function bgToFfmpeg(bg, fallbackAlpha = 1) {
  const s = String(bg || '');
  if (!s) return null;
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return `${s.slice(1)}@${fallbackAlpha}`;
  if (/^#[0-9a-fA-F]{8}$/.test(s)) {
    const a = parseInt(s.slice(7, 9), 16) / 255;
    return `${s.slice(1, 7)}@${a.toFixed(2)}`;
  }
  if (/^[a-z]+@[0-9.]+$/i.test(s) || /^[a-z]+$/i.test(s)) return s.toLowerCase();
  return `ffffff@${fallbackAlpha}`;
}

export function addMarker(timeline, { time = 0, label = '', color = '#e8b44a' } = {}) {
  if (!Array.isArray(timeline.markers)) timeline.markers = [];
  const t = round3(Math.max(0, Number(time) || 0));
  const marker = {
    id: uid('mk'),
    time: t,
    label: String(label || '').slice(0, 80),
    color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#e8b44a',
  };
  timeline.markers.push(marker);
  timeline.markers.sort((a, b) => a.time - b.time);
  return marker;
}

export function removeMarker(timeline, markerId) {
  if (!Array.isArray(timeline.markers)) return false;
  const i = timeline.markers.findIndex((m) => m.id === markerId);
  if (i < 0) return false;
  timeline.markers.splice(i, 1);
  return true;
}

export function moveMarker(timeline, markerId, time) {
  const m = Array.isArray(timeline.markers) ? timeline.markers.find((x) => x.id === markerId) : null;
  if (!m) throw new TimelineError('MARKER_NOT_FOUND', `Unknown marker: ${markerId}`);
  m.time = round3(Math.max(0, Number(time) || 0));
  timeline.markers.sort((a, b) => a.time - b.time);
  return m;
}

export function getTrack(timeline, trackId) {
  const track = timeline.tracks.find((t) => t.id === trackId);
  if (!track) throw new TimelineError('TRACK_NOT_FOUND', `Unknown track: ${trackId}`);
  return track;
}

export function getClip(timeline, trackId, clipId) {
  const track = getTrack(timeline, trackId);
  const clip = track.clips.find((c) => c.id === clipId);
  if (!clip) throw new TimelineError('CLIP_NOT_FOUND', `Unknown clip: ${clipId}`);
  return { track, clip };
}

export function clipEnd(clip) {
  return clip.start + clip.duration;
}

export function timelineDuration(timeline) {
  let max = 0;
  for (const track of timeline.tracks) {
    for (const clip of track.clips) max = Math.max(max, clipEnd(clip));
  }
  return round3(max);
}

function assertFinitePositive(name, value, { allowZero = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TimelineError('INVALID_NUMBER', `${name} must be a finite number`);
  }
  if (allowZero ? value < 0 : value <= 0) {
    throw new TimelineError('INVALID_NUMBER', `${name} must be ${allowZero ? '>= 0' : '> 0'}`);
  }
}

function assertNoOverlap(track, start, duration, ignoreId = null) {
  const end = start + duration;
  for (const other of track.clips) {
    if (other.id === ignoreId) continue;
    const oEnd = clipEnd(other);
    if (start < oEnd - EPS && end > other.start + EPS) {
      throw new TimelineError(
        'OVERLAP',
        `Clip would overlap "${other.id}" on track ${track.id} (${other.start.toFixed(2)}–${oEnd.toFixed(2)})`
      );
    }
  }
}

function assertAccepts(track, kind) {
  const def = TRACK_DEFS.find((t) => t.id === track.id);
  if (!def || !def.accepts.includes(kind)) {
    throw new TimelineError(
      'KIND_MISMATCH',
      `Track ${track.id} does not accept clips of kind "${kind}"`
    );
  }
}

function assertUnlocked(track) {
  if (track.locked) throw new TimelineError('TRACK_LOCKED', `Track ${track.id} is locked`);
}

export function sortClips(timeline) {
  for (const track of timeline.tracks) track.clips.sort((a, b) => a.start - b.start);
}

/** Find first time >= fromTime where duration fits without overlap. */
export function findFreeSlot(track, duration, fromTime = 0) {
  let t = Math.max(0, fromTime);
  const sorted = [...track.clips].sort((a, b) => a.start - b.start);
  for (;;) {
    let pushed = false;
    for (const c of sorted) {
      const end = clipEnd(c);
      if (t < end - EPS && t + duration > c.start + EPS) {
        t = end;
        pushed = true;
      }
    }
    if (!pushed) return round3(t);
  }
}

export function makeClip({
  kind,
  start = 0,
  duration = 1,
  srcIn = 0,
  assetId = null,
  volume = 1,
  muted = false,
  text = null,
  id = null,
  speed = 1,
  overlay = null,
  fit = null,
  scale = null,
  posX = null,
  posY = null,
  effect = null,
  fadeIn = 0,
  fadeOut = 0,
  transitionIn = 'none',
  keyframes = null,
} = {}) {
  const clip = {
    id: id || uid('clip'),
    kind,
    start: round3(start),
    duration: round3(duration),
    srcIn: round3(srcIn),
    volume: clamp(volume, 0, 4),
    muted: !!muted,
    speed: clampSpeed(speed),
    fadeIn: clampFade(fadeIn),
    fadeOut: clampFade(fadeOut),
    transitionIn: normalizeTransition(transitionIn),
  };
  const kf = normalizeKeyframes(keyframes);
  if (Object.keys(kf).length) clip.keyframes = kf;
  if (kind !== 'text') clip.assetId = assetId;
  if (kind === 'text') {
    clip.text = normalizeText(text || {});
  }
  if (kind === 'image' || kind === 'video') {
    clip.overlay = normalizeOverlay(overlay || null, kind);
    const tr = normalizeTransform({ fit, scale, posX, posY });
    clip.fit = tr.fit;
    clip.scale = tr.scale;
    clip.posX = tr.posX;
    clip.posY = tr.posY;
    clip.effect = normalizeEffect(effect);
  }
  return clip;
}

function normalizeOverlay(overlay, kind) {
  const base = {
    xPct: 50,
    yPct: 50,
    widthPct: kind === 'image' ? 30 : 70,
  };
  if (!overlay) return base;
  return {
    xPct: clamp(Number(overlay.xPct ?? base.xPct), 0, 100),
    yPct: clamp(Number(overlay.yPct ?? base.yPct), 0, 100),
    widthPct: clamp(Number(overlay.widthPct ?? base.widthPct), 5, 100),
  };
}

function normalizeText(text) {
  const bgMode = normalizeBgMode(text.bgMode || (text.bg ? 'inline' : 'none'));
  return {
    content: String(text.content ?? 'Text'),
    role: text.role || 'title',
    font: text.font || 'Arial',
    size: clamp(Number(text.size) || 72, 8, 400),
    color: hexOr(text.color, '#ffffff'),
    bg: typeof text.bg === 'string' ? text.bg : '',
    bgMode,
    position: text.position || 'center',
    xPct: text.xPct != null ? clamp(Number(text.xPct), 0, 100) : null,
    yPct: text.yPct != null ? clamp(Number(text.yPct), 0, 100) : null,
    align: normalizeTextAlign(text.align),
    bold: text.bold == null ? true : !!text.bold,
    uppercase: !!text.uppercase,
    italic: !!text.italic,
    strokeWidth: clamp(Number(text.strokeWidth) || 0, 0, 16),
    strokeColor: hexOr(text.strokeColor, '#000000'),
    shadow: !!text.shadow,
    letterSpacing: clamp(Number(text.letterSpacing) || 0, 0, 40),
    padX: clamp(text.padX != null ? Number(text.padX) : (bgMode === 'full' ? 40 : 14), 0, 160),
    padY: clamp(text.padY != null ? Number(text.padY) : (bgMode === 'full' ? 22 : 10), 0, 120),
    // Banner/box width as % of canvas (drag-resize). Full banners default 100.
    widthPct: clamp(text.widthPct != null ? Number(text.widthPct) : 100, 10, 100),
    anim: normalizeTextAnim(text.anim),
    animDur: clamp(Number(text.animDur) || 0.3, 0.05, 2),
  };
}

/**
 * Word-wrap line estimate for full-width banner sizing (preview ↔ export).
 * Uses Arial-bold-ish average glyph width (~0.56em) + letter-spacing.
 */
export function estimateBannerLines(content, size, widthPx, padX = 40, letterSpacing = 0) {
  const text = String(content ?? '');
  const S = Math.max(8, Number(size) || 72);
  const W = Math.max(40, Number(widthPx) || 1080);
  const P = Math.max(0, Number(padX) || 0);
  const LS = Math.max(0, Number(letterSpacing) || 0);
  const charW = Math.max(4, S * 0.56 + LS);
  const usable = Math.max(S * 0.8, W - P * 2);
  const maxChars = Math.max(4, Math.floor(usable / charW));
  let lines = 0;
  for (const para of text.split('\n')) {
    if (!para.trim()) { lines += 1; continue; }
    const words = para.trim().split(/\s+/);
    let cur = 0;
    let n = 1;
    for (const w of words) {
      if (cur === 0) cur = w.length;
      else if (cur + 1 + w.length <= maxChars) cur += 1 + w.length;
      else { n += 1; cur = w.length; }
      while (cur > maxChars) { n += 1; cur -= maxChars; }
    }
    lines += n;
  }
  return Math.max(1, lines);
}

/** Banner strip height in canvas px for N lines (matches renderer + preview). */
export function bannerBoxHeight(lines, size, padY) {
  const S = Math.max(8, Number(size) || 72);
  const P = Math.max(0, Number(padY) || 0);
  const N = Math.max(1, Math.round(Number(lines) || 1));
  return Math.ceil(N * S * 1.28 + P * 2);
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function addClip(timeline, trackId, clipInput, { autoSlot = false } = {}) {
  const track = getTrack(timeline, trackId);
  assertUnlocked(track);
  const kind = clipInput.kind;
  assertAccepts(track, kind);
  assertFinitePositive('start', clipInput.start, { allowZero: true });
  assertFinitePositive('duration', clipInput.duration);
  if (clipInput.kind !== 'text') {
    assertFinitePositive('srcIn', clipInput.srcIn ?? 0, { allowZero: true });
    if (!clipInput.assetId) throw new TimelineError('ASSET_REQUIRED', 'Media clip requires assetId');
  }
  const clip = makeClip(clipInput);
  let start = clip.start;
  if (autoSlot) start = findFreeSlot(track, clip.duration, clip.start);
  clip.start = start;
  assertNoOverlap(track, clip.start, clip.duration);
  track.clips.push(clip);
  sortClips(timeline);
  return clip;
}

export function removeClip(timeline, trackId, clipId) {
  const track = getTrack(timeline, trackId);
  assertUnlocked(track);
  const idx = track.clips.findIndex((c) => c.id === clipId);
  if (idx === -1) throw new TimelineError('CLIP_NOT_FOUND', `Unknown clip: ${clipId}`);
  const [removed] = track.clips.splice(idx, 1);
  return removed;
}

export function splitClip(timeline, trackId, clipId, at) {
  const { track, clip } = getClip(timeline, trackId, clipId);
  assertUnlocked(track);
  assertFinitePositive('at', at, { allowZero: true });
  const end = clipEnd(clip);
  if (at <= clip.start + MIN_CLIP - EPS || at >= end - MIN_CLIP + EPS) {
    throw new TimelineError(
      'SPLIT_OUT_OF_RANGE',
      `Split point must be inside the clip with at least ${MIN_CLIP}s on each side`
    );
  }
  const leftDur = round3(at - clip.start);
  const rightStart = round3(at);
  const rightDur = round3(end - at);

  const speed = clip.speed > 0 ? clip.speed : 1;
  const left = { ...deep(clip), duration: leftDur };
  const right = {
    ...deep(clip),
    id: uid('clip'),
    start: rightStart,
    duration: rightDur,
    srcIn: round3(clip.srcIn + leftDur * speed),
  };
  // Remap fades / transitions / keyframes for the two halves (local time from each start).
  left.fadeIn = clampFade(clip.fadeIn);
  left.fadeOut = clip.fadeOut != null ? Math.min(clampFade(clip.fadeOut), leftDur) : 0;
  left.transitionIn = normalizeTransition(clip.transitionIn);
  right.fadeIn = 0;
  right.fadeOut = clampFade(clip.fadeOut);
  right.transitionIn = 'none';
  if (clip.keyframes && Object.keys(clip.keyframes).length) {
    const remap = remapKeyframesSplit(clip.keyframes, leftDur);
    if (Object.keys(remap.left).length) left.keyframes = remap.left;
    else delete left.keyframes;
    if (Object.keys(remap.right).length) right.keyframes = remap.right;
    else delete right.keyframes;
  }
  const idx = track.clips.indexOf(clip);
  track.clips.splice(idx, 1, left, right);
  sortClips(timeline);
  return { left, right };
}

export function trimClip(timeline, trackId, clipId, { start, duration, srcIn } = {}, assetDuration = null) {
  const { track, clip } = getClip(timeline, trackId, clipId);
  assertUnlocked(track);
  const newStart = start != null ? round3(start) : clip.start;
  const newDur = duration != null ? round3(duration) : clip.duration;
  const newSrcIn = srcIn != null ? round3(srcIn) : clip.srcIn;

  assertFinitePositive('start', newStart, { allowZero: true });
  assertFinitePositive('duration', newDur);
  assertFinitePositive('srcIn', newSrcIn, { allowZero: true });
  if (newDur < MIN_CLIP) throw new TimelineError('TOO_SHORT', `Clip duration must be >= ${MIN_CLIP}s`);
  if (clip.kind !== 'text' && assetDuration != null) {
    const sp = clip.speed > 0 ? clip.speed : 1;
    if (newSrcIn + newDur * sp > assetDuration + EPS) {
      throw new TimelineError('SOURCE_OVERRUN', 'Trim exceeds source media duration');
    }
  }
  assertNoOverlap(track, newStart, newDur, clip.id);

  clip.start = newStart;
  clip.duration = newDur;
  clip.srcIn = newSrcIn;
  sortClips(timeline);
  return clip;
}

export function moveClip(timeline, trackId, clipId, newStart) {
  const { track, clip } = getClip(timeline, trackId, clipId);
  assertUnlocked(track);
  assertFinitePositive('newStart', newStart, { allowZero: true });
  assertNoOverlap(track, round3(newStart), clip.duration, clip.id);
  clip.start = round3(newStart);
  sortClips(timeline);
  return clip;
}

export function moveClipToTrack(timeline, fromTrackId, clipId, toTrackId, newStart) {
  const from = getTrack(timeline, fromTrackId);
  const to = getTrack(timeline, toTrackId);
  assertUnlocked(from);
  assertUnlocked(to);
  const idx = from.clips.findIndex((c) => c.id === clipId);
  if (idx === -1) throw new TimelineError('CLIP_NOT_FOUND', `Unknown clip: ${clipId}`);
  const [clip] = from.clips.splice(idx, 1);
  assertAccepts(to, clip.kind);
  const start = round3(newStart);
  assertFinitePositive('newStart', start, { allowZero: true });
  assertNoOverlap(to, start, clip.duration);
  clip.start = start;
  to.clips.push(clip);
  sortClips(timeline);
  return clip;
}

export function duplicateClip(timeline, trackId, clipId, newStart = null) {
  const { track, clip } = getClip(timeline, trackId, clipId);
  assertUnlocked(track);
  const from = newStart != null ? round3(newStart) : clipEnd(clip);
  const slot = findFreeSlot(track, clip.duration, from);
  const copy = deep(clip);
  copy.id = uid('clip');
  copy.start = slot;
  track.clips.push(copy);
  sortClips(timeline);
  return copy;
}

const CLIP_PROP_KEYS = [
  'volume', 'muted', 'start', 'duration', 'srcIn', 'overlay', 'speed',
  'fit', 'scale', 'posX', 'posY', 'effect',
  'fadeIn', 'fadeOut', 'transitionIn', 'keyframes',
];

export function setClipProps(timeline, trackId, clipId, props = {}) {
  const { track, clip } = getClip(timeline, trackId, clipId);
  assertUnlocked(track);
  const { text, ...rest } = props;
  for (const [key, value] of Object.entries(rest)) {
    if (!CLIP_PROP_KEYS.includes(key)) {
      throw new TimelineError('BAD_PROP', `Unsupported clip property: ${key}`);
    }
  }
  if (rest.volume != null) clip.volume = clamp(Number(rest.volume), 0, 4);
  if (rest.muted != null) clip.muted = !!rest.muted;
  if (rest.speed != null) {
    if (clip.kind !== 'video' && clip.kind !== 'audio') {
      throw new TimelineError('BAD_PROP', 'Speed only applies to video/audio clips');
    }
    clip.speed = clampSpeed(rest.speed);
  }
  if (rest.overlay != null) {
    if (clip.kind !== 'text') clip.overlay = normalizeOverlay({ ...clip.overlay, ...rest.overlay }, clip.kind);
    else throw new TimelineError('BAD_PROP', 'Text clips do not have overlay props');
  }
  const hasTransform = rest.fit != null || rest.scale != null || rest.posX != null || rest.posY != null;
  if (hasTransform) {
    if (clip.kind !== 'video' && clip.kind !== 'image') {
      throw new TimelineError('BAD_PROP', 'Fit/scale/position only apply to video/image clips');
    }
    if (rest.fit != null && !FIT_MODES.includes(rest.fit)) {
      throw new TimelineError('BAD_FIT', `fit must be one of: ${FIT_MODES.join(', ')}`);
    }
    const next = normalizeTransform({
      fit: rest.fit != null ? rest.fit : (clip.fit || 'cover'),
      scale: rest.scale != null ? rest.scale : (clip.scale ?? 1),
      posX: rest.posX != null ? rest.posX : (clip.posX ?? 50),
      posY: rest.posY != null ? rest.posY : (clip.posY ?? 50),
    });
    clip.fit = next.fit;
    clip.scale = next.scale;
    clip.posX = next.posX;
    clip.posY = next.posY;
  }
  if (rest.effect != null) {
    if (clip.kind !== 'video' && clip.kind !== 'image') {
      throw new TimelineError('BAD_PROP', 'effect only applies to video/image clips');
    }
    if (rest.effect !== 'none' && !EFFECTS.includes(rest.effect)) {
      throw new TimelineError('BAD_EFFECT', `effect must be one of: ${EFFECTS.join(', ')}`);
    }
    clip.effect = normalizeEffect(rest.effect);
  }
  if (rest.fadeIn != null) clip.fadeIn = clampFade(rest.fadeIn);
  if (rest.fadeOut != null) clip.fadeOut = clampFade(rest.fadeOut);
  if (rest.transitionIn != null) {
    if (!TRANSITIONS.includes(rest.transitionIn)) {
      throw new TimelineError('BAD_TRANSITION', `transitionIn must be one of: ${TRANSITIONS.join(', ')}`);
    }
    clip.transitionIn = normalizeTransition(rest.transitionIn);
  }
  if (rest.keyframes != null) {
    const kf = normalizeKeyframes(rest.keyframes);
    if (Object.keys(kf).length) clip.keyframes = kf;
    else delete clip.keyframes;
  }
  const needsWindow = rest.start != null || rest.duration != null || rest.srcIn != null;
  if (needsWindow) {
    trimClip(
      timeline,
      trackId,
      clipId,
      {
        start: rest.start != null ? rest.start : clip.start,
        duration: rest.duration != null ? rest.duration : clip.duration,
        srcIn: rest.srcIn != null ? rest.srcIn : clip.srcIn,
      },
      props.assetDuration ?? null
    );
  }
  if (text != null) {
    if (clip.kind !== 'text') throw new TimelineError('BAD_PROP', 'Only text clips have text props');
    clip.text = normalizeText({ ...clip.text, ...text });
  }
  return clip;
}

export function setTrackProps(timeline, trackId, props = {}) {
  const track = getTrack(timeline, trackId);
  for (const key of ['muted', 'hidden', 'locked']) {
    if (props[key] != null) track[key] = !!props[key];
  }
  return track;
}

export function clearTimeline(timeline) {
  for (const track of timeline.tracks) {
    if (track.locked) throw new TimelineError('TRACK_LOCKED', `Track ${track.id} is locked`);
    track.clips = [];
  }
  return timeline;
}

export function cloneTimeline(timeline) {
  return deep(timeline);
}

function deep(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Structural validation used by the server before accepting autosaved timelines. */
export function validateTimeline(timeline) {
  const issues = [];
  const err = (code, message) => issues.push({ code, message });

  if (!timeline || typeof timeline !== 'object') {
    return [{ code: 'NOT_OBJECT', message: 'Timeline must be an object' }];
  }
  for (const key of ['width', 'height', 'fps']) {
    if (!Number.isFinite(timeline[key]) || timeline[key] <= 0) {
      err('BAD_CANVAS', `${key} must be a positive number`);
    }
  }
  if (!Array.isArray(timeline.tracks)) {
    return [...issues, { code: 'NO_TRACKS', message: 'timeline.tracks must be an array' }];
  }
  if (timeline.markers != null && !Array.isArray(timeline.markers)) {
    err('BAD_MARKERS', 'timeline.markers must be an array');
  } else if (Array.isArray(timeline.markers)) {
    const mkIds = new Set();
    for (const mk of timeline.markers) {
      if (!mk || typeof mk !== 'object') { err('BAD_MARKER', 'Marker must be an object'); continue; }
      if (!mk.id || typeof mk.id !== 'string') err('BAD_MARKER_ID', 'Marker missing id');
      else if (mkIds.has(mk.id)) err('DUP_MARKER_ID', `Duplicate marker id ${mk.id}`);
      else mkIds.add(mk.id);
      if (!Number.isFinite(mk.time) || mk.time < 0) err('BAD_MARKER_TIME', `Marker ${mk.id || '?'} bad time`);
    }
  }
  if (timeline.layout != null) {
    if (typeof timeline.layout !== 'object' || timeline.layout === null || Array.isArray(timeline.layout)) {
      err('BAD_LAYOUT', 'timeline.layout must be an object');
    } else if (timeline.layout.mode != null && !LAYOUT_MODES.includes(timeline.layout.mode)) {
      err('BAD_LAYOUT_MODE', `layout.mode must be one of: ${LAYOUT_MODES.join(', ')}`);
    }
  }

  const seenIds = new Set();
  for (const def of TRACK_DEFS) {
    const track = timeline.tracks.find((t) => t.id === def.id);
    if (!track) {
      err('MISSING_TRACK', `Missing track ${def.id}`);
      continue;
    }
    if (!Array.isArray(track.clips)) {
      err('BAD_TRACK', `Track ${def.id} clips must be an array`);
      continue;
    }
    const clipIds = new Set();
    const sorted = [...track.clips].sort((a, b) => a.start - b.start);
    for (const clip of sorted) {
      if (!clip || typeof clip !== 'object') {
        err('BAD_CLIP', `Track ${def.id} contains a non-object clip`);
        continue;
      }
      if (!clip.id || typeof clip.id !== 'string') err('BAD_CLIP_ID', `Clip on ${def.id} missing id`);
      else if (seenIds.has(clip.id)) err('DUP_CLIP_ID', `Duplicate clip id ${clip.id}`);
      else {
        seenIds.add(clip.id);
        clipIds.add(clip.id);
      }
      if (!def.accepts.includes(clip.kind)) {
        err('KIND_MISMATCH', `Clip ${clip.id} kind "${clip.kind}" not allowed on ${def.id}`);
      }
      if (!Number.isFinite(clip.start) || clip.start < 0) err('BAD_START', `Clip ${clip.id} bad start`);
      if (!Number.isFinite(clip.duration) || clip.duration < MIN_CLIP - EPS) {
        err('BAD_DURATION', `Clip ${clip.id} bad duration`);
      }
      if (clip.kind !== 'text') {
        if (!Number.isFinite(clip.srcIn) || clip.srcIn < 0) err('BAD_SRCIN', `Clip ${clip.id} bad srcIn`);
        if (!clip.assetId) err('NO_ASSET', `Clip ${clip.id} missing assetId`);
      } else {
        if (!clip.text || typeof clip.text.content !== 'string') {
          err('BAD_TEXT', `Text clip ${clip.id} missing content`);
        }
      }
      if (!Number.isFinite(clip.volume) || clip.volume < 0 || clip.volume > 4) {
        err('BAD_VOLUME', `Clip ${clip.id} volume out of range`);
      }
      if (clip.speed != null && (!Number.isFinite(clip.speed) || clip.speed < MIN_SPEED - EPS || clip.speed > MAX_SPEED + EPS)) {
        err('BAD_SPEED', `Clip ${clip.id} speed out of range ${MIN_SPEED}–${MAX_SPEED}`);
      }
      for (const fk of ['fadeIn', 'fadeOut']) {
        if (clip[fk] != null && (!Number.isFinite(clip[fk]) || clip[fk] < -EPS || clip[fk] > MAX_FADE_SEC + EPS)) {
          err('BAD_FADE', `Clip ${clip.id} ${fk} out of range 0–${MAX_FADE_SEC}`);
        }
      }
      if (clip.transitionIn != null && !TRANSITIONS.includes(clip.transitionIn)) {
        err('BAD_TRANSITION', `Clip ${clip.id} transitionIn must be one of: ${TRANSITIONS.join(', ')}`);
      }
      if (clip.keyframes != null) {
        if (typeof clip.keyframes !== 'object' || clip.keyframes === null || Array.isArray(clip.keyframes)) {
          err('BAD_KEYFRAMES', `Clip ${clip.id} keyframes must be an object`);
        } else {
          for (const [pk, pts] of Object.entries(clip.keyframes)) {
            if (!KEYFRAME_PROPS.includes(pk)) {
              err('BAD_KEYFRAME_PROP', `Clip ${clip.id} keyframe prop must be one of: ${KEYFRAME_PROPS.join(', ')}`);
              continue;
            }
            if (!Array.isArray(pts)) {
              err('BAD_KEYFRAMES', `Clip ${clip.id} keyframes.${pk} must be an array`);
              continue;
            }
            for (const p of pts) {
              if (!p || !Number.isFinite(Number(p.t)) || !Number.isFinite(Number(p.v))) {
                err('BAD_KEYFRAME_POINT', `Clip ${clip.id} keyframes.${pk} has invalid point`);
                break;
              }
            }
          }
        }
      }
      if (clip.kind === 'video' || clip.kind === 'image') {
        if (clip.fit != null && !FIT_MODES.includes(clip.fit)) {
          err('BAD_FIT', `Clip ${clip.id} fit must be one of: ${FIT_MODES.join(', ')}`);
        }
        if (clip.scale != null && (!Number.isFinite(clip.scale) || clip.scale < MIN_ZOOM - EPS || clip.scale > MAX_ZOOM + EPS)) {
          err('BAD_ZOOM', `Clip ${clip.id} scale out of range ${MIN_ZOOM}–${MAX_ZOOM}`);
        }
        for (const pk of ['posX', 'posY']) {
          if (clip[pk] != null && (!Number.isFinite(clip[pk]) || clip[pk] < 0 || clip[pk] > 100)) {
            err('BAD_POS', `Clip ${clip.id} ${pk} out of range 0–100`);
          }
        }
        if (clip.effect != null && !EFFECTS.includes(clip.effect)) {
          err('BAD_EFFECT', `Clip ${clip.id} effect must be one of: ${EFFECTS.join(', ')}`);
        }
      }
      if (clip.kind === 'text' && clip.text) {
        if (clip.text.bgMode != null && !BG_MODES.includes(clip.text.bgMode)) {
          err('BAD_BG_MODE', `Clip ${clip.id} text.bgMode must be one of: ${BG_MODES.join(', ')}`);
        }
        if (clip.text.anim != null && !TEXT_ANIMS.includes(clip.text.anim)) {
          err('BAD_TEXT_ANIM', `Clip ${clip.id} text.anim must be one of: ${TEXT_ANIMS.join(', ')}`);
        }
        if (clip.text.align != null && !TEXT_ALIGNS.includes(clip.text.align)) {
          err('BAD_TEXT_ALIGN', `Clip ${clip.id} text.align must be one of: ${TEXT_ALIGNS.join(', ')}`);
        }
        if (clip.text.strokeWidth != null && (!Number.isFinite(clip.text.strokeWidth) || clip.text.strokeWidth < 0 || clip.text.strokeWidth > 16)) {
          err('BAD_TEXT_STROKE', `Clip ${clip.id} text.strokeWidth out of range 0–16`);
        }
      }
    }
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (cur.start < prev.start + prev.duration - EPS) {
        err('OVERLAP', `Overlapping clips on ${def.id}: ${prev.id} & ${cur.id}`);
      }
    }
  }
  return issues;
}

/** Active clips of a given kind at timeline time t (sorted by track order). */
export function activeClips(timeline, t, kinds = null) {
  const out = [];
  for (const track of timeline.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (t >= clip.start - EPS && t < clipEnd(clip) - EPS) {
        if (!kinds || kinds.includes(clip.kind)) out.push({ track, clip });
      }
    }
  }
  return out;
}

/** Snap a 0–100 percent value to candidates (default center + edges). */
export function snapPct(value, { candidates = [0, 50, 100], threshold = 1.5, disabled = false } = {}) {
  const v = Number(value);
  if (disabled || !Number.isFinite(v)) return { value: v, snapped: null };
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = Math.abs(v - c);
    if (d <= threshold && d < bestD) { best = c; bestD = d; }
  }
  if (best == null) return { value: v, snapped: null };
  return { value: best, snapped: best };
}

/** Split keyframe tracks at local time `leftDur` → { left, right } (clip-local times). */
function remapKeyframesSplit(keyframes, leftDur) {
  const left = {};
  const right = {};
  const cut = round3(Math.max(0, leftDur));
  for (const [prop, pts] of Object.entries(keyframes || {})) {
    if (!Array.isArray(pts) || !pts.length) continue;
    const sorted = [...pts].sort((a, b) => a.t - b.t);
    const leftPts = sorted.filter((p) => p.t <= cut);
    if (leftPts.length) left[prop] = leftPts;
    const atCut = evalKeyframes({ keyframes: { [prop]: sorted } }, cut, prop, sorted[0].v);
    const rightPts = [{ t: 0, v: round3(atCut) }];
    for (const p of sorted) {
      if (p.t > cut) rightPts.push({ t: round3(p.t - cut), v: p.v });
    }
    right[prop] = rightPts;
  }
  return { left, right };
}
