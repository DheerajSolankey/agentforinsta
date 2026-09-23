import { api, el, toast, modal, fmtDuration, fmtBytes, fmtDate, confirmModal, catIcon, catLabel, copyText } from './api.js';

const CATEGORIES = ['video', 'image', 'music', 'voice', 'sfx', 'audio', 'font', 'other'];

async function uploadFiles(files, { asReference = false, category = null } = {}) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  if (asReference) fd.append('asReference', 'true');
  if (category) fd.append('category', category);
  const res = await fetch('/api/media', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
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
    ? el('img', { src: a.thumb, alt: '', loading: 'lazy' })
    : el('div', { class: 'mi-thumb', text: catIcon(a.category) });
}

function editMediaModal(a, onDone) {
  const name = el('input', { class: 'input', value: a.filename });
  const tags = el('input', { class: 'input', value: (a.tags || []).join(', '), placeholder: 'tag1, tag2' });
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

function mediaActions(a, { onDone, isReference = false }) {
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
    el('button', { class: 'btn sm ghost', text: 'Rename', onclick: () => editMediaModal(a, onDone) }),
    el('button', {
      class: 'btn sm ghost', text: 'Copy path',
      onclick: async () => { await copyText(a.abs_path); toast('Path copied'); },
    }),
  ];
  if (!isReference && (a.hasVideo || a.hasAudio)) {
    btns.push(
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

async function analyzeModal(asset, onDone) {
  const nameInput = el('input', { class: 'input', value: `Style from ${asset.filename}` });
  const out = el('div', { class: 'muted', text: 'Local FFmpeg analysis: scene cuts, pacing, visual stats, audio energy…' });
  const analyzeBtn = el('button', { class: 'btn primary', text: 'Analyze' });
  const pre = el('pre', { class: 'code', style: 'display:none;max-height:34vh' });
  const saveName = el('input', { class: 'input', placeholder: 'Style name (e.g. My Dark Motivation)' });
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
  const url = el('input', { class: 'input', placeholder: 'https://example.com/file.mp4 (direct media file URL)' });
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
            a.thumb ? el('img', { class: 'thumb-sq', src: a.thumb, loading: 'lazy' }) : el('div', { class: 'ic-sq', text: catIcon(a.category) }),
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
    const chip = el('span', { class: `chip ${c.id === cat ? 'active' : ''}`, text: c.label });
    chip.addEventListener('click', () => {
      if (c.id === 'reference' && !referenceMode) {
        location.hash = '#/references';
        return;
      }
      cat = c.id;
      chips.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
      chip.classList.add('active');
      refresh();
    });
    chips.append(chip);
  }

  const search = el('input', { class: 'input', placeholder: 'Search name or tags…', style: 'max-width:240px' });
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
