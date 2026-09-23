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

/** Attach a plain-language tooltip (title) for discoverability. */
export function hint(node, text) {
  if (node && text) node.title = text;
  return node;
}

let modalPrevFocus = null;

export function modal({ title, body, actions = [] }) {
  const root = document.getElementById('modalRoot');
  root.innerHTML = '';
  modalPrevFocus = document.activeElement;
  const titleId = `mdlg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const close = () => {
    root.classList.add('hidden');
    root.innerHTML = '';
    if (modalPrevFocus && typeof modalPrevFocus.focus === 'function') {
      try { modalPrevFocus.focus(); } catch { /* gone */ }
    }
    modalPrevFocus = null;
  };
  const m = el('div', {
    class: 'modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
  },
    el('h2', { id: titleId, text: title }),
    body,
    el('div', { class: 'foot' },
      actions.map((a) =>
        el('button', {
          class: `btn ${a.class || ''}`,
          type: 'button',
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

  // focus first focusable, trap Tab, Escape closes
  const focusables = () => [...m.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((n) => !n.disabled && n.offsetParent !== null);
  setTimeout(() => {
    const f = focusables();
    (f[0] || m).focus?.();
  }, 20);
  m.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  return { close, root: m };
}

export function confirmModal(title, message) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const m = modal({
      title,
      body: el('p', { text: message, style: 'color:var(--text2);line-height:1.5' }),
      actions: [
        { label: 'Cancel', onClick: () => finish(false) },
        { label: 'Confirm', class: 'danger', onClick: () => finish(true) },
      ],
    });
    const orig = m.root.parentElement;
    orig.addEventListener('click', (e) => { if (e.target === orig) finish(false); }, { once: true });
    // if closed via Escape / backdrop without an action click
    const obs = new MutationObserver(() => {
      if (rootHidden()) { finish(false); obs.disconnect(); }
    });
    function rootHidden() { return document.getElementById('modalRoot')?.classList.contains('hidden'); }
    obs.observe(document.getElementById('modalRoot'), { attributes: true, attributeFilter: ['class'] });
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
        role: 'option',
        'aria-selected': i === active ? 'true' : 'false',
        id: `pal-item-${i}`,
        onclick: () => run(c),
      },
        el('span', { class: 'pi-label', text: c.label }),
        c.hint ? el('span', { class: 'pi-hint', text: c.hint }) : null
      );
      list.append(row);
    });
    list.setAttribute('aria-activedescendant', `pal-item-${active}`);
  };

  const run = (c) => {
    closePalette();
    try { c.run?.(); } catch (err) { toast(err?.message || 'Command failed', true); }
  };

  const input = el('input', {
    class: 'palette-input',
    placeholder: 'Type a command or page…',
    'aria-label': 'Type a command or page',
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

  const panel = el('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
    el('div', { class: 'palette-head' },
      el('span', { class: 'palette-kbd', text: 'Ctrl+K' }),
      input
    ),
    list
  );
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Commands');
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
  const shortcuts = [
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
    ['P', 'Toggle 6.3" phone preview (drag to move)'],
    ['Esc', 'Clear multi-select / selection'],
    ['Drag on preview', 'Move · corners resize · snap to center'],
  ];
  const glossary = [
    ['Projects', 'Your Reels. Create one, then open it in the Editor.'],
    ['Media', 'Import videos, photos, music, and sound here.'],
    ['References', 'Upload a Reel you like → Analyze → save a Style.'],
    ['Styles', 'Look-and-feel recipes (color, captions, cuts). Apply to a project.'],
    ['Editor', 'The timeline. Drag clips, add text, press Space to play.'],
    ['Exports', 'Download finished videos, thumbnails, and captions.'],
    ['Looks', 'One-click color grades (B&W, Vintage, Teal, Golden, Vignette, Soft…).'],
    ['Motion', 'One-click camera moves (push-in, punch, Ken Burns, Spin, Float).'],
    ['Text FX', 'Entrance animations for titles (fade, pop, slide, bounce, flicker).'],
    ['PiP', 'Shrink a clip into a corner overlay (picture-in-picture).'],
    ['Split', 'Cut the selected clip in two at the red playhead line.'],
    ['Text', 'Add a title/caption clip on the text track.'],
    ['Safe guides', 'Show Instagram UI safe zones over the preview.'],
    ['Quick preview', 'Fast low-quality render to check your edit.'],
    ['Render final', 'Export the finished 1080×1920 Reel.'],
    ['Layout', 'Full screen, side-by-side, or top & bottom split.'],
    ['Track 🔒', 'Lock a track so clips cannot be moved.'],
    ['Track 👁', 'Hide a track (video/text disappears from preview).'],
    ['Track M', 'Mute an audio track.'],
    ['Clip Tools', 'Edit the selected clip: size, color, speed, fades, rotation.'],
    ['Keyframes', 'Animate a value over time (size, position, rotation, volume…). Smooth eases them.'],
    ['Transition in', 'How this clip appears: hard cut, fade, dip, flash…'],
  ];
  const panel = el('div', { class: 'palette help-palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Help' },
    el('div', { class: 'palette-head' },
      el('b', { text: 'Help' }),
      el('button', { class: 'btn sm', type: 'button', text: 'Close', onclick: closeHelp })
    ),
    el('div', { class: 'help-section-title', text: 'What the buttons do' }),
    el('div', { class: 'help-grid' },
      glossary.map(([k, d]) => el('div', { class: 'help-row glossary' },
        el('b', { text: k }),
        el('span', { text: d })
      ))
    ),
    el('div', { class: 'help-section-title', text: 'Keyboard shortcuts' }),
    el('div', { class: 'help-grid' },
      shortcuts.map(([k, d]) => el('div', { class: 'help-row' },
        el('kbd', { text: k }),
        el('span', { text: d })
      ))
    )
  );
  root.append(panel);
  root.onclick = (e) => { if (e.target === root) closeHelp(); };
  setTimeout(() => panel.querySelector('button')?.focus(), 20);
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeHelp(); }
  });
}
