import { el, toast, modal, fmtDuration } from './api.js';

/**
 * Image & thumbnail editor — canvas-based, non-destructive (callers decide save targets).
 *
 * openImageEditor({
 *   title,                  // modal title
 *   src,                    // image URL to edit  OR
 *   videoSrc, fallbackSrc,  // video URL → scrub to pick a frame (falls back to image if decode fails)
 *   defaultFormat,          // 'image/png' | 'image/jpeg' | 'image/webp'
 *   actions: [ { label, class?, handler(blob) } ]  // footer actions rendered after Cancel
 * })
 */

const EDIT_FORMATS = ['image/png', 'image/jpeg', 'image/webp'];
const EXT_BY_FORMAT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function formatForExt(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  const f = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[e];
  return EDIT_FORMATS.includes(f) ? f : 'image/jpeg';
}

export function extForFormat(type) {
  return EXT_BY_FORMAT[type] || 'jpg';
}

const DEFAULT_ADJ = { b: 100, c: 100, s: 100 };
const MIN_CROP_PX = 28;
const MAX_OUT = 8192;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function filterCss(adj) {
  return `brightness(${adj.b}%) contrast(${adj.c}%) saturate(${adj.s}%)`;
}

/* ---------- crop geometry ----------
 * Crop is stored normalized {x,y,w,h} in *oriented image* space.
 * Display scale is uniform, so ratios computed in display px stay valid.
 */

function moveCrop(dxPx, dyPx, b, bw, bh) {
  const x = clamp(b.x * bw + dxPx, 0, bw - b.w * bw);
  const y = clamp(b.y * bh + dyPx, 0, bh - b.h * bh);
  return { x: x / bw, y: y / bh, w: b.w, h: b.h };
}

/** Resize from a corner handle. `aspect` = target w/h in image pixels (or null = free). */
function cornerResize(mode, dxPx, dyPx, b, bw, bh, aspect) {
  const west = mode[1] === 'w';
  const north = mode[0] === 'n';
  const fixX = (west ? b.x + b.w : b.x) * bw;
  const fixY = (north ? b.y + b.h : b.y) * bh;
  const startX = (west ? b.x : b.x + b.w) * bw;
  const startY = (north ? b.y : b.y + b.h) * bh;
  const px = startX + dxPx;
  const py = startY + dyPx;
  let w = west ? fixX - px : px - fixX;
  let h = north ? fixY - py : py - fixY;
  w = Math.max(MIN_CROP_PX, w);
  h = Math.max(MIN_CROP_PX, h);
  const maxW = west ? fixX : bw - fixX;
  const maxH = north ? fixY : bh - fixY;
  if (aspect) {
    w = Math.min(w, maxW, maxH * aspect);
    h = w / aspect;
    if (h < MIN_CROP_PX) { h = MIN_CROP_PX; w = h * aspect; }
    if (h > maxH) { h = maxH; w = h * aspect; }
    w = Math.min(w, maxW);
    h = w / aspect;
  } else {
    w = Math.min(w, maxW);
    h = Math.min(h, maxH);
  }
  return {
    x: (west ? fixX - w : fixX) / bw,
    y: (north ? fixY - h : fixY) / bh,
    w: w / bw,
    h: h / bh,
  };
}

/** Rotate the normalized crop rect with the image (+1 = clockwise 90°). */
function rotateCrop(c, dir) {
  if (dir > 0) return { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w };
  return { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w };
}

function flipCropH(c) { return { ...c, x: 1 - c.x - c.w }; }
function flipCropV(c) { return { ...c, y: 1 - c.y - c.h }; }

/**
 * Largest centered rect whose *pixel* w/h equals `ratio`, inside an oriented
 * image of ow×oh. Returns normalized rect. ratio null → full frame.
 */
function fitAspect(ratio, ow, oh) {
  if (!ratio || !ow || !oh) return { x: 0, y: 0, w: 1, h: 1 };
  let w = 1;
  let h = ow / (ratio * oh);
  if (h > 1) {
    h = 1;
    w = (ratio * oh) / ow;
  }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/** Resize/center a crop to `ratio` around its current center (keeps user framing). */
function refitCropAroundCenter(c, ratio, ow, oh) {
  if (!ratio || !ow || !oh) return c || { x: 0, y: 0, w: 1, h: 1 };
  const cur = c || { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
  // max centered rect with this ratio
  let w = 1;
  let h = ow / (ratio * oh);
  if (h > 1) {
    h = 1;
    w = (ratio * oh) / ow;
  }
  // scale down so it fits inside remaining space around current center if needed
  const cx = cur.x + cur.w / 2;
  const cy = cur.y + cur.h / 2;
  // start from current size projected onto ratio, prefer larger of the two
  let sw = Math.max(cur.w, cur.h * ratio * (oh / ow));
  let sh = sw / (ratio * (oh / ow));
  if (sw > w) { sw = w; sh = sw / (ratio * (oh / ow)); }
  if (sh > h) { sh = h; sw = sh * (ratio * (oh / ow)); }
  sw = Math.min(sw, w);
  sh = Math.min(sh, h);
  return {
    x: clamp(cx - sw / 2, 0, 1 - sw),
    y: clamp(cy - sh / 2, 0, 1 - sh),
    w: sw,
    h: sh,
  };
}

/* ---------- main editor ---------- */

export function openImageEditor(opts = {}) {
  const {
    title = 'Edit image',
    src = null,
    videoSrc = null,
    fallbackSrc = null,
    defaultFormat = 'image/jpeg',
    actions = [],
  } = opts;

  const isVideo = !!videoSrc;
  const st = {
    rot: 0,
    flipH: false,
    flipV: false,
    crop: null,
    adj: { ...DEFAULT_ADJ },
    aspect: null,
    outW: 0,
    outH: 0,
    outTouched: false,
    format: EDIT_FORMATS.includes(defaultFormat) ? defaultFormat : 'image/jpeg',
    quality: 0.92,
    srcW: 0,
    srcH: 0,
    ready: false,
    closed: false,
    dirty: false,
    videoDead: false,
    lastSrc: null,
    saveAbort: null,
  };
  const canFilter = (() => {
    try {
      const c = document.createElement('canvas').getContext('2d');
      return typeof c.filter === 'string';
    } catch { return false; }
  })();

  const source = document.createElement('canvas');
  const oriented = document.createElement('canvas');
  const preview = el('canvas', { class: 'ie-canvas', 'aria-label': 'Image preview' });
  const cropSizeEl = el('div', { class: 'ie-crop-size' });
  const cropEl = el('div', { class: 'ie-crop', title: 'Drag to move · corners to resize' },
    ...['nw', 'ne', 'sw', 'se'].map((h) => el('div', { class: `ie-handle ${h}`, dataset: { handle: h } })),
    cropSizeEl
  );
  const stageInner = el('div', { class: 'ie-stage-inner' }, preview, cropEl);
  const stageBox = el('div', { class: 'ie-stage' }, stageInner);
  const loadingEl = el('div', { class: 'ie-overlay', text: 'Loading…' });
  const errorEl = el('div', { class: 'ie-overlay ie-error', style: 'display:none' });
  stageBox.append(loadingEl, errorEl);

  const video = isVideo
    ? el('video', { src: videoSrc, preload: 'auto', playsinline: true, crossorigin: 'anonymous', muted: true, style: 'display:none' })
    : null;
  if (video) video.muted = true;

  /* ----- side panel widgets ----- */
  const infoLine = el('div', { class: 'ie-info', text: '—' });
  const srcInfo = el('span', { class: 'mono' });

  const outWIn = el('input', { class: 'input', type: 'number', min: '16', max: String(MAX_OUT), 'aria-label': 'Output width', disabled: true });
  const outHIn = el('input', { class: 'input', type: 'number', min: '16', max: String(MAX_OUT), 'aria-label': 'Output height', disabled: true });
  const lockChk = el('input', { type: 'checkbox', checked: true, 'aria-label': 'Lock output aspect ratio' });

  const fmtSel = el('select', { class: 'input', 'aria-label': 'Output format' },
    el('option', { value: 'image/png', selected: st.format === 'image/png' || undefined }, 'PNG (lossless)'),
    el('option', { value: 'image/jpeg', selected: st.format === 'image/jpeg' || undefined }, 'JPEG'),
    el('option', { value: 'image/webp', selected: st.format === 'image/webp' || undefined }, 'WebP')
  );
  const qualityIn = el('input', { type: 'range', min: '50', max: '100', step: '1', value: '92', 'aria-label': 'Quality' });
  const qualityVal = el('span', { class: 'ie-val', text: '92%' });
  const qualityRow = el('label', { class: 'ie-slider', style: 'display:none' },
    el('span', { class: 'ie-slider-head' }, el('span', { text: 'Quality' }), qualityVal),
    qualityIn
  );

  const aspectChips = el('div', { class: 'chips' });
  const ASPECTS = [
    { label: 'Free', ratio: null },
    { label: '1:1', ratio: 1 },
    { label: '4:5', ratio: 4 / 5 },
    { label: '9:16', ratio: 9 / 16 },
    { label: '16:9', ratio: 16 / 9 },
    { label: '3:4', ratio: 3 / 4 },
  ];
  for (const a of ASPECTS) {
    const chip = el('button', {
      type: 'button',
      class: `chip ${a.ratio === null ? 'active' : ''}`,
      text: a.label,
      onclick: () => {
        if (!st.ready) return;
        st.aspect = a.ratio;
        if (a.ratio === null) {
          // Free: keep current crop, only unlock ratio
        } else {
          st.crop = refitCropAroundCenter(st.crop, a.ratio, oriented.width, oriented.height);
        }
        aspectChips.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        st.dirty = true;
        syncCropEl();
        updateOutDims(false);
        renderPreview();
      },
    });
    aspectChips.append(chip);
  }

  function adjSlider(label, key) {
    const val = el('span', { class: 'ie-val', text: `${st.adj[key]}%` });
    const inp = el('input', {
      type: 'range', min: '0', max: '200', step: '1',
      value: String(st.adj[key]), 'aria-label': label, disabled: true,
    });
    inp.addEventListener('input', () => {
      st.adj[key] = Number(inp.value);
      val.textContent = `${inp.value}%`;
      st.dirty = true;
      renderPreview();
    });
    const row = el('label', { class: 'ie-slider' },
      el('span', { class: 'ie-slider-head' }, el('span', { text: label }), val),
      inp
    );
    return { row, inp, val };
  }
  const bSlider = adjSlider('Brightness', 'b');
  const cSlider = adjSlider('Contrast', 'c');
  const sSlider = adjSlider('Saturation', 's');

  /* ----- video bar ----- */
  const playBtn = el('button', { class: 'btn sm', text: '▶ Play', 'aria-label': 'Play / pause', disabled: true });
  const scrub = el('input', { type: 'range', class: 'ie-range', min: '0', max: '10', step: '0.01', value: '0', 'aria-label': 'Frame time', disabled: true });
  const timeLbl = el('span', { class: 'ie-time mono', text: '—' });
  const videoBar = isVideo ? el('div', { class: 'ie-video-bar' }, playBtn, scrub, timeLbl) : null;
  let rafId = 0;

  /* ----- geometry / render ----- */

  function orientedSize() {
    return st.rot % 180 === 0
      ? { w: st.srcW, h: st.srcH }
      : { w: st.srcH, h: st.srcW };
  }

  function rebuildOriented() {
    const { w: ow, h: oh } = orientedSize();
    oriented.width = ow;
    oriented.height = oh;
    const c = oriented.getContext('2d');
    let base = source;
    if (st.flipH || st.flipV) {
      base = document.createElement('canvas');
      base.width = st.srcW;
      base.height = st.srcH;
      const bc = base.getContext('2d');
      bc.save();
      bc.translate(st.flipH ? st.srcW : 0, st.flipV ? st.srcH : 0);
      bc.scale(st.flipH ? -1 : 1, st.flipV ? -1 : 1);
      bc.drawImage(source, 0, 0);
      bc.restore();
    }
    if (st.rot) {
      c.save();
      c.translate(ow / 2, oh / 2);
      c.rotate((st.rot * Math.PI) / 180);
      c.drawImage(base, -st.srcW / 2, -st.srcH / 2);
      c.restore();
    } else {
      c.drawImage(base, 0, 0);
    }
  }

  function renderPreview() {
    if (!st.ready || st.closed) return;
    const box = stageBox.getBoundingClientRect();
    const aw = oriented.width;
    const ah = oriented.height;
    if (!aw || !ah) return;
    const availW = Math.max(80, box.width - 12);
    const availH = Math.max(80, box.height - 12);
    const scale = Math.min(availW / aw, availH / ah, 4);
    const dw = Math.max(1, Math.round(aw * scale));
    const dh = Math.max(1, Math.round(ah * scale));
    preview.width = dw;
    preview.height = dh;
    stageInner.style.width = `${dw}px`;
    stageInner.style.height = `${dh}px`;
    const ctx = preview.getContext('2d');
    ctx.save();
    if (canFilter) ctx.filter = filterCss(st.adj);
    ctx.drawImage(oriented, 0, 0, dw, dh);
    ctx.restore();
    // CSS filter when ctx.filter unsupported (preview only; export falls back below)
    preview.style.filter = canFilter ? '' : filterCss(st.adj);
    syncCropEl();
  }

  function syncCropEl() {
    if (!st.ready || !st.crop) {
      cropEl.style.display = 'none';
      return;
    }
    const dw = preview.width;
    const dh = preview.height;
    const c = st.crop;
    cropEl.style.display = 'block';
    cropEl.style.left = `${c.x * dw}px`;
    cropEl.style.top = `${c.y * dh}px`;
    cropEl.style.width = `${c.w * dw}px`;
    cropEl.style.height = `${c.h * dh}px`;
    const nat = naturalOut();
    cropSizeEl.textContent = `${nat.w} × ${nat.h}`;
  }

  function cropRectPx() {
    const ow = oriented.width || st.srcW || 1;
    const oh = oriented.height || st.srcH || 1;
    const c = st.crop || { x: 0, y: 0, w: 1, h: 1 };
    const sx = clamp(Math.round(c.x * ow), 0, ow - 1);
    const sy = clamp(Math.round(c.y * oh), 0, oh - 1);
    const ex = clamp(Math.round((c.x + c.w) * ow), sx + 1, ow);
    const ey = clamp(Math.round((c.y + c.h) * oh), sy + 1, oh);
    return { sx, sy, sw: ex - sx, sh: ey - sy, ow, oh };
  }

  function naturalOut() {
    const r = cropRectPx();
    return { w: r.sw, h: r.sh };
  }

  function updateOutDims(reset = false) {
    if (!st.ready) return;
    const nat = naturalOut();
    if (reset || !st.outW || !st.outH) {
      st.outW = nat.w;
      st.outH = nat.h;
      st.outTouched = false;
    } else if (st.outTouched && lockChk.checked && nat.w > 0) {
      // keep lock aspect relative to the new crop
      const ratio = nat.w / nat.h;
      if (st.outW / Math.max(1, st.outH) !== ratio) {
        st.outH = clamp(Math.round(st.outW / ratio), 16, MAX_OUT);
      }
    } else if (st.outW > MAX_OUT || st.outH > MAX_OUT || st.outW < 16 || st.outH < 16) {
      st.outW = nat.w;
      st.outH = nat.h;
      st.outTouched = false;
    }
    st.outW = clamp(Math.round(st.outW) || nat.w, 16, MAX_OUT);
    st.outH = clamp(Math.round(st.outH) || nat.h, 16, MAX_OUT);
    outWIn.value = String(st.outW);
    outHIn.value = String(st.outH);
    srcInfo.textContent = `${nat.w} × ${nat.h}`;
    infoLine.textContent = `Export ${st.outW} × ${st.outH} px`;
  }

  function structuralChange() {
    rebuildOriented();
    renderPreview();
    // never wipe a user-typed export size on crop/rotate unless lock forces recompute
    updateOutDims(!st.outTouched);
  }

  /* ----- crop interaction ----- */

  let drag = null;
  cropEl.addEventListener('pointerdown', (e) => {
    if (!st.ready) return;
    const handle = e.target instanceof HTMLElement ? e.target.dataset.handle : null;
    drag = {
      mode: handle || 'move',
      px: e.clientX,
      py: e.clientY,
      base: { ...st.crop },
      bw: preview.width,
      bh: preview.height,
    };
    cropEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  cropEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.px;
    const dy = e.clientY - drag.py;
    if (drag.mode === 'move') st.crop = moveCrop(dx, dy, drag.base, drag.bw, drag.bh);
    else st.crop = cornerResize(drag.mode, dx, dy, drag.base, drag.bw, drag.bh, st.aspect);
    st.dirty = true;
    syncCropEl();
    // don't wipe custom export size on every pixel of drag
    updateOutDims(false);
  });
  const endDrag = () => { drag = null; };
  cropEl.addEventListener('pointerup', endDrag);
  cropEl.addEventListener('pointercancel', endDrag);

  /* ----- transform ----- */

  function rotate(dir) {
    if (!st.ready) return;
    st.dirty = true;
    if (st.aspect) st.crop = fitAspect(st.aspect, ...rotatedDims(dir));
    else if (st.crop) st.crop = rotateCrop(st.crop, dir);
    st.rot = (st.rot + (dir > 0 ? 90 : 270)) % 360;
    structuralChange();
  }
  function rotatedDims(dir) {
    void dir;
    return st.rot % 180 === 0
      ? [st.srcH, st.srcW]   // after ±90 the dims swap
      : [st.srcW, st.srcH];
  }
  function flip(axis) {
    if (!st.ready) return;
    st.dirty = true;
    // crop lives in oriented space; at 90°/270° source H/V axes are swapped
    const swapAxes = st.rot % 180 !== 0;
    if (axis === 'h') {
      st.flipH = !st.flipH;
      if (st.crop) st.crop = swapAxes ? flipCropV(st.crop) : flipCropH(st.crop);
    } else {
      st.flipV = !st.flipV;
      if (st.crop) st.crop = swapAxes ? flipCropH(st.crop) : flipCropV(st.crop);
    }
    structuralChange();
  }
  function resetAll() {
    if (!st.ready) return;
    st.rot = 0;
    st.flipH = false;
    st.flipV = false;
    st.aspect = null;
    st.crop = { x: 0, y: 0, w: 1, h: 1 };
    st.adj = { ...DEFAULT_ADJ };
    st.outTouched = false;
    st.dirty = true;
    [bSlider, cSlider, sSlider].forEach((s) => {
      s.inp.value = '100';
      s.val.textContent = '100%';
    });
    aspectChips.querySelectorAll('.chip').forEach((c, i) => c.classList.toggle('active', i === 0));
    structuralChange();
  }

  /* ----- output size / format ----- */

  outWIn.addEventListener('input', () => {
    const nat = naturalOut();
    const w = clamp(Math.round(Number(outWIn.value) || nat.w), 16, MAX_OUT);
    st.outW = w;
    st.outTouched = true;
    st.dirty = true;
    if (lockChk.checked && nat.w > 0) {
      st.outH = clamp(Math.round(w * (nat.h / nat.w)), 16, MAX_OUT);
      outHIn.value = String(st.outH);
    }
    outWIn.value = String(st.outW);
    infoLine.textContent = `Export ${st.outW} × ${st.outH} px`;
  });
  outHIn.addEventListener('input', () => {
    const nat = naturalOut();
    const h = clamp(Math.round(Number(outHIn.value) || nat.h), 16, MAX_OUT);
    st.outH = h;
    st.outTouched = true;
    st.dirty = true;
    if (lockChk.checked && nat.h > 0) {
      st.outW = clamp(Math.round(h * (nat.w / nat.h)), 16, MAX_OUT);
      outWIn.value = String(st.outW);
    }
    outHIn.value = String(st.outH);
    infoLine.textContent = `Export ${st.outW} × ${st.outH} px`;
  });

  fmtSel.addEventListener('change', () => {
    st.format = fmtSel.value;
    st.dirty = true;
    qualityRow.style.display = st.format === 'image/png' ? 'none' : '';
  });
  qualityIn.addEventListener('input', () => {
    st.quality = Number(qualityIn.value) / 100;
    qualityVal.textContent = `${qualityIn.value}%`;
    st.dirty = true;
  });

  /* ----- sections ----- */

  const sec = (title, ...kids) => el('div', { class: 'ie-sec' },
    el('div', { class: 'ie-sec-title', text: title }),
    ...kids
  );

  const side = el('div', { class: 'ie-side' },
    infoLine,
    sec('Transform',
      el('div', { class: 'ie-row' },
        el('button', { class: 'btn sm', text: '⟲ L', title: 'Rotate 90° counter-clockwise', disabled: true, onclick: () => rotate(-1) }),
        el('button', { class: 'btn sm', text: '⟳ R', title: 'Rotate 90° clockwise', disabled: true, onclick: () => rotate(1) }),
        el('button', { class: 'btn sm', text: '⇋ Flip H', title: 'Flip horizontally', disabled: true, onclick: () => flip('h') }),
        el('button', { class: 'btn sm', text: '↕ Flip V', title: 'Flip vertically', disabled: true, onclick: () => flip('v') })
      ),
      el('button', { class: 'btn sm block', text: 'Reset all', disabled: true, onclick: resetAll })
    ),
    sec('Crop ratio', aspectChips,
      el('button', {
        class: 'btn sm block', style: 'margin-top:8px', text: 'Reset crop', disabled: true,
        onclick: () => {
          st.dirty = true;
          st.crop = fitAspect(st.aspect, oriented.width, oriented.height);
          syncCropEl();
          updateOutDims(!st.outTouched);
          renderPreview();
        },
      })
    ),
    sec('Adjust',
      bSlider.row, cSlider.row, sSlider.row,
      el('button', {
        class: 'btn sm block', style: 'margin-top:6px', text: 'Reset adjust', disabled: true,
        onclick: () => {
          st.adj = { ...DEFAULT_ADJ };
          st.dirty = true;
          [bSlider, cSlider, sSlider].forEach((s) => { s.inp.value = '100'; s.val.textContent = '100%'; });
          renderPreview();
        },
      })
    ),
    sec('Resize',
      el('div', { class: 'ie-row' },
        el('label', { class: 'field', style: 'flex:1;margin:0' }, el('span', { text: 'Width' }), outWIn),
        el('label', { class: 'field', style: 'flex:1;margin:0' }, el('span', { text: 'Height' }), outHIn)
      ),
      el('label', { class: 'ie-lock' }, lockChk, el('span', { text: 'Lock aspect' })),
      el('div', { class: 'ie-src' }, el('span', { text: 'Native crop: ' }), srcInfo)
    ),
    sec('Output',
      el('label', { class: 'field' }, el('span', { text: 'Format' }), fmtSel),
      qualityRow
    )
  );

  /* ----- assemble ----- */

  const main = el('div', { class: 'ie-main' }, stageBox, videoBar);
  const root = el('div', { class: 'ie' }, main, side);
  if (video) root.append(video);

  const footBtns = () => [...dlg.root.querySelectorAll('.foot .btn')];
  function setFootState(mode) { // 'loading' | 'ready' | 'busy'
    const btns = footBtns();
    btns.forEach((b, i) => {
      if (mode === 'busy') b.disabled = i !== 0; // Cancel stays live → abort save
      else if (mode === 'loading') b.disabled = i !== 0;
      else b.disabled = false;
    });
    const ready = mode === 'ready';
    side.querySelectorAll('.btn').forEach((b) => { b.disabled = !ready; });
    side.querySelectorAll('.chip').forEach((c) => { c.disabled = !ready; });
    [bSlider.inp, cSlider.inp, sSlider.inp, outWIn, outHIn, fmtSel, qualityIn]
      .forEach((s) => { s.disabled = !ready; });
    if (videoBar) {
      const videoOk = ready && !st.videoDead;
      scrub.disabled = !videoOk;
      playBtn.disabled = !videoOk;
      videoBar.style.display = st.videoDead ? 'none' : '';
    }
    cropEl.style.pointerEvents = ready ? '' : 'none';
  }

  async function exportBlob() {
    if (!st.ready) throw new Error('Image is still loading');
    const { sx, sy, sw, sh } = cropRectPx();
    const out = document.createElement('canvas');
    out.width = st.outW;
    out.height = st.outH;
    const ctx = out.getContext('2d');
    if (st.format === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, out.width, out.height);
    }
    if (canFilter) {
      ctx.filter = filterCss(st.adj);
      ctx.drawImage(oriented, sx, sy, sw, sh, 0, 0, out.width, out.height);
      ctx.filter = 'none';
    } else {
      // no ctx.filter — bake adjustments per-pixel when non-default
      ctx.drawImage(oriented, sx, sy, sw, sh, 0, 0, out.width, out.height);
      const { b, c, s } = st.adj;
      if (b !== 100 || c !== 100 || s !== 100) {
        const img = ctx.getImageData(0, 0, out.width, out.height);
        const d = img.data;
        const bm = b / 100;
        const cm = c / 100;
        const sm = s / 100;
        for (let i = 0; i < d.length; i += 4) {
          let r = d[i]; let g = d[i + 1]; let bl = d[i + 2];
          r = (r - 128) * cm + 128;
          g = (g - 128) * cm + 128;
          bl = (bl - 128) * cm + 128;
          r *= bm; g *= bm; bl *= bm;
          const gray = 0.299 * r + 0.587 * g + 0.114 * bl;
          r = gray + (r - gray) * sm;
          g = gray + (g - gray) * sm;
          bl = gray + (bl - gray) * sm;
          d[i] = clamp(r, 0, 255);
          d[i + 1] = clamp(g, 0, 255);
          d[i + 2] = clamp(bl, 0, 255);
        }
        ctx.putImageData(img, 0, 0);
      }
    }
    return new Promise((resolve, reject) => {
      out.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), st.format, st.quality);
    });
  }

  const dlg = modal({
    title,
    body: root,
    actions: [
      {
        label: 'Cancel',
        onClick: () => {
          if (st.dirty && st.ready && !confirm('Discard unsaved edits?')) return false;
          return undefined;
        },
      },
      ...actions.map((a) => ({
        label: a.label,
        class: a.class || '',
        onClick: async () => {
          setFootState('busy');
          try {
            const blob = await exportBlob();
            const result = await a.handler(blob);
            st.dirty = false;
            return result;
          } catch (e) {
            toast(e?.message || 'Save failed', true);
            return false; // keep modal open
          } finally {
            if (!st.closed) setFootState('ready');
          }
        },
      })),
    ],
  });
  dlg.root.classList.add('modal-wide', 'modal-editor');
  setFootState('loading');

  /* ----- lifecycle ----- */

  const obs = new MutationObserver(() => {
    const modalRoot = document.getElementById('modalRoot');
    if (!modalRoot || modalRoot.classList.contains('hidden') || !modalRoot.querySelector('.modal')) dispose();
  });
  obs.observe(document.getElementById('modalRoot'), {
    attributes: true,
    attributeFilter: ['class'],
    childList: true,
    subtree: true,
  });

  const onResize = () => renderPreview();
  window.addEventListener('resize', onResize);

  function dispose() {
    if (st.closed) return;
    st.closed = true;
    obs.disconnect();
    window.removeEventListener('resize', onResize);
    cancelAnimationFrame(rafId);
    if (video) {
      try { video.pause(); } catch { /* gone */ }
      video.removeAttribute('src');
      try { video.load(); } catch { /* gone */ }
    }
  }

  function showError(msg) {
    loadingEl.style.display = 'none';
    errorEl.style.display = 'flex';
    errorEl.textContent = '';
    errorEl.append(
      el('div', { text: msg }),
      el('button', {
        class: 'btn sm', type: 'button', style: 'margin-top:10px', text: 'Retry',
        onclick: () => {
          errorEl.style.display = 'none';
          loadingEl.style.display = 'flex';
          loadingEl.textContent = 'Loading…';
          setFootState('loading');
          const url = st.lastSrc;
          if (url) initFromImage(url);
        },
      })
    );
    setFootState('loading');
  }

  function onSourceReady() {
    st.srcW = source.width;
    st.srcH = source.height;
    if (!st.srcW || !st.srcH) {
      showError('Could not read image dimensions');
      return;
    }
    rebuildOriented();
    st.crop = fitAspect(st.aspect, oriented.width, oriented.height);
    st.ready = true;
    st.dirty = false;
    loadingEl.style.display = 'none';
    errorEl.style.display = 'none';
    renderPreview();
    updateOutDims(true);
    setFootState('ready');
    if (st.format !== 'image/png') qualityRow.style.display = '';
  }

  async function initFromImage(url) {
    st.lastSrc = url;
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Could not load image'));
        img.src = url;
      });
      source.width = img.naturalWidth;
      source.height = img.naturalHeight;
      source.getContext('2d').drawImage(img, 0, 0);
      onSourceReady();
    } catch (e) {
      showError(e.message);
    }
  }

  function captureVideoFrame(first) {
    if (!video || !video.videoWidth) return;
    source.width = video.videoWidth;
    source.height = video.videoHeight;
    source.getContext('2d').drawImage(video, 0, 0);
    if (first) onSourceReady();
    else {
      rebuildOriented();
      renderPreview();
    }
  }

  function initVideo() {
    video.addEventListener('loadedmetadata', () => {
      if (st.closed) return;
      const dur = video.duration || 0;
      scrub.max = String(dur || 10);
      const t0 = dur && Number.isFinite(dur) ? Math.min(0.5, dur / 2) : 0;
      scrub.value = String(t0);
      timeLbl.textContent = `${fmtDuration(t0)} / ${fmtDuration(dur)}`;
      // if already has data and t0===0, seeked may never fire — capture directly
      if (video.readyState >= 2 && t0 === 0) {
        captureVideoFrame(true);
      } else {
        video.currentTime = t0;
        // safety net if seeked never fires
        setTimeout(() => {
          if (!st.closed && !st.ready && video.readyState >= 2) captureVideoFrame(true);
        }, 1500);
      }
    });
    video.addEventListener('loadeddata', () => {
      if (st.closed || st.ready) return;
      if (video.readyState >= 2) {
        setTimeout(() => {
          if (!st.closed && !st.ready) captureVideoFrame(true);
        }, 500);
      }
    });
    video.addEventListener('seeked', () => {
      if (st.closed) return;
      scrub.value = String(video.currentTime);
      timeLbl.textContent = `${fmtDuration(video.currentTime)} / ${fmtDuration(video.duration || 0)}`;
      if (!st.ready) captureVideoFrame(true);
      else captureVideoFrame(false);
    });
    video.addEventListener('error', () => {
      if (st.closed) return;
      st.videoDead = true;
      if (videoBar) videoBar.style.display = 'none';
      if (fallbackSrc) initFromImage(fallbackSrc);
      else showError('Could not decode this video for thumbnail editing');
    });
    scrub.addEventListener('input', () => {
      if (!video || !st.ready || st.videoDead) return;
      video.pause();
      playBtn.textContent = '▶ Play';
      cancelAnimationFrame(rafId);
      video.currentTime = Number(scrub.value);
    });
    playBtn.addEventListener('click', () => {
      if (!video || !st.ready || st.videoDead) return;
      if (video.paused) {
        video.muted = true;
        video.play().then(() => {
          playBtn.textContent = '❚❚ Pause';
          const tick = () => {
            if (st.closed || video.paused) {
              playBtn.textContent = '▶ Play';
              return;
            }
            scrub.value = String(video.currentTime);
            timeLbl.textContent = `${fmtDuration(video.currentTime)} / ${fmtDuration(video.duration || 0)}`;
            captureVideoFrame(false);
            rafId = requestAnimationFrame(tick);
          };
          rafId = requestAnimationFrame(tick);
        }).catch(() => toast('Playback failed — try scrubbing instead', true));
      } else {
        video.pause();
        playBtn.textContent = '▶ Play';
        cancelAnimationFrame(rafId);
      }
    });
  }

  if (!isVideo && src) st.lastSrc = src;
  if (isVideo) initVideo();
  else initFromImage(src);
}
