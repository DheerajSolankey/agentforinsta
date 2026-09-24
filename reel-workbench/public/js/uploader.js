import { el, fmtBytes, fmtDuration } from './api.js';

let panel = null;
let refs = null;
let hideTimer = null;
let state = null;

function ensurePanel() {
  if (panel) return;
  refs = {
    title: el('div', { class: 'up-title' }),
    fill: el('div', { class: 'up-fill' }),
    stats: el('span', { class: 'up-stats' }),
    pct: el('span', { class: 'up-pct' }),
    status: el('div', { class: 'up-status' }),
  };
  const bar = el('div', { class: 'up-bar' }, refs.fill);
  refs.bar = bar;
  const meta = el('div', { class: 'up-meta' }, refs.stats, refs.pct);
  panel = el(
    'div',
    { id: 'uploadPanel', class: 'upload-panel hidden', role: 'status', 'aria-live': 'polite' },
    refs.title,
    bar,
    meta,
    refs.status
  );
  document.body.append(panel);
}

function resetPanel(title) {
  ensurePanel();
  clearTimeout(hideTimer);
  panel.classList.remove('hidden', 'done', 'error');
  refs.bar.classList.remove('indeterminate');
  refs.title.textContent = title;
  refs.fill.style.width = '0%';
  refs.stats.textContent = '';
  refs.pct.textContent = '0%';
  refs.status.textContent = '';
  const now = performance.now();
  state = { startedAt: now, lastT: now, lastLoaded: 0, speed: 0, phase: 'upload' };
}

function renderProgress(loaded, total) {
  if (!state || state.phase !== 'upload') return;
  const now = performance.now();
  const dt = (now - state.lastT) / 1000;
  if (dt >= 0.25) {
    const inst = (loaded - state.lastLoaded) / dt;
    state.speed = state.speed ? state.speed * 0.65 + inst * 0.35 : Math.max(inst, 0);
    state.lastT = now;
    state.lastLoaded = loaded;
  }
  if (total > 0) {
    const ratio = Math.min(1, loaded / total);
    refs.fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    refs.pct.textContent = `${Math.floor(ratio * 100)}%`;
    refs.stats.textContent = `${fmtBytes(loaded)} / ${fmtBytes(total)}`;
    if (loaded < total && state.speed > 0) {
      const eta = (total - loaded) / state.speed;
      refs.status.textContent = `~${fmtDuration(eta)} left · ${fmtBytes(state.speed)}/s`;
    } else if (loaded >= total) {
      enterProcessing();
    }
  } else {
    refs.bar.classList.add('indeterminate');
    refs.pct.textContent = '';
    refs.stats.textContent = fmtBytes(loaded);
    refs.status.textContent = state.speed > 0 ? `${fmtBytes(state.speed)}/s` : 'Uploading…';
  }
}

function enterProcessing() {
  if (!state || state.phase !== 'upload') return;
  state.phase = 'processing';
  refs.bar.classList.add('indeterminate');
  refs.fill.style.width = '';
  refs.pct.textContent = '';
  if (state.lastLoaded) refs.stats.textContent = fmtBytes(state.lastLoaded);
  refs.status.textContent = 'Processing (probe & thumbnail)…';
}

function finishPanel(msg = 'Done') {
  if (!panel) return;
  state = null;
  clearTimeout(hideTimer);
  panel.classList.remove('error');
  panel.classList.add('done');
  refs.bar.classList.remove('indeterminate');
  refs.fill.style.width = '100%';
  refs.pct.textContent = '100%';
  refs.status.textContent = msg;
  hideTimer = setTimeout(() => panel.classList.add('hidden'), 1400);
}

function failPanel(msg) {
  if (!panel) return;
  state = null;
  clearTimeout(hideTimer);
  panel.classList.remove('done');
  panel.classList.add('error');
  refs.bar.classList.remove('indeterminate');
  refs.status.textContent = msg;
  hideTimer = setTimeout(() => panel.classList.add('hidden'), 7000);
}

/**
 * Indeterminate progress for server-side work (FFmpeg cut/convert/extract).
 * Returns { done, fail } — call exactly one when the request settles.
 */
export function showServerOp(title) {
  resetPanel(title);
  enterProcessing();
  return {
    done(msg = 'Done') { finishPanel(msg); },
    fail(msg) { failPanel(msg || 'Failed'); },
  };
}

/** POST/PUT a FormData body with live upload progress. Resolves parsed JSON on 2xx. */
export function xhrWithProgress(url, fd, { title = 'Uploading…', method = 'POST', timeoutMs = 120000 } = {}) {
  resetPanel(title);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    if (timeoutMs > 0) xhr.timeout = timeoutMs;
    xhr.upload.onprogress = (e) => {
      if (!state) return;
      const loaded = e.loaded || 0;
      const total = e.lengthComputable ? e.total || 0 : 0;
      renderProgress(loaded, total);
      if (total > 0 && loaded >= total) enterProcessing();
    };
    xhr.upload.onerror = () => {
      failPanel('Network error during upload');
      reject(new Error('Network error during upload'));
    };
    xhr.ontimeout = () => {
      failPanel('Upload timed out');
      reject(new Error('Upload timed out'));
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { data = {}; }
      if (xhr.status >= 200 && xhr.status < 300) {
        finishPanel(data.failures?.length ? `Done — ${data.failures.length} file(s) failed` : 'Done');
        resolve(data);
      } else {
        const msg = data.error || `Upload failed (HTTP ${xhr.status})`;
        failPanel(msg);
        const err = new Error(msg);
        err.status = xhr.status;
        err.data = data;
        reject(err);
      }
    };
    xhr.onerror = () => {
      failPanel('Network error');
      reject(new Error('Network error'));
    };
    xhr.onabort = () => {
      failPanel('Upload cancelled');
      reject(new Error('Upload cancelled'));
    };
    xhr.send(fd);
  });
}
