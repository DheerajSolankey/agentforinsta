import { api, el, toast, modal, fmtDuration, fmtDate, confirmModal, initGlobalHotkeys, openHelp } from './api.js';
import { renderMediaView, renderReferencesView } from './media.js';
import { renderStylesView } from './styles.js';
import { renderEditorView, editorOpenProject, editorOpenLast, editorCleanup } from './editor.js';

const viewRoot = () => document.getElementById('view');
let currentView = null;
const routes = {};
export const appState = { projectId: null, env: null };

routes.projects = renderProjects;
routes.media = (root, rest = []) => renderMediaView(root, { category: rest[0] || null });
routes.references = (root) => renderReferencesView(root);
routes.styles = renderStylesView;
routes.editor = renderEditorView;
routes.exports = renderExports;
routes.settings = renderSettings;

function paletteCommands() {
  const pages = [
    ['Projects', '#/projects'],
    ['Media', '#/media'],
    ['References', '#/references'],
    ['Styles & Templates', '#/styles'],
    ['Editor', '#/editor'],
    ['Exports', '#/exports'],
    ['Settings', '#/settings'],
  ].map(([label, hash]) => ({ label: `Go: ${label}`, hint: hash, run: () => navigate(hash) }));

  const actions = [
    {
      label: 'Create new project',
      hint: 'projects',
      run: async () => {
        try {
          const { project } = await api('/api/projects', { body: { name: `Reel ${Date.now() % 1000}` } });
          toast(`Created ${project.name}`);
          editorOpenProject(project.id);
        } catch (e) { toast(e.message, true); }
      },
    },
    { label: 'Import media', hint: 'media', run: () => navigate('#/media') },
    { label: 'Import reference Reel', hint: 'references', run: () => navigate('#/references') },
    { label: 'Open last project', hint: 'editor', run: () => editorOpenLast() },
    { label: 'Open command help', hint: '?', run: () => openHelp() },
  ];
  return [...actions, ...pages];
}

export function navigate(hash) {
  if (location.hash !== hash) location.hash = hash;
  else route();
}

async function route() {
  const hash = location.hash.replace(/^#\//, '') || 'projects';
  const [name, ...rest] = hash.split('/');
  const fn = routes[name] || routes.projects;
  if (currentView === 'editor' && name !== 'editor') editorCleanup();
  currentView = name;
  document.querySelectorAll('#mainnav a').forEach((a) => {
    const on = a.dataset.view === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const gear = document.querySelector('.topbar-right a[data-view="settings"]');
  if (gear) {
    const on = name === 'settings';
    if (on) gear.setAttribute('aria-current', 'page');
    else gear.removeAttribute('aria-current');
  }
  const root = viewRoot();
  root.innerHTML = '';
  root.className = 'view';
  try {
    await fn(root, rest);
  } catch (err) {
    console.error('[route]', name, err);
    root.append(
      el('div', { class: 'empty' },
        el('div', { class: 'big', text: 'Something went wrong' }),
        el('div', { class: 'muted', text: err?.message || String(err) }),
        err?.stack ? el('pre', { class: 'code', style: 'max-height:30vh;overflow:auto;text-align:left;font-size:11px', text: String(err.stack) }) : null,
        el('button', { class: 'btn', text: 'Back to Projects', onclick: () => navigate('#/projects') })
      )
    );
  }
}

window.addEventListener('hashchange', route);

/* ================= PROJECTS ================= */

async function renderProjects(root) {
  root.classList.add('pad');
  const { projects } = await api('/api/projects');
  const { media } = await api('/api/media');

  const grid = el('div', { class: 'grid' });

  const newCard = el('div', { class: 'card', style: 'border-style:dashed;cursor:pointer;align-items:center;justify-content:center;min-height:220px' },
    el('div', { style: 'font-size:30px;color:var(--text3)', text: '＋' }),
    el('h3', { text: 'New Project' }),
    el('div', { class: 'meta', text: '1080 × 1920 · 30 fps' }),
    el('button', {
      class: 'btn primary sm', text: 'Create',
      onclick: async (e) => {
        e.stopPropagation();
        try {
          const { project } = await api('/api/projects', { body: { name: `Reel ${projects.length + 1}` } });
          toast(`Created ${project.name}`);
          editorOpenProject(project.id);
        } catch (err) { toast(err.message, true); }
      },
    })
  );
  grid.append(newCard);

  for (const p of projects) {
        const thumb = p.thumbnail
      ? el('img', { class: 'thumb', alt: `Thumbnail for ${p.name}`, src: `/api/projects/${p.id}/exports/${encodeURIComponent(p.thumbnail.replace('exports/', ''))}`, onerror: function () { this.src = `/api/projects/${p.id}/poster?t=0`; } })
      : el('img', { class: 'thumb', alt: `Thumbnail for ${p.name}`, src: `/api/projects/${p.id}/poster?t=0`, onerror: function () { this.style.background = '#111'; this.removeAttribute('src'); } });

    const statusBadge = p.renderJob && ['queued', 'processing'].includes(p.renderJob.status)
      ? el('span', { class: 'badge warn', text: `rendering ${p.renderJob.progress || 0}%` })
      : p.status === 'rendered'
        ? el('span', { class: 'badge ok', text: 'rendered' })
        : p.status === 'failed'
          ? el('span', { class: 'badge fail', text: 'failed' })
          : p.status === 'ready'
            ? el('span', { class: 'badge ok', text: 'ready' })
            : p.status === 'active'
              ? el('span', { class: 'badge warn', text: 'active' })
              : el('span', { class: 'badge', text: p.status || 'draft' });

    const statusSel = el('select', {
      class: 'input status-sel',
      title: 'Project status',
      'aria-label': `Project status for ${p.name}`,
      onchange: async (e) => {
        try {
          await api(`/api/projects/${p.id}`, { method: 'PATCH', body: { status: e.target.value } });
          toast('Status updated');
          route();
        } catch (err) { toast(err.message, true); }
      },
    },
      ['draft', 'active', 'ready', 'rendered'].map((s) =>
        el('option', { value: s, selected: (p.status || 'draft') === s || undefined }, s))
    );

    grid.append(
      el('div', { class: 'card' },
        el('div', { class: 'thumb-wrap', onclick: () => editorOpenProject(p.id), style: 'cursor:pointer' }, thumb,
          el('div', { class: 'play-ico', text: '▶' })),
        el('h3', { text: p.name }),
        el('div', { class: 'meta' },
          el('span', { text: fmtDuration(p.duration) }),
          el('span', { text: fmtDate(p.updated_at) }),
          statusBadge
        ),
        p.style_name ? el('div', { class: 'meta' }, el('span', { class: 'badge', text: p.style_name })) : null,
        el('div', { class: 'actions', style: 'align-items:center;gap:8px' },
          statusSel,
          el('button', { class: 'btn sm primary', text: 'Open', onclick: () => editorOpenProject(p.id) }),
          el('button', {
            class: 'btn sm', text: 'Duplicate',
            onclick: async () => {
              try {
                const r = await api(`/api/projects/${p.id}/duplicate`, { body: {} });
                toast('Duplicated');
                route();
              } catch (e) { toast(e.message, true); }
            },
          }),
          el('button', {
            class: 'btn sm', text: 'Rename',
            onclick: () => {
              const input = el('input', { class: 'input', value: p.name });
              modal({
                title: 'Rename project',
                body: input,
                actions: [
                  { label: 'Cancel' },
                  {
                    label: 'Rename', class: 'primary',
                    onClick: async () => {
                      await api(`/api/projects/${p.id}`, { method: 'PATCH', body: { name: input.value } });
                      toast('Renamed');
                      route();
                    },
                  },
                ],
              });
              setTimeout(() => input.focus(), 50);
            },
          }),
          el('button', {
            class: 'btn sm danger', text: 'Delete',
            onclick: async () => {
              if (!(await confirmModal('Delete project', `Delete "${p.name}" and all its files? This cannot be undone.`))) return;
              await api(`/api/projects/${p.id}`, { method: 'DELETE' });
              toast('Project deleted');
              route();
            },
          })
        )
      )
    );
  }

  root.append(
    el('div', { class: 'view-head' },
      el('h1', { text: 'Projects' }),
      el('span', { class: 'sub', text: `${projects.length} project(s) · ${media.length} media assets` }),
      el('div', { class: 'spacer' }),
      el('a', { class: 'btn', href: '#/media', text: 'Import media' })
    ),
    grid,
    projects.length === 0 ? el('div', { class: 'empty', style: 'margin-top:20px' },
      el('div', { class: 'big', text: 'No projects yet' }),
      el('div', { text: 'Create a project, import your clips, then open the Editor.' }),
      el('div', { class: 'start-steps', style: 'margin-top:16px' },
        el('div', { class: 'start-step' },
          el('div', { class: 'n', text: '1' }),
          el('div', { class: 't', text: 'Create' }),
          el('div', { class: 'd', text: 'Click New Project above.' })
        ),
        el('div', { class: 'start-step' },
          el('div', { class: 'n', text: '2' }),
          el('div', { class: 't', text: 'Import' }),
          el('div', { class: 'd', text: 'Add videos, photos, or music in Media.' })
        ),
        el('div', { class: 'start-step' },
          el('div', { class: 'n', text: '3' }),
          el('div', { class: 't', text: 'Edit' }),
          el('div', { class: 'd', text: 'Drag clips onto the timeline in the Editor.' })
        ),
        el('div', { class: 'start-step' },
          el('div', { class: 'n', text: '4' }),
          el('div', { class: 't', text: 'Render' }),
          el('div', { class: 'd', text: 'Press Render final, then download in Exports.' })
        )
      )
    ) : null
  );
}

/* ================= EXPORTS ================= */

async function renderExports(root) {
  root.classList.add('pad');
  const { projects } = await api('/api/projects');
  const rows = [];
  for (const p of projects) {
    let files = { exports: [], previews: [], absolute_dir: '' };
    try {
      files = await api(`/api/projects/${p.id}/exports`);
    } catch { /* ignore */ }
    const qc = p.last_qc;
    rows.push({ p, files, qc });
  }

  const table = el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {},
      el('th', { text: 'Project' }), el('th', { text: 'Files' }), el('th', { text: 'QC' }),
      el('th', { text: 'History' }), el('th', { text: 'Updated' }), el('th', { text: '' })
    )),
    el('tbody', {},
      rows.map(({ p, files, qc }) =>
        el('tr', {},
          el('td', {},
            el('div', { style: 'font-weight:600', text: p.name }),
            el('div', { class: 'muted mono', style: 'font-size:10.5px', text: files.absolute_dir || '' })
          ),
          el('td', {},
            files.exports.length || files.previews.length
              ? el('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px' },
                  [...files.previews, ...files.exports].map((f) =>
                    el('a', {
                      class: 'btn sm', href: f.url, download: f.file,
                      text: `${f.file} ↓`,
                      title: `${(f.size / 1048576).toFixed(2)} MB`,
                    })
                  ),
                  el('button', {
                    class: 'btn sm ghost', text: 'Copy path',
                    onclick: async () => {
                      const { copyText } = await import('./api.js');
                      await copyText(files.absolute_dir);
                      toast('Path copied');
                    },
                  }),
                  el('button', {
                    class: 'btn sm', text: 'Caption',
                    onclick: async () => {
                      try {
                        const { copyText } = await import('./api.js');
                        const r = await api(`/api/projects/${p.id}/caption`, { body: {} });
                        await copyText(r.caption);
                        toast('Caption generated & copied');
                        route();
                      } catch (e) { toast(e.message, true); }
                    },
                  })
                )
              : el('span', { class: 'muted', text: 'Nothing rendered yet' })
          ),
          el('td', {},
            qc
              ? el('div', {},
                  el('span', { class: `badge ${qc.overall === 'PASS' ? 'ok' : qc.overall === 'FAIL' ? 'fail' : 'warn'}`, text: qc.overall }),
                  el('div', { class: 'muted', style: 'font-size:10.5px;margin-top:4px', text: `${qc.items.filter((i) => i.status !== 'PASS').length || 'all'} check(s) flagged` })
                )
              : el('span', { class: 'muted', text: '—' })
          ),
          el('td', {},
            el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
              Array.isArray(p.renderHistory) && p.renderHistory.length
                ? p.renderHistory.slice(0, 4).map((h) =>
                    el('span', {
                      class: `badge ${h.qc === 'PASS' ? 'ok' : h.qc === 'FAIL' ? 'fail' : 'warn'}`,
                      text: `${h.quality}${h.qc ? ' · ' + h.qc : ''}`,
                      title: h.finishedAt || '',
                    }))
                : el('span', { class: 'muted', text: 'No renders yet' })
            )
          ),
          el('td', { class: 'muted', text: fmtDate(p.updated_at) }),
          el('td', {},
            el('button', { class: 'btn sm', text: 'Open', onclick: () => editorOpenProject(p.id) })
          )
        )
      )
    )
  );

  root.append(
    el('div', { class: 'view-head' },
      el('h1', { text: 'Exports' }),
      el('span', { class: 'sub', text: 'Rendered previews, finals, thumbnails and captions' })
    ),
    projects.length === 0
      ? el('div', { class: 'empty' },
          el('div', { class: 'big', text: 'No projects yet' }),
          el('div', { text: 'Create a project and render it — files show up here.' })
        )
      : (rows.every((r) => !r.files.exports.length && !r.files.previews.length)
          ? el('div', { class: 'empty' },
              el('div', { class: 'big', text: 'Nothing rendered yet' }),
              el('div', { text: 'Open a project in the Editor and press Render final or Quick preview.' }),
              table
            )
          : table)
  );
}

/* ================= SETTINGS ================= */

async function renderSettings(root) {
  root.classList.add('pad');
  const { settings, environment } = await api('/api/settings');

  const crf = el('input', { class: 'input', type: 'number', min: '10', max: '40', value: String(settings.export.crf) });
  const preset = el('select', { class: 'input' },
    ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'].map((p) =>
      el('option', { value: p, selected: p === settings.export.preset || undefined }, p)
    )
  );
  const abr = el('input', { class: 'input', type: 'text', value: settings.export.audioBitrate });
  const fps = el('input', { class: 'input', type: 'number', value: String(settings.defaultFps) });

  const envCard = el('div', { class: 'card', style: 'margin-bottom:14px' },
    el('h3', { text: 'Environment' }),
    el('div', { class: 'meta', style: 'flex-direction:column;gap:6px' },
      el('div', {}, el('span', { class: `badge ${environment.ffmpeg_ok ? 'ok' : 'fail'}`, text: environment.ffmpeg_ok ? 'FFmpeg OK' : 'FFmpeg MISSING' }),
        el('span', { class: 'mono', style: 'margin-left:8px', text: environment.ffmpegVersion || '' })),
      el('div', { class: 'mono', style: 'font-size:11px', text: environment.ffmpeg }),
      el('div', {}, el('span', { class: `badge ${environment.font_ok ? 'ok' : 'fail'}`, text: environment.font_ok ? 'Font OK' : 'Font MISSING' }),
        el('span', { class: 'mono', style: 'margin-left:8px;font-size:11px', text: environment.font || '' })),
      el('div', { class: 'muted', text: `Node ${environment.node} · ${environment.platform}` })
    )
  );

  const form = el('div', { class: 'card', style: 'max-width:520px' },
    el('h3', { text: 'Render defaults' }),
    el('div', { class: 'insp-grid' },
      el('label', { class: 'field' }, el('span', { text: 'Quality (lower = better, larger file)' }), crf),
      el('label', { class: 'field' }, el('span', { text: 'Speed vs quality (Preset)' }), preset),
      el('label', { class: 'field' }, el('span', { text: 'Sound quality (bitrate)' }), abr),
      el('label', { class: 'field' }, el('span', { text: 'Default FPS' }), fps)
    ),
    el('div', { style: 'margin-top:12px' },
      el('button', {
        class: 'btn primary', text: 'Save settings',
        onclick: async () => {
          try {
            await api('/api/settings', {
              method: 'PUT',
              body: {
                export: { crf: Number(crf.value), preset: preset.value, audioBitrate: abr.value },
                defaultFps: Number(fps.value),
              },
            });
            toast('Settings saved');
          } catch (e) { toast(e.message, true); }
        },
      })
    )
  );

  root.append(
    el('div', { class: 'view-head' }, el('h1', { text: 'Settings' }),
      el('span', { class: 'sub', text: 'Local configuration — stored in data/settings.json' })),
    envCard, form,
    el('div', { class: 'help-line', style: 'margin-top:18px', html: 'Full operator docs: <b>AGENTS.md</b> in the workbench folder (how OpenCode edits timelines).' })
  );
}

/* ================= boot ================= */

async function boot() {
  initGlobalHotkeys(paletteCommands);
  try {
    const s = await api('/api/summary');
    appState.env = s;
  } catch { /* offline server */ }
  try {
    const { environment } = await api('/api/settings');
    const pill = document.getElementById('envPill');
    pill.textContent = environment.ffmpeg_ok ? 'FFmpeg ✓' : 'FFmpeg ✗';
    pill.classList.add(environment.ffmpeg_ok ? 'ok' : 'bad');
    pill.title = environment.ffmpeg;
  } catch { /* ignore */ }
  document.getElementById('mainnav').addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    if (a.dataset.view === 'editor') {
      e.preventDefault();
      editorOpenLast();
    }
  });
  document.querySelector('.brand').addEventListener('click', () => navigate('#/projects'));
  document.querySelector('.brand')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('#/projects'); }
  });
  document.getElementById('helpBtn')?.addEventListener('click', () => openHelp());
  if (!location.hash) location.hash = '#/projects';
  route();
}

boot();
