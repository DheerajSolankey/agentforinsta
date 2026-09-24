import { api, el, toast, modal, fmtDuration, fmtBytes, fmtDate, confirmModal, catIcon, catLabel, copyText } from './api.js';
import { openImageEditor, formatForExt, extForFormat } from './image-editor.js';
import { xhrWithProgress, showServerOp } from './uploader.js';

const CATEGORIES = ['video', 'image', 'music', 'voice', 'sfx', 'audio', 'font', 'other'];

export async function uploadFiles(files, { asReference = false, category = null } = {}) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  if (asReference) fd.append('asReference', 'true');
  if (category) fd.append('category', category);
  const label = files.length === 1 ? files[0].name : `${files.length} files`;
  return xhrWithProgress('/api/media', fd, { title: `Importing ${label}` });
}

function importDropzone(opts) {
  const defaultLabel = opts.label || '+ Import media (drop files here)';
  const input = el('input', {
    type: 'file',
    multiple: true,
    accept: 'video/*,audio/*,image/*,.mkv,.mov,.webm,.wav,.mp3,.m4a,.flac,.png,.jpg,.jpeg,.webp',
    style: 'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:auto',
  });
  const zoneText = el('span', { text: defaultLabel });
  const zone = el('label', { class: 'media-import', style: 'display:block;position:relative;cursor:pointer' },
    zoneText,
    input
  );
  const pickerBtn = el('button', {
    class: 'btn primary', type: 'button', text: 'Import files',
    onclick: () => input.click(),
  });
  let busy = false;

  const resetLabel = () => { zoneText.textContent = defaultLabel; };

  const handle = async (fileList) => {
    if (busy) return;
    const files = [...(fileList || [])];
    if (!files.length) return;
    busy = true;
    zoneText.textContent = `Importing ${files.length} file(s)…`;
    pickerBtn.disabled = true;
    try {
      const data = await uploadFiles(files, opts);
      const fails = data.failures?.length ? ` (${data.failures.length} failed: ${data.failures[0].error})` : '';
      toast(`Imported ${data.media?.length || 0} file(s)${fails}`, !!fails);
      resetLabel();
      opts.onDone?.();
    } catch (e) {
      toast(e.message || 'Upload failed', true);
      resetLabel();
    } finally {
      busy = false;
      pickerBtn.disabled = false;
      input.value = '';
    }
  };

  // label + input: native file picker (click zone or button)
  input.addEventListener('change', () => { handle(input.files); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files?.length) handle(e.dataTransfer.files);
  });

  return el('div', { class: 'import-row', style: 'display:flex;gap:8px;align-items:stretch;margin-bottom:10px' },
    zone,
    pickerBtn
  );
}

function assetThumb(a) {
  return a.thumb
    ? el('img', { src: a.thumb, alt: `Preview of ${a.filename || a.original_filename || 'media'}`, loading: 'lazy' })
    : el('div', { class: 'mi-thumb', text: catIcon(a.category) });
}

function editMediaModal(a, onDone) {
  const name = el('input', { class: 'input', value: a.filename });
  const tags = el('input', { class: 'input', value: (a.tags || []).join(', '), placeholder: 'tag1, tag2', 'aria-label': 'Tags (comma separated)' });
  const rights = el('select', { class: 'input' },
    ['OWNED', 'LICENSED', 'USER_PROVIDED_WITH_PERMISSION', 'PUBLIC_DOMAIN_OR_PERMITTED', 'REFERENCE_ONLY', 'UNKNOWN']
      .map((r) => el('option', { value: r, selected: r === a.rights_status || undefined }, r))
  );
  if (a.rights_status === 'REFERENCE_ONLY' && a.category === 'reference') rights.disabled = true;
  const purpose = el('select', { class: 'input' },
    ['production', 'reference', 'both'].map((p) => el('option', { value: p, selected: p === a.purpose || undefined }, p))
  );
  if (a.rights_status === 'REFERENCE_ONLY') purpose.disabled = true;

  modal({
    title: `Edit media — ${a.original_filename || a.filename}`,
    body: el('div', {},
      el('label', { class: 'field' }, el('span', { text: 'Name' }), name),
      el('label', { class: 'field' }, el('span', { text: 'Tags' }), tags),
      el('div', { class: 'insp-grid' },
        el('label', { class: 'field' }, el('span', { text: 'Rights status' }), rights),
        el('label', { class: 'field' }, el('span', { text: 'Purpose' }), purpose)
      ),
      a.rights_status === 'REFERENCE_ONLY'
        ? el('p', { class: 'muted', style: 'font-size:11.5px;margin-top:8px', text: 'Reference assets stay REFERENCE_ONLY — they can be analyzed but never placed on a timeline.' })
        : null
    ),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save', class: 'primary',
        onClick: async () => {
          await api(`/api/media/${a.id}`, {
            method: 'PATCH',
            body: {
              filename: name.value,
              tags: tags.value.split(',').map((s) => s.trim()).filter(Boolean),
              rights_status: rights.disabled ? undefined : rights.value,
              purpose: purpose.disabled ? undefined : purpose.value,
            },
          });
          toast('Updated');
          onDone?.();
        },
      },
    ],
  });
}

async function uploadEditedFile(url, blob, filename, method = 'POST') {
  const fd = new FormData();
  fd.append('file', blob, filename);
  return xhrWithProgress(url, fd, { title: `Saving ${filename}`, method });
}

/** Open the image editor for an image asset. Save = overwrite in place; or save a derived copy. */
export function editAssetImage(a, onDone) {
  const base = String(a.url || '').split('?')[0];
  openImageEditor({
    title: `Edit image — ${a.filename}`,
    src: `${base}?v=${Date.now()}`,
    defaultFormat: formatForExt(a.ext),
    actions: [
      {
        label: 'Save changes', class: 'primary',
        handler: async (blob) => {
          const fx = extForFormat(blob.type);
          await uploadEditedFile(`/api/media/${a.id}/replace`, blob, `edited.${fx}`, 'POST');
          toast('Image updated');
          onDone?.();
        },
      },
      {
        label: 'Save as new copy',
        handler: async (blob) => {
          const fx = extForFormat(blob.type);
          const fd = new FormData();
          fd.append('files', blob, `${a.filename}-edited.${fx}`);
          fd.append('derivedFrom', a.id);
          await xhrWithProgress('/api/media', fd, { title: `Saving ${a.filename}-edited.${fx}` });
          toast('Saved as new copy');
          onDone?.();
        },
      },
    ],
  });
}

/** Open the editor on a video's thumbnail — scrub to a frame, crop/adjust, save as the cover. */
export function editAssetThumb(a, onDone) {
  const base = String(a.url || '').split('?')[0];
  const thumbBase = a.thumb ? String(a.thumb).split('?')[0] : null;
  openImageEditor({
    title: `Edit thumbnail — ${a.filename}`,
    videoSrc: `${base}?v=${Date.now()}`,
    fallbackSrc: thumbBase ? `${thumbBase}?v=${Date.now()}` : null,
    defaultFormat: 'image/jpeg',
    actions: [
      {
        label: 'Save thumbnail', class: 'primary',
        handler: async (blob) => {
          const fx = extForFormat(blob.type);
          await uploadEditedFile(`/api/media/${a.id}/thumb`, blob, `thumb.${fx}`, 'PUT');
          toast('Thumbnail updated');
          onDone?.();
        },
      },
    ],
  });
}

function mediaActions(a, { onDone, isReference = false }) {
  const isImage = a.kind === 'image' || a.category === 'image';
  const btns = [
    el('button', {
      class: 'btn sm ghost', text: 'Preview',
      onclick: () => {
        const isVideo = a.hasVideo && a.kind !== 'image';
        const isAudio = a.kind === 'audio' || (!a.hasVideo && a.hasAudio);
        const body = isVideo
          ? el('video', { src: a.url, controls: true, autoplay: true, style: 'width:100%;max-height:60vh;background:#000;border-radius:8px' })
          : isAudio
            ? el('div', {}, el('audio', { src: a.url, controls: true, autoplay: true, style: 'width:100%' }),
                el('p', { class: 'muted', style: 'margin-top:8px', text: a.filename }))
            : a.thumb || a.url
              ? el('img', { src: a.thumb || a.url, style: 'width:100%;border-radius:8px' })
              : el('p', { class: 'muted', text: 'No preview available' });
        modal({ title: a.filename, body, actions: [{ label: 'Close' }] });
      },
    }),
  ];
  if (isImage && a.ext !== '.svg') {
    btns.push(el('button', { class: 'btn sm ghost', text: 'Edit image', onclick: () => editAssetImage(a, onDone) }));
  } else if (a.hasVideo && a.kind !== 'image') {
    btns.push(el('button', { class: 'btn sm ghost', text: 'Edit thumbnail', onclick: () => editAssetThumb(a, onDone) }));
  }
  btns.push(
    el('button', { class: 'btn sm ghost', text: 'Rename', onclick: () => editMediaModal(a, onDone) }),
    el('button', {
      class: 'btn sm ghost', text: 'Copy path',
      onclick: async () => { await copyText(a.abs_path); toast('Path copied'); },
    }),
  );
  if (!isReference && (a.hasVideo || a.hasAudio)) {
    btns.push(
      el('button', {
        class: 'btn sm ghost', text: 'Cut segment',
        onclick: () => cutSegmentModal(a, onDone),
      }),
      el('button', {
        class: 'btn sm ghost', text: 'Extract audio',
        onclick: async () => {
          try {
            await api(`/api/media/${a.id}/extract-audio`, { body: {} });
            toast('Audio extracted');
            onDone?.();
          } catch (e) { toast(e.message, true); }
        },
      })
    );
  }
  if (!isReference && (a.hasVideo || (a.kind === 'image' && a.width))) {
    btns.push(
      el('button', {
        class: 'btn sm ghost', text: 'Convert size',
        onclick: () => convertSizeModal(a, onDone),
      })
    );
  }
  if (!isReference && a.hasVideo) {
    btns.push(
      el('button', {
        class: 'btn sm ghost', text: 'Extract frames',
        onclick: async () => {
          try {
            const r = await api(`/api/media/${a.id}/extract-frames`, { body: { count: 6 } });
            toast(`Extracted ${r.media.length} frames`);
            onDone?.();
          } catch (e) { toast(e.message, true); }
        },
      })
    );
  }
  if (isReference) {
    btns.push(
      el('button', {
        class: 'btn sm primary', text: 'Analyze style',
        onclick: () => analyzeModal(a, onDone),
      })
    );
  }
  btns.push(
    el('button', {
      class: 'btn sm danger', text: 'Delete',
      onclick: async () => {
        try {
          if (!(await confirmModal('Delete media', `Delete "${a.filename}" from the library?`))) return;
          await api(`/api/media/${a.id}`, { method: 'DELETE' });
          toast('Deleted');
          onDone?.();
        } catch (e) {
          if (e.status === 409 && e.data?.used) {
            modal({
              title: 'In use',
              body: el('p', { text: `Used on timeline of: ${e.data.used.join(', ')}. Remove those clips first, or delete with force.`, style: 'color:var(--text2)' }),
              actions: [
                { label: 'Close' },
                {
                  label: 'Force delete', class: 'danger',
                  onClick: async () => {
                    await api(`/api/media/${a.id}?force=true`, { method: 'DELETE' });
                    toast('Force deleted');
                    onDone?.();
                  },
                },
              ],
            });
          } else toast(e.message, true);
        }
      },
    })
  );
  return btns;
}

/** Parse "90" | "1:30" | "01:02:03.5" → seconds (client-side mirror of server). */
function parseTimecode(s) {
  const t = String(s ?? '').trim();
  if (!/^\d{1,3}(:\d{1,2}){0,2}(\.\d{1,3})?$/.test(t)) return null;
  const parts = t.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return sec;
}

function formatTimecode(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = s.toFixed(s % 1 === 0 ? 0 : 3).padStart(h > 0 || s >= 10 ? 2 : 1, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

function cutSegmentModal(asset, onDone) {
  const total = asset.duration || 0;
  const fromIn = el('input', {
    class: 'input', value: '0:00', 'aria-label': 'Cut from (start time)',
    placeholder: '0:00 or 00:01:30.5', spellcheck: 'false',
  });
  const toIn = el('input', {
    class: 'input', value: formatTimecode(Math.min(total || 10, 10)) || '0:10',
    'aria-label': 'Cut to (end time)',
    placeholder: '0:10 or 00:02:00', spellcheck: 'false',
  });
  const mode = el('select', { class: 'input', 'aria-label': 'Cut quality' },
    el('option', { value: 'copy', text: 'Fast (keyframe snap — instant on big files)' }),
    el('option', { value: 'precise', text: 'Precise (re-encode — slower, frame-accurate)' })
  );
  const info = el('p', { class: 'muted', style: 'font-size:11.5px;margin-top:6px' });
  const err = el('p', { style: 'color:var(--red);font-size:11.5px;min-height:14px;margin-top:4px' });

  const preview = () => {
    const a = parseTimecode(fromIn.value);
    const b = parseTimecode(toIn.value);
    if (a == null || b == null) { info.textContent = total ? `Source length: ${fmtDuration(total)}` : ''; return; }
    if (b <= a) { info.textContent = 'End must be after start'; return; }
    const len = b - a;
    info.textContent = `Segment: ${fmtDuration(len)}  ·  from ${formatTimecode(a)} → ${formatTimecode(b)}`
      + (total ? `  ·  source ${fmtDuration(total)}` : '');
  };
  fromIn.addEventListener('input', preview);
  toIn.addEventListener('input', preview);
  preview();

  // small helper: "use current preview position" is not available here — offer set-from/to via preview video
  const previewVideo = total
    ? el('video', {
        src: `${asset.url}?v=${Date.now()}`, controls: true, preload: 'metadata',
        style: 'width:100%;max-height:28vh;background:#000;border-radius:8px;margin-top:8px',
      })
    : null;
  const setFrom = el('button', {
    class: 'btn sm', type: 'button', text: 'Set from video time → From',
    onclick: () => {
      if (!previewVideo) return;
      fromIn.value = formatTimecode(previewVideo.currentTime || 0);
      preview();
    },
  });
  const setTo = el('button', {
    class: 'btn sm', type: 'button', text: 'Set from video time → To',
    onclick: () => {
      if (!previewVideo) return;
      toIn.value = formatTimecode(previewVideo.currentTime || 0);
      preview();
    },
  });

  const body = el('div', {},
    el('p', { class: 'muted', style: 'font-size:12px;margin-bottom:10px',
      text: 'Cut a part of this clip into a new library item. Accepts 90, 1:30, or 01:02:03.5.' }),
    el('div', { class: 'insp-grid', style: 'gap:10px' },
      el('label', { class: 'field' }, el('span', { text: 'From' }), fromIn),
      el('label', { class: 'field' }, el('span', { text: 'To' }), toIn),
      el('label', { class: 'field full' }, el('span', { text: 'Mode' }), mode)
    ),
    el('div', { style: 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap' }, setFrom, setTo),
    info, err,
    previewVideo
  );

  modal({
    title: `Cut segment — ${asset.filename}`,
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Cut', class: 'primary', keepOpen: true,
        onClick: async (close, ev) => {
          err.textContent = '';
          const start = parseTimecode(fromIn.value);
          const end = parseTimecode(toIn.value);
          if (start == null) { err.textContent = 'Invalid From time'; return false; }
          if (end == null) { err.textContent = 'Invalid To time'; return false; }
          if (end <= start) { err.textContent = 'To must be after From'; return false; }
          if (total > 0 && start >= total) { err.textContent = `From is past end (${fmtDuration(total)})`; return false; }
          const btn = ev?.currentTarget;
          if (btn) btn.disabled = true;
          const op = showServerOp(`Cutting ${formatTimecode(start)} → ${formatTimecode(end)}…`);
          try {
            const r = await api(`/api/media/${asset.id}/cut`, {
              body: { start: fromIn.value.trim(), end: toIn.value.trim(), mode: mode.value },
            });
            op.done(`Cut created — ${fmtDuration(r.media?.duration || 0)}`);
            toast('Segment cut into a new library item');
            onDone?.();
            close();
          } catch (e) {
            op.fail(e.message);
            err.textContent = e.message;
            if (btn) btn.disabled = false;
            return false;
          }
          return true;
        },
      },
    ],
  });
}

function convertSizeModal(asset, onDone) {
  const srcW0 = asset.width || 1080;
  const srcH0 = asset.height || 1920;
  const isVideo = asset.hasVideo && asset.kind !== 'image';
  const isImage = asset.kind === 'image' || asset.category === 'image';

  const wIn = el('input', { class: 'input', type: 'number', min: '16', max: '7680', step: '2', value: String(srcW0), 'aria-label': 'Width' });
  const hIn = el('input', { class: 'input', type: 'number', min: '16', max: '7680', step: '2', value: String(srcH0), 'aria-label': 'Height' });
  const modeSel = el('select', { class: 'input', 'aria-label': 'Fit mode' },
    el('option', { value: 'stretch', text: 'Stretch (fill exact size)' }),
    el('option', { value: 'pad', text: 'Pad (keep aspect, letterbox)' }),
    el('option', { value: 'crop', text: 'Crop (keep aspect, fill + trim)' })
  );
  const rotSel = el('select', { class: 'input', 'aria-label': 'Rotate before fit' },
    el('option', { value: '0', text: 'No rotation' }),
    el('option', { value: '90', text: 'Rotate 90° clockwise' }),
    el('option', { value: '180', text: 'Rotate 180°' }),
    el('option', { value: '270', text: 'Rotate 90° counter-clockwise' })
  );
  const info = el('p', { class: 'muted', style: 'font-size:11.5px;margin-top:6px' });
  const err = el('p', { style: 'color:var(--red);font-size:11.5px;min-height:14px;margin-top:4px' });

  /* ---- live preview: source frame → canvas with rotate + stretch/pad/crop ---- */
  const outCanvas = el('canvas', {
    class: 'cv-preview-canvas',
    'aria-label': 'Conversion preview',
    style: 'max-width:100%;max-height:220px;background:#000;border:1px solid var(--line);border-radius:8px;display:block',
  });
  const outCtx = outCanvas.getContext('2d');
  const srcLabel = el('span', { class: 'cv-tag', text: `Source ${srcW0}×${srcH0}` });
  const outLabel = el('span', { class: 'cv-tag', text: `Output ${srcW0}×${srcH0}` });
  const modeTag = el('span', { class: 'cv-tag', text: 'stretch' });

  let sourceEl = null; // HTMLImageElement | HTMLVideoElement
  let sourceReady = false;
  let drawRaf = 0;
  const rotCanvas = document.createElement('canvas');
  const rotCtx = rotCanvas.getContext('2d');
  const frameScrub = el('input', {
    type: 'range', min: '0', max: '1000', value: '200',
    'aria-label': 'Preview frame position',
    style: 'width:100%;margin-top:6px',
  });
  const scrubWrap = isVideo
    ? el('label', { class: 'field', style: 'margin-top:8px' },
        el('span', { text: 'Preview frame' }),
        frameScrub,
        el('div', { class: 'muted', id: 'cv-scrub-lbl', style: 'font-size:11px;margin-top:2px', text: '—' })
      )
    : null;
  const scrubLbl = scrubWrap?.querySelector('#cv-scrub-lbl') || null;

  const rotateDeg = () => Number(rotSel.value) || 0;
  const srcDims = () => {
    const r = rotateDeg();
    return r % 180 === 0 ? { w: srcW0, h: srcH0 } : { w: srcH0, h: srcW0 };
  };

  function loadSource() {
    if (isImage || (!isVideo && asset.thumb)) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { sourceEl = img; sourceReady = true; scheduleDraw(); };
      img.onerror = () => { sourceReady = false; info.textContent = 'Could not load preview image'; };
      img.src = asset.thumb || asset.url;
      sourceEl = img;
      return;
    }
    if (isVideo) {
      const v = document.createElement('video');
      v.preload = 'metadata'; // large files: only pull headers + first seek range
      v.muted = true;
      v.playsInline = true;
      v.crossOrigin = 'anonymous';
      v.src = asset.url;
      const grab = () => {
        // default preview frame ~20% in (matches scrubber default)
        const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : (asset.duration || 1);
        const t = Math.max(0.1, dur * 0.2);
        const onSeek = () => {
          v.removeEventListener('seeked', onSeek);
          sourceEl = v;
          sourceReady = true;
          if (scrubLbl) scrubLbl.textContent = `${fmtDuration(v.currentTime || 0)} / ${fmtDuration(dur)}`;
          scheduleDraw();
        };
        v.addEventListener('seeked', onSeek);
        try { v.currentTime = t; } catch { sourceReady = false; }
      };
      if (v.readyState >= 2) grab();
      else v.addEventListener('loadeddata', grab, { once: true });
      v.addEventListener('error', () => { sourceReady = false; });
      sourceEl = v;
      return;
    }
    // fallback: thumb only
    if (asset.thumb) {
      const img = new Image();
      img.onload = () => { sourceEl = img; sourceReady = true; scheduleDraw(); };
      img.src = asset.thumb;
      sourceEl = img;
    }
  }

  function drawFrame() {
    drawRaf = 0;
    const w = Math.round(Number(wIn.value) || 0);
    const h = Math.round(Number(hIn.value) || 0);
    const rot = rotateDeg();
    outLabel.textContent = `Output ${w}×${h}`;
    modeTag.textContent = rot ? `${modeSel.value} · rot ${rot}°` : modeSel.value;
    if (!(w >= 16 && h >= 16 && w <= 7680 && h <= 7680)) return;
    outCanvas.width = w;
    outCanvas.height = h;
    outCtx.fillStyle = '#000';
    outCtx.fillRect(0, 0, w, h);
    if (!sourceReady || !sourceEl) {
      outCtx.fillStyle = '#555';
      outCtx.font = `${Math.max(12, Math.floor(w / 28))}px sans-serif`;
      outCtx.textAlign = 'center';
      outCtx.textBaseline = 'middle';
      outCtx.fillText('Loading preview…', w / 2, h / 2);
      return;
    }
    const natW = sourceEl.videoWidth || sourceEl.naturalWidth || sourceEl.width || srcW0;
    const natH = sourceEl.videoHeight || sourceEl.naturalHeight || sourceEl.height || srcH0;
    // 1) render source into rotated buffer (actual pixels, no stretch)
    const swap = rot % 180 !== 0;
    rotCanvas.width = swap ? natH : natW;
    rotCanvas.height = swap ? natW : natH;
    rotCtx.save();
    rotCtx.fillStyle = '#000';
    rotCtx.fillRect(0, 0, rotCanvas.width, rotCanvas.height);
    rotCtx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
    rotCtx.rotate((rot * Math.PI) / 180);
    rotCtx.drawImage(sourceEl, -natW / 2, -natH / 2, natW, natH);
    rotCtx.restore();

    const sw = rotCanvas.width;
    const sh = rotCanvas.height;
    const mode = modeSel.value;
    if (mode === 'stretch') {
      outCtx.drawImage(rotCanvas, 0, 0, w, h);
    } else if (mode === 'pad') {
      const scale = Math.min(w / sw, h / sh);
      const dw = sw * scale;
      const dh = sh * scale;
      outCtx.drawImage(rotCanvas, (w - dw) / 2, (h - dh) / 2, dw, dh);
    } else { // crop
      const scale = Math.max(w / sw, h / sh);
      const dw = sw * scale;
      const dh = sh * scale;
      outCtx.drawImage(rotCanvas, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }
    // thin accent frame when pad letterboxes
    if (mode === 'pad' && Math.abs(sw / sh - w / h) > 0.01) {
      outCtx.strokeStyle = 'rgba(232,180,74,0.35)';
      outCtx.lineWidth = Math.max(1, Math.round(w / 400));
      outCtx.strokeRect(0.5, 0.5, w - 1, h - 1);
    }
  }

  function scheduleDraw() {
    if (drawRaf) return;
    drawRaf = requestAnimationFrame(drawFrame);
  }

  function preview() {
    const w = Math.round(Number(wIn.value) || 0);
    const h = Math.round(Number(hIn.value) || 0);
    if (w < 16 || h < 16 || w > 7680 || h > 7680) {
      info.textContent = 'Size must be 16–7680';
      err.textContent = '';
      scheduleDraw();
      return;
    }
    const rot = rotateDeg();
    const sd = srcDims();
    const srcAr = (sd.w / sd.h).toFixed(3);
    const outAr = (w / h).toFixed(3);
    const same = w === srcW0 && h === srcH0 && rot === 0 && modeSel.value === 'stretch';
    info.textContent = `${srcW0}×${srcH0}${rot ? ` →rot${rot}→ ${sd.w}×${sd.h}` : ''} → ${w}×${h}  ·  ${modeSel.value}`
      + `  ·  AR ${srcAr} → ${outAr}`
      + (same ? '  ·  same size' : '')
      + (asset.duration ? `  ·  ${fmtDuration(asset.duration)}` : '');
    scheduleDraw();
  }

  const PRESETS = [
    { w: 1080, h: 1920, label: '9:16 · 1080×1920' },
    { w: 720, h: 1280, label: '9:16 · 720×1280' },
    { w: 1920, h: 1080, label: '16:9 · 1920×1080' },
    { w: 1280, h: 720, label: '16:9 · 1280×720' },
    { w: 1080, h: 1080, label: '1:1 · 1080×1080' },
    { w: srcW0, h: srcH0, label: `Source · ${srcW0}×${srcH0}` },
  ];
  const chips = el('div', { class: 'chips', style: 'margin:8px 0' });
  const chipEls = [];
  for (const p of PRESETS) {
    const chip = el('button', {
      class: `chip ${p.w === srcW0 && p.h === srcH0 ? 'active' : ''}`, type: 'button', text: p.label,
      onclick: () => {
        wIn.value = String(p.w);
        hIn.value = String(p.h);
        chipEls.forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        preview();
      },
    });
    chipEls.push(chip);
    chips.append(chip);
  }

  // landscape movie → portrait reel: rotate 90° CW + crop to fill 9:16
  const reelBtn = el('button', {
    class: 'btn sm', type: 'button', text: 'Reel 9:16 (rotate + crop)',
    title: 'Rotate 90° CW then crop to 720×1280 — no stretch',
    onclick: () => {
      rotSel.value = '90';
      wIn.value = '720';
      hIn.value = '1280';
      modeSel.value = 'crop';
      syncChip();
      preview();
    },
  });
  const reelPadBtn = el('button', {
    class: 'btn sm', type: 'button', text: 'Reel 9:16 (rotate + pad)',
    title: 'Rotate 90° CW then letterbox to 720×1280 — full frame kept',
    onclick: () => {
      rotSel.value = '90';
      wIn.value = '720';
      hIn.value = '1280';
      modeSel.value = 'pad';
      syncChip();
      preview();
    },
  });

  const swap = el('button', {
    class: 'btn sm', type: 'button', text: 'Swap W↔H',
    onclick: () => {
      const t = wIn.value; wIn.value = hIn.value; hIn.value = t;
      chipEls.forEach((c) => c.classList.remove('active'));
      preview();
    },
  });
  const keepAspect = el('button', {
    class: 'btn sm', type: 'button', text: 'Match aspect',
    onclick: () => {
      const sd = srcDims();
      const ratio = sd.w / sd.h || 1;
      hIn.value = String(Math.round(Number(wIn.value) / ratio) || sd.h);
      chipEls.forEach((c) => c.classList.remove('active'));
      preview();
    },
  });

  // mark active chip when size matches a preset
  const syncChip = () => {
    const w = Math.round(Number(wIn.value));
    const h = Math.round(Number(hIn.value));
    chipEls.forEach((c, i) => {
      c.classList.toggle('active', PRESETS[i].w === w && PRESETS[i].h === h);
    });
  };
  const onField = () => { syncChip(); preview(); };
  wIn.addEventListener('input', onField);
  hIn.addEventListener('input', onField);
  modeSel.addEventListener('change', preview);
  rotSel.addEventListener('change', preview);

  frameScrub.addEventListener('input', () => {
    if (!sourceEl || !sourceEl.duration || !Number.isFinite(sourceEl.duration)) return;
    const t = (Number(frameScrub.value) / 1000) * sourceEl.duration;
    const onSeek = () => {
      sourceEl.removeEventListener('seeked', onSeek);
      if (scrubLbl) scrubLbl.textContent = `${fmtDuration(t)} / ${fmtDuration(sourceEl.duration)}`;
      scheduleDraw();
    };
    sourceEl.addEventListener('seeked', onSeek);
    try { sourceEl.currentTime = t; } catch { /* ignore */ }
  });

  const previewBox = el('div', { class: 'cv-preview-box' },
    el('div', { class: 'cv-preview-head' }, srcLabel, el('span', { class: 'cv-arrow', text: '→' }), outLabel, modeTag),
    outCanvas,
    scrubWrap
  );

  loadSource();
  preview();

  const body = el('div', {},
    el('p', { class: 'muted', style: 'font-size:12px;margin-bottom:8px',
      text: 'Live preview updates as you change rotate / size / fit mode. For 1920×1038 movies → 720×1280 reels, use Reel 9:16 (rotate + crop).' }),
    previewBox,
    el('div', { class: 'chips', style: 'margin:0 0 8px' }, reelBtn, reelPadBtn),
    chips,
    el('div', { class: 'insp-grid', style: 'gap:10px' },
      el('label', { class: 'field' }, el('span', { text: 'Width' }), wIn),
      el('label', { class: 'field' }, el('span', { text: 'Height' }), hIn),
      el('label', { class: 'field full' }, el('span', { text: 'Rotate (before fit)' }), rotSel),
      el('label', { class: 'field full' }, el('span', { text: 'Fit mode' }), modeSel)
    ),
    el('div', { style: 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap' }, swap, keepAspect),
    info, err
  );

  const release = () => {
    if (drawRaf) cancelAnimationFrame(drawRaf);
    if (sourceEl && sourceEl.tagName === 'VIDEO') {
      try { sourceEl.pause(); sourceEl.removeAttribute('src'); sourceEl.load(); } catch { /* ignore */ }
    }
    sourceEl = null;
    sourceReady = false;
    if (mo) { mo.disconnect(); mo = null; }
  };

  /* cleanup on any close path (button, Escape, backdrop) */
  let mo = null;
  const root = document.getElementById('modalRoot');
  mo = new MutationObserver(() => {
    if (!root || !root.classList.contains('hidden') && root.querySelector('.modal')) return;
    release();
  });
  if (root) mo.observe(root, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });

  modal({
    title: `Convert size — ${asset.filename}`,
    body,
    actions: [
      { label: 'Cancel', onClick: () => { release(); } },
      {
        label: 'Convert', class: 'primary', keepOpen: true,
        onClick: async (close, ev) => {
          err.textContent = '';
          const w = Math.round(Number(wIn.value));
          const h = Math.round(Number(hIn.value));
          const rotate = rotateDeg();
          if (!Number.isFinite(w) || !Number.isFinite(h) || w < 16 || h < 16 || w > 7680 || h > 7680) {
            err.textContent = 'Width/height must be 16–7680';
            return false;
          }
          if (w === srcW0 && h === srcH0 && modeSel.value === 'stretch' && rotate === 0) {
            err.textContent = 'Already that size — pick a different size, rotate, or fit mode';
            return false;
          }
          const btn = ev?.currentTarget;
          if (btn) btn.disabled = true;
          const op = showServerOp(`Converting to ${w}×${h}${rotate ? ` (rot ${rotate}°)` : ''}…`);
          try {
            const r = await api(`/api/media/${asset.id}/convert`, {
              body: { width: w, height: h, mode: modeSel.value, rotate },
            });
            op.done(`Converted — ${r.media?.width}×${r.media?.height}`);
            toast(`Converted to ${r.media?.width}×${r.media?.height}`);
            onDone?.();
            release();
            close();
          } catch (e) {
            op.fail(e.message);
            err.textContent = e.message;
            if (btn) btn.disabled = false;
            return false;
          }
          return true;
        },
      },
    ],
  });
}

async function analyzeModal(asset, onDone) {
  const nameInput = el('input', { class: 'input', value: `Style from ${asset.filename}`, 'aria-label': 'Draft style name' });
  const out = el('div', { class: 'muted', text: 'Local FFmpeg analysis: scene cuts, pacing, visual stats, audio energy…' });
  const analyzeBtn = el('button', { class: 'btn primary', type: 'button', text: 'Analyze' });
  const pre = el('pre', { class: 'code', style: 'display:none;max-height:34vh' });
  const saveName = el('input', { class: 'input', placeholder: 'Style name (e.g. My Dark Motivation)', 'aria-label': 'Style name to save' });
  let draft = null;

  analyzeBtn.addEventListener('click', async () => {
    analyzeBtn.disabled = true;
    out.textContent = 'Analyzing… (local FFmpeg, can take a minute)';
    try {
      const r = await api('/api/analyze', { body: { mediaId: asset.id, name: nameInput.value } });
      draft = r.style;
      saveName.value = draft.name;
      pre.style.display = 'block';
      pre.textContent = JSON.stringify(draft, null, 2);
      out.innerHTML = '';
      out.append(
        el('div', { class: 'chips', style: 'margin-top:6px' },
          el('span', { class: 'chip', text: `shots: ${draft.pacing?.sceneCount ?? '?'}` }),
          el('span', { class: 'chip', text: `avg shot: ${draft.pacing?.averageShotDuration ?? '?'}s` }),
          el('span', { class: 'chip', text: `cuts: ${draft.cuts?.frequency ?? '?'}` }),
          el('span', { class: 'chip', text: `contrast: ${draft.visual?.contrast ?? '?'}` }),
          el('span', { class: 'chip', text: `brightness: ${draft.visual?.brightness ?? '?'}` })
        ),
        el('div', { class: 'muted', style: 'margin-top:8px;font-size:11.5px', text: 'Draft saved below — review, then store it in your Style Library.' })
      );
    } catch (e) {
      out.textContent = e.message;
      out.style.color = 'var(--red)';
    } finally {
      analyzeBtn.disabled = false;
    }
  });

  modal({
    title: 'Analyze reference → style',
    body: el('div', {},
      el('label', { class: 'field' }, el('span', { text: 'Draft name' }), nameInput),
      el('div', { class: 'row', style: 'margin-bottom:10px' }, analyzeBtn, out),
      pre,
      draft || true ? el('label', { class: 'field', style: 'margin-top:10px' }, el('span', { text: 'Save as style' }), saveName) : null
    ),
    actions: [
      { label: 'Close' },
      {
        label: 'Save style', class: 'primary',
        onClick: async () => {
          if (!draft) { toast('Run analysis first', true); return false; }
          draft.name = saveName.value.trim() || draft.name;
          delete draft.id;
          const saved = await api('/api/styles', { body: draft });
          toast(`Saved style "${saved.style.name}"`);
          onDone?.();
        },
      },
    ],
  });
}

function urlImportModal(asReference, onDone) {
  const url = el('input', { class: 'input', placeholder: 'https://example.com/file.mp4 (direct media file URL)', 'aria-label': 'Direct media file URL' });
  const note = el('p', {
    class: 'muted',
    style: 'font-size:11.5px;margin-top:8px;line-height:1.5',
    text: 'Direct file URLs only. No logins, no DRM, no platform pages, no bypasses. Anything imported this way is REFERENCE_ONLY by default.',
  });
  modal({
    title: 'Import from URL',
    body: el('div', {}, el('label', { class: 'field' }, el('span', { text: 'URL' }), url), note),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Download', class: 'primary',
        onClick: async () => {
          try {
            await api('/api/media/url', { body: { url: url.value.trim(), asReference, confirmDirectFile: true } });
            toast('Downloaded and imported');
            onDone?.();
          } catch (e) { toast(e.message, true); return false; }
        },
      },
    ],
  });
}

/* ================= MEDIA VIEW ================= */

export function renderMediaView(root, { category = null } = {}) {
  return buildLibrary(root, { category, referenceMode: false });
}

export function renderReferencesView(root) {
  return buildLibrary(root, { category: 'reference', referenceMode: true });
}

async function buildLibrary(root, { category: initCat, referenceMode }) {
  root.classList.add('pad');
  let cat = initCat || 'all';
  let q = '';

  const listWrap = el('div', { class: 'grid', style: 'margin-top:14px' });

  async function refresh() {
    const query = new URLSearchParams();
    if (cat !== 'all') query.set('category', cat);
    if (q) query.set('q', q);
    const { media } = await api(`/api/media?${query}`);
    listWrap.innerHTML = '';
    if (!media.length) {
      listWrap.append(
        el('div', { class: 'empty', style: 'grid-column:1/-1' },
          el('div', { class: 'big', text: referenceMode ? 'No reference Reels yet' : 'No media yet' }),
          el('div', { text: referenceMode ? 'Upload a reference Reel to analyze its editing style.' : 'Import videos, images, music, voice or SFX to get started.' })
        )
      );
      return;
    }
    for (const a of media) {
      const isRef = a.category === 'reference' || a.rights_status === 'REFERENCE_ONLY';
      listWrap.append(
        el('div', { class: 'card media-card' },
          el('div', { class: 'row1' },
            a.thumb ? el('img', { class: 'thumb-sq', src: a.thumb, alt: `Preview of ${a.filename}`, loading: 'lazy' }) : el('div', { class: 'ic-sq', text: catIcon(a.category) }),
            el('div', { class: 'info' },
              el('div', { class: 'fname', text: a.filename }),
              el('div', { class: 'fmeta' },
                el('span', { text: [fmtDuration(a.duration), a.width ? `${a.width}×${a.height}` : null, fmtBytes(a.size)].filter(Boolean).join(' · ') }),
                el('div', { style: 'margin-top:4px' },
                  el('span', { class: `badge ${isRef ? 'ref' : ''}`, text: isRef ? 'REFERENCE_ONLY' : a.rights_status }),
                  el('span', { class: 'badge', style: 'margin-left:4px', text: catLabel(a.category) }),
                  a.derived_from ? el('span', { class: 'badge', style: 'margin-left:4px', text: 'derived' }) : null
                ),
                (a.tags || []).length ? el('div', { style: 'margin-top:4px' }, a.tags.map((t) => el('span', { class: 'chip', style: 'margin-right:4px;cursor:default', text: t }))) : null
              )
            )
          ),
          el('div', { class: 'actions' }, ...mediaActions(a, { onDone: refresh, isReference: isRef }))
        )
      );
    }
  }

  const chips = el('div', { class: 'chips' });
  const cats = referenceMode
    ? [{ id: 'reference', label: 'Reference Reels' }]
    : [{ id: 'all', label: 'All' }, ...CATEGORIES.map((c) => ({ id: c, label: catLabel(c) })), { id: 'reference', label: 'References' }];
  for (const c of cats) {
    const chip = el('button', {
      type: 'button',
      class: `chip ${c.id === cat ? 'active' : ''}`,
      text: c.label,
      'aria-pressed': c.id === cat ? 'true' : 'false',
    });
    chip.addEventListener('click', () => {
      if (c.id === 'reference' && !referenceMode) {
        location.hash = '#/references';
        return;
      }
      cat = c.id;
      chips.querySelectorAll('.chip').forEach((x) => {
        x.classList.remove('active');
        x.setAttribute('aria-pressed', 'false');
      });
      chip.classList.add('active');
      chip.setAttribute('aria-pressed', 'true');
      refresh();
    });
    chips.append(chip);
  }

  const search = el('input', {
    class: 'input', placeholder: 'Search name or tags…', 'aria-label': 'Search media by name or tags',
    style: 'max-width:240px',
  });
  search.addEventListener('input', () => {
    q = search.value.trim();
    refresh();
  });

  const importCtl = importDropzone({
    label: referenceMode ? '+ Drop reference Reel(s) or click to upload' : '+ Import media (drop files here)',
    asReference: referenceMode,
    category: referenceMode ? 'reference' : null,
    onDone: refresh,
  });

  root.append(
    el('div', { class: 'view-head' },
      el('h1', { text: referenceMode ? 'References' : 'Media' }),
      el('span', { class: 'sub', text: referenceMode ? 'Editing references — analyzed for style, never auto-used in renders' : 'Your local media library' }),
      el('div', { class: 'spacer' }),
      search,
      el('button', {
        class: 'btn primary', text: 'Import files',
        onclick: () => { importCtl.querySelector('input[type=file]')?.click(); },
      }),
      el('button', { class: 'btn', text: 'URL import', onclick: () => urlImportModal(referenceMode, refresh) })
    ),
    importCtl,
    referenceMode
      ? el('div', { class: 'help-line', text: 'Workflow: reference → Analyze style → save Style → apply to YOUR media. Reference assets are REFERENCE_ONLY and blocked from rendering.' })
      : chips,
    listWrap
  );
  await refresh();
}
