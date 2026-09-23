import { api, el, toast, modal, confirmModal, catIcon, fmtDuration, copyText } from './api.js';
import { navigate } from './app.js';

export async function renderStylesView(root) {
  root.classList.add('pad');
  let tab = 'styles';

  const tabs = el('div', { class: 'tabs' });
  const body = el('div', {});
  const mkTab = (id, label) => {
    const b = el('button', { class: tab === id ? 'active' : '', text: label });
    b.addEventListener('click', () => { tab = id; draw(); });
    return b;
  };

  async function draw() {
    tabs.innerHTML = '';
    tabs.append(mkTab('styles', 'Styles'), mkTab('templates', 'Templates'));
    body.innerHTML = '';
    if (tab === 'styles') await drawStyles(body);
    else await drawTemplates(body);
  }

  root.append(
    el('div', { class: 'view-head' },
      el('h1', { text: 'Styles & Templates' }),
      el('span', { class: 'sub', text: 'Style = how it looks & paces · Template = narrative structure' })
    ),
    tabs, body
  );
  await draw();
}

/* ---------------- styles ---------------- */

async function drawStyles(body) {
  const { styles } = await api('/api/styles');
  const { projects } = await api('/api/projects').catch(() => ({ projects: [] }));

  const toolbar = el('div', { class: 'row', style: 'margin-bottom:14px;gap:8px' },
    el('button', {
      class: 'btn primary', text: '+ New style',
      onclick: () => editStyleModal(null, () => draw()),
    }),
    el('button', {
      class: 'btn', text: 'Import JSON',
      onclick: () => {
        const ta = el('textarea', { class: 'input', rows: 8, placeholder: '{ "name": "My Style", "pacing": { … } }' });
        modal({
          title: 'Import style JSON',
          body: ta,
          actions: [
            { label: 'Cancel' },
            {
              label: 'Import', class: 'primary',
              onClick: async () => {
                let parsed;
                try { parsed = JSON.parse(ta.value); } catch { toast('Invalid JSON', true); return false; }
                await api('/api/styles/import', { body: parsed });
                toast('Style imported');
                draw();
              },
            },
          ],
        });
      },
    }),
    el('div', { class: 'spacer' }),
    el('span', { class: 'muted', text: `${styles.length} styles` })
  );

  const grid = el('div', { class: 'grid' });
  for (const s of styles) {
    grid.append(
      el('div', { class: 'card' },
        el('div', { class: 'row' },
          el('h3', { text: s.name, style: 'flex:1' }),
          el('span', { class: `badge ${s.builtin ? '' : 'ok'}`, text: s.builtin ? 'built-in' : `v${s.version || 1}` }),
          s.locked ? el('span', { class: 'badge warn', text: 'locked' }) : null
        ),
        el('div', { class: 'muted', style: 'font-size:11.5px;line-height:1.45', text: s.description || '' }),
        el('div', { class: 'chips' },
          s.pacing?.cutFrequency ? el('span', { class: 'chip', style: 'cursor:default', text: `cuts: ${s.pacing.cutFrequency}` }) : null,
          s.pacing?.averageShotDuration ? el('span', { class: 'chip', style: 'cursor:default', text: `shot: ${s.pacing.averageShotDuration}s` }) : null,
          s.visual?.contrast ? el('span', { class: 'chip', style: 'cursor:default', text: `contrast: ${s.visual.contrast}` }) : null,
          s.captions?.position ? el('span', { class: 'chip', style: 'cursor:default', text: `captions: ${s.captions.position}` }) : null
        ),
        el('div', { class: 'actions' },
          el('button', {
            class: 'btn sm primary', text: 'Apply to project',
            disabled: projects.length === 0 || undefined,
            onclick: () => applyStyleModal(s, projects),
          }),
          el('button', { class: 'btn sm', text: 'View JSON', onclick: () => viewJsonModal(s) }),
          el('button', {
            class: 'btn sm', text: s.builtin ? 'Duplicate' : 'Edit',
            onclick: () => {
              if (s.builtin) duplicateStyle(s, () => draw());
              else if (s.locked) lockedModal(s, () => draw());
              else editStyleModal(s, () => draw());
            },
          }),
          s.builtin
            ? el('button', { class: 'btn sm', text: 'Duplicate', onclick: () => duplicateStyle(s, () => draw()) })
            : el('button', {
                class: 'btn sm danger', text: 'Delete',
                onclick: async () => {
                  if (!(await confirmModal('Delete style', `Delete "${s.name}"?`))) return;
                  try {
                    await api(`/api/styles/${s.id || s.file}`, { method: 'DELETE' });
                    toast('Deleted');
                    draw();
                  } catch (e) { toast(e.message, true); }
                },
              }),
          el('button', {
            class: 'btn sm ghost', text: 'Export',
            onclick: async () => {
              const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = `${(s.name || 'style').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
              a.click();
              URL.revokeObjectURL(a.href);
            },
          }),
          el('button', { class: 'btn sm ghost', text: 'Copy', onclick: async () => { await copyText(JSON.stringify(s, null, 2)); toast('Copied'); } })
        )
      )
    );
  }

  body.append(toolbar, grid);
}

function lockedModal(style, onDone) {
  modal({
    title: `"${style.name}" is locked`,
    body: el('p', { class: 'muted', text: 'Locked styles keep typography, captions, transitions, audio and color consistent. Duplicate it to create an editable version.' }),
    actions: [
      { label: 'Close' },
      { label: 'Duplicate', class: 'primary', onClick: () => duplicateStyle(style, onDone) },
      {
        label: 'Unlock', class: 'danger',
        onClick: async () => {
          await api(`/api/styles/${style.id || style.file}`, { method: 'PATCH', body: { locked: false, unlock: true } });
          toast('Unlocked');
          onDone?.();
        },
      },
    ],
  });
}

async function duplicateStyle(style, onDone) {
  const name = el('input', { class: 'input', value: `${style.name} v2` });
  modal({
    title: 'Duplicate style',
    body: el('label', { class: 'field' }, el('span', { text: 'New name' }), name),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Duplicate', class: 'primary',
        onClick: async () => {
          await api(`/api/styles/${style.id || style.name || style.file}/duplicate`, { body: { name: name.value } });
          toast('Duplicated');
          onDone?.();
        },
      },
    ],
  });
}

function viewJsonModal(style) {
  modal({
    title: style.name,
    body: el('pre', { class: 'code', text: JSON.stringify(style, null, 2) }),
    actions: [{ label: 'Close', class: 'primary' }],
  });
}

function editStyleModal(existing, onDone) {
  const s = existing || {};
  const name = el('input', { class: 'input', value: s.name || '' });
  const desc = el('textarea', { class: 'input', rows: 2 }, s.description || '');
  const cuts = el('select', { class: 'input' }, ['low', 'medium', 'high'].map((v) => el('option', { value: v, selected: (s.pacing?.cutFrequency || s.cuts?.frequency || 'medium') === v || undefined }, v)));
  const shot = el('input', { class: 'input', type: 'number', step: '0.1', value: String(s.pacing?.averageShotDuration ?? 2.0) });
  const capPos = el('select', { class: 'input' }, ['top', 'center', 'bottom'].map((v) => el('option', { value: v, selected: (s.captions?.position || 'center') === v || undefined }, v)));
  const capStyle = el('input', { class: 'input', value: s.captions?.style || 'bold' });
  const contrast = el('select', { class: 'input' }, ['low', 'medium', 'high'].map((v) => el('option', { value: v, selected: (s.visual?.contrast || 'medium') === v || undefined }, v)));
  const saturation = el('select', { class: 'input' }, ['low', 'medium', 'high'].map((v) => el('option', { value: v, selected: (s.visual?.saturation || 'medium') === v || undefined }, v)));
  const music = el('select', { class: 'input' }, ['low', 'medium', 'high'].map((v) => el('option', { value: v, selected: (s.audio?.musicIntensity || 'medium') === v || undefined }, v)));
  const beatSync = el('input', { type: 'checkbox', checked: s.audio?.beatSync || undefined });
  const transitions = el('input', { class: 'input', value: Array.isArray(s.transitions) ? s.transitions.join(', ') : 'hard_cut' });
  const zoom = el('select', { class: 'input' }, ['none', 'low', 'moderate', 'high'].map((v) => el('option', { value: v, selected: (s.motion?.zoom || 'low') === v || undefined }, v)));
  const locked = el('input', { type: 'checkbox', checked: s.locked || undefined });
  const notes = el('textarea', { class: 'input', rows: 2 }, (s.notes || []).join('\n'));

  modal({
    title: existing ? `Edit style — ${s.name}` : 'New style',
    body: el('div', {},
      el('div', { class: 'insp-grid' },
        el('label', { class: 'field full' }, el('span', { text: 'Name' }), name),
        el('label', { class: 'field full' }, el('span', { text: 'Description' }), desc),
        el('label', { class: 'field' }, el('span', { text: 'Cut frequency' }), cuts),
        el('label', { class: 'field' }, el('span', { text: 'Avg shot (s)' }), shot),
        el('label', { class: 'field' }, el('span', { text: 'Caption position' }), capPos),
        el('label', { class: 'field' }, el('span', { text: 'Caption style' }), capStyle),
        el('label', { class: 'field' }, el('span', { text: 'Contrast' }), contrast),
        el('label', { class: 'field' }, el('span', { text: 'Saturation' }), saturation),
        el('label', { class: 'field' }, el('span', { text: 'Music intensity' }), music),
        el('label', { class: 'field' }, el('span', { text: 'Transitions' }), transitions),
        el('label', { class: 'field' }, el('span', { text: 'Zoom motion' }), zoom),
        el('label', { class: 'field', style: 'display:flex;align-items:flex-end;gap:8px;padding-bottom:8px' }, beatSync, el('span', { style: 'text-transform:none;letter-spacing:0', text: 'Beat sync' })),
        el('label', { class: 'field', style: 'display:flex;align-items:flex-end;gap:8px;padding-bottom:8px' }, locked, el('span', { style: 'text-transform:none;letter-spacing:0', text: 'Lock style' })),
        el('label', { class: 'field full' }, el('span', { text: 'Notes (one per line)' }), notes)
      )
    ),
    actions: [
      { label: 'Cancel' },
      {
        label: existing ? 'Save' : 'Create', class: 'primary',
        onClick: async () => {
          const payload = {
            id: s.id,
            name: name.value.trim(),
            description: desc.value,
            locked: locked.checked,
            pacing: { averageShotDuration: Number(shot.value), cutFrequency: cuts.value },
            cuts: { frequency: cuts.value },
            transitions: transitions.value.split(',').map((t) => t.trim()).filter(Boolean),
            motion: { zoom: zoom.value },
            captions: { style: capStyle.value, position: capPos.value, animation: 'word_highlight' },
            audio: { musicIntensity: music.value, beatSync: beatSync.checked, sfxDensity: 'medium' },
            visual: { contrast: contrast.value, saturation: saturation.value },
            notes: notes.value.split('\n').map((n) => n.trim()).filter(Boolean),
            structure: s.structure,
            source: s.source,
            version: s.version || 1,
          };
          if (!payload.name) { toast('Name required', true); return false; }
          if (existing && !s.builtin) await api(`/api/styles/${s.id || s.file}`, { method: 'PATCH', body: payload });
          else await api('/api/styles', { body: payload });
          toast('Style saved');
          onDone?.();
        },
      },
    ],
  });
}

function applyStyleModal(style, projects) {
  const sel = el('select', { class: 'input' }, projects.map((p) => el('option', { value: p.id }, p.name)));
  modal({
    title: `Apply "${style.name}"`,
    body: el('div', {},
      el('label', { class: 'field' }, el('span', { text: 'Project' }), sel),
      el('p', { class: 'muted', style: 'font-size:11.5px', text: 'The style recipe is snapshotted into the project and becomes its active style (caption defaults, pacing reference for AI/OpenCode, footer display).' })
    ),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Apply', class: 'primary',
        onClick: async () => {
          await api(`/api/projects/${sel.value}/apply-style`, { body: { style: style.builtin ? style.name : style.id || style.file } });
          toast('Style applied');
        },
      },
    ],
  });
}

/* ---------------- templates ---------------- */

async function drawTemplates(body) {
  const { templates } = await api('/api/templates');
  const { projects } = await api('/api/projects').catch(() => ({ projects: [] }));

  const grid = el('div', { class: 'grid' });
  for (const t of templates) {
    grid.append(
      el('div', { class: 'card' },
        el('h3', { text: t.name }),
        el('div', { class: 'muted', style: 'font-size:11.5px', text: t.description || '' }),
        el('div', { style: 'display:flex;flex-direction:column;gap:4px' },
          t.sections.map((sec) =>
            el('div', { class: 'row', style: 'font-size:11.5px' },
              el('span', { class: 'badge', style: 'min-width:70px;text-align:center', text: sec.label }),
              el('div', { style: `height:5px;border-radius:3px;background:var(--accent);opacity:.75;width:${Math.round(sec.weight * 100)}%;min-width:12px` }),
              el('span', { class: 'muted', text: `${Math.round(sec.weight * 100)}%` })
            )
          )
        ),
        el('div', { class: 'actions' },
          el('button', {
            class: 'btn sm primary', text: 'Apply to project',
            disabled: projects.length === 0 || undefined,
            onclick: () => {
              const sel = el('select', { class: 'input' }, projects.map((p) => el('option', { value: p.id }, p.name)));
              modal({
                title: `Apply template "${t.name}"`,
                body: el('div', {},
                  el('label', { class: 'field' }, el('span', { text: 'Project' }), sel),
                  el('p', { class: 'muted', style: 'font-size:11.5px', text: 'Scaffolds placeholder text clips (Hook → … → CTA) across the T1 track, sized by the current timeline duration (or 25s if empty). Existing T1 clips are replaced.' })
                ),
                actions: [
                  { label: 'Cancel' },
                  {
                    label: 'Apply template', class: 'primary',
                    onClick: async () => {
                      const r = await api(`/api/projects/${sel.value}/apply-template`, { body: { template: t.name } });
                      toast(`Added ${r.created} section clip(s)`);
                    },
                  },
                ],
              });
            },
          })
        )
      )
    );
  }
  body.append(
    el('div', { class: 'help-line', style: 'margin-bottom:12px', text: 'Templates scaffold NARRATIVE STRUCTURE as editable text clips. They do not replace styles.' }),
    grid
  );
}

export { navigate };
