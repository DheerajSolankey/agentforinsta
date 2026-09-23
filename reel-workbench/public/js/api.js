export async function api(path, opts = {}) {
  const { body, method } = opts;
  const init = { method: method || (body ? 'POST' : 'GET'), headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    const err = new Error(data?.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '—';
  const s = Number(sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m > 0 ? `${m}:${String(Math.floor(r)).padStart(2, '0')}` : `${r.toFixed(1)}s`;
}

export function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function fmtDate(isoOrMs) {
  const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset' && v && typeof v === 'object') {
      for (const [dk, dv] of Object.entries(v)) {
        if (dv != null && dv !== false) node.dataset[dk] = String(dv);
      }
    } else if (k === 'style' && v && typeof v === 'object') {
      Object.assign(node.style, v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2), v);
    } else {
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

let toastTimer = null;
export function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 5200 : 3000);
}

export function modal({ title, body, actions = [] }) {
  const root = document.getElementById('modalRoot');
  root.innerHTML = '';
  const close = () => root.classList.add('hidden');
  const m = el('div', { class: 'modal' },
    el('h2', { text: title }),
    body,
    el('div', { class: 'foot' },
      actions.map((a) =>
        el('button', {
          class: `btn ${a.class || ''}`,
          onclick: async (ev) => {
            try {
              if (a.onClick) {
                const keep = await a.onClick(close, ev);
                if (keep === false) return;
              }
              if (a.keepOpen) return;
              close();
            } catch (err) {
              toast(err?.message || 'Action failed', true);
            }
          },
          text: a.label,
        })
      )
    )
  );
  root.append(m);
  root.classList.remove('hidden');
  root.onclick = (e) => { if (e.target === root) close(); };
  return { close, root: m };
}

export function confirmModal(title, message) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      body: el('p', { text: message, style: 'color:var(--text2);line-height:1.5' }),
      actions: [
        { label: 'Cancel', onClick: () => resolve(false) },
        { label: 'Confirm', class: 'danger', onClick: () => resolve(true) },
      ],
    });
    const orig = m.root.parentElement;
    orig.addEventListener('click', (e) => { if (e.target === orig) resolve(false); }, { once: true });
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

const CAT_ICONS = {
  video: '🎬', image: '🖼', music: '🎵', voice: '🎙', sfx: '💥', audio: '🎧',
  font: '🔤', reference: '🔎', export: '📦', other: '📄',
};
export function catIcon(cat) { return CAT_ICONS[cat] || '📄'; }

export function catLabel(cat) {
  return { video: 'Videos', image: 'Images', music: 'Music', voice: 'Voice', sfx: 'SFX', audio: 'Audio', font: 'Fonts', reference: 'References', export: 'Exports', other: 'Other' }[cat] || cat;
}

/* ================= command palette + shortcut help ================= */

let paletteOpen = false;
let helpOpen = false;

export function initGlobalHotkeys(getCommands) {
  if (initGlobalHotkeys.bound) return;
  initGlobalHotkeys.bound = true;
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (paletteOpen) closePalette();
      else openPalette(typeof getCommands === 'function' ? getCommands() : []);
      return;
    }
    if (e.key === 'Escape') {
      if (paletteOpen) { closePalette(); return; }
      if (helpOpen) { closeHelp(); return; }
    }
    if (typing) return;
    if (e.key === '?') {
      e.preventDefault();
      if (helpOpen) closeHelp();
      else openHelp();
    }
  });
}

export function closePalette() {
  paletteOpen = false;
  const root = document.getElementById('paletteRoot');
  if (root) { root.classList.add('hidden'); root.innerHTML = ''; }
}

export function closeHelp() {
  helpOpen = false;
  const root = document.getElementById('paletteRoot');
  if (root) { root.classList.add('hidden'); root.innerHTML = ''; }
}

export function openPalette(commands = []) {
  const root = document.getElementById('paletteRoot');
  if (!root) return;
  paletteOpen = true;
  root.innerHTML = '';
  root.classList.remove('hidden');
  const list = el('div', { class: 'palette-list' });
  let filtered = [...commands];
  let active = 0;

  const renderList = () => {
    list.innerHTML = '';
    if (!filtered.length) {
      list.append(el('div', { class: 'palette-empty', text: 'No matches' }));
      return;
    }
    filtered.forEach((c, i) => {
      const row = el('button', {
        class: `palette-item ${i === active ? 'active' : ''}`,
        type: 'button',
        onclick: () => run(c),
      },
        el('span', { class: 'pi-label', text: c.label }),
        c.hint ? el('span', { class: 'pi-hint', text: c.hint }) : null
      );
      list.append(row);
    });
  };

  const run = (c) => {
    closePalette();
    try { c.run?.(); } catch (err) { toast(err?.message || 'Command failed', true); }
  };

  const input = el('input', {
    class: 'palette-input',
    placeholder: 'Type a command or page…',
    oninput: () => {
      const q = input.value.trim().toLowerCase();
      filtered = commands.filter((c) => !q || c.label.toLowerCase().includes(q) || (c.hint || '').toLowerCase().includes(q));
      active = 0;
      renderList();
    },
    onkeydown: (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(filtered.length - 1, active + 1); renderList(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); renderList(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (filtered[active]) run(filtered[active]); }
      else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    },
  });

  const panel = el('div', { class: 'palette' },
    el('div', { class: 'palette-head' },
      el('span', { class: 'palette-kbd', text: 'Ctrl+K' }),
      input
    ),
    list
  );
  root.append(panel);
  renderList();
  setTimeout(() => input.focus(), 30);
  root.onclick = (e) => { if (e.target === root) closePalette(); };
}

export function openHelp() {
  const root = document.getElementById('paletteRoot');
  if (!root) return;
  helpOpen = true;
  root.innerHTML = '';
  root.classList.remove('hidden');
  const rows = [
    ['Ctrl+K', 'Command palette'],
    ['?', 'This shortcut help'],
    ['Space', 'Play / pause'],
    ['S', 'Split clip at playhead'],
    ['Del', 'Delete selected clip'],
    ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'],
    ['Ctrl+S', 'Save timeline'],
    ['M', 'Add marker at playhead'],
    ['L', 'Toggle loop region'],
    ['← →', 'Scrub (Shift = 1s)'],
    ['Home / End', 'Jump start / end'],
    ['[ / ]', 'Zoom timeline out / in'],
    ['1–4', 'Nudge selected clip speed'],
    ['Shift+click clip', 'Multi-select on timeline'],
    ['Alt+←→↑↓', 'Nudge selection on canvas (Shift = 5%)'],
    ['Alt while drag', 'Disable snap guides'],
    ['Esc / 0', 'Fit preview zoom (exit 150%)'],
    ['+ / −', 'Preview zoom in / out'],
    ['P', 'Toggle 6.3" phone preview (drag to move)'],
    ['Esc', 'Clear multi-select / selection'],
    ['Drag on preview', 'Move · corners resize · snap to center'],
  ];
  const panel = el('div', { class: 'palette help-palette' },
    el('div', { class: 'palette-head' },
      el('b', { text: 'Keyboard shortcuts' }),
      el('button', { class: 'btn sm', text: 'Close', onclick: closeHelp })
    ),
    el('div', { class: 'help-grid' },
      rows.map(([k, d]) => el('div', { class: 'help-row' },
        el('kbd', { text: k }),
        el('span', { text: d })
      ))
    )
  );
  root.append(panel);
  root.onclick = (e) => { if (e.target === root) closeHelp(); };
}
