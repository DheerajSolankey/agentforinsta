import {
  api, el, toast, modal, confirmModal, fmtDuration, fmtDate, copyText, catIcon, catLabel,
} from './api.js';
import { navigate, appState } from './app.js';
import { editAssetImage, uploadFiles } from './media.js';
import {
  createTimeline, getTrack, getClip, addClip, removeClip, splitClip, trimClip, moveClip,
  duplicateClip, setClipProps, setTrackProps, timelineDuration, cloneTimeline, validateTimeline,
  clipEnd, findFreeSlot, makeClip, round3, activeClips,
  addMarker, removeMarker, clampSpeed, MIN_SPEED, MAX_SPEED,
  clampZoom, MIN_ZOOM, MAX_ZOOM, FIT_MODES, normalizeTransform,
  EFFECTS, BG_MODES, normalizeEffect, normalizeBgMode, bgToCss,
  TEXT_ANIMS, TEXT_ALIGNS, TEXT_PRESETS, TEXT_FONTS, CAPTION_PRESETS,
  normalizeTextAnim, normalizeTextAlign, estimateBannerLines, bannerBoxHeight,
  normalizeWatermark, defaultWatermark, WATERMARK_POSITIONS, staggerWordWindows,
  getLayoutMode, setLayoutMode, isSplitLayout, splitPanes, LAYOUT_MODES,
  snapPct, evalKeyframes, fadeGain, transitionGain, TRANSITIONS, KEYFRAME_PROPS,
  clampFade, normalizeTransition, normalizeTransitionDur, DEFAULT_TRANSITION,
  MIN_TRANSITION, MAX_TRANSITION,
  GRADE_KEYS, GRADE_RANGES, GRADE_LABELS, GRADE_PRESETS, GRADE_KEYFRAME_PROPS,
  DEFAULT_GRADE, normalizeGrade, isDefaultGrade, gradeOf,
  SPEED_CURVE_PRESETS, SPEED_CURVE_PRESET_NAMES, SPEED_CURVE_CUSTOM,
  MIN_SPEED_CURVE_POINTS, MAX_SPEED_CURVE_POINTS,
  normalizeSpeedCurve, speedCurveOf, curveSpeedAt, speedCurveConstant, sourceTimeAt,
  normalizeReverse,
  DEFAULT_CHROMA, normalizeChroma,
  MASK_TYPES, DEFAULT_MASK, MASK_RANGES, normalizeMask,
} from '/shared/timeline-ops.js';

/* ================= module state ================= */
const S = {
  project: null,
  timeline: null,
  media: [],
  selection: null, // {trackId, clipId}
  playhead: 0,
  pps: 64, // px per second
  playing: false,
  raf: null,
  lastTick: 0,
  history: [],
  hIndex: -1,
  saveTimer: null,
  dirty: false,
  diskMtime: null,
  pollTimer: null,
  renderPoll: null,
  styles: [],
  templates: [],
  videoEl: null,
  imgEl: null,
  videoEl2: null,
  imgEl2: null,
  audioEls: new Map(),
  lastTextKey: '',
  unsubs: [],
  renderResult: null,
  loop: null, // {start, end} | null
  previewFrame: null,
  vignetteLayer: null,
  previewBadges: null,
  previewEmpty: null,
  selBox: null,
  phoneSelBox: null,
  drag: null, // active canvas drag session
  multi: null, // extra multi-select picks [{trackId, clipId}] (primary is S.selection)
  snapGuides: null,
  phoneOpen: false,
  phoneEls: null,
  phonePos: null, // {x,y} viewport px
  phoneBtn: null,
  phoneUserScale: 1, // user resize multiplier for 6.3" preview (persisted)
  quickRefs: null, // toggle-button registry for the quick bar ({effect:{}, motion:{}, text:{}, caption:{}})
  transSel: null, // quick-bar transition <select>
  flashLayer: null, // white flash under-lay for `flash` transitions
};

export function editorCleanup() {
  for (const fn of S.unsubs) { try { fn(); } catch { /* ignore */ } }
  S.unsubs = [];
  S.refreshMediaList = null;
  stopPlayback();
  clearInterval(S.pollTimer);
  clearInterval(S.renderPoll);
  S.pollTimer = null;
  S.renderPoll = null;
  const pe = S.phoneEls;
  if (pe) {
    try { pe.v1.pause(); } catch { /* */ }
    try { pe.v2.pause(); } catch { /* */ }
    pe.shell?.remove();
  }
  S.phoneEls = null;
  S.phoneOpen = false;
  S.phoneBtn = null;
  S.phoneSelBox = null;
  S.quickRefs = null;
  S.transSel = null;
  S.flashLayer = null;
  document.body.classList.remove('sheet-open');
}

export async function editorOpenProject(id) {
  appState.projectId = id;
  localStorage.setItem('rw_last_project', id);
  navigate(`#/editor/${id}`);
}

export function editorOpenLast() {
  const id = appState.projectId || localStorage.getItem('rw_last_project');
  if (id) editorOpenProject(id);
  else {
    navigate('#/projects');
    toast('Open a project first');
  }
}

/* ================= mount ================= */

/** Re-fetch the media library (after import / image edit), busting caches so edits show. */
async function reloadMediaFromServer() {
  try {
    const { media } = await api('/api/media');
    const v = Date.now();
    for (const m of media) {
      if (m.url && (m.kind === 'image' || m.category === 'image')) m.url = `${m.url}?v=${v}`;
      if (m.thumb) m.thumb = `${m.thumb}?v=${v}`;
    }
    S.media = media;
    S.refreshMediaList?.();
    renderInspector();
    syncMedia(true);
  } catch (e) {
    toast(e.message, true);
  }
}

export async function renderEditorView(root, params = []) {
  editorCleanup();
  root.classList.add('editor');
  const projectId = params[0] || appState.projectId || localStorage.getItem('rw_last_project');
  if (!projectId) {
    root.append(el('div', { class: 'empty' },
      el('div', { class: 'big', text: 'No project open' }),
      el('a', { class: 'btn primary', href: '#/projects', text: 'Choose a project' })));
    return;
  }
  appState.projectId = projectId;

  const [{ project, timeline }, { media }, { styles }, { templates }] = await Promise.all([
    api(`/api/projects/${projectId}`),
    api('/api/media'),
    api('/api/styles'),
    api('/api/templates'),
  ]);
  S.project = project;
  S.timeline = timeline || createTimeline({ width: project.width, height: project.height, fps: project.fps });
  S.media = media;
  S.styles = styles;
  S.templates = templates;
  clearSelection();
  S.playhead = 0;
  S.dirty = false;
  S.diskMtime = project.timeline_mtime || 0;
  S.history = [cloneTimeline(S.timeline)];
  S.hIndex = 0;
  S.renderResult = project.last_qc && project.has_final ? { qc: project.last_qc, kind: 'final' } : null;

  buildUi(root);
  startPolling();
  bindKeys();
}

/* ================= UI build ================= */

function buildUi(root) {
  /* ---- toolbar ---- */
  const nameInput = el('input', { class: 'proj-name', value: S.project.name, title: 'Rename' });
  nameInput.addEventListener('change', async () => {
    try {
      S.project.name = nameInput.value.trim() || S.project.name;
      await api(`/api/projects/${S.project.id}`, { method: 'PATCH', body: { name: S.project.name } });
      toast('Renamed');
    } catch (e) { toast(e.message, true); }
  });

  const saveState = el('span', { class: 'save-state', id: 'saveState', text: 'Saved' });

  const toolbar = el('div', { class: 'editor-toolbar' },
    el('a', { class: 'icon-btn', href: '#/projects', title: 'Back to projects', 'aria-label': 'Back to projects', text: '←' }),
    nameInput,
    saveState,
    el('div', { class: 'tb-sep' }),
    btn('Undo', 'Undo (Ctrl+Z)', doUndo, 'ghost'),
    btn('Redo', 'Redo (Ctrl+Y)', doRedo, 'ghost'),
    el('div', { class: 'tb-sep' }),
    btn('Split', 'Cut the selected clip in two at the playhead (S)', doSplit, ''),
    btn('Text', 'Add a title or caption (Text track)', doAddText, ''),
    btn('Watermark', 'Project brand watermark (burned into export)', openWatermarkModal, ''),
    btn('Duplicate', 'Copy the selected clip', doDuplicate, ''),
    btn('Delete', 'Remove the selected clip (Del)', doDelete, 'danger'),
    el('div', { class: 'tb-sep' }),
    layoutControls(),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn sm', text: 'Safe guides', title: 'Show Instagram UI safe zones over the preview', onclick: (e) => {
      document.querySelector('.safe-guides')?.classList.toggle('hidden');
      e.currentTarget.classList.toggle('primary');
    } }),
    el('button', { class: 'btn sm', text: 'Quick preview', title: 'Fast low-quality render to check your edit', onclick: () => startRender('preview') }),
    el('button', { class: 'btn primary', text: 'Render final', title: 'Export the finished 1080×1920 Reel', onclick: () => startRender('final') })
  );

  /* ---- left: media ---- */
  const mediaList = el('div', {});
  const catChips = el('div', { class: 'chips', style: 'margin-bottom:8px' });
  let mediaCat = 'video';
  let mediaQ = '';

  const refreshMedia = () => {
    mediaList.innerHTML = '';
    const items = S.media.filter((m) => {
      const isRef = m.category === 'reference' || m.rights_status === 'REFERENCE_ONLY';
      if (mediaCat === 'video') return m.category === 'video';
      if (mediaCat === 'image') return m.category === 'image';
      if (mediaCat === 'audio') return ['music', 'voice', 'sfx', 'audio'].includes(m.category);
      if (mediaCat === 'reference') return isRef;
      if (mediaCat === 'all') return true;
      return m.category === mediaCat;
    }).filter((m) => !mediaQ || m.filename.toLowerCase().includes(mediaQ));

    if (!items.length) {
      mediaList.append(el('div', { class: 'muted', style: 'padding:14px 6px;font-size:11.5px;text-align:center', text: 'Nothing here — import in Media / References.' }));
      return;
    }
    for (const m of items) {
      const isRef = m.category === 'reference' || m.rights_status === 'REFERENCE_ONLY';
      const item = el('div', {
        class: 'media-item' + (isRef ? ' ref' : ''),
        draggable: isRef ? 'false' : 'true',
        title: isRef ? 'REFERENCE_ONLY — cannot be placed on the timeline' : 'Drag to timeline or double-click to add',
      },
        m.thumb ? el('img', { src: m.thumb, loading: 'lazy' }) : el('div', { class: 'mi-thumb', text: catIcon(m.category) }),
        el('div', { class: 'mi-info' },
          el('div', { class: 'mi-name', text: m.filename }),
          el('div', { class: 'mi-meta' },
            el('span', { text: fmtDuration(m.duration) }),
            isRef ? el('span', { class: 'badge ref', text: 'REF' }) : null
          )
        )
      );
      if (!isRef) {
        item.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/rw-asset', m.id);
          e.dataTransfer.effectAllowed = 'copy';
        });
        item.addEventListener('dblclick', () => quickAdd(m));
      } else {
        item.addEventListener('dblclick', () => toast('Reference assets cannot be added to the timeline', true));
      }
      mediaList.append(item);
    }
  };
  S.refreshMediaList = refreshMedia;

  for (const c of [
    { id: 'video', label: 'Videos' }, { id: 'image', label: 'Images' },
    { id: 'audio', label: 'Music/Voice/SFX' }, { id: 'reference', label: 'References' },
    { id: 'all', label: 'All' },
  ]) {
    const chip = el('button', {
      type: 'button',
      class: `chip ${c.id === mediaCat ? 'active' : ''}`,
      text: c.label,
      'aria-pressed': c.id === mediaCat ? 'true' : 'false',
    });
    chip.addEventListener('click', () => {
      mediaCat = c.id;
      catChips.querySelectorAll('.chip').forEach((x) => {
        x.classList.remove('active');
        x.setAttribute('aria-pressed', 'false');
      });
      chip.classList.add('active');
      chip.setAttribute('aria-pressed', 'true');
      refreshMedia();
    });
    catChips.append(chip);
  }
  const search = el('input', {
    class: 'input', placeholder: 'Search…', 'aria-label': 'Search media by name',
    style: 'margin-bottom:8px;padding:5px 8px',
  });
  search.addEventListener('input', () => { mediaQ = search.value.trim().toLowerCase(); refreshMedia(); });

  const importBtn = el('button', {
    class: 'btn sm block', text: '+ Import into library',
    onclick: () => {
      const input = el('input', {
        type: 'file',
        multiple: true,
        accept: 'video/*,audio/*,image/*,.mkv,.mov,.webm,.wav,.mp3,.m4a,.flac,.png,.jpg,.jpeg,.webp',
        style: 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0.01',
      });
      input.addEventListener('change', async () => {
        if (!input.files?.length) return;
        try {
          const data = await uploadFiles([...input.files]);
          toast(`Imported ${data.media?.length || 0} file(s)`);
          await reloadMediaFromServer();
        } catch (e) { toast(e.message, true); }
        input.remove();
      });
      document.body.append(input);
      input.click();
    },
  });

  /* ---- left: CapCut-style library (Media / Text / FX / Filters / …) ---- */
  const sec = (text) => el('div', { class: 'lib-sec', text });
  const grid = (items) => el('div', { class: 'lib-grid' }, ...items);
  const labelize = (s) => (s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
  const libBtn = (label, title, active, onclick) => el('button', {
    type: 'button', class: active ? 'lib-item active' : 'lib-item', title, onclick,
    'aria-pressed': active ? 'true' : 'false',
  }, el('span', { class: 'li-name', text: label }));

  const mediaPane = () => el('div', { class: 'lib-pane' },
    el('div', { class: 'region-hint', html: 'Drag a clip onto the <b>timeline</b> — or double-click to drop it at the red line.' }),
    search, catChips, mediaList, importBtn);

  const textMatch = (preset, clip) => !!clip && Object.entries(preset)
    .every(([k, v]) => k === 'content' || JSON.stringify((clip.text || {})[k]) === JSON.stringify(v));

  const textPane = () => {
    let tclip = null;
    try {
      if (S.selection) {
        const c = getClip(S.timeline, S.selection.trackId, S.selection.clipId);
        if (c && c.kind === 'text') tclip = c;
      }
    } catch { tclip = null; }
    if (!tclip) tclip = textClipAtPlayhead();
    return el('div', { class: 'lib-pane' },
      sec('Text styles'),
      grid(Object.keys(TEXT_PRESETS).map((k) => libBtn(labelize(k), `Apply the "${k}" text style`, textMatch(TEXT_PRESETS[k], tclip), () => quickTextPreset(k)))),
      sec('Captions · safe area'),
      grid(Object.keys(CAPTION_PRESETS).map((k) => libBtn(labelize(k), `Apply the "${k}" caption style`, textMatch(CAPTION_PRESETS[k], tclip), () => quickCaptionPreset(k)))),
    );
  };

  const effectsPane = () => {
    const found = resolveMediaClip();
    const clip = found?.clip || null;
    const cur = clip ? normalizeEffect(clip.effect) : 'none';
    const fit = clip ? normalizeTransform(clip).fit : 'cover';
    return el('div', { class: 'lib-pane' },
      sec('Color effects'),
      grid(EFFECTS.map((ef) => libBtn(labelize(EFFECT_LABELS[ef] || ef), `Toggle ${EFFECT_LABELS[ef] || ef} on the clip`, cur === ef && ef !== 'none', () => quickEffect(ef)))),
      sec('Framing'),
      grid([
        libBtn('Fit (no crop)', 'Letterbox instead of cropping', fit === 'contain', () => quickFit('contain')),
        libBtn('Reset look', 'Clear fit, zoom, effect and grade', false, () => quickResetLook()),
      ]),
    );
  };

  const filtersPane = () => {
    const clip = resolveMediaClip()?.clip || null;
    const g = clip ? gradeOf(clip) : { ...DEFAULT_GRADE };
    return el('div', { class: 'lib-pane' },
      sec('Filters'),
      grid(Object.keys(GRADE_PRESETS).map((k) => {
        const want = normalizeGrade({ ...DEFAULT_GRADE, ...GRADE_PRESETS[k] });
        const active = GRADE_KEYS.every((x) => Math.abs((g[x] || 0) - (want[x] || 0)) < 1e-6);
        return libBtn(labelize(k), `Apply the ${k} filter`, active, () => applyGradePreset(k));
      })),
      sec('Tune'),
      el('div', { class: 'muted', style: 'font-size:11px;line-height:1.5', text: 'Fine-tune exposure, contrast, saturation, temperature and vignette in Clip Tools → Color grading.' }),
    );
  };

  const motionPane = () => {
    const clip = resolveMediaClip()?.clip || null;
    return el('div', { class: 'lib-pane' },
      sec('Camera moves'),
      grid(MOTION_LIB.map(([k, label]) => libBtn(label, `Toggle the ${label} move on the clip`, !!clip && hasMotionPreset(clip, k), () => applyMotionPreset(k)))),
    );
  };

  const speedPane = () => {
    const clip = resolveMediaClip()?.clip || null;
    const curve = clip ? speedCurveOf(clip) : null;
    const rev = clip ? normalizeReverse(clip.reverse) : false;
    return el('div', { class: 'lib-pane' },
      sec('Speed ramps'),
      grid(SPEED_CURVE_PRESET_NAMES.map((k) => libBtn(
        CURVE_PRESET_LABELS[k] || k,
        `Toggle the ${CURVE_PRESET_LABELS[k] || k} speed ramp`,
        !!curve && curve.preset === k && k !== 'constant',
        () => applyCurvePreset(k),
      ))),
      sec('Reverse & still'),
      grid([
        libBtn(rev ? 'Reverse: ON' : 'Reverse', 'Play the clip backwards', rev, () => toggleReverse()),
        libBtn('Freeze frame', 'Hold the current frame for 2s', false, () => doFreezeFrame()),
        libBtn('Clear curve', 'Back to constant speed', false, () => {
          const found = resolveMediaClip();
          if (!found) { toast('Add a clip first', true); return; }
          selectOnly(found.track.id, found.clip.id);
          quickCommit(() => setClipProps(S.timeline, found.track.id, found.clip.id, { speedCurve: null }));
          toast('Speed curve cleared');
        }),
      ]),
    );
  };

  const transitionsPane = () => {
    const clip = resolveMediaClip()?.clip || null;
    const cur = clip ? normalizeTransition(clip.transitionIn) : 'none';
    return el('div', { class: 'lib-pane' },
      sec('Transitions'),
      grid(TRANSITION_LIB.map(([k, label]) => libBtn(
        label, `Toggle the ${label} transition on the clip`, cur === k, () => applyTransitionToSelection(k),
      ))),
      sec('Whole timeline'),
      grid([
        libBtn(`All cuts → ${S.transSel?.value === 'smart' ? 'auto mix' : (S.transSel?.value || 'auto mix')}`, 'Add the chosen transition between every clip', false, () => applyTransitionsToAll(false)),
        libBtn('Clear every cut', 'Remove all transitions', false, () => applyTransitionsToAll(true)),
        libBtn(`Cut length ${TRANS_DUR_STEPS[transDurIdx]}s`, 'Cycle how long each transition takes', false, () => cycleTransitionDur()),
      ]),
    );
  };

  const LIB_TABS = [
    { id: 'media', label: 'Media', icon: '▦', build: mediaPane },
    { id: 'text', label: 'Text', icon: 'T', build: textPane },
    { id: 'effects', label: 'FX', icon: '✦', build: effectsPane },
    { id: 'filters', label: 'Filters', icon: '◑', build: filtersPane },
    { id: 'motion', label: 'Motion', icon: '➤', build: motionPane },
    { id: 'speed', label: 'Speed', icon: '»', build: speedPane },
    { id: 'transitions', label: 'Trans', icon: '⧉', build: transitionsPane },
  ];
  const libRail = el('div', { class: 'lib-rail', role: 'tablist', 'aria-label': 'Library categories' });
  const libBody = el('div', { class: 'panel-body lib-body' });
  let libTab = 'media';
  const renderLib = () => {
    libRail.querySelectorAll('.lib-tab').forEach((b) => {
      const on = b.dataset.tab === libTab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const tab = LIB_TABS.find((t) => t.id === libTab) || LIB_TABS[0];
    libBody.innerHTML = '';
    libBody.append(tab.build());
  };
  S.renderLib = renderLib;
  for (const t of LIB_TABS) {
    libRail.append(el('button', {
      type: 'button', class: 'lib-tab', role: 'tab', dataset: { tab: t.id },
      title: t.label, 'aria-selected': 'false',
      onclick: () => { libTab = t.id; renderLib(); },
    }, el('span', { class: 'lib-ico', text: t.icon }), el('span', { class: 'lib-lbl', text: t.label })));
  }

  const leftPanel = el('div', { class: 'panel left' },
    el('div', { class: 'panel-head', text: 'Library' }),
    el('div', { class: 'lib-wrap' }, libRail, libBody)
  );
  renderLib();

  /* ---- center: preview ---- */
  const video = el('video', { playsinline: true, class: 'pane-media pane-a-media' });
  video.addEventListener('loadedmetadata', () => syncMedia(true));
  const img = el('img', { class: 'frame-layer pane-a-media hidden', alt: '' });
  const video2 = el('video', { playsinline: true, class: 'pane-media pane-b-media hidden', muted: true });
  video2.addEventListener('loadedmetadata', () => syncMedia(true));
  const img2 = el('img', { class: 'frame-layer pane-b-media hidden', alt: '' });
  const textLayer = el('div', { class: 'text-layer' });
  const wmLayer = el('div', { class: 'watermark-layer', id: 'watermarkLayer', 'aria-hidden': 'true' });
  const overlayLayer = el('div', { class: 'overlay-layer' });
  const guides = el('div', { class: 'safe-guides' },
    el('div', { class: 'g-top' }), el('div', { class: 'g-bottom' }), el('div', { class: 'g-center' })
  );
  guides.classList.add('hidden');
  const emptyState = el('div', { class: 'preview-empty', id: 'previewEmpty' },
    el('div', { class: 'pe-icon', text: '▶' }),
    el('div', { class: 'pe-title', text: 'No video at playhead' }),
    el('div', { text: 'Drag a clip onto the top timeline row (V1), or move the red line over a clip. Click a timeline clip to edit it.' })
  );
  const badges = el('div', { class: 'preview-badges', id: 'previewBadges' });
  const vignette = el('div', { class: 'vignette-layer hidden', id: 'vignetteLayer', 'aria-hidden': 'true' });
  const flashLayer = el('div', { class: 'flash-layer hidden', 'aria-hidden': 'true' });
  const selBox = el('div', { class: 'sel-box', id: 'selBox' },
    el('div', { class: 'sh-label', text: '' }),
    ...['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => el('div', { class: `sh ${h}`, dataset: { h } }))
  );
  const snapGuides = el('div', { class: 'snap-guides hidden', id: 'snapGuides' },
    el('div', { class: 'sg-v' }),
    el('div', { class: 'sg-h' })
  );
  const frame = el('div', { class: 'preview-frame' }, video, img, video2, img2, overlayLayer, flashLayer, textLayer, wmLayer, vignette, guides, emptyState, badges, snapGuides, selBox);
  S.videoEl = video;
  S.imgEl = img;
  S.videoEl2 = video2;
  S.imgEl2 = img2;
  S.overlayLayer = overlayLayer;
  S.previewFrame = frame;
  S.previewBadges = badges;
  S.previewEmpty = emptyState;
  S.vignetteLayer = vignette;
  S.flashLayer = flashLayer;
  S.selBox = selBox;
  S.snapGuides = snapGuides;
  bindSelBox(selBox);

  const playBtn = el('button', { class: 'btn sm primary', text: '▶', title: 'Play / pause (Space)', 'aria-label': 'Play or pause', onclick: togglePlay });
  const timeLabel = el('span', { class: 'transport-time', text: '0:00.0 / 0:00.0' });
  const scrub = el('div', { class: 'scrub', role: 'slider', 'aria-label': 'Playback position', 'aria-valuemin': '0', tabindex: '0' }, el('div', { class: 'fill' }), el('div', { class: 'head' }));
  scrub.addEventListener('pointerdown', (e) => {
    const move = (ev) => {
      const r = scrub.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      setPlayhead(f * timelineDuration(S.timeline));
    };
    move(e);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  scrub.addEventListener('keydown', (e) => {
    const dur = timelineDuration(S.timeline);
    const fps = S.timeline.fps || 30;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setPlayhead(S.playhead - (e.shiftKey ? 1 : 1 / fps)); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setPlayhead(S.playhead + (e.shiftKey ? 1 : 1 / fps)); }
    else if (e.key === 'Home') { e.preventDefault(); setPlayhead(0); }
    else if (e.key === 'End') { e.preventDefault(); setPlayhead(dur); }
  });
  const frameStep = (n) => setPlayhead(S.playhead + n / (S.timeline.fps || 30));

  const transport = el('div', { class: 'preview-transport' },
    playBtn,
    el('button', { class: 'btn sm ghost', text: '⏮', title: 'Frame back', 'aria-label': 'Step one frame back', onclick: () => frameStep(-1) }),
    el('button', { class: 'btn sm ghost', text: '⏭', title: 'Frame fwd', 'aria-label': 'Step one frame forward', onclick: () => frameStep(1) }),
    timeLabel, scrub,
    el('button', { class: 'btn sm ghost', text: '◇', title: 'Add marker (M)', 'aria-label': 'Add marker', onclick: addMarkerAtPlayhead }),
    el('button', { class: 'btn sm ghost', text: 'Loop', title: 'Toggle loop region (L)', onclick: toggleLoop }),
    el('span', { class: 'muted mono', style: 'font-size:10.5px', text: 'Space · S · M · L · Del · Ctrl+Z · Ctrl+K · ?' })
  );

  // Always-visible quick actions (phone + looks + motion + text + PiP)
  const phoneBtn = el('button', {
    type: 'button',
    class: 'btn sm qs-btn phone-toggle',
    text: '📱 6.3"',
    title: 'Draggable 6.3" phone preview (live) — shortcut P',
    'aria-label': 'Toggle phone preview',
    'aria-pressed': 'false',
    onclick: () => setPhoneOpen(!S.phoneOpen),
  });
  S.phoneBtn = phoneBtn;

  /* Toggle registry: quick-bar buttons light up when their look is applied. */
  const qrefs = { effect: {}, motion: {}, text: {}, caption: {}, transdur: {}, kf: {} };
  S.quickRefs = qrefs;
  const qbtn = (group, key, text, title, onclick) => {
    const b = el('button', { class: 'btn sm qs-btn', type: 'button', text, title, onclick, dataset: group ? { qgroup: group, qkey: key } : null });
    if (group && key && qrefs[group]) qrefs[group][key] = b;
    return b;
  };

  const quickStyle = el('div', { class: 'quick-style', id: 'quickStyle' },
    phoneBtn,
    el('span', { class: 'qs-sep', 'aria-hidden': 'true' }),
    el('span', { class: 'qs-label', text: 'Looks' }),
    qbtn(null, null, '▣ Top title bar', 'Add/select text + full-width white top banner (meme look)', () => quickMemeBanner()),
    qbtn('effect', 'bw', '◐ B&W', 'Black & white on the target clip — click again to remove', () => quickEffect('bw')),
    qbtn('effect', 'vintage', '🎞 Vintage', 'Faded film look — click again to remove', () => quickEffect('vintage')),
    qbtn('effect', 'teal', '🌊 Teal', 'Teal & orange cinematic look — click again to remove', () => quickEffect('teal')),
    qbtn('effect', 'golden', '🌅 Golden', 'Warm golden-hour glow — click again to remove', () => quickEffect('golden')),
    qbtn('effect', 'noir', '🖤 Noir', 'High-contrast black & white — click again to remove', () => quickEffect('noir')),
    qbtn('effect', 'neon', '💜 Neon', 'Saturated neon pop — click again to remove', () => quickEffect('neon')),
    qbtn('effect', 'luxury', '👑 Luxury', 'Premium warm gold grade — click again to remove', () => quickEffect('luxury')),
    qbtn('effect', 'vignette', '◌ Vignette', 'Darken edges for cinematic focus — click again to remove', () => quickEffect('vignette')),
    qbtn('effect', 'soft', '☁ Soft', 'Soft focus / gentle gaussian blur — click again to remove', () => quickEffect('soft')),
    qbtn('effect', 'contain', '◻ Fit', 'No crop — letterbox video to fit (click again for cover)', () => quickFit('contain')),
    qbtn(null, null, '↺ Reset', 'Reset fit/zoom/focus/effect/grade on selected media', () => quickResetLook()),
    el('span', { class: 'qs-sep', 'aria-hidden': 'true' }),
    el('span', { class: 'qs-label', text: 'Motion' }),
    qbtn('motion', 'push-in', '↗ Push-in', 'Slow zoom in over the selected clip — click again to remove', () => applyMotionPreset('push-in')),
    qbtn('motion', 'punch', '⚡ Punch', 'Fast hard zoom punch-in at start — click again to remove', () => applyMotionPreset('punch')),
    qbtn('motion', 'reveal', '⟵ Reveal', 'Zoom out from close-up — click again to remove', () => applyMotionPreset('reveal')),
    qbtn('motion', 'kenburns', '🎞 Ken Burns', 'Slow pan across the frame — click again to remove', () => applyMotionPreset('kenburns')),
    qbtn('motion', 'spin', '↻ Spin', 'Rotate 360° over the clip (smooth ease) — click again to remove', () => applyMotionPreset('spin')),
    qbtn('motion', 'float', '〰 Float', 'Gentle vertical float bob — click again to remove', () => applyMotionPreset('float')),
    el('span', { class: 'qs-sep', 'aria-hidden': 'true' }),
    el('span', { class: 'qs-label', text: 'Text' }),
    qbtn('text', 'fade', 'Fade', 'Text fade in/out animation — click again to remove', () => quickTextAnim('fade')),
    qbtn('text', 'pop', 'Pop', 'Text pop-in animation — click again to remove', () => quickTextAnim('pop')),
    qbtn('text', 'slide-up', 'Slide ↑', 'Text slides up into place — click again to remove', () => quickTextAnim('slide-up')),
    qbtn('text', 'bounce', 'Bounce', 'Text bounces in — click again to remove', () => quickTextAnim('bounce')),
    qbtn('text', 'zoom-in', 'Zoom-in', 'Text zooms in from small — click again to remove', () => quickTextAnim('zoom-in')),
    qbtn('text', 'flicker', '⚡ Flicker', 'Strobe/flicker entrance for titles — click again to remove', () => quickTextAnim('flicker')),
    qbtn('text', 'glitch', '◈ Glitch', 'Digital glitch entrance for tech/gaming titles — click again to remove', () => quickTextAnim('glitch')),
    el('span', { class: 'qs-sep', 'aria-hidden': 'true' }),
    el('span', { class: 'qs-label', text: 'Captions' }),
    qbtn('caption', 'karaoke', '🎤 Karaoke', 'Word-by-word caption on T2 (reels style) — click again to remove', () => quickCaptionPreset('karaoke')),
    qbtn('caption', 'pop', '🔥 Pop', 'Yellow bold pop caption, word stagger — click again to remove', () => quickCaptionPreset('pop')),
    qbtn('caption', 'clean', '◻ Clean', 'Clean bold white caption in safe area — click again to remove', () => quickCaptionPreset('clean')),
    qbtn('caption', 'boxed', '▢ Boxed', 'Dark box caption — click again to remove', () => quickCaptionPreset('boxed')),
    qbtn('caption', 'outline', 'A Outline', 'Heavy outline caption — click again to remove', () => quickCaptionPreset('outline')),
    el('span', { class: 'qs-sep', 'aria-hidden': 'true' }),
    el('span', { class: 'qs-label', text: 'Cuts' }),
    (() => {
      const sel = el('select', {
        class: 'input qs-select',
        'aria-label': 'Transition style for every cut',
        title: 'Transition applied between clips',
        onchange: () => refreshQuickStates(),
      },
        el('option', { value: 'smart' }, 'Auto mix'),
        ...TRANSITIONS.filter((tr) => tr !== 'none').map((tr) =>
          el('option', { value: tr }, tr === 'dip' ? 'Dip black' : tr.charAt(0).toUpperCase() + tr.slice(1)))
      );
      S.transSel = sel;
      return sel;
    })(),
    qbtn(null, null, '⚡ Apply to cuts', 'Add the chosen transition to every cut — click again to clear them all', () => applyTransitionsToAll()),
    qbtn('transdur', 'dur', '⏱ 0.3s', 'Transition length in seconds (0.05–2) — click to cycle 0.15 / 0.3 / 0.6 / 1', () => cycleTransitionDur()),
    el('span', { class: 'qs-sep', 'aria-hidden': 'true' }),
    el('span', { class: 'qs-label', text: 'Layout' }),
    el('button', {
      class: 'btn sm qs-btn', text: '⧉ PiP corner', title: 'Make selected clip a picture-in-picture overlay (bottom-right)',
      onclick: () => quickPip('br'),
    }),
    el('button', {
      class: 'btn sm qs-btn', text: 'PiP top-left', title: 'Picture-in-picture overlay top-left',
      onclick: () => quickPip('tl'),
    }),
    el('span', { class: 'qs-hint', text: 'Tip: click a clip first — drag corners on canvas or open Clip Tools.' })
  );

  const center = el('div', { class: 'preview-center' },
    el('div', { class: 'region-hint', style: 'margin:8px 12px 0', html: 'This is your <b>Reel</b>. Press <b>Space</b> to play. Drag corners on the canvas (or the 6.3" phone) to resize.' }),
    el('div', { class: 'preview-stage' }, frame),
    quickStyle,
    transport
  );

  /* ---- right: director + inspector ---- */
  const diskBanner = el('div', { class: 'disk-banner', style: 'display:none' },
    el('span', { text: 'Timeline changed on disk (OpenCode).' }),
    el('button', { class: 'btn sm primary', text: 'Reload', onclick: () => reloadTimeline(true) })
  );

  const styleSel = el('select', { class: 'input' },
    el('option', { value: '' }, '— no style —'),
    S.styles.map((s) => el('option', { value: s.builtin ? s.name : (s.id || s.file), selected: (S.project.style_name === s.name) || undefined }, s.name + (s.builtin ? ' ·built-in' : '')))
  );
  styleSel.addEventListener('change', async () => {
    if (!styleSel.value) return;
    try {
      const r = await api(`/api/projects/${S.project.id}/apply-style`, { body: { style: styleSel.value } });
      S.project = r.project;
      if (r.timeline) {
        S.timeline = r.timeline;
        S.history = [cloneTimeline(S.timeline)];
        S.hIndex = 0;
        clearSelection();
        renderTimeline();
        updatePreviewText(true);
        syncMedia(true);
        updateFooter();
      }
      toast(`Style applied: ${S.project.style_name}`);
      updateFooter();
    } catch (e) { toast(e.message, true); }
  });

  const tmplSel = el('select', { class: 'input' },
    el('option', { value: '' }, '— no template —'),
    S.templates.map((t) => el('option', { value: t.name, selected: S.project.template_id === t.name || undefined }, t.name))
  );
  tmplSel.addEventListener('change', async () => {
    if (!tmplSel.value) return;
    if (!(await confirmModal('Apply template', `Scaffold "${tmplSel.value}" structure onto T1? Existing T1 text clips will be replaced.`))) {
      tmplSel.value = S.project.template_id || '';
      return;
    }
    try {
      const r = await api(`/api/projects/${S.project.id}/apply-template`, { body: { template: tmplSel.value } });
      await reloadTimeline(true);
      toast(`Template applied (${r.created} clips)`);
    } catch (e) { toast(e.message, true); }
  });

  const instruction = el('textarea', {
    class: 'input', rows: 5,
    'aria-label': 'Instructions for OpenCode',
    placeholder: 'Instructions for OpenCode, e.g.\nCreate a 25 second Reel using this style. Strong first 2 seconds. Fast cuts. Sync important cuts to music. Add bold captions.',
  });
  const quick = el('div', { class: 'quick-actions' },
    ['Make this 25 seconds.', 'Strong first 2 seconds.', 'Sync cuts to the music.', 'Add bold captions.', 'Make the middle faster.', 'Remove boring sections.', 'Make the ending stronger.', 'Use the Dark Motivation style.']
      .map((q) => {
        const c = el('button', { type: 'button', class: 'chip', text: q });
        c.addEventListener('click', () => { instruction.value = instruction.value ? `${instruction.value}\n${q}` : q; instruction.focus(); });
        return c;
      })
  );

  const inboxList = el('div', {});
  const refreshInbox = async () => {
    try {
      const { files } = await api(`/api/projects/${S.project.id}/inbox`);
      inboxList.innerHTML = '';
      if (!files.length) {
        inboxList.append(el('div', { class: 'muted', text: 'No instructions saved yet.' }));
        return;
      }
      for (const f of files.slice(-6).reverse()) {
        const item = el('div', { class: 'inbox-item' },
          el('div', { class: 't', text: f.file }),
          el('div', { class: 'd', text: new Date(f.mtime).toLocaleTimeString() })
        );
        item.addEventListener('click', () => {
          modal({ title: f.file, body: el('pre', { class: 'code', text: f.content }), actions: [{ label: 'Close', class: 'primary' }] });
        });
        inboxList.append(item);
      }
    } catch { /* ignore */ }
  };

  const saveInbox = async () => {
    const text = instruction.value.trim();
    if (!text) { toast('Write an instruction first', true); return; }
    try {
      const r = await api(`/api/projects/${S.project.id}/inbox`, { body: { instruction: text } });
      toast(`Saved ${r.file}`);
      instruction.value = '';
      refreshInbox();
    } catch (e) { toast(e.message, true); }
  };
  const copyPrompt = async () => {
    const text = instruction.value.trim() || 'Create an edit for this project.';
    const prompt = [
      `Open the Reel Workbench project at:`,
      (S.project.dir || '').replace(/\\/g, '/'),
      ``,
      `Instruction:`,
      text,
      ``,
      `Read AGENTS.md first. Edit timeline.json directly (validate with shared/timeline-ops.js), then I will reload in the UI.`,
    ].join('\n');
    await copyText(prompt);
    toast('Prompt copied — paste it into OpenCode');
  };

  const dirPanel = el('div', { class: 'panel right' },
    el('div', { class: 'panel-head' },
      el('span', { text: 'Clip Tools' }),
      el('button', {
        class: 'btn sm ghost sheet-close', type: 'button', text: '✕', 'aria-label': 'Close Clip Tools',
        onclick: () => document.body.classList.remove('sheet-open'),
      }),
      el('span', { class: 'badge new', text: 'NEW' })
    ),
    el('div', { class: 'panel-body' },
      diskBanner,
      el('div', { class: 'dir-section clip-tools' },
        el('h4', { class: 'section-hot' }, 'Inspector'),
        el('div', { class: 'region-hint', html: 'Click a clip on the timeline to edit it here — size, color, speed, fades.' }),
        el('div', { id: 'inspector' })
      ),
      el('div', { class: 'dir-section' },
        el('h4', { text: 'Style' }), styleSel,
        el('div', { class: 'muted', style: 'font-size:11px;margin-top:4px', text: 'Recipes only — apply from Styles for full library.' })
      ),
      el('div', { class: 'dir-section' }, el('h4', { text: 'Template' }), tmplSel),
      el('div', { class: 'dir-section' },
        el('h4', { text: 'Instruction → OpenCode' }),
        instruction,
        el('div', { class: 'row', style: 'margin-top:7px;gap:6px' },
          el('button', { class: 'btn sm primary', text: 'Save to inbox', onclick: saveInbox }),
          el('button', { class: 'btn sm', text: 'Copy prompt', onclick: copyPrompt })
        ),
        el('div', { style: 'margin-top:7px' }, quick)
      ),
      el('div', { class: 'dir-section' },
        el('h4', { text: 'Inbox' }), inboxList
      )
    )
  );

  /* ---- timeline ---- */
  const tlToolbar = el('div', { class: 'tl-toolbar' },
    el('span', { class: 'muted', style: 'font-size:11px', text: 'TIMELINE' }),
    el('span', { class: 'region-hint', style: 'margin:0 6px;flex:1;min-width:0', html: 'Click a colored bar to edit it. Drag its edges to trim.' }),
    btn('Split', 'Cut the selected clip in two at the playhead (S)', doSplit, 'sm'),
    btn('＋ Text', 'Add a title or caption', doAddText, 'sm'),
    el('div', { class: 'spacer' }),
    el('span', { class: 'muted', style: 'font-size:11px', id: 'tlDur', text: '' }),
    btn('⤢ Taller', 'Make timeline taller for precision editing', () => {
      const w = document.querySelector('.timeline-wrap');
      if (w) { w.classList.toggle('tall'); fitPreviewFrame(); }
    }),
    el('input', {
      type: 'range', min: '20', max: '200', value: String(S.pps), style: 'width:110px',
      title: 'Timeline zoom',
      'aria-label': 'Timeline zoom',
      oninput: (e) => { S.pps = Number(e.target.value); renderTimeline(); },
    })
  );
  const tlScroll = el('div', { class: 'tl-scroll', id: 'tlScroll' });
  const tlWrap = el('div', { class: 'timeline-wrap' }, tlToolbar, tlScroll);

  /* ---- footer ---- */
  const footer = el('div', { class: 'editor-footer', id: 'editorFooter' });

  root.append(toolbar, el('div', { class: 'editor-main' }, leftPanel, center, dirPanel), tlWrap, footer);

  // Mobile: floating "Edit clip" opens Clip Tools bottom sheet
  const sheetFab = el('button', {
    class: 'sheet-fab', type: 'button', text: '✎ Edit clip',
    title: 'Open Clip Tools (bottom sheet on mobile)',
    'aria-label': 'Open Clip Tools',
    onclick: () => {
      const open = !document.body.classList.contains('sheet-open');
      document.body.classList.toggle('sheet-open', open);
      if (open) document.getElementById('inspector')?.focus?.();
    },
  });
  root.append(sheetFab);

  refreshMedia();
  applyLayoutToFrame();
  autoSelectClip();
  renderTimeline();
  renderInspector();
  updateFooter();
  refreshInbox();
  updatePreviewText(true);
  syncMedia(true);
  updatePreviewBadges();
  fitPreviewFrame();
  updateTimeLabel();
  updateSelBox();

  if (S.renderResult) showRenderResult(S.renderResult);

  // Live 6.3" phone overlay — default on unless user turned it off
  ensurePhonePreview();
  loadPhoneScale();
  setPhoneOpen(localStorage.getItem('rw_phone_preview') !== '0', { quiet: true });

  const onResize = () => {
    fitPreviewFrame();
    if (S.phoneOpen) {
      sizePhonePreview();
      renderPhoneText();
      syncOverlays();
      updateSelBox();
    }
  };
  S.unsubs.push(() => { /* media elements cleanup */ S.audioEls.forEach((a) => { a.pause(); }); S.audioEls.clear(); });
  S.unsubs.push(() => window.removeEventListener('resize', onResize));
  window.addEventListener('resize', onResize);
}

function btn(label, title, onclick, cls = '') {
  return el('button', { class: `btn sm ${cls}`, text: label, title: title || label, onclick });
}

/* ================= split layout (50/50) ================= */

function layoutControls() {
  const mode = getLayoutMode(S.timeline);
  const mk = (label, value, title) => el('button', {
    class: `btn sm layout-btn ${mode === value ? 'primary' : ''}`,
    text: label,
    title,
    'aria-pressed': mode === value ? 'true' : 'false',
    onclick: () => setLayout(value),
  });
  return el('div', { class: 'layout-controls', title: 'Screen layout' },
    el('span', { class: 'muted', style: 'font-size:10.5px;letter-spacing:.5px', text: 'LAYOUT' }),
    mk('Full', 'none', 'Full frame (single video)'),
    mk('◫ L|R', 'split-h', '50/50 side-by-side (left | right)'),
    mk('⊟ T|B', 'split-v', '50/50 stacked (top / bottom)'),
  );
}

function setLayout(mode) {
  if (!LAYOUT_MODES.includes(mode)) return;
  try {
    const snap = cloneTimeline(S.timeline);
    setLayoutMode(S.timeline, mode);
    commit(snap);
    applyLayoutToFrame();
    renderToolbarLayout();
    syncMedia(true);
    updateFooter();
    updatePreviewBadges();
    flashPreview();
    if (mode === 'split-h' || mode === 'split-v') {
      toast(`${mode === 'split-h' ? 'Left | Right' : 'Top / Bottom'} 50/50 — clip A on V1, clip B on V3`);
    } else {
      toast('Full frame layout');
    }
  } catch (e) { toast(e.message, true); }
}

function applyLayoutToFrame() {
  const frame = document.querySelector('.preview-frame');
  if (!frame || !S.timeline) return;
  const mode = getLayoutMode(S.timeline);
  frame.classList.remove('layout-none', 'layout-split-h', 'layout-split-v');
  frame.classList.add(`layout-${mode}`);
  const split = mode !== 'none';
  S.videoEl2?.classList.toggle('hidden', !split);
  S.imgEl2?.classList.toggle('hidden', !split);
  if (S.videoEl) S.videoEl.classList.toggle('pane-a-media', true);
  syncMedia(true);
}

function renderToolbarLayout() {
  const old = document.querySelector('.layout-controls');
  if (!old) return;
  old.replaceWith(layoutControls());
}

function clipOnTrack(trackId, t) {
  const track = getTrack(S.timeline, trackId);
  if (track.hidden) return null;
  for (const c of track.clips) {
    if (t >= c.start - 1e-6 && t < clipEnd(c) - 1e-6) return c;
  }
  return null;
}

/* ---- color grade preview (mirrors server buildGradeFilter) ---- */

let gfxSeq = 0;

/**
 * Cached SVG feColorMatrix for channels CSS filters cannot express
 * (exposure offset + white-balance temperature), matched to FFmpeg `eq`.
 */
function gradeMatrixRef(node, exposure, temperature) {
  if (!node) return '';
  const NS = 'http://www.w3.org/2000/svg';
  let id = node.dataset.gfxGrade;
  if (!id) {
    id = `gfxGrade${++gfxSeq}`;
    node.dataset.gfxGrade = id;
    let root = document.getElementById('rwGradeFx');
    if (!root) {
      root = document.createElementNS(NS, 'svg');
      root.id = 'rwGradeFx';
      root.setAttribute('width', '0');
      root.setAttribute('height', '0');
      root.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
      document.body.append(root);
    }
    const filter = document.createElementNS(NS, 'filter');
    filter.id = id;
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const mtx = document.createElementNS(NS, 'feColorMatrix');
    mtx.setAttribute('type', 'matrix');
    filter.append(mtx);
    root.append(filter);
  }
  const mtx = document.getElementById(id)?.querySelector('feColorMatrix');
  if (!mtx) return '';
  const off = round3(exposure * 0.4);
  const kr = round3(1 + temperature * 0.22);
  const kg = round3(1 + temperature * 0.02);
  const kb = round3(1 - temperature * 0.22);
  mtx.setAttribute('values', `${kr} 0 0 0 ${off} 0 ${kg} 0 0 ${off} 0 0 ${kb} 0 ${off} 0 0 0 1 0`);
  return `url(#${id})`;
}

/** Effect + grade CSS filter for a clip at clip-local time `localT`. */
function mediaFilterCss(clip, localT, node) {
  if (!clip) return '';
  const parts = [];
  const ef = effectToCssFilter(clip.effect);
  if (ef) parts.push(ef);
  const g = gradeOf(clip);
  const ex = evalKeyframes(clip, localT, 'exposure', g.exposure);
  const ct = evalKeyframes(clip, localT, 'contrast', g.contrast);
  const sa = evalKeyframes(clip, localT, 'saturation', g.saturation);
  const tp = evalKeyframes(clip, localT, 'temperature', g.temperature);
  if (Math.abs(ex) > 1e-6 || Math.abs(tp) > 1e-6) {
    const ref = gradeMatrixRef(node, ex, tp);
    if (ref) parts.push(ref);
    else if (Math.abs(ex) > 1e-6) parts.push(`brightness(${(1 + ex).toFixed(3)})`);
  }
  if (Math.abs(ct) > 1e-6) parts.push(`contrast(${Math.max(0, 1 + ct).toFixed(3)})`);
  if (Math.abs(sa) > 1e-6) parts.push(`saturate(${Math.max(0, 1 + sa).toFixed(3)})`);
  const chroma = normalizeChroma(clip.chroma);
  if (chroma) {
    const ref = chromaMatrixRef(node, chroma);
    if (ref) parts.push(ref);
  }
  return parts.join(' ');
}

/**
 * Approximate chroma-key preview: SVG filter that turns "how green (or blue)
 * is this pixel" into alpha — same similarity/blend knobs as FFmpeg `colorkey`.
 * The export is exact; this is a close visual stand-in.
 */
function chromaMatrixRef(node, chroma) {
  if (!node || !chroma) return '';
  const NS = 'http://www.w3.org/2000/svg';
  const rgb = hexToRgb(chroma.color || '#00ff00');
  const blueKey = rgb && rgb.b > rgb.r && rgb.b > rgb.g;
  let id = node.dataset.gfxChroma;
  if (!id) {
    id = `gfxChroma${++gfxSeq}`;
    node.dataset.gfxChroma = id;
    let root = document.getElementById('rwGradeFx');
    if (!root) {
      root = document.createElementNS(NS, 'svg');
      root.id = 'rwGradeFx';
      root.setAttribute('width', '0');
      root.setAttribute('height', '0');
      root.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
      document.body.append(root);
    }
    const filter = document.createElementNS(NS, 'filter');
    filter.id = id;
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    filter.append(document.createElementNS(NS, 'feColorMatrix'));
    filter.append(document.createElementNS(NS, 'feComponentTransfer'));
    const transfer = filter.lastChild;
    transfer.append(document.createElementNS(NS, 'feFuncA'));
    root.append(filter);
  }
  const root = document.getElementById('rwGradeFx');
  const filter = document.getElementById(id);
  const mtx = filter?.querySelector('feColorMatrix');
  const fn = filter?.querySelector('feFuncA');
  if (!mtx || !fn) return '';
  const blend = Math.max(0.02, Number(chroma.blend) || 0.15);
  const sim = Math.max(0, Math.min(1, Number(chroma.similarity) || 0.3));
  // a = 0.5*keyness + 0.5 ; alpha = clamp((sim - keyness)/blend)
  mtx.setAttribute('values', blueKey
    ? '-0.25 -0.25 0.5 0 0.5  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'
    : '-0.25 0.5 -0.25 0 0.5  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0');
  fn.setAttribute('type', 'linear');
  fn.setAttribute('slope', round3(-2 / blend));
  fn.setAttribute('intercept', round3((sim + 1) / blend));
  void root;
  return `url(#${id})`;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** CSS mask (feathered shape) URI for a clip — mirrors the FFmpeg `geq` matte. */
function maskUri(clip) {
  const m = normalizeMask(clip?.mask);
  if (!m) return '';
  const W = 400;
  const H = 400 * (9 / 16);
  const cx = (m.x / 100) * W;
  const cy = (m.y / 100) * H;
  const w = Math.max(1, (m.w / 100) * W);
  const h = Math.max(1, (m.h / 100) * H);
  const blur = round3(m.feather * 18);
  const rot = round3(m.rotation);
  const fill = m.invert ? 'black' : 'white';
  let shape;
  if (m.type === 'rect') {
    shape = `<rect x="${round3(cx - w / 2)}" y="${round3(cy - h / 2)}" width="${round3(w)}" height="${round3(h)}" fill="${fill}"/>`;
  } else if (m.type === 'circle') {
    const r = Math.max(1, Math.min(w, h) / 2);
    shape = `<ellipse cx="${round3(cx)}" cy="${round3(cy)}" rx="${round3(r)}" ry="${round3(r)}" fill="${fill}"/>`;
  } else if (m.type === 'line') {
    shape = `<rect x="0" y="${round3(cy - h / 2)}" width="${W}" height="${round3(h)}" fill="${fill}"/>`;
  } else {
    shape = `<ellipse cx="${round3(cx)}" cy="${round3(cy)}" rx="${round3(w / 2)}" ry="${round3(h / 2)}" fill="${fill}"/>`;
  }
  const bg = m.invert ? `<rect width="${W}" height="${H}" fill="white"/>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<defs><filter id="f" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="${blur}"/></filter></defs>`
    + `${bg}<g filter="url(#f)" transform="rotate(${rot} ${round3(cx)} ${round3(cy)})">${shape}</g></svg>`;
  const uri = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  return uri;
}

/** Apply/clear the shape mask on a preview element. */
function applyMaskCss(node, clip) {
  if (!node) return;
  const uri = maskUri(clip);
  for (const p of ['mask-image', '-webkit-mask-image']) node.style.setProperty(p, uri || 'none');
  if (uri) {
    for (const p of ['mask-size', '-webkit-mask-size']) node.style.setProperty(p, '100% 100%');
    for (const p of ['mask-repeat', '-webkit-mask-repeat']) node.style.setProperty(p, 'no-repeat');
    for (const p of ['mask-position', '-webkit-mask-position']) node.style.setProperty(p, 'center');
  }
}

/** Vignette box-shadow CSS for a clip (overlays / PiP). */
function vignetteShadowCss(clip) {
  const v = gradeOf(clip).vignette;
  if (v <= 1e-6) return '';
  const blur = Math.round(28 + 54 * v);
  const spread = Math.round(6 + 24 * v);
  const alpha = (0.18 + 0.5 * v).toFixed(2);
  return `inset 0 0 ${blur}px ${spread}px rgba(0,0,0,${alpha})`;
}

/** Apply object-fit / object-position / zoom / color effect + grade to preview media. */
function applyClipTransform(el, clip) {
  if (!el) return;
  if (!clip) {
    el.style.objectFit = '';
    el.style.objectPosition = '';
    el.style.transformOrigin = '';
    el.style.transform = '';
    el.style.filter = '';
    el.style.opacity = '';
    el.classList.remove('fx-vignette');
    applyMaskCss(el, null);
    return;
  }
  const base = normalizeTransform(clip);
  const localT = S.playhead - clip.start;
  const scale = evalKeyframes(clip, localT, 'scale', base.scale);
  const posX = evalKeyframes(clip, localT, 'posX', base.posX);
  const posY = evalKeyframes(clip, localT, 'posY', base.posY);
  const rotate = evalKeyframes(clip, localT, 'rotate', base.rotate);
  const opacityKf = evalKeyframes(clip, localT, 'opacity', 1);
  const trGain = transitionGain(clip, localT);
  el.style.objectFit = base.fit;
  el.style.objectPosition = `${posX}% ${posY}%`;
  el.style.transformOrigin = `${posX}% ${posY}%`;
  const xf = [];
  if (Math.abs(scale - 1) > 1e-6) xf.push(`scale(${scale})`);
  if (Math.abs(rotate) > 1e-6) xf.push(`rotate(${rotate}deg)`);
  el.style.transform = xf.join(' ');
  el.style.filter = mediaFilterCss(clip, localT, el);
  applyMaskCss(el, clip);
  el.classList.toggle('fx-vignette', normalizeEffect(clip?.effect) === 'vignette');
  const op = Math.max(0, Math.min(1, opacityKf * trGain));
  el.style.opacity = op >= 0.999 ? '' : String(op);
}

/**
 * Frame-level vignette (effect `vignette` + graded vignette strength) and the
 * white flash layer used by `flash` transitions — both mirrored in the export.
 */
function syncVignetteLayer() {
  const layer = S.vignetteLayer;
  if (!layer || !S.timeline) return;
  const t = S.playhead;
  let on = false;
  let strength = 0;
  for (const { clip } of activeClips(S.timeline, t, ['video', 'image'])) {
    if (normalizeEffect(clip.effect) === 'vignette') on = true;
    const v = gradeOf(clip).vignette;
    if (v > strength) strength = v;
  }
  layer.classList.toggle('hidden', !on);
  if (strength > 1e-6) {
    const alpha = (0.15 + 0.6 * strength).toFixed(2);
    const stop = Math.round(58 - 24 * strength);
    layer.style.background = `radial-gradient(ellipse at center, transparent ${stop}%, rgba(0,0,0,${alpha}) 100%)`;
  } else {
    layer.style.background = '';
  }
}

/** White flash under text/overlays while the program clip is transitioning in. */
function syncFlashLayer() {
  const layer = S.flashLayer;
  if (!layer || !S.timeline) return;
  const t = S.playhead;
  let op = 0;
  const clip = clipOnTrack('v1', t);
  if (clip && normalizeTransition(clip.transitionIn) === 'flash') {
    const d = normalizeTransitionDur(clip.transitionDur);
    const u = Math.max(0, (t - clip.start) / d);
    op = Math.max(0, 1 - Math.min(1, u * 1.25));
  }
  layer.classList.toggle('hidden', op <= 0.001);
  layer.style.opacity = op >= 0.999 ? '1' : String(op);
}

/** Collect floating overlay clips (v2 always; v3 only when not split) active at t. */
function overlayClipsAt(t) {
  const split = isSplitLayout(S.timeline);
  const out = [];
  for (const trackId of ['v2', 'v3']) {
    if (split && trackId === 'v3') continue;
    const track = getTrack(S.timeline, trackId);
    if (track.hidden) continue;
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      if (t >= clip.start - 1e-6 && t < clipEnd(clip) - 1e-6) out.push({ trackId, clip });
    }
  }
  return out;
}

/** Sync floating v2/v3 overlay media into a layer (.overlay-layer or phone). */
function syncOverlaysInto(layer, play) {
  if (!layer || !S.timeline) return;
  const t = S.playhead;
  const wanted = overlayClipsAt(t);
  const keep = new Set(wanted.map((w) => w.clip.id));
  for (const node of [...layer.children]) {
    if (!keep.has(node.dataset.clipId)) {
      if (node.tagName === 'VIDEO') node.pause?.();
      node.remove();
    }
  }
  for (const { trackId, clip } of wanted) {
    let node = layer.querySelector(`[data-clip-id="${clip.id}"]`);
    const asset = S.media.find((m) => m.id === clip.assetId);
    const url = asset?.url || '';
    const ov = clip.overlay || { xPct: 50, yPct: 50, widthPct: 30 };
    const localT = t - clip.start;
    const opacityKf = evalKeyframes(clip, localT, 'opacity', 1);
    const trGain = transitionGain(clip, localT);
    const op = Math.max(0, Math.min(1, opacityKf * trGain));
    const applyBox = (n) => {
      n.style.left = `${ov.xPct}%`;
      n.style.top = `${ov.yPct}%`;
      n.style.width = `${ov.widthPct}%`;
      n.style.opacity = op >= 0.999 ? '' : String(op);
      n.style.filter = mediaFilterCss(clip, localT, n);
      applyMaskCss(n, clip);
      n.style.boxShadow = vignetteShadowCss(clip);
      n.classList.toggle('fx-vignette', normalizeEffect(clip.effect) === 'vignette');
      n.classList.toggle('hidden', op <= 0.001);
    };
    if (!node) {
      if (clip.kind === 'video') {
        node = el('video', { playsinline: true, class: 'overlay-media', dataset: { clipId: clip.id, trackId } });
        node.muted = true;
      } else {
        node = el('img', { class: 'overlay-media', alt: '', dataset: { clipId: clip.id, trackId } });
      }
      layer.append(node);
    }
    if (clip.kind === 'video') {
      if (node.tagName !== 'VIDEO') { node.remove(); continue; }
      const speed = clip.speed > 0 ? clip.speed : 1;
      const remapped = !!speedCurveOf(clip) || normalizeReverse(clip.reverse);
      const target = sourceTimeAt(clip, localT);
      if (node.dataset.src !== url) {
        node.src = url;
        node.dataset.src = url;
        node.addEventListener('loadedmetadata', () => {
          try { node.playbackRate = remapped ? 1 : speed; node.currentTime = target; } catch { /* */ }
        }, { once: true });
      } else if (Math.abs(node.currentTime - target) > (remapped ? 0.02 : 0.18)) {
        try { node.currentTime = target; } catch { /* */ }
      }
      const rate = remapped ? 1 : speed;
      if (node.playbackRate !== rate) {
        try { node.playbackRate = rate; } catch { /* */ }
      }
      if (play && !remapped) node.play?.().catch(() => {});
      else node.pause?.();
    } else {
      if (node.tagName !== 'IMG') { node.remove(); continue; }
      if (node.dataset.src !== url) { node.src = url; node.dataset.src = url; }
    }
    applyBox(node);
  }
}

/** Sync floating v2/v3 overlay media into main frame + phone (W1-3 preview parity). */
function syncOverlays() {
  if (!S.timeline) return;
  syncOverlaysInto(S.overlayLayer, S.playing);
  if (S.phoneEls?.overlay) {
    syncOverlaysInto(S.phoneEls.overlay, S.playing && S.phoneOpen);
  }
}

/** Size 9:16 preview to always fill available stage (fit). */
function fitPreviewFrame() {
  const stage = document.querySelector('.preview-stage');
  const frame = S.previewFrame || document.querySelector('.preview-frame');
  if (!stage || !frame || !S.timeline) return;
  stage.classList.remove('zoomed');
  frame.classList.remove('manual-size');
  frame.style.width = '';
  frame.style.height = '';
  const cs = getComputedStyle(stage);
  const availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (availH < 40 || availW < 40) return;
  let h = availH;
  let w = h * (9 / 16);
  if (w > availW) { w = availW; h = w * (16 / 9); }
  frame.style.height = `${Math.floor(h)}px`;
  frame.style.width = `${Math.floor(w)}px`;
  updatePreviewText(true);
  updateSelBox();
}

function setPhoneOpen(open, { quiet = false } = {}) {
  const pe = ensurePhonePreview();
  S.phoneOpen = !!open;
  try { localStorage.setItem('rw_phone_preview', S.phoneOpen ? '1' : '0'); } catch { /* */ }
  pe.shell.classList.toggle('hidden', !S.phoneOpen);
  if (S.phoneBtn) {
    S.phoneBtn.setAttribute('aria-pressed', S.phoneOpen ? 'true' : 'false');
    S.phoneBtn.classList.toggle('on', S.phoneOpen);
  }

  if (S.phoneOpen) {
    sizePhonePreview();
    applyPhonePos();
    // Layout class mirrors main frame
    const main = S.previewFrame;
    pe.screen.classList.remove('layout-none', 'layout-split-h', 'layout-split-v');
    const mode = main ? ([...main.classList].find((c) => c.startsWith('layout-')) || 'layout-none') : 'layout-none';
    pe.screen.classList.add(mode);
    syncPhonePreview(true);
    renderPhoneText();
    syncOverlays();
    updateTimeLabel();
    updateSelBox();
    if (!quiet) toast('6.3" live — select a clip, drag handles on the phone · corner ◢ resizes phone · P hides');
  } else {
    try { pe.v1.pause(); } catch { /* */ }
    try { pe.v2.pause(); } catch { /* */ }
    pe.overlay?.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch { /* */ } });
    updateSelBox();
    if (!quiet) toast('Phone preview hidden (P shows it)');
  }
}

/* ================= 6.3" phone preview (live, draggable) ================= */

/** Screen diagonal (inches) for a common 6.3" phone; CSS assumes 96 px/in. */
const PHONE_DIAG_IN = 6.3;
const CSS_PX_PER_IN = 96;

function phoneScreenSize() {
  // 9:16 content on a 6.3" diagonal screen
  const h = (PHONE_DIAG_IN * 16 / Math.sqrt(81 + 256)) * CSS_PX_PER_IN;
  const w = h * (9 / 16);
  return { w: Math.round(w), h: Math.round(h) };
}

function ensurePhonePreview() {
  if (S.phoneEls?.shell?.isConnected) return S.phoneEls;

  const v1 = el('video', { playsinline: true, muted: true, class: 'pane-a-media pp-media' });
  const i1 = el('img', { class: 'pane-a-media pp-media hidden', alt: '' });
  const v2 = el('video', { playsinline: true, muted: true, class: 'pane-b-media pp-media hidden' });
  const i2 = el('img', { class: 'pane-b-media pp-media hidden', alt: '' });
  const overlayLayer = el('div', { class: 'overlay-layer pp-overlay' });
  const textLayer = el('div', { class: 'text-layer pp-text' });
  const wmLayer = el('div', { class: 'watermark-layer pp-wm', 'aria-hidden': 'true' });
  const empty = el('div', { class: 'preview-empty pp-empty', text: 'No video at playhead' });
  empty.classList.add('hidden');
  const time = el('span', { class: 'pp-time', text: '0:00.0' });
  const phoneGuides = el('div', { class: 'snap-guides hidden' },
    el('div', { class: 'sg-v' }),
    el('div', { class: 'sg-h' })
  );
  const phoneSelBox = el('div', { class: 'sel-box', id: 'phoneSelBox' },
    el('div', { class: 'sh-label', text: '' }),
    ...['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => el('div', { class: `sh ${h}`, dataset: { h } }))
  );

  const screen = el('div', { class: 'pp-screen' },
    v1, i1, v2, i2, overlayLayer, textLayer, wmLayer, empty, phoneGuides, phoneSelBox, time
  );
  const dragBar = el('div', { class: 'pp-drag', title: 'Drag to move · corner to resize' },
    el('span', { class: 'pp-grip', text: '⠿' }),
    el('span', { class: 'pp-drag-label', text: '6.3" live · drag' }),
    el('button', {
      class: 'pp-close', type: 'button', text: '✕', title: 'Hide phone (P / Esc)', 'aria-label': 'Hide phone preview',
      onclick: (e) => { e.stopPropagation(); setPhoneOpen(false); },
    })
  );
  const resize = el('div', {
    class: 'pp-resize', title: 'Drag to resize phone preview',
    'aria-label': 'Resize phone preview', role: 'separator',
  }, el('span', { class: 'pp-resize-grip', text: '◢' }));
  const shell = el('div', { class: 'phone-preview hidden', id: 'phonePreview' },
    dragBar,
    el('div', { class: 'pp-device' },
      el('div', { class: 'pp-island' }),
      el('div', { class: 'pp-notch-slot' }),
      screen,
      el('div', { class: 'pp-home' }),
      resize
    ),
    el('div', { class: 'pp-meta', id: 'ppMeta', text: '6.3"' })
  );

  (document.getElementById('app') || document.body).append(shell);

  S.phoneEls = { shell, screen, v1, i1, v2, i2, overlay: overlayLayer, text: textLayer, wm: wmLayer, empty, time, dragBar, resize, guides: phoneGuides };
  S.phoneSelBox = phoneSelBox;
  bindPhoneDrag(shell, dragBar);
  bindPhoneResize(shell, resize);
  bindSelBox(phoneSelBox, () => S.phoneEls?.screen);
  v1.addEventListener('loadedmetadata', () => syncPhonePreview(true));
  v2.addEventListener('loadedmetadata', () => syncPhonePreview(true));
  return S.phoneEls;
}

/** Load persisted user scale for the phone preview. */
function loadPhoneScale() {
  try {
    const n = Number(localStorage.getItem('rw_phone_scale'));
    if (Number.isFinite(n) && n >= 0.4 && n <= 2.5) S.phoneUserScale = n;
  } catch { /* */ }
}

function savePhoneScale() {
  try { localStorage.setItem('rw_phone_scale', String(S.phoneUserScale)); } catch { /* */ }
}

/** Drag corner grip → scale the 6.3" preview (aspect locked 9:16). */
function bindPhoneResize(shell, handle) {
  if (!handle) return;
  let resizing = false;
  let pid = null;
  let startW = 0;
  let startClientX = 0;

  const onDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    resizing = true;
    pid = e.pointerId;
    const r = S.phoneEls?.screen?.getBoundingClientRect() || shell.getBoundingClientRect();
    startW = r.width || 300;
    startClientX = e.clientX;
    shell.classList.add('resizing');
    try { handle.setPointerCapture(e.pointerId); } catch { /* */ }
    e.preventDefault();
    e.stopPropagation();
  };
  const onMove = (e) => {
    if (!resizing || (pid != null && e.pointerId !== pid)) return;
    const base = phoneScreenSize();
    const dx = e.clientX - startClientX;
    const nextW = Math.max(140, Math.min(Math.round(startW + dx), Math.round(base.w * 2.4)));
    // Map desired pixel width → userScale relative to natural 6.3" @ 96dpi
    S.phoneUserScale = Math.max(0.4, Math.min(2.5, nextW / base.w));
    sizePhonePreview();
    renderPhoneText();
    applyPhonePos();
  };
  const onUp = () => {
    if (!resizing) return;
    resizing = false;
    pid = null;
    shell.classList.remove('resizing');
    savePhoneScale();
    applyPhonePos();
  };

  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

function bindPhoneDrag(shell, handle) {
  let dragging = false;
  let ox = 0;
  let oy = 0;
  let pid = null;

  const onDown = (e) => {
    if (e.target.closest('button, a, input, select, textarea, .pp-resize, .sel-box')) return;
    if (e.button != null && e.button !== 0) return;
    dragging = true;
    pid = e.pointerId;
    const r = shell.getBoundingClientRect();
    ox = e.clientX - r.left;
    oy = e.clientY - r.top;
    shell.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch { /* */ }
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging || (pid != null && e.pointerId !== pid)) return;
    setPhonePos(e.clientX - ox, e.clientY - oy, { save: false });
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    pid = null;
    shell.classList.remove('dragging');
    try { localStorage.setItem('rw_phone_pos', JSON.stringify(S.phonePos || {})); } catch { /* */ }
  };

  // Drag from bar OR device bezel (not from the glass — keeps video easy to watch)
  for (const n of [handle, shell.querySelector('.pp-device')]) {
    if (!n) continue;
    n.addEventListener('pointerdown', onDown);
    n.addEventListener('pointermove', onMove);
    n.addEventListener('pointerup', onUp);
    n.addEventListener('pointercancel', onUp);
  }
}

function setPhonePos(x, y, { save = true } = {}) {
  const shell = S.phoneEls?.shell;
  if (!shell) return;
  const w = shell.offsetWidth || 320;
  const h = shell.offsetHeight || 580;
  const maxX = Math.max(4, window.innerWidth - w - 4);
  const maxY = Math.max(4, window.innerHeight - h - 4);
  const nx = Math.round(Math.max(4, Math.min(x, maxX)));
  const ny = Math.round(Math.max(4, Math.min(y, maxY)));
  S.phonePos = { x: nx, y: ny };
  shell.style.left = `${nx}px`;
  shell.style.top = `${ny}px`;
  shell.style.right = 'auto';
  shell.style.bottom = 'auto';
  if (save) {
    try { localStorage.setItem('rw_phone_pos', JSON.stringify(S.phonePos)); } catch { /* */ }
  }
}

function defaultPhonePos() {
  // Prefer over the main preview so you see canvas + phone together
  const stage = document.querySelector('.preview-center') || document.querySelector('.preview-main') || document.body;
  const r = stage.getBoundingClientRect();
  const { w, h } = phoneScreenSize();
  const shellW = w + 36;
  const shellH = h + 72;
  let x = r.right - shellW - 18;
  let y = r.bottom - shellH - 18;
  if (x < 8) x = Math.max(8, window.innerWidth - shellW - 18);
  if (y < 48) y = Math.max(48, window.innerHeight - shellH - 18);
  return { x, y };
}

function applyPhonePos() {
  let pos = S.phonePos;
  if (!pos) {
    try { pos = JSON.parse(localStorage.getItem('rw_phone_pos') || 'null'); } catch { pos = null; }
  }
  if (!pos || typeof pos.x !== 'number') pos = defaultPhonePos();
  setPhonePos(pos.x, pos.y, { save: false });
}

function sizePhonePreview() {
  const pe = S.phoneEls;
  if (!pe || !S.phoneOpen) return;
  const { w, h } = phoneScreenSize();
  // Fit device chrome into the viewport, then apply the user's resize multiplier
  const chromeX = 36;
  const chromeY = 72;
  const availW = Math.max(180, window.innerWidth - 48);
  const availH = Math.max(220, window.innerHeight - 56);
  const maxFit = Math.min((availW - chromeX) / w, (availH - chromeY) / h);
  const user = Math.max(0.4, Math.min(2.5, S.phoneUserScale || 1));
  // Allow growth up to viewport; never exceed available space
  const scale = Math.min(Math.max(user, 0.4), Math.max(0.4, maxFit));
  let sw = Math.max(140, Math.round(w * scale));
  let sh = Math.round(sw * (16 / 9));
  if (sh > availH - chromeY) {
    const k = (availH - chromeY) / sh;
    sw = Math.max(140, Math.round(sw * k));
    sh = Math.round(sw * (16 / 9));
  }
  if (sw > availW - chromeX) {
    const k = (availW - chromeX) / sw;
    sw = Math.max(140, Math.round(sw * k));
    sh = Math.round(sw * (16 / 9));
  }
  pe.screen.style.width = `${sw}px`;
  pe.screen.style.height = `${sh}px`;
  const meta = document.getElementById('ppMeta');
  if (meta) {
    const pct = Math.round((sw / w) * 100);
    const sizeIn = (PHONE_DIAG_IN * (sw / w)).toFixed(1);
    meta.textContent = `6.3" base · ${sizeIn}" @ ${pct}%`;
  }
  // Keep on-screen after resize
  if (S.phonePos) setPhonePos(S.phonePos.x, S.phonePos.y, { save: false });
  updateSelBox();
}

function togglePhonePreview() {
  setPhoneOpen(!S.phoneOpen);
}

/** Mirror canvas media onto the phone screen (volume forced to 0). */
function syncPhonePreview(force = false) {
  const pe = S.phoneEls;
  if (!pe || !S.phoneOpen || !S.timeline) return;
  void force;
  const t = S.playhead;
  const split = isSplitLayout(S.timeline);

  const main = S.previewFrame;
  if (main) {
    const mode = ([...main.classList].find((c) => c.startsWith('layout-')) || 'layout-none');
    if (!pe.screen.classList.contains(mode)) {
      pe.screen.classList.remove('layout-none', 'layout-split-h', 'layout-split-v');
      pe.screen.classList.add(mode);
    }
  }

  const v1 = clipOnTrack('v1', t);
  const v3 = split ? clipOnTrack('v3', t) : null;

  if (split) {
    pe.v2.classList.remove('hidden');
    pe.i2.classList.remove('hidden');
    syncPane(v1, pe.v1, pe.i1, { volume: 0, play: S.playing });
    syncPane(v3, pe.v2, pe.i2, { volume: 0, play: S.playing });
    pe.v2.muted = true;
    pe.v1.muted = true;
    if (!v1 && !v3) {
      pe.v1.pause(); pe.v2.pause();
    }
  } else {
    pe.v2.pause();
    pe.v2.style.visibility = 'hidden';
    pe.i2.classList.add('hidden');
    pe.v2.classList.add('hidden');
    pe.i2.classList.add('hidden');
    if (!v1) {
      pe.v1.style.visibility = 'hidden';
      pe.v1.pause();
      pe.i1.classList.add('hidden');
      syncPane(null, pe.v1, pe.i1, { volume: 0, play: false });
    } else {
      syncPane(v1, pe.v1, pe.i1, { volume: 0, play: S.playing });
      pe.v1.muted = true;
    }
  }

  const hasMedia = !!(v1 || v3);
  pe.empty.classList.toggle('hidden', hasMedia);
  pe.time.textContent = fmtDuration(S.playhead);
}

function renderPhoneText() {
  const pe = S.phoneEls;
  if (!pe || !S.phoneOpen || !pe.text || !pe.screen) return;
  const pw = pe.screen.clientWidth || 297;
  const ph = pe.screen.clientHeight || Math.round(pw * 16 / 9);
  renderTextLayer(pe.text, pw, ph);
  if (pe.wm) renderWatermarkLayer(pe.wm, pw, ph);
  updateSelBox();
}

/** Auto-select first timeline clip so Clip Tools are never empty on open. */
function autoSelectClip() {
  if (S.selection) return;
  for (const tid of ['v1', 'v3', 'v2', 't1', 't2', 'a1', 'a2', 'a3']) {
    try {
      const tr = getTrack(S.timeline, tid);
      const c = (tr.clips || [])[0];
      if (c) {
        selectOnly(tid, c.id);
        // put playhead inside first clip so preview shows it
        if (S.playhead < c.start || S.playhead >= clipEnd(c)) S.playhead = c.start + Math.min(0.05, c.duration / 2);
        return;
      }
    } catch { /* skip */ }
  }
}

/** Overlay chips: what’s live on the canvas right now. */
function updatePreviewBadges() {
  const box = S.previewBadges || document.getElementById('previewBadges');
  if (!box || !S.timeline) return;
  const t = S.playhead;
  const chips = [];
  const mode = getLayoutMode(S.timeline);
  if (mode !== 'none') chips.push({ cls: '', label: mode === 'split-h' ? 'Split L|R' : 'Split T|B' });

  for (const { clip } of activeClips(S.timeline, t)) {
    if (clip.kind === 'video' || clip.kind === 'image') {
      const tr = normalizeTransform(clip);
      const ef = normalizeEffect(clip.effect);
      if (ef && ef !== 'none') chips.push({ cls: 'fx', label: ef === 'bw' ? 'B&W' : ef });
      if (tr.fit === 'contain') chips.push({ cls: 'fx', label: 'Contain' });
      if (tr.fit === 'fill') chips.push({ cls: 'fx', label: 'Fill' });
      if (Math.abs(tr.scale - 1) > 0.01) chips.push({ cls: 'fx', label: `${tr.scale.toFixed(2)}× zoom` });
    }
    if (clip.kind === 'text') {
      const s = clip.text || {};
      const bm = normalizeBgMode(s.bgMode || (s.bg ? 'inline' : 'none'));
      if (bm === 'full') chips.push({ cls: 'txt', label: 'Top banner' });
      else if (bm === 'inline') chips.push({ cls: 'txt', label: 'Text box' });
      if (normalizeTextAnim(s.anim) !== 'none') chips.push({ cls: 'txt', label: `Anim:${s.anim}` });
      if (Number(s.strokeWidth) > 0) chips.push({ cls: 'txt', label: 'Outline' });
    }
  }
  // selected clip look (even if playhead outside — show intent)
  if (S.selection) {
    try {
      const { clip } = getClip(S.timeline, S.selection.trackId, S.selection.clipId);
      if (clip && (clip.kind === 'video' || clip.kind === 'image')) {
        const ef = normalizeEffect(clip.effect);
        if (ef && ef !== 'none' && !chips.some((c) => c.label === (ef === 'bw' ? 'B&W' : ef))) {
          chips.push({ cls: 'fx', label: `${ef === 'bw' ? 'B&W' : ef} (clip)` });
        }
      }
    } catch { /* */ }
  }

  box.innerHTML = '';
  for (const c of chips.slice(0, 8)) {
    box.append(el('span', { class: `p-badge ${c.cls}`, text: c.label }));
  }

  // empty overlay when no media under playhead
  const empty = S.previewEmpty || document.getElementById('previewEmpty');
  if (empty) {
    const hasMedia = activeClips(S.timeline, t, ['video', 'image']).length > 0;
    empty.classList.toggle('hidden', hasMedia);
  }
}

/** Gold ring flash so users see an edit landed on the canvas. */
function flashPreview() {
  const f = S.previewFrame || document.querySelector('.preview-frame');
  if (!f) return;
  f.classList.remove('flash-ok');
  // reflow
  void f.offsetWidth;
  f.classList.add('flash-ok');
  setTimeout(() => f.classList.remove('flash-ok'), 600);
}

/* ================= canvas direct manipulation (move / resize) ================= */

function getSelClip() {
  if (!S.selection || !S.timeline) return null;
  try {
    return getClip(S.timeline, S.selection.trackId, S.selection.clipId);
  } catch { return null; }
}

/** Geometry of one clip (by pick) in frame-local %. `frame` is the container to measure against. */
function clipGeometry(pick, frame = S.previewFrame) {
  if (!pick || !S.timeline || !frame) return null;
  let found;
  try { found = getClip(S.timeline, pick.trackId, pick.clipId); } catch { return null; }
  if (!found) return null;
  const { track, clip } = found;
  const atPlay = S.playhead >= clip.start - 1e-6 && S.playhead < clipEnd(clip) - 1e-6;

  if (clip.kind === 'text') {
    const layer = frame.querySelector('.text-layer');
    const node = layer?.querySelector(`[data-clip="${clip.id}"]`);
    const s = clip.text || {};
    if (node) {
      const fr = frame.getBoundingClientRect();
      const nr = node.getBoundingClientRect();
      if (fr.width > 0 && fr.height > 0) {
        return {
          kind: 'text', track, clip, pick, atPlay,
          x: ((nr.left - fr.left) / fr.width) * 100,
          y: ((nr.top - fr.top) / fr.height) * 100,
          w: (nr.width / fr.width) * 100,
          h: (nr.height / fr.height) * 100,
          label: 'Text / banner',
        };
      }
    }
    const presets = { top: { x: 50, y: 14 }, center: { x: 50, y: 50 }, bottom: { x: 50, y: 80 } };
    const p = presets[s.position] || presets.center;
    const x = s.position === 'custom' ? (s.xPct ?? 50) : p.x;
    const y = s.position === 'custom' ? (s.yPct ?? 50) : p.y;
    const w = Math.min(100, Number(s.widthPct) || 100);
    return {
      kind: 'text', track, clip, pick, atPlay,
      x: x - w / 2, y: y - 6, w, h: 12,
      label: 'Text / banner',
    };
  }

  if (clip.kind === 'video' || clip.kind === 'image') {
    const isFull = track.id === 'v1' || isSplitLayout(S.timeline);
    if (isFull) {
      if (isSplitLayout(S.timeline)) {
        const panes = splitPanes(
          S.timeline.width || 1080,
          S.timeline.height || 1920,
          getLayoutMode(S.timeline),
        );
        const pane = track.id === 'v1' ? panes?.[0] : panes?.[1];
        if (pane) {
          return {
            kind: 'media', track, clip, pick, atPlay, full: true,
            x: (pane.x / (S.timeline.width || 1080)) * 100,
            y: (pane.y / (S.timeline.height || 1920)) * 100,
            w: (pane.w / (S.timeline.width || 1080)) * 100,
            h: (pane.h / (S.timeline.height || 1920)) * 100,
            label: track.id === 'v1' ? 'Video A (pane)' : 'Video B (pane)',
          };
        }
      }
      return {
        kind: 'media', track, clip, pick, atPlay, full: true,
        x: 0, y: 0, w: 100, h: 100,
        label: 'Full frame video',
      };
    }
    const ov = clip.overlay || { xPct: 50, yPct: 50, widthPct: 35 };
    const w = Math.max(5, Number(ov.widthPct) || 35);
    let hPct = (w * 9 / 16) * ((S.timeline.width || 1080) / (S.timeline.height || 1920));
    if (clip.kind === 'image') hPct = w * 0.5625 * ((S.timeline.width || 1080) / (S.timeline.height || 1920));
    return {
      kind: 'overlay', track, clip, pick, atPlay,
      x: (Number(ov.xPct) || 50) - w / 2,
      y: (Number(ov.yPct) || 50) - hPct / 2,
      w, h: hPct,
      label: clip.kind === 'image' ? 'Overlay image' : 'Overlay video',
    };
  }
  return null;
}

/** Geometry of selection (union when multi) in frame-local %. */
function selBoxGeometry(frame = S.previewFrame) {
  const picks = selectedPicks();
  if (!picks.length) return null;
  const live = [];
  for (const p of picks) {
    const g = clipGeometry(p, frame);
    if (g && g.atPlay) live.push(g);
  }
  if (!live.length) return null;
  if (live.length === 1) {
    const g = live[0];
    g.multi = false;
    g.count = 1;
    return g;
  }
  const x = Math.min(...live.map((g) => g.x));
  const y = Math.min(...live.map((g) => g.y));
  const r = Math.max(...live.map((g) => g.x + g.w));
  const b = Math.max(...live.map((g) => g.y + g.h));
  return {
    kind: 'multi', multi: true, count: live.length, atPlay: true,
    x, y, w: r - x, h: b - y,
    geoms: live,
    track: live[0].track, clip: live[0].clip, pick: live[0].pick,
    label: `${live.length} clips`,
  };
}

function snapGuideRoots() {
  const roots = [];
  const main = S.snapGuides || document.getElementById('snapGuides');
  if (main) roots.push(main);
  if (S.phoneOpen && S.phoneEls?.guides) roots.push(S.phoneEls.guides);
  return roots;
}

function updateSelBox() {
  const boxes = [];
  const mainBox = S.selBox || document.getElementById('selBox');
  if (mainBox) boxes.push([mainBox, S.previewFrame]);
  const phoneBox = S.phoneSelBox || document.getElementById('phoneSelBox');
  if (phoneBox) {
    if (S.phoneOpen && S.phoneEls?.screen) boxes.push([phoneBox, S.phoneEls.screen]);
    else {
      phoneBox.classList.remove('on');
      phoneBox.style.display = 'none';
    }
  }
  if (!boxes.length) return;

  let anyGeom = false;
  for (const [box, frame] of boxes) {
    if (!box || !frame || !S.timeline) continue;
    const g = selBoxGeometry(frame);
    if (!g || !g.atPlay) {
      box.classList.remove('on');
      box.style.display = 'none';
      continue;
    }
    anyGeom = true;
    box.style.display = '';
    box.classList.add('on');
    box.classList.toggle('multi', !!g.multi);
    box.style.left = `${g.x}%`;
    box.style.top = `${g.y}%`;
    box.style.width = `${g.w}%`;
    box.style.height = `${g.h}%`;
    const lab = box.querySelector('.sh-label');
    if (lab && !S.drag) lab.textContent = g.label;
    // Multi / full-frame media: hide edge handles that don't apply
    const full = g.kind === 'media' && g.full;
    const multi = !!g.multi;
    box.querySelectorAll('.sh').forEach((h) => {
      const k = h.dataset.h;
      if (multi || (full && (k === 'n' || k === 's'))) h.style.display = 'none';
      else h.style.display = '';
    });
  }
  if (!anyGeom) hideSnapGuides();
}

/** Show/hide center snap guides (axis: 'x' | 'y' | null). */
function showSnapGuide(axis, pct) {
  const roots = snapGuideRoots();
  if (!roots.length) return;
  for (const root of roots) {
    root.classList.remove('hidden');
    const v = root.querySelector('.sg-v');
    const h = root.querySelector('.sg-h');
    if (v) {
      v.style.display = axis === 'x' ? '' : 'none';
      if (axis === 'x') v.style.left = `${pct}%`;
    }
    if (h) {
      h.style.display = axis === 'y' ? '' : 'none';
      if (axis === 'y') h.style.top = `${pct}%`;
    }
  }
}

function hideSnapGuides() {
  for (const root of snapGuideRoots()) {
    root.classList.add('hidden');
    const v = root.querySelector('.sg-v');
    const h = root.querySelector('.sg-h');
    if (v) v.style.display = 'none';
    if (h) h.style.display = 'none';
  }
}

/** Snap x/y while dragging (Alt disables). Returns {x,y,gx,gy}. */
function snapMove(x, y, ev) {
  const off = ev && ev.altKey;
  const sx = snapPct(x, { disabled: off });
  const sy = snapPct(y, { disabled: off });
  if (sx.snapped != null) showSnapGuide('x', sx.snapped);
  else if (sy.snapped != null) showSnapGuide('y', sy.snapped);
  else hideSnapGuides();
  if (sx.snapped != null && sy.snapped != null) {
    // both — show both by stacking: prefer horizontal center when both
    for (const root of snapGuideRoots()) {
      root.classList.remove('hidden');
      const v = root.querySelector('.sg-v');
      const h = root.querySelector('.sg-h');
      if (v) { v.style.display = ''; v.style.left = `${sx.snapped}%`; }
      if (h) { h.style.display = ''; h.style.top = `${sy.snapped}%`; }
    }
  }
  return { x: sx.value, y: sy.value, gx: sx.snapped, gy: sy.snapped };
}

/** Live dimension label while dragging. */
function dragLabelText(d, mut) {
  if (d.kind === 'text' || d.kind === 'multi-text') {
    if (mut.size != null) return `Size ${Math.round(mut.size)}px`;
    if (mut.widthPct != null && mut.padY == null) return `Width ${Math.round(mut.widthPct)}%`;
    if (mut.padY != null) return `PadY ${Math.round(mut.padY)}`;
    if (mut.xPct != null) return `X ${Math.round(mut.xPct)}% · Y ${Math.round(mut.yPct)}%`;
  }
  if (d.kind === 'overlay') {
    if (mut.widthPct != null) return `Width ${Math.round(mut.widthPct)}%`;
    if (mut.xPct != null) return `X ${Math.round(mut.xPct)}% · Y ${Math.round(mut.yPct)}%`;
  }
  if (d.kind === 'media') {
    if (mut.scale != null) return `${mut.scale.toFixed(2)}× zoom`;
    if (mut.posX != null) return `Focus ${Math.round(mut.posX)}% · ${Math.round(mut.posY)}%`;
  }
  return null;
}

/** Bind pointer drag on selection box (move body / resize via handles). Touch-friendly.
 *  `getFrame` returns the container to measure against (main preview or phone screen). */
function bindSelBox(box, getFrame = () => S.previewFrame) {
  box.style.touchAction = 'none';
  const onDown = (e) => {
    const frame = getFrame();
    const g = selBoxGeometry(frame);
    if (!g || !g.atPlay) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.target.dataset?.h || null;
    if (g.multi && handle) {
      toast('Multi-select: drag body to move · resize one clip at a time', true);
      return;
    }
    const fr = frame.getBoundingClientRect();
    const snap = cloneTimeline(S.timeline);
    const start = {
      xPct: null, yPct: null, size: null, padX: null, padY: null, widthPct: null,
      ox: null, oy: null, ow: null,
      posX: null, posY: null, scale: null,
      group: null,
    };
    const clip = g.clip;
    const s = clip.text || {};

    if (g.multi && !handle) {
      // snapshot start positions for every live geom
      start.group = (g.geoms || []).map((sub) => {
        const sc = sub.clip;
        const ss = sc.text || {};
        if (sub.kind === 'text') {
          const presets = { top: { x: 50, y: 14 }, center: { x: 50, y: 50 }, bottom: { x: 50, y: 80 } };
          const p = presets[ss.position] || presets.center;
          return {
            kind: 'text',
            pick: sub.pick,
            xPct: ss.position === 'custom' ? (ss.xPct ?? 50) : p.x,
            yPct: ss.position === 'custom' ? (ss.yPct ?? 50) : p.y,
          };
        }
        if (sub.kind === 'overlay') {
          const ov = sc.overlay || { xPct: 50, yPct: 50 };
          return { kind: 'overlay', pick: sub.pick, ox: Number(ov.xPct) || 50, oy: Number(ov.yPct) || 50 };
        }
        const tr = normalizeTransform(sc);
        return { kind: 'media', pick: sub.pick, posX: tr.posX, posY: tr.posY };
      });
      start.xPct = g.x + g.w / 2;
      start.yPct = g.y + g.h / 2;
      start.rect = { x: g.x, y: g.y, w: g.w, h: g.h };
    } else if (g.kind === 'text') {
      const presets = { top: { x: 50, y: 14 }, center: { x: 50, y: 50 }, bottom: { x: 50, y: 80 } };
      const p = presets[s.position] || presets.center;
      start.xPct = s.position === 'custom' ? (s.xPct ?? 50) : p.x;
      start.yPct = s.position === 'custom' ? (s.yPct ?? 50) : p.y;
      start.size = Number(s.size) || 72;
      start.padX = Number(s.padX) ?? (s.bgMode === 'full' ? 40 : 14);
      start.padY = Number(s.padY) ?? (s.bgMode === 'full' ? 22 : 10);
      start.widthPct = Number(s.widthPct) || 100;
      start.rect = { x: g.x, y: g.y, w: g.w, h: g.h };
    } else if (g.kind === 'overlay') {
      const ov = clip.overlay || { xPct: 50, yPct: 50, widthPct: 35 };
      start.ox = Number(ov.xPct) || 50;
      start.oy = Number(ov.yPct) || 50;
      start.ow = Number(ov.widthPct) || 35;
      start.rect = { x: g.x, y: g.y, w: g.w, h: g.h };
    } else {
      const tr = normalizeTransform(clip);
      start.posX = tr.posX;
      start.posY = tr.posY;
      start.scale = tr.scale;
      start.rect = { x: g.x, y: g.y, w: g.w, h: g.h };
      start.fit = tr.fit;
    }

    S.drag = {
      handle, startX: e.clientX, startY: e.clientY, start, snap, g,
      frW: fr.width, frH: fr.height, kind: g.kind, multi: !!g.multi,
    };
    box.classList.add('dragging');
    try { box.setPointerCapture?.(e.pointerId); } catch { /* */ }

    const lab = box.querySelector('.sh-label');

    const onMove = (ev) => {
      const d = S.drag;
      if (!d) return;
      const dxPct = ((ev.clientX - d.startX) / d.frW) * 100;
      const dyPct = ((ev.clientY - d.startY) / d.frH) * 100;
      const st = d.start;
      const h = d.handle;
      try {
        if (d.multi && !h) {
          // group move: snap primary center, apply same delta to all
          const primary = snapMove(st.xPct + dxPct, st.yPct + dyPct, ev);
          const adx = primary.x - st.xPct;
          const ady = primary.y - st.yPct;
          for (const item of st.group || []) {
            if (item.kind === 'text') {
              setClipProps(S.timeline, item.pick.trackId, item.pick.clipId, {
                text: { position: 'custom', xPct: clampPct(item.xPct + adx), yPct: clampPct(item.yPct + ady) },
              });
            } else if (item.kind === 'overlay') {
              setClipProps(S.timeline, item.pick.trackId, item.pick.clipId, {
                overlay: { xPct: clampPct(item.ox + adx), yPct: clampPct(item.oy + ady) },
              });
            } else {
              setClipProps(S.timeline, item.pick.trackId, item.pick.clipId, {
                posX: clampPct(item.posX + adx), posY: clampPct(item.posY + ady),
              });
            }
          }
          if (lab) d.lastLabel = `Move ${st.group.length} · X ${Math.round(primary.x)}% · Y ${Math.round(primary.y)}%`;
        } else if (d.kind === 'text') {
          const mut = {};
          if (!h) {
            const sn = snapMove(st.xPct + dxPct, st.yPct + dyPct, ev);
            mut.position = 'custom';
            mut.xPct = sn.x;
            mut.yPct = sn.y;
          } else {
            const isX = h.includes('e') || h.includes('w');
            if (h === 'n' || h === 's') {
              mut.padY = Math.max(0, Math.min(160, st.padY + (h === 's' ? dyPct : -dyPct) * 2));
              mut.position = 'custom';
              mut.xPct = st.xPct;
              mut.yPct = clampPct(st.yPct + dyPct * (h === 's' ? 1 : 1));
            } else if (h === 'e' || h === 'w') {
              let w = st.widthPct + (h === 'e' ? dxPct : -dxPct);
              const sw = snapPct(w, { candidates: [10, 50, 100], threshold: 1.5, disabled: ev.altKey });
              w = sw.value;
              mut.widthPct = Math.max(10, Math.min(100, w));
              mut.position = 'custom';
              mut.xPct = clampPct(st.xPct + (h === 'e' ? dxPct / 2 : -dxPct / 2));
              mut.yPct = st.yPct;
              if (sw.snapped != null) showSnapGuide('x', 50); // visual cue while width-snapping
            } else {
              const factor = 1 + dxPct / 80;
              mut.size = Math.max(12, Math.min(480, Math.round(st.size * factor)));
              mut.position = 'custom';
              mut.xPct = clampPct(st.xPct + dxPct / 4);
              mut.yPct = clampPct(st.yPct + dyPct / 4);
              if (isX) mut.widthPct = Math.max(10, Math.min(100, st.widthPct + dxPct * 0.5));
            }
            hideSnapGuides();
          }
          setClipProps(S.timeline, d.g.track.id, d.g.clip.id, { text: mut });
          d.lastLabel = dragLabelText(d, mut) || d.g.label;
        } else if (d.kind === 'overlay') {
          const mut = {};
          if (!h) {
            const sn = snapMove(st.ox + dxPct, st.oy + dyPct, ev);
            mut.xPct = sn.x;
            mut.yPct = sn.y;
          } else {
            let w = st.ow;
            if (h.includes('e')) w = st.ow + dxPct;
            if (h.includes('w')) w = st.ow - dxPct;
            const sw = snapPct(w, { candidates: [5, 25, 50, 100], threshold: 1.5, disabled: ev.altKey });
            mut.widthPct = Math.max(5, Math.min(100, sw.value));
            if (h.includes('n') || h.includes('s')) mut.yPct = clampPct(st.oy + dyPct);
            if (h.includes('e') || h.includes('w')) mut.xPct = st.ox;
            if (h === 'e' || h === 'w') mut.yPct = st.oy;
            if (h === 'n' || h === 's') mut.xPct = st.ox;
            if (h.length === 2) {
              mut.xPct = st.ox;
              mut.yPct = clampPct(st.oy + dyPct * 0.5);
            }
            hideSnapGuides();
          }
          setClipProps(S.timeline, d.g.track.id, d.g.clip.id, { overlay: mut });
          d.lastLabel = dragLabelText(d, mut) || d.g.label;
        } else {
          const mut = {};
          if (!h) {
            const sn = snapMove(st.posX + dxPct, st.posY + dyPct, ev);
            mut.posX = sn.x;
            mut.posY = sn.y;
          } else {
            const factor = 1 + dxPct / 80;
            mut.scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, st.scale * factor));
            if (h === 'n') mut.posY = clampPct(st.posY - dyPct);
            if (h === 's') mut.posY = clampPct(st.posY + dyPct);
            if (h === 'w') mut.posX = clampPct(st.posX - dxPct);
            if (h === 'e') mut.posX = clampPct(st.posX + dxPct);
            if (h.length === 2) {
              mut.posX = clampPct(st.posX + dxPct * 0.35);
              mut.posY = clampPct(st.posY + dyPct * 0.35);
            }
            hideSnapGuides();
          }
          setClipProps(S.timeline, d.g.track.id, d.g.clip.id, mut);
          d.lastLabel = dragLabelText(d, mut) || d.g.label;
        }
        renderTimeline();
        updatePreviewText(true);
        syncMedia(true);
        updatePreviewBadges();
        updateSelBox();
        if (lab && d.lastLabel) lab.textContent = d.lastLabel;
      } catch { /* ignore mid-drag invalid */ }
    };

    const finish = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      box.classList.remove('dragging');
      hideSnapGuides();
      try {
        commit(snap);
        renderInspector();
        updateFooter();
        flashPreview();
      } catch (err) { toast(err.message, true); }
      S.drag = null;
      updateSelBox();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };
  box.addEventListener('pointerdown', onDown);
}

function clampPct(n) {
  return Math.max(0, Math.min(100, Number(n) || 0));
}

/** Nudge selected clip(s) on canvas via Alt+Arrows. step in percent. */
function nudgeSelection(key, step = 1) {
  const picks = selectedPicks();
  if (!picks.length) { toast('Select a clip first', true); return; }
  const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
  const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
  if (!dx && !dy) return;
  try {
    const snap = cloneTimeline(S.timeline);
    for (const p of picks) {
      let found;
      try { found = getClip(S.timeline, p.trackId, p.clipId); } catch { continue; }
      if (!found) continue;
      const { track, clip } = found;
      if (clip.kind === 'text') {
        const ss = clip.text || {};
        const presets = { top: { x: 50, y: 14 }, center: { x: 50, y: 50 }, bottom: { x: 50, y: 80 } };
        const pr = presets[ss.position] || presets.center;
        const x = ss.position === 'custom' ? (ss.xPct ?? 50) : pr.x;
        const y = ss.position === 'custom' ? (ss.yPct ?? 50) : pr.y;
        setClipProps(S.timeline, track.id, clip.id, {
          text: { position: 'custom', xPct: clampPct(x + dx), yPct: clampPct(y + dy) },
        });
      } else if (clip.kind === 'video' || clip.kind === 'image') {
        const isFull = track.id === 'v1' || isSplitLayout(S.timeline);
        if (isFull) {
          const tr = normalizeTransform(clip);
          setClipProps(S.timeline, track.id, clip.id, {
            posX: clampPct(tr.posX + dx), posY: clampPct(tr.posY + dy),
          });
        } else {
          const ov = clip.overlay || { xPct: 50, yPct: 50 };
          setClipProps(S.timeline, track.id, clip.id, {
            overlay: { xPct: clampPct((Number(ov.xPct) || 50) + dx), yPct: clampPct((Number(ov.yPct) || 50) + dy) },
          });
        }
      }
    }
    commit(snap);
    renderTimeline();
    renderInspector();
    updateFooter();
    updatePreviewText(true);
    syncMedia(true);
    updatePreviewBadges();
    updateSelBox();
    flashPreview();
  } catch (e) { toast(e.message, true); }
}

/** CSS filter string matching server buildEffectFilter. */
function effectToCssFilter(effect) {
  switch (normalizeEffect(effect)) {
    case 'bw': return 'grayscale(1)';
    case 'sepia': return 'sepia(1)';
    case 'warm': return 'saturate(1.15) contrast(1.05) hue-rotate(-8deg)';
    case 'cool': return 'saturate(1.1) contrast(1.05) hue-rotate(12deg)';
    case 'vivid': return 'contrast(1.18) saturate(1.35)';
    case 'vintage': return 'contrast(0.92) saturate(0.78) brightness(1.04) sepia(0.12)';
    case 'teal': return 'contrast(1.08) saturate(1.1) hue-rotate(-12deg)';
    case 'golden': return 'contrast(1.06) saturate(1.12) sepia(0.18) brightness(1.03)';
    case 'noir': return 'grayscale(1) contrast(1.28) brightness(0.98)';
    case 'neon': return 'contrast(1.15) saturate(1.55) hue-rotate(8deg)';
    case 'luxury': return 'contrast(1.12) saturate(1.05) sepia(0.12) brightness(1.02)';
    case 'soft': return 'blur(1.35px)';
    default: return '';
  }
}

function syncPane(clip, videoEl, imgEl, { volume = 0, play = false, muted = false } = {}) {
  if (!videoEl || !imgEl) return;
  if (!clip) {
    videoEl.style.visibility = 'hidden';
    videoEl.pause?.();
    imgEl.classList.add('hidden');
    applyClipTransform(videoEl, null);
    applyClipTransform(imgEl, null);
    return;
  }
  const asset = S.media.find((m) => m.id === clip.assetId);
  const url = asset?.url;
  const localT = S.playhead - clip.start;
  const volKf = evalKeyframes(clip, localT, 'volume', volume);
  const envelope = fadeGain(clip, localT);
  const vol = muted ? 0 : Math.min(1, Math.max(0, volKf * envelope));
  if (clip.kind === 'image') {
    videoEl.pause?.();
    videoEl.style.visibility = 'hidden';
    if (imgEl.dataset.src !== url) { imgEl.src = url || ''; imgEl.dataset.src = url || ''; }
    imgEl.classList.remove('hidden');
    applyClipTransform(imgEl, clip);
    applyClipTransform(videoEl, null);
    return;
  }
  imgEl.classList.add('hidden');
  applyClipTransform(imgEl, null);
  videoEl.style.visibility = 'visible';
  applyClipTransform(videoEl, clip);
  const speed = clip.speed > 0 ? clip.speed : 1;
  const remapped = !!speedCurveOf(clip) || normalizeReverse(clip.reverse);
  const target = sourceTimeAt(clip, localT);
  const wantSrc = url ? `${url}` : '';
  if (videoEl.dataset.src !== wantSrc) {
    videoEl.src = wantSrc;
    videoEl.dataset.src = wantSrc;
    videoEl.addEventListener('loadedmetadata', () => {
      try { videoEl.playbackRate = remapped ? 1 : speed; videoEl.currentTime = target; } catch { /* */ }
    }, { once: true });
  } else {
    const rate = remapped ? 1 : speed;
    if (videoEl.playbackRate !== rate) {
      try { videoEl.playbackRate = rate; } catch { /* */ }
    }
    // Curved / reversed clips are stepped frame-by-frame from the playhead.
    if (Math.abs(videoEl.currentTime - target) > (remapped ? 0.02 : 0.18)) {
      try { videoEl.currentTime = target; } catch { /* ignore */ }
    }
  }
  videoEl.volume = vol;
  if (play && !remapped) videoEl.play?.().catch(() => {});
  else videoEl.pause?.();
}

/* ================= timeline rendering ================= */

function renderTimeline() {
  const scroll = document.getElementById('tlScroll');
  if (!scroll) return;
  const dur = timelineDuration(S.timeline);
  const width = Math.max(92 + (dur + 8) * S.pps, scroll.clientWidth || 800);
  const labelW = 92;

  const inner = el('div', { class: 'tl-inner', style: `width:${width}px` });

  // ruler
  const ruler = el('div', { class: 'tl-ruler', style: `width:${width}px` });
  const stepChoices = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60];
  let step = stepChoices.find((s) => s * S.pps >= 56) || 60;
  for (let t = 0; t <= dur + 8; t += step) {
    ruler.append(el('div', { class: 'tick', style: `left:${labelW + t * S.pps}px`, text: fmtRuler(t) }));
    if (step * S.pps > 80) {
      // minor ticks
      const minor = step / (step >= 1 ? 5 : 2);
      for (let m = t + minor; m < t + step - 1e-9; m += minor) {
        ruler.append(el('div', { class: 'tick minor', style: `left:${labelW + m * S.pps}px;`, text: '' }));
      }
    }
  }
  inner.append(ruler);

  // tracks
  for (const track of S.timeline.tracks) {
    const def = { v1: 'V1', v2: 'V2', v3: 'V3', a1: 'A1', a2: 'A2', a3: 'A3', t1: 'T1', t2: 'T2' }[track.id];
    const row = el('div', { class: `tl-track ${track.hidden ? 'hidden-track' : ''} ${track.locked ? 'locked-track' : ''}` });
    const lockBtn = el('button', { class: `tbtn ${track.locked ? 'on' : ''}`, text: '🔒', title: 'Lock — stop moves & trims on this track', 'aria-label': `Lock ${def} track`, 'aria-pressed': track.locked ? 'true' : 'false' });
    lockBtn.addEventListener('click', () => {
      setTrackProps(S.timeline, track.id, { locked: !track.locked });
      commit();
      renderTimeline();
    });
    const hideBtn = el('button', { class: `tbtn ${track.hidden ? 'on' : ''}`, text: '👁', title: 'Hide — remove this track from the preview', 'aria-label': `Hide ${def} track`, 'aria-pressed': track.hidden ? 'true' : 'false' });
    hideBtn.addEventListener('click', () => {
      setTrackProps(S.timeline, track.id, { hidden: !track.hidden });
      commit();
      renderTimeline();
      updatePreviewText(true);
      syncMedia(true);
    });
    const muteBtn = el('button', { class: `tbtn ${track.muted ? 'on' : ''}`, text: 'M', title: 'Mute — silence this audio track', 'aria-label': `Mute ${def} track`, 'aria-pressed': track.muted ? 'true' : 'false' });
    muteBtn.addEventListener('click', () => {
      setTrackProps(S.timeline, track.id, { muted: !track.muted });
      commit();
      renderTimeline();
      syncMedia(true);
    });
    const audioRole = { a1: 'Voice', a2: 'Music', a3: 'SFX' }[track.id] || 'Audio';
    const roleLabel = track.type === 'video'
      ? (track.id === 'v1' ? 'Video' : track.id === 'v2' ? 'Overlay' : 'Images')
      : track.type === 'audio'
        ? audioRole
        : (track.id === 't1' ? 'Text' : 'Captions');
    const trackHints = {
      v1: 'Main video — drag clips here',
      v2: 'Floating overlay images',
      v3: 'Second video / images (split layouts)',
      a1: 'Voice / narration',
      a2: 'Music',
      a3: 'Sound effects',
      t1: 'Titles and text',
      t2: 'Burned-in captions (exported to .srt)',
    };
    const label = el('div', { class: 'tl-label', title: trackHints[track.id] || track.id },
      el('span', { class: 'track-name', text: `${def} ${roleLabel}` }),
      ...(track.type === 'audio' ? [muteBtn] : []),
      hideBtn, lockBtn
    );
    const lane = el('div', { class: 'tl-lane', dataset: { track: track.id } });

    lane.addEventListener('dragover', (e) => { e.preventDefault(); lane.classList.add('dragover'); });
    lane.addEventListener('dragleave', () => lane.classList.remove('dragover'));
    lane.addEventListener('drop', (e) => {
      e.preventDefault();
      lane.classList.remove('dragover');
      const assetId = e.dataTransfer.getData('text/rw-asset');
      if (!assetId) return;
      const rect = lane.getBoundingClientRect();
      const t = Math.max(0, (e.clientX - rect.left) / S.pps);
      dropAsset(assetId, track.id, t);
    });
    lane.addEventListener('pointerdown', (e) => {
      if (e.target !== lane) return;
      const rect = lane.getBoundingClientRect();
      setPlayhead(Math.max(0, (e.clientX - rect.left) / S.pps));
      clearSelection();
      renderInspector();
      renderTimeline();
      updatePreviewBadges();
      updateSelBox();
    });

    for (const clip of track.clips) {
      lane.append(renderClip(track, clip));
    }
    row.append(label, lane);
    inner.append(row);
  }

  // markers
  const markers = Array.isArray(S.timeline.markers) ? S.timeline.markers : [];
  for (const mk of markers) {
    const x = labelW + mk.time * S.pps;
    const node = el('div', {
      class: 'tl-marker',
      title: `${mk.label || 'Marker'} @ ${mk.time.toFixed(2)}s (click to jump, dbl-click to remove)`,
      style: `left:${x}px;color:${mk.color || '#e8b44a'}`,
      text: '◆',
    });
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      setPlayhead(mk.time);
    });
    node.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      try {
        const snap = cloneTimeline(S.timeline);
        removeMarker(S.timeline, mk.id);
        commit(snap);
        renderTimeline();
        toast('Marker removed');
      } catch (err) { toast(err.message, true); }
    });
    inner.append(node);
    if (mk.label) {
      inner.append(el('div', {
        class: 'tl-marker-label',
        style: `left:${x + 6}px;color:${mk.color || '#e8b44a'}`,
        text: mk.label,
      }));
    }
  }

  // loop region
  if (S.loop) {
    inner.append(el('div', {
      class: 'tl-loop',
      style: `left:${labelW + S.loop.start * S.pps}px;width:${Math.max(2, (S.loop.end - S.loop.start) * S.pps)}px`,
    }));
  }

  // playhead
  inner.append(el('div', { class: 'tl-playhead', style: `left:${labelW + S.playhead * S.pps}px` }));

  scroll.innerHTML = '';
  scroll.append(inner);
  const durEl = document.getElementById('tlDur');
  if (durEl) {
    const loopTxt = S.loop ? ` · loop ${S.loop.start.toFixed(1)}–${S.loop.end.toFixed(1)}s` : '';
    const mkTxt = markers.length ? ` · ${markers.length} marker${markers.length > 1 ? 's' : ''}` : '';
    durEl.textContent = `${dur.toFixed(1)}s · ${S.timeline.width}×${S.timeline.height} · ${S.timeline.fps}fps${loopTxt}${mkTxt}`;
  }
}

function fmtRuler(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m > 0 ? `${m}:${String(Math.floor(s)).padStart(2, '0')}` : `${s % 1 === 0 ? s : s.toFixed(1)}`;
}

function drawWaveform(elWave, clip) {
  elWave.innerHTML = '';
  let h = 0;
  const seed = String(clip.id || 'x');
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const w = Math.max(40, Math.min(600, Math.round((clip.duration || 1) * 48)));
  const hgt = 24;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hgt;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.opacity = '0.7';
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, w, hgt);
    ctx.fillStyle = 'rgba(120,200,255,0.55)';
    const vol = Math.min(1.4, Number(clip.volume) > 0 ? Number(clip.volume) : 1);
    const bw = 2;
    const gap = 2;
    let x = 0;
    while (x < w) {
      h = (h * 1664525 + 1013904223) >>> 0;
      const amp = 0.2 + ((h >>> 16) % 1000) / 1000 * 0.8;
      const bh = Math.max(2, Math.min(hgt - 2, amp * vol * hgt * 0.9));
      ctx.fillRect(x, (hgt - bh) / 2, bw, bh);
      x += bw + gap;
    }
  }
  elWave.append(canvas);
}

function toggleLoop() {
  const dur = timelineDuration(S.timeline);
  if (dur < 0.5) { toast('Timeline too short to loop', true); return; }
  if (S.loop) {
    S.loop = null;
    toast('Loop off');
  } else {
    const end = Math.min(dur, S.playhead + Math.min(5, dur) || dur);
    const start = Math.max(0, Math.min(S.playhead, end - 0.5));
    S.loop = { start: round3(start), end: round3(end > start ? end : dur) };
    toast(`Loop ${S.loop.start.toFixed(1)}–${S.loop.end.toFixed(1)}s`);
  }
  renderTimeline();
}

function addMarkerAtPlayhead() {
  try {
    const snap = cloneTimeline(S.timeline);
    if (!Array.isArray(S.timeline.markers)) S.timeline.markers = [];
    const n = S.timeline.markers.length + 1;
    addMarker(S.timeline, { time: S.playhead, label: `M${n}`, color: '#e8b44a' });
    commit(snap);
    renderTimeline();
    toast(`Marker @ ${S.playhead.toFixed(2)}s`);
  } catch (e) { toast(e.message, true); }
}

function setClipSpeed(mult) {
  const found = (() => { try { return getClip(S.timeline, S.selection.trackId, S.selection.clipId); } catch { return null; } })();
  if (!found) return;
  const { track, clip } = found;
  if (clip.kind !== 'video' && clip.kind !== 'audio') { toast('Speed applies to video/audio clips', true); return; }
  try {
    const snap = cloneTimeline(S.timeline);
    const next = clampSpeed((Number(clip.speed) || 1) * mult);
    setClipProps(S.timeline, track.id, clip.id, { speed: next });
    commit(snap);
    renderTimeline(); renderInspector(); updateFooter();
    toast(`Speed ${next}×`);
  } catch (e) { toast(e.message, true); }
}

function renderClip(track, clip) {
  const sel = isSelectedClip(clip.id);
  const label = clip.kind === 'text' ? (clip.text?.content || 'Text').slice(0, 40) : labelForClip(clip);
  const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
  const speedBadge = speed !== 1 && (clip.kind === 'video' || clip.kind === 'audio')
    ? el('span', { class: 'speed-badge', text: `${speed}×` })
    : null;
  const featureBadges = [];
  if (clip.kind === 'video' || clip.kind === 'image') {
    const ef = normalizeEffect(clip.effect);
    if (ef && ef !== 'none') featureBadges.push(el('span', { class: 'speed-badge feat', title: 'Color effect', text: ef === 'bw' ? 'B&W' : ef }));
    const fit = normalizeTransform(clip).fit;
    if (fit === 'contain') featureBadges.push(el('span', { class: 'speed-badge feat', title: 'Fit mode', text: 'fit' }));
    if (Number(clip.scale) > 1 || Number(clip.scale) < 1) featureBadges.push(el('span', { class: 'speed-badge feat', title: 'Zoom', text: `${Number(clip.scale).toFixed(2)}×` }));
    if (!isDefaultGrade(clip.grade)) {
      featureBadges.push(el('span', {
        class: 'speed-badge feat grade', title: 'Color graded — open Clip Tools to adjust',
        text: 'grade',
      }));
    }
    const tr = normalizeTransition(clip.transitionIn);
    if (tr !== 'none') {
      featureBadges.push(el('span', {
        class: `speed-badge feat tr tr-${tr}`,
        title: `${tr} transition in (${normalizeTransitionDur(clip.transitionDur)}s) — change in Clip Tools`,
        text: tr === 'dip' ? 'dip' : tr,
      }));
    }
    const curve = speedCurveOf(clip);
    if (curve) {
      const flat = speedCurveConstant(curve);
      featureBadges.push(el('span', {
        class: 'speed-badge feat curve',
        title: flat ? `Constant speed curve ${flat}×` : `Speed curve "${curve.preset}" — edit in Clip Tools → Speed`,
        text: flat ? `${flat}×` : 'curve',
      }));
    }
    if (normalizeReverse(clip.reverse)) {
      featureBadges.push(el('span', { class: 'speed-badge feat rev', title: 'Playing in reverse — toggle in Clip Tools → Speed', text: 'rev' }));
    }
    if (normalizeChroma(clip.chroma)) {
      featureBadges.push(el('span', { class: 'speed-badge feat key', title: `Chroma key ${(clip.chroma.color || '#00ff00').toUpperCase()} — Clip Tools → Chroma`, text: 'key' }));
    }
    if (normalizeMask(clip.mask)) {
      featureBadges.push(el('span', { class: 'speed-badge feat mask', title: `Mask: ${normalizeMask(clip.mask).type} — Clip Tools → Mask`, text: 'mask' }));
    }
  }
  if (clip.kind === 'audio') {
    if (normalizeReverse(clip.reverse)) {
      featureBadges.push(el('span', { class: 'speed-badge feat rev', title: 'Audio reversed', text: 'rev' }));
    }
    const curve = speedCurveOf(clip);
    if (curve) featureBadges.push(el('span', { class: 'speed-badge feat curve', title: 'Audio speed curve', text: 'curve' }));
  }
  const kfCount = Object.values(clip.keyframes || {}).reduce((n, pts) => n + (Array.isArray(pts) ? pts.length : 0), 0);
  const kfDot = kfCount
    ? el('span', { class: 'kf-dot', title: `${kfCount} keyframe${kfCount > 1 ? 's' : ''} animated — click the + buttons in Clip Tools to remove` }, '◆')
    : null;
  if (clip.kind === 'text') {
    const bm = normalizeBgMode((clip.text || {}).bgMode || ((clip.text || {}).bg ? 'inline' : 'none'));
    if (bm === 'full') featureBadges.push(el('span', { class: 'speed-badge feat', title: 'Top banner (meme)', text: 'banner' }));
    else if (bm === 'inline') featureBadges.push(el('span', { class: 'speed-badge feat', title: 'Inline box', text: 'box' }));
  }
  const node = el('div', {
    class: `tl-clip kind-${clip.kind} ${isSelectedClip(clip.id) ? 'selected' : ''} track-${track.id}`,
    style: `left:${clip.start * S.pps}px;width:${Math.max(4, clip.duration * S.pps)}px`,
    dataset: { track: track.id, clip: clip.id },
    title: `${label} · ${clip.start.toFixed(2)}–${clipEnd(clip).toFixed(2)}s${speed !== 1 ? ` · ${speed}× speed` : ''}${featureBadges.length ? ' · ' + featureBadges.map((b) => b.textContent).join(' · ') : ''} — Shift+click multi-select · double-click opens Clip Tools`,
  },
    el('span', { class: 'h l', dataset: { edge: 'l' } }),
    el('span', { class: 'lbl' }, label, speedBadge, ...featureBadges, kfDot),
    el('span', { class: 'h r', dataset: { edge: 'r' } })
  );
  if (track.type === 'audio' || clip.kind === 'audio') {
    node.classList.add('audio-clip');
    const wave = el('div', { class: 'waveform', dataset: { seed: clip.id } });
    drawWaveform(wave, clip);
    node.insertBefore(wave, node.querySelector('.lbl'));
  }

  node.addEventListener('pointerdown', (e) => {
    if (track.locked) { toast('Track is locked', true); return; }
    e.stopPropagation();
    if (e.shiftKey) {
      toggleMultiPick(track.id, clip.id);
      afterSelectionChange({ timeline: false, inspector: true });
      return; // multi-select click does not start a drag
    }
    selectOnly(track.id, clip.id);
    afterSelectionChange({ timeline: false, inspector: true });

    const snapshot = cloneTimeline(S.timeline);
    const edge = e.target.dataset?.edge;
    const startX = e.clientX;
    const orig = { ...getClip(S.timeline, track.id, clip.id).clip };
    let moved = false;

    const onMove = (ev) => {
      const dx = (ev.clientX - startX) / S.pps;
      if (Math.abs(ev.clientX - startX) < 2 && !moved) return;
      moved = true;
      try {
        const { clip: cur } = getClip(S.timeline, track.id, clip.id);
        if (edge === 'l') {
          let ns = round3(Math.max(0, orig.start + dx));
          let nd = round3(orig.duration - (ns - orig.start));
          if (nd < 0.1) { nd = 0.1; ns = round3(orig.start + orig.duration - 0.1); }
          const sp = orig.speed > 0 ? orig.speed : 1;
          trimClip(S.timeline, track.id, clip.id, {
            start: ns,
            duration: nd,
            srcIn: round3(Math.max(0, orig.srcIn + (ns - orig.start) * sp)),
          });
        } else if (edge === 'r') {
          const nd = round3(Math.max(0.1, orig.duration + dx));
          trimClip(S.timeline, track.id, clip.id, { duration: nd, start: orig.start, srcIn: orig.srcIn });
        } else {
          let ns = round3(Math.max(0, orig.start + dx));
          ns = snapTime(ns, clip.id, orig.duration);
          moveClip(S.timeline, track.id, clip.id, ns);
        }
        updateClipNode(track.id, clip.id);
      } catch {
        /* overlap etc — keep last valid */
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (moved) {
        const changed = JSON.stringify(S.timeline) !== JSON.stringify(snapshot);
        if (changed) {
          S.history = S.history.slice(0, S.hIndex + 1);
          S.history.push(cloneTimeline(S.timeline));
          S.hIndex = S.history.length - 1;
          capHistory();
          scheduleSave();
          renderTimeline();
          updateFooter();
          updatePreviewText(true);
        }
      } else {
        renderInspector();
      }
    };
    try { node.setPointerCapture?.(e.pointerId); } catch { /* */ }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });

  node.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (clip.kind === 'text') renderInspector(true);
  });
  return node;
}

function updateClipNode(trackId, clipId) {
  const { clip } = getClip(S.timeline, trackId, clipId);
  const node = document.querySelector(`.tl-clip[data-clip="${clipId}"]`);
  if (!node) return;
  node.style.left = `${clip.start * S.pps}px`;
  node.style.width = `${Math.max(4, clip.duration * S.pps)}px`;
}

function snapTime(t, ignoreId, duration) {
  const labelW = 92;
  void labelW;
  const threshold = 7 / S.pps;
  const candidates = [0, S.playhead];
  for (const track of S.timeline.tracks) {
    for (const c of track.clips) {
      if (c.id === ignoreId) continue;
      candidates.push(c.start, clipEnd(c));
    }
  }
  let best = t;
  let bestD = threshold;
  for (const c of candidates) {
    const d = Math.abs(t - c);
    if (d < bestD) { bestD = d; best = c; }
    const d2 = Math.abs(t + duration - c);
    if (d2 < bestD) { bestD = d2; best = c - duration; }
  }
  return round3(Math.max(0, best));
}

function labelForClip(clip) {
  const m = clip.assetId ? S.media.find((x) => x.id === clip.assetId) : null;
  return m ? m.filename : clip.kind;
}

function quickAdd(asset) {
  const kind = asset.category === 'image' || asset.kind === 'image' ? 'image'
    : asset.category === 'video' || asset.kind === 'video' ? 'video' : 'audio';
  const preferred = kind === 'video' ? 'v1' : kind === 'image' ? 'v3' : asset.category === 'voice' ? 'a1' : asset.category === 'sfx' ? 'a3' : 'a2';
  dropAsset(asset.id, preferred, S.playhead);
}

function dropAsset(assetId, trackId, time) {
  const asset = S.media.find((m) => m.id === assetId);
  if (!asset) return;
  if (asset.rights_status === 'REFERENCE_ONLY') { toast('REFERENCE_ONLY assets cannot go on the timeline', true); return; }
  const kind = asset.category === 'image' || asset.kind === 'image' ? 'image'
    : ['video'].includes(asset.category) || asset.kind === 'video' ? 'video' : 'audio';
  let targetTrack = trackId;
  // Split mode: second video/image belongs on V3 (pane B).
  if (isSplitLayout(S.timeline) && (kind === 'video' || kind === 'image') && trackId === 'v1') {
    const hasV1 = getTrack(S.timeline, 'v1').clips.some((c) => time < clipEnd(c) && time + 0.05 > c.start);
    const hasV3 = getTrack(S.timeline, 'v3').clips.some((c) => time < clipEnd(c) && time + 0.05 > c.start);
    if (hasV1 && !hasV3 && kind === 'video') targetTrack = 'v3';
    else if (hasV1 && !hasV3 && kind === 'image') targetTrack = 'v3';
  }
  const track = getTrack(S.timeline, targetTrack);
  const accepts = { v1: ['video', 'image'], v2: ['image'], v3: ['image', 'video'], a1: ['audio'], a2: ['audio'], a3: ['audio'], t1: ['text'], t2: ['text'] }[targetTrack];
  if (!accepts.includes(kind)) {
    // route to a sensible track instead of failing
    const fallback = kind === 'video' ? (isSplitLayout(S.timeline) ? 'v3' : 'v1') : kind === 'image' ? 'v3' : asset.category === 'voice' ? 'a1' : asset.category === 'sfx' ? 'a3' : 'a2';
    if (fallback === targetTrack) return;
    return dropAsset(assetId, fallback, time);
  }
  // Full source length (was hard-capped at 15s — long clips truncated on drop).
  const dur = kind === 'image'
    ? 4
    : Math.max(0.5, asset.duration > 0 ? asset.duration : (asset.duration || 4));
  const snapshot = cloneTimeline(S.timeline);
  try {
    const clip = addClip(S.timeline, targetTrack, {
      kind, assetId, start: time, duration: dur, srcIn: 0, volume: kind === 'audio' ? (asset.category === 'music' ? 0.18 : 1) : 1,
      overlay: kind !== 'video' || targetTrack !== 'v1' ? { xPct: 50, yPct: 50, widthPct: 35 } : undefined,
    }, { autoSlot: true });
    commit(snapshot);
    selectOnly(targetTrack, clip.id);
    renderTimeline();
    renderInspector();
    updateFooter();
    syncMedia(true);
    updateSelBox();
    toast(`Added to ${targetTrack.toUpperCase()}${isSplitLayout(S.timeline) && targetTrack === 'v3' ? ' (pane B)' : ''}`);
  } catch (e) {
    toast(e.message, true);
  }
}

/* ================= selection helpers ================= */

function clearSelection() {
  S.selection = null;
  S.multi = null;
}

function selectOnly(trackId, clipId) {
  S.selection = { trackId, clipId };
  S.multi = null;
}

/** Primary + multi picks (unique by trackId:clipId). */
function selectedPicks() {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    if (!p || !p.clipId) return;
    const k = `${p.trackId}:${p.clipId}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ trackId: p.trackId, clipId: p.clipId });
  };
  push(S.selection);
  for (const p of S.multi || []) push(p);
  return out;
}

function isSelectedClip(clipId) {
  return selectedPicks().some((p) => p.clipId === clipId);
}

/** Shift+click: toggle clip in multi-select (or seed primary). */
function toggleMultiPick(trackId, clipId) {
  const picks = selectedPicks();
  const k = `${trackId}:${clipId}`;
  const exists = picks.find((p) => `${p.trackId}:${p.clipId}` === k);
  if (exists) {
    if (picks.length <= 1) {
      // shift-click sole selection → keep it (no empty multi)
      return;
    }
    // remove from primary or multi
    if (S.selection && `${S.selection.trackId}:${S.selection.clipId}` === k) {
      const rest = picks.filter((p) => `${p.trackId}:${p.clipId}` !== k);
      S.selection = rest[0] || null;
      S.multi = rest.slice(1);
      if (!S.selection) S.multi = null;
    } else {
      S.multi = (S.multi || []).filter((p) => `${p.trackId}:${p.clipId}` !== k);
      if (!S.multi.length) S.multi = null;
    }
    return;
  }
  if (!S.selection) {
    S.selection = { trackId, clipId };
    S.multi = null;
    return;
  }
  S.multi = [...picks.filter((p) => !(p.trackId === S.selection.trackId && p.clipId === S.selection.clipId)), { trackId, clipId }];
}

/** Sync timeline clip selected classes without full re-render. */
function syncSelectionClasses() {
  document.querySelectorAll('.tl-clip').forEach((n) => {
    n.classList.toggle('selected', !!n.dataset.clip && isSelectedClip(n.dataset.clip));
  });
}

function afterSelectionChange({ timeline = false, inspector = true } = {}) {
  if (timeline) renderTimeline();
  else syncSelectionClasses();
  if (inspector) renderInspector();
  updatePreviewBadges();
  updateSelBox();
  updateFooter();
}

/* ================= editing ops ================= */

function commit(snapshot = cloneTimeline(S.timeline)) {
  S.history = S.history.slice(0, S.hIndex + 1);
  S.history.push(cloneTimeline(S.timeline));
  S.hIndex = S.history.length - 1;
  capHistory();
  scheduleSave();
  void snapshot;
}

function capHistory() {
  if (S.history.length > 100) {
    S.history.shift();
    S.hIndex--;
  }
}

function requireSelection() {
  if (!S.selection) { toast('Select a clip first', true); return null; }
  try {
    return getClip(S.timeline, S.selection.trackId, S.selection.clipId);
  } catch {
    clearSelection();
    return null;
  }
}

function doSplit() {
  const found = requireSelection();
  if (!found) return;
  const { track, clip } = found;
  if (S.playhead <= clip.start + 0.05 || S.playhead >= clipEnd(clip) - 0.05) {
    toast('Move the playhead inside the selected clip to split', true);
    return;
  }
  try {
    splitClip(S.timeline, track.id, clip.id, S.playhead);
    commit();
    renderTimeline();
    updateFooter();
    updatePreviewText(true);
    updatePreviewBadges();
    flashPreview();
    updateSelBox();
  } catch (e) { toast(e.message, true); }
}

function doDelete() {
  const picks = selectedPicks();
  if (!picks.length) { toast('Select a clip first', true); return; }
  try {
    const snap = cloneTimeline(S.timeline);
    for (const p of picks) {
      try { removeClip(S.timeline, p.trackId, p.clipId); } catch { /* already gone / locked */ }
    }
    clearSelection();
    commit(snap);
    renderTimeline();
    renderInspector();
    updateFooter();
    updatePreviewText(true);
    syncMedia(true);
    updatePreviewBadges();
    flashPreview();
    updateSelBox();
  } catch (e) { toast(e.message, true); }
}

function doDuplicate() {
  const found = requireSelection();
  if (!found) return;
  try {
    const copy = duplicateClip(S.timeline, found.track.id, found.clip.id);
    selectOnly(found.track.id, copy.id);
    commit();
    renderTimeline();
    renderInspector();
    updateFooter();
    updatePreviewText(true);
    updatePreviewBadges();
    flashPreview();
    updateSelBox();
  } catch (e) { toast(e.message, true); }
}

function doAddText() {
  const dur = timelineDuration(S.timeline);
  const start = S.playhead <= dur ? S.playhead : 0;
  try {
    const clip = addClip(S.timeline, 't1', {
      kind: 'text',
      start,
      duration: Math.min(3, Math.max(0.5, (dur || 0) - start) || 3),
      text: { content: 'Your text', role: 'title', position: 'center', size: 72, color: '#ffffff' },
    }, { autoSlot: true });
    selectOnly('t1', clip.id);
    commit();
    renderTimeline();
    renderInspector(true);
    updateFooter();
    updatePreviewText(true);
    updatePreviewBadges();
    flashPreview();
    updateSelBox();
  } catch (e) { toast(e.message, true); }
}

/** Project watermark dialog — brand mark burned into preview + export. */
function openWatermarkModal() {
  const wm = normalizeWatermark(S.timeline?.watermark);
  const fields = {
    text: el('input', { class: 'input', type: 'text', value: wm.text, placeholder: 'e.g. FRAMEFLOW or @yourbrand', maxlength: '80' }),
    position: el('select', { class: 'input' },
      WATERMARK_POSITIONS.map((p) => el('option', { value: p, selected: wm.position === p || undefined },
        p === 'vertical-left' ? 'Left edge · vertical ↑' :
        p === 'vertical-right' ? 'Right edge · vertical ↓' :
        p === 'top-left' ? 'Top left' : p === 'top-right' ? 'Top right' :
        p === 'bottom-left' ? 'Bottom left' : p === 'bottom-right' ? 'Bottom right' :
        p === 'top' ? 'Top center' : p === 'bottom' ? 'Bottom center' : 'Center'))),
    opacity: el('input', { class: 'input', type: 'number', min: '0.05', max: '1', step: '0.05', value: String(wm.opacity) }),
    size: el('input', { class: 'input', type: 'number', min: '8', max: '160', value: String(wm.size) }),
    color: el('input', { class: 'input', type: 'color', value: /^#[0-9a-fA-F]{6}$/.test(wm.color) ? wm.color : '#ffffff', style: 'padding:2px;height:32px' }),
    font: el('select', { class: 'input' }, TEXT_FONTS.map((f) => el('option', { value: f, selected: (wm.font || 'Arial') === f || undefined }, f))),
    bold: el('select', { class: 'input' }, [['1', 'Bold'], ['0', 'Regular']].map(([v, lab]) => el('option', { value: v, selected: String(wm.bold ? '1' : '0') === v || undefined }, lab))),
    uppercase: el('select', { class: 'input' }, [['1', 'UPPERCASE'], ['0', 'As typed']].map(([v, lab]) => el('option', { value: v, selected: String(wm.uppercase ? '1' : '0') === v || undefined }, lab))),
    letterSpacing: el('input', { class: 'input', type: 'number', min: '0', max: '40', value: String(wm.letterSpacing) }),
    margin: el('input', { class: 'input', type: 'number', min: '0', max: '300', value: String(wm.margin) }),
    enabled: el('select', { class: 'input' }, [['1', 'On (shown + exported)'], ['0', 'Off']].map(([v, lab]) => el('option', { value: v, selected: String(wm.enabled ? '1' : '0') === v || undefined }, lab))),
  };

  const readFields = () => normalizeWatermark({
    enabled: fields.enabled.value === '1',
    text: fields.text.value,
    position: fields.position.value,
    opacity: Number(fields.opacity.value),
    size: Number(fields.size.value),
    color: fields.color.value,
    font: fields.font.value,
    bold: fields.bold.value === '1',
    uppercase: fields.uppercase.value === '1',
    letterSpacing: Number(fields.letterSpacing.value),
    margin: Number(fields.margin.value),
  });

  const applyAndClose = () => {
    const next = readFields();
    if (next.enabled && !next.text.trim()) { toast('Watermark needs text when enabled', true); return false; }
    try {
      const snap = cloneTimeline(S.timeline);
      S.timeline.watermark = next;
      commit(snap);
      updatePreviewText(true);
      updateFooter();
      toast(next.enabled ? `Watermark on — ${next.position}` : 'Watermark off');
      return true;
    } catch (e) { toast(e.message, true); return false; }
  };

  const grid = el('div', { class: 'insp-grid' },
    el('div', { class: 'full' }, el('div', { class: 'insp-sec' }, 'Brand mark · burned into final export')),
    el('label', { class: 'field full' }, el('span', { text: 'Watermark text' }), fields.text),
    el('label', { class: 'field full' }, el('span', { text: 'Position' }), fields.position),
    el('label', { class: 'field' }, el('span', { text: 'Show' }), fields.enabled),
    el('label', { class: 'field' }, el('span', { text: 'Opacity (0–1)' }), fields.opacity),
    el('label', { class: 'field' }, el('span', { text: 'Size (px @1080)' }), fields.size),
    el('label', { class: 'field' }, el('span', { text: 'Color' }), fields.color),
    el('label', { class: 'field full' }, el('span', { text: 'Font' }), fields.font),
    el('label', { class: 'field' }, el('span', { text: 'Weight' }), fields.bold),
    el('label', { class: 'field' }, el('span', { text: 'Case' }), fields.uppercase),
    el('label', { class: 'field' }, el('span', { text: 'Letter spacing' }), fields.letterSpacing),
    el('label', { class: 'field' }, el('span', { text: 'Margin (px)' }), fields.margin),
    el('div', { class: 'full region-hint', html: 'Vertical positions render like <b>FRAMEFLOW</b> — wide-tracked letters down the edge. Appears in preview and <b>final.mp4</b>.' }),
  );

  modal({
    title: 'Watermark',
    body: grid,
    actions: [
      { label: 'Cancel' },
      { label: 'Apply', class: 'primary', onClick: () => (applyAndClose() ? undefined : false) },
    ],
  });
  setTimeout(() => fields.text.focus(), 80);
}

function doUndo() {
  if (S.hIndex <= 0) { toast('Nothing to undo'); return; }
  S.hIndex--;
  S.timeline = cloneTimeline(S.history[S.hIndex]);
  clearSelection();
  scheduleSave();
  renderTimeline(); renderInspector(); updateFooter(); updatePreviewText(true); syncMedia(true);
  updatePreviewBadges();
  autoSelectClip();
  if (S.selection) { renderTimeline(); renderInspector(); syncMedia(true); updatePreviewBadges(); updateSelBox(); }
}

function doRedo() {
  if (S.hIndex >= S.history.length - 1) { toast('Nothing to redo'); return; }
  S.hIndex++;
  S.timeline = cloneTimeline(S.history[S.hIndex]);
  clearSelection();
  scheduleSave();
  renderTimeline(); renderInspector(); updateFooter(); updatePreviewText(true); syncMedia(true);
  updatePreviewBadges();
  autoSelectClip();
  if (S.selection) { renderTimeline(); renderInspector(); syncMedia(true); updatePreviewBadges(); updateSelBox(); }
}

/* ================= quick style bar ================= */

function findFirstMediaClip(kind) {
  for (const tid of ['v1', 'v3', 'v2']) {
    try {
      const tr = getTrack(S.timeline, tid);
      for (const c of tr.clips || []) {
        if (!kind || c.kind === kind) return { track: tr, clip: c };
      }
    } catch { /* skip */ }
  }
  return null;
}

function selectedMediaClip() {
  if (!S.selection) return null;
  try {
    const tr = getTrack(S.timeline, S.selection.trackId);
    const clip = getClip(S.timeline, S.selection.trackId, S.selection.clipId);
    if (clip && (clip.kind === 'video' || clip.kind === 'image')) return { track: tr, clip };
  } catch { /* skip */ }
  return null;
}

function selectedTextClip() {
  if (!S.selection) return null;
  try {
    const tr = getTrack(S.timeline, S.selection.trackId);
    const clip = getClip(S.timeline, S.selection.trackId, S.selection.clipId);
    if (clip && clip.kind === 'text') return { track: tr, clip };
  } catch { /* skip */ }
  return null;
}

function quickCommit(mut) {
  try {
    const snap = cloneTimeline(S.timeline);
    mut();
    commit(snap);
    renderTimeline(); renderInspector(); updateFooter(); updatePreviewText(true); syncMedia(true);
    updatePreviewBadges();
    flashPreview();
    updateSelBox();
  } catch (e) { toast(e.message, true); renderInspector(); }
}

function ensureTextAtPlayhead() {
  let found = selectedTextClip();
  if (found) return found;
  const dur = timelineDuration(S.timeline);
  const start = S.playhead <= dur ? S.playhead : 0;
  try {
    const clip = addClip(S.timeline, 't1', {
      kind: 'text',
      start,
      duration: Math.min(3, Math.max(0.5, (dur || 0) - start) || 3),
      text: { content: 'Your text', role: 'hook', position: 'top', size: 56, color: '#000000' },
    }, { autoSlot: true });
    selectOnly('t1', clip.id);
    return { track: getTrack(S.timeline, 't1'), clip };
  } catch { return null; }
}

function quickMemeBanner() {
  const found = ensureTextAtPlayhead();
  if (!found) { toast('Could not add text clip', true); return; }
  const { track, clip } = found;
  const t = clip.text || {};
  const preset = { ...TEXT_PRESETS.meme };
  if (t.content && t.content !== 'Your text') preset.content = t.content;
  quickCommit(() => setClipProps(S.timeline, track.id, clip.id, { text: preset }));
  toast('Optimized top banner applied — edit in Clip Tools');
  const content = document.querySelector('#inspector textarea');
  if (content) { content.focus(); content.select(); }
}

/** Target clip for the quick bar: current selection, else first media clip. */
function resolveMediaClip() {
  return selectedMediaClip() || findFirstMediaClip('video') || findFirstMediaClip('image');
}

/** One-click look — click again to remove it (no undo needed). */
function quickEffect(ef) {
  const found = resolveMediaClip();
  if (!found) { toast('Add a video/image clip on the timeline first', true); return; }
  const { track, clip } = found;
  selectOnly(track.id, clip.id);
  const cur = normalizeEffect(clip.effect);
  const next = cur === ef ? 'none' : ef;
  quickCommit(() => setClipProps(S.timeline, track.id, clip.id, { effect: next }));
  const names = {
    bw: 'Black & white', vintage: 'Vintage', teal: 'Teal & orange', golden: 'Golden hour',
    noir: 'Noir', neon: 'Neon', luxury: 'Luxury', vignette: 'Vignette', soft: 'Soft focus',
    sepia: 'Sepia', warm: 'Warm', cool: 'Cool', vivid: 'Vivid',
  };
  toast(next === 'none' ? `${names[ef] || ef} removed` : `Effect: ${names[ef] || ef}`);
}

function quickFit(fit) {
  const found = resolveMediaClip();
  if (!found) { toast('Add a video/image clip on the timeline first', true); return; }
  const { track, clip } = found;
  selectOnly(track.id, clip.id);
  const next = normalizeTransform(clip).fit === fit ? 'cover' : fit;
  quickCommit(() => setClipProps(S.timeline, track.id, clip.id, {
    fit: next, scale: 1, posX: 50, posY: 50, rotate: 0,
  }));
  toast(next === 'contain' ? 'Fit mode: Contain (no crop)' : 'Fit mode: Cover (crop to fill)');
}

function quickResetLook() {
  const found = resolveMediaClip();
  if (!found) { toast('No media clip to reset', true); return; }
  const { track, clip } = found;
  selectOnly(track.id, clip.id);
  quickCommit(() => {
    setClipProps(S.timeline, track.id, clip.id, {
      fit: 'cover', scale: 1, posX: 50, posY: 50, rotate: 0, effect: 'none',
      grade: { ...DEFAULT_GRADE }, chroma: null, mask: null,
    });
    const rest = { ...(clip.keyframes || {}) };
    for (const p of ['exposure', 'contrast', 'saturation', 'temperature']) delete rest[p];
    setClipProps(S.timeline, track.id, clip.id, { keyframes: rest });
  });
  toast('Look reset (fit, zoom, focus, rotate, effect, grade)');
}

/** Keyframe recipe for a motion preset (clip-local times). */
function motionPresetKeyframes(name, dur) {
  const end = round3(Math.max(0.2, dur));
  const mid = round3(end * 0.5);
  if (name === 'push-in') {
    return { scale: [{ t: 0, v: 1, ease: 'ease' }, { t: end, v: 1.08 }] };
  }
  if (name === 'punch') {
    return { scale: [{ t: 0, v: 1.2, ease: 'out' }, { t: round3(Math.min(0.35, end * 0.35)), v: 1, ease: 'ease' }, { t: end, v: 1.04 }] };
  }
  if (name === 'reveal') {
    return { scale: [{ t: 0, v: 1.25, ease: 'ease' }, { t: end, v: 1 }] };
  }
  if (name === 'kenburns') {
    return {
      scale: [{ t: 0, v: 1.08 }, { t: end, v: 1.08 }],
      posX: [{ t: 0, v: 44, ease: 'ease' }, { t: end, v: 56 }],
      posY: [{ t: 0, v: 50, ease: 'ease' }, { t: mid, v: 48, ease: 'ease' }, { t: end, v: 50 }],
    };
  }
  if (name === 'spin') {
    return { rotate: [{ t: 0, v: 0, ease: 'ease' }, { t: end, v: 360 }] };
  }
  if (name === 'float') {
    return {
      posY: [{ t: 0, v: 50, ease: 'ease' }, { t: mid, v: 46, ease: 'ease' }, { t: end, v: 50 }],
      scale: [{ t: 0, v: 1.04, ease: 'ease' }, { t: end, v: 1.04 }],
    };
  }
  return null;
}

const MOTION_LABELS = {
  'push-in': 'Slow push-in', punch: 'Punch-in', reveal: 'Zoom-out reveal',
  kenburns: 'Ken Burns pan', spin: 'Spin 360°', float: 'Float',
};

/** True when the clip already carries this motion preset (button shows active). */
function hasMotionPreset(clip, name) {
  const want = motionPresetKeyframes(name, clip.duration);
  if (!want) return false;
  const have = clip.keyframes || {};
  return Object.entries(want).every(([prop, pts]) => JSON.stringify(have[prop] || []) === JSON.stringify(pts));
}

/** One-click camera motion via keyframes — click again to remove it. */
function applyMotionPreset(name) {
  const found = resolveMediaClip();
  if (!found) { toast('Add a video/image clip first', true); return; }
  const { track, clip } = found;
  selectOnly(track.id, clip.id);
  const want = motionPresetKeyframes(name, clip.duration);
  if (!want) { toast('Unknown motion preset', true); return; }
  const on = hasMotionPreset(clip, name);
  quickCommit(() => {
    const kf = { ...(clip.keyframes || {}) };
    if (on) {
      for (const prop of Object.keys(want)) delete kf[prop];
    } else {
      Object.assign(kf, want);
    }
    setClipProps(S.timeline, track.id, clip.id, { keyframes: kf });
  });
  toast(on ? `Motion removed: ${MOTION_LABELS[name] || name}` : `Motion: ${MOTION_LABELS[name] || name}`);
}

/** Apply text entrance animation (adds text clip if needed) — click again to remove. */
function quickTextAnim(anim) {
  const found = ensureTextAtPlayhead();
  if (!found) { toast('Could not add text clip', true); return; }
  const { track, clip } = found;
  const on = normalizeTextAnim((clip.text || {}).anim) === anim;
  quickCommit(() => setClipProps(S.timeline, track.id, clip.id, {
    text: {
      ...(clip.text || {}),
      anim: on ? 'none' : anim,
      animDur: anim === 'fade' ? 0.3 : anim === 'flicker' ? 0.45 : anim === 'glitch' ? 0.5 : 0.35,
    },
  }));
  const labels = {
    fade: 'Fade', pop: 'Pop', 'slide-up': 'Slide up', 'slide-down': 'Slide down',
    bounce: 'Bounce', 'zoom-in': 'Zoom in', flicker: 'Flicker', glitch: 'Glitch',
  };
  toast(on ? `Text animation removed (${labels[anim] || anim})` : `Text animation: ${labels[anim] || anim}`);
}

/** True when a caption clip already wears this preset (content is free text). */
function captionMatchesPreset(clip, preset) {
  const t = clip.text || {};
  return Object.entries(preset).every(([k, v]) => k === 'content' || JSON.stringify(t[k]) === JSON.stringify(v));
}

/** Add/apply a caption preset on T2 (captions track) — click again to remove it. */
function quickCaptionPreset(name) {
  const preset = CAPTION_PRESETS[name];
  if (!preset) return;
  const dur = timelineDuration(S.timeline);
  const start = S.playhead <= dur ? S.playhead : 0;
  try {
    const snap = cloneTimeline(S.timeline);
    // Reuse selected T2 caption if there is one at the playhead.
    let found = null;
    if (S.selection?.trackId === 't2') {
      try {
        const c = getClip(S.timeline, 't2', S.selection.clipId);
        if (c && c.kind === 'text') found = { track: getTrack(S.timeline, 't2'), clip: c };
      } catch { /* fall through */ }
    }
    if (found && captionMatchesPreset(found.clip, preset)) {
      removeClip(S.timeline, 't2', found.clip.id);
      clearSelection();
      commit(snap);
      renderTimeline(); renderInspector(); updateFooter(); updatePreviewText(true); syncMedia(true);
      updatePreviewBadges(); flashPreview(); updateSelBox();
      toast(`Caption removed (${name})`);
      return;
    }
    if (!found) {
      const track = getTrack(S.timeline, 't2');
      const overlap = track.clips.some((c) => start < clipEnd(c) - 1e-6 && start + 3 > c.start + 1e-6);
      const clip = addClip(S.timeline, 't2', {
        kind: 'text',
        start: overlap ? findFreeSlot(track, 3, start) : start,
        duration: Math.min(3, Math.max(1, (dur || 0) - start) || 3),
        text: { ...preset, content: 'Your caption' },
      });
      found = { track, clip };
    } else {
      setClipProps(S.timeline, 't2', found.clip.id, { text: { ...preset } });
    }
    selectOnly('t2', found.clip.id);
    commit(snap);
    renderTimeline(); renderInspector(true); updateFooter(); updatePreviewText(true); syncMedia(true);
    updatePreviewBadges(); flashPreview(); updateSelBox();
    toast(`Caption style: ${name}${preset.stagger ? ' · word-by-word' : ''}`);
    const content = document.querySelector('#inspector textarea');
    if (content) { content.focus(); content.select(); }
  } catch (e) { toast(e.message, true); }
}

/** Make selected media a floating PiP overlay (image→v2, video→v3). */
function quickPip(corner = 'br') {
  const found = selectedMediaClip() || findFirstMediaClip('video') || findFirstMediaClip('image');
  if (!found) { toast('Add a video/image clip first', true); return; }
  const { track, clip } = found;
  const ov = corner === 'tl'
    ? { xPct: 18, yPct: 18, widthPct: 28 }
    : { xPct: 80, yPct: 80, widthPct: 28 };
  const isOverlayTrack = track.id === 'v2' || track.id === 'v3';
  if (isOverlayTrack) {
    quickCommit(() => setClipProps(S.timeline, track.id, clip.id, { overlay: ov }));
    toast('PiP corner updated');
    return;
  }
  // Move clip to overlay track as floating PiP
  const dest = clip.kind === 'image' ? 'v2' : 'v3';
  try {
    const snap = cloneTimeline(S.timeline);
    const props = {
      kind: clip.kind,
      assetId: clip.assetId,
      start: clip.start,
      duration: clip.duration,
      srcIn: clip.srcIn,
      volume: clip.volume ?? 1,
      muted: clip.muted,
      speed: clip.speed ?? 1,
      overlay: ov,
      effect: clip.effect || 'none',
      fit: clip.fit || 'cover',
      scale: clip.scale ?? 1,
      posX: clip.posX ?? 50,
      posY: clip.posY ?? 50,
      rotate: clip.rotate ?? 0,
      transitionIn: clip.transitionIn || 'none',
      transitionDur: clip.transitionDur ?? DEFAULT_TRANSITION,
      fadeIn: clip.fadeIn || 0,
      fadeOut: clip.fadeOut || 0,
      grade: clip.grade || null,
      speedCurve: clip.speedCurve || null,
      reverse: clip.reverse || false,
      chroma: clip.chroma || null,
      mask: clip.mask || null,
      keyframes: clip.keyframes || {},
    };
    removeClip(S.timeline, track.id, clip.id);
    const nc = addClip(S.timeline, dest, props, { autoSlot: true });
    selectOnly(dest, nc.id);
    commit(snap);
    renderTimeline(); renderInspector(); updateFooter(); updatePreviewText(true); syncMedia(true);
    updatePreviewBadges(); flashPreview(); updateSelBox();
    toast('PiP — clip is now a corner overlay (drag on canvas)');
  } catch (e) { toast(e.message, true); }
}

/* ================= transitions across every cut ================= */

/** Clips that can carry a transition (the very first V1 clip has nothing before it). */
function transitionCandidates() {
  const out = [];
  for (const track of S.timeline.tracks) {
    if (track.type !== 'video') continue;
    const clips = [...track.clips].sort((a, b) => a.start - b.start);
    clips.forEach((clip, i) => {
      if (clip.kind !== 'video' && clip.kind !== 'image') return;
      if (track.id === 'v1' && i === 0) return;
      out.push({ track, clip });
    });
  }
  return out;
}

const SMART_CUTS = ['fade', 'zoom', 'slide', 'fade', 'dip', 'zoom'];

/** Deterministic smart pick: punchy flash on tiny clips, gentle mix elsewhere. */
function smartTransitionFor(clip, index) {
  if (clip.duration <= 0.45) return 'flash';
  return SMART_CUTS[index % SMART_CUTS.length];
}

/** Apply the chosen transition to every cut — pass `true` to clear them all. */
function applyTransitionsToAll(forceClear = false) {
  const mode = S.transSel?.value || 'smart';
  const cands = transitionCandidates();
  if (!cands.length) { toast('Add at least two clips first', true); return; }
  const already = forceClear || (mode === 'smart'
    ? cands.every(({ clip }) => normalizeTransition(clip.transitionIn) !== 'none')
    : cands.every(({ clip }) => normalizeTransition(clip.transitionIn) === mode));
  const next = already ? 'none' : mode;
  let changed = 0;
  quickCommit(() => {
    cands.forEach(({ track, clip }, i) => {
      const tr = next === 'smart' ? smartTransitionFor(clip, i) : next;
      if (normalizeTransition(clip.transitionIn) === tr) return;
      setClipProps(S.timeline, track.id, clip.id, { transitionIn: tr });
      changed++;
    });
  });
  if (next === 'none') toast(`Transitions cleared on ${cands.length} cut(s)`);
  else toast(`${changed} cut(s) → ${next === 'smart' ? 'auto mix' : next}`);
}

const TRANS_DUR_STEPS = [0.15, 0.3, 0.6, 1];
let transDurIdx = 1;

/** Cycle how long each cut takes to come in (0.15 / 0.3 / 0.6 / 1s). */
function cycleTransitionDur() {
  transDurIdx = (transDurIdx + 1) % TRANS_DUR_STEPS.length;
  const d = TRANS_DUR_STEPS[transDurIdx];
  const cands = transitionCandidates();
  const withTrans = cands.filter(({ clip }) => normalizeTransition(clip.transitionIn) !== 'none');
  const list = withTrans.length ? withTrans : cands;
  if (!list.length) { toast('Add clips first', true); return; }
  quickCommit(() => {
    for (const { track, clip } of list) setClipProps(S.timeline, track.id, clip.id, { transitionDur: d });
  });
  const b = S.quickRefs?.transdur?.dur;
  if (b) b.textContent = `⏱ ${d}s`;
  toast(`Transition length ${d}s on ${list.length} clip(s)`);
}

/* ================= grade (all clips) ================= */

/** Apply a grade to every unlocked video/image clip in one undo step. */
function gradeAllClips(grade) {
  const snap = cloneTimeline(S.timeline);
  let n = 0;
  for (const track of S.timeline.tracks) {
    if (track.type !== 'video' || track.locked) continue;
    for (const c of [...track.clips]) {
      if (c.kind !== 'video' && c.kind !== 'image') continue;
      setClipProps(S.timeline, track.id, c.id, { grade });
      n++;
    }
  }
  if (!n) { toast('No media clips on the timeline', true); return 0; }
  commit(snap);
  renderTimeline(); renderInspector(); updateFooter(); updatePreviewText(true); syncMedia(true);
  updatePreviewBadges(); flashPreview(); updateSelBox();
  return n;
}

/* ================= quick-bar toggle state ================= */

/** Target text clip for the quick bar: selection, else the clip under the playhead. */
function textClipAtPlayhead() {
  try {
    const tr = getTrack(S.timeline, 't1');
    const t = S.playhead;
    return tr.clips.find((c) => t >= c.start - 1e-6 && t < clipEnd(c) - 1e-6) || null;
  } catch { return null; }
}

/** True when the clip already has a keyframe on `prop` at the playhead. */
function hasKfAtPlayhead(clip, prop) {
  const localT = round3(Math.max(0, S.playhead - (clip.start || 0)));
  const pts = clip?.keyframes?.[prop] || [];
  return pts.some((p) => Math.abs(Number(p.t) - localT) <= 0.002);
}

/** Light up quick-bar / keyframe toggles that are currently applied. */
function refreshQuickStates() {
  const refs = S.quickRefs;
  if (!refs || !S.timeline) return;
  const on = (group, key, isOn) => {
    const b = refs[group]?.[key];
    if (!b) return;
    b.classList.toggle('active', !!isOn);
    b.setAttribute('aria-pressed', isOn ? 'true' : 'false');
  };

  const media = resolveMediaClip();
  const clip = media?.clip || null;
  const ef = clip ? normalizeEffect(clip.effect) : 'none';
  const fit = clip ? normalizeTransform(clip).fit : 'cover';
  for (const key of Object.keys(refs.effect)) {
    on('effect', key, key === 'contain' ? fit === 'contain' : ef === key);
  }
  for (const key of Object.keys(refs.motion)) on('motion', key, !!clip && hasMotionPreset(clip, key));

  const tsel = selectedTextClip()?.clip || textClipAtPlayhead();
  const anim = normalizeTextAnim((tsel?.text || {}).anim);
  for (const key of Object.keys(refs.text)) on('text', key, anim === key && anim !== 'none');

  let capClip = null;
  if (S.selection?.trackId === 't2') {
    try { capClip = getClip(S.timeline, 't2', S.selection.clipId); } catch { capClip = null; }
  }
  for (const key of Object.keys(refs.caption)) {
    on('caption', key, !!capClip && !!CAPTION_PRESETS[key] && captionMatchesPreset(capClip, CAPTION_PRESETS[key]));
  }

  // keyframe diamonds in the inspector (depends on the playhead)
  let selClip = null;
  if (S.selection) {
    try { selClip = getClip(S.timeline, S.selection.trackId, S.selection.clipId); } catch { selClip = null; }
  }
  for (const key of Object.keys(refs.kf || {})) {
    on('kf', key, !!selClip && hasKfAtPlayhead(selClip, key));
  }
}

/* ================= pro tools: speed curve / reverse / chroma / mask ========= */

const CURVE_PRESET_LABELS = {
  constant: 'Flat', fastStart: 'Fast start', fastEnd: 'Fast end', flashIn: 'Flash in',
  sloMo: 'Slo-mo', montage: 'Montage', hero: 'Hero',
};
const CURVE_VMAX = 4;

/** Live-draggable speed ramp editor (points are committed on release). */
function speedCurveEditor(clip, track, apply) {
  const W = 600;
  const H = 170;
  const canvas = el('canvas', { class: 'curve-canvas', width: W, height: H });
  const wrap = el('div', { class: 'curve-wrap', title: 'Drag points · double-click to add · right-click a point to remove' }, canvas);
  const ctx = canvas.getContext('2d');
  let points = (speedCurveOf(clip)?.points || []).map((p) => ({ t: Number(p.t), v: Number(p.v) }));
  let snap = null;
  let drag = -1;
  const toX = (t) => 6 + t * (W - 12);
  const toY = (v) => H - 8 - (Math.max(0, Math.min(CURVE_VMAX, v)) / CURVE_VMAX) * (H - 16);
  const toT = (x) => Math.max(0, Math.min(1, (x - 6) / (W - 12)));
  const toV = (y) => Math.max(MIN_SPEED, Math.min(MAX_SPEED, ((H - 8 - y) / (H - 16)) * CURVE_VMAX));

  const draw = () => {
    const css = getComputedStyle(document.documentElement);
    const accent = (css.getPropertyValue('--accent') || '#6a5bff').trim();
    const line = (css.getPropertyValue('--line2') || '#2a2d34').trim();
    const dim = (css.getPropertyValue('--text3') || '#6b7280').trim();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.03)';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    for (const g of [1, 2, 3]) {
      const y = toY(g);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.fillStyle = dim;
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(`${g}×`, 4, y - 3);
    }
    const y1 = toY(1);
    ctx.strokeStyle = 'rgba(255,255,255,.28)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, y1); ctx.lineTo(W, y1); ctx.stroke();
    ctx.setLineDash([]);
    if (points.length > 1) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(toX(points[0].t), toY(points[0].v));
      for (let i = 1; i < points.length; i++) {
        const p0 = points[i - 1];
        const p1 = points[i];
        const x0 = toX(p0.t);
        const x1 = toX(p1.t);
        ctx.bezierCurveTo((x0 + x1) / 2, toY(p0.v), (x0 + x1) / 2, toY(p1.v), x1, toY(p1.v));
      }
      ctx.stroke();
      ctx.fillStyle = accent;
      for (const p of points) {
        ctx.beginPath();
        ctx.arc(toX(p.t), toY(p.v), 6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = dim;
      ctx.fillText('time →', W - 46, H - 6);
    } else {
      ctx.fillStyle = dim;
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('Constant speed — click a preset, or double-click to draw a ramp', 18, H / 2);
    }
  };

  const nearest = (x, y) => {
    let best = -1;
    let bd = 16;
    points.forEach((p, i) => {
      const d = Math.hypot(toX(p.t) - x, toY(p.v) - y);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };

  const store = (changed) => {
    if (!changed) return;
    const normalized = normalizeSpeedCurve({ preset: SPEED_CURVE_CUSTOM, points });
    snap = null;
    apply(() => setClipProps(S.timeline, track.id, clip.id, { speedCurve: normalized }));
  };

  canvas.addEventListener('pointerdown', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    if (e.button === 2) {
      const i = nearest(x, y);
      if (i >= 0 && points.length > MIN_SPEED_CURVE_POINTS) {
        points.splice(i, 1);
        store(true);
      }
      return;
    }
    const i = nearest(x, y);
    if (i < 0) return;
    drag = i;
    snap = cloneTimeline(S.timeline);
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    const p = points[drag];
    const isEnd = drag === 0 || drag === points.length - 1;
    let t = isEnd ? p.t : toT(x);
    const lo = drag > 0 ? points[drag - 1].t + 0.02 : 0;
    const hi = drag < points.length - 1 ? points[drag + 1].t - 0.02 : 1;
    p.t = round3(Math.max(lo, Math.min(hi, t)));
    p.v = round3(toV(y));
    draw();
    const live = normalizeSpeedCurve({ preset: SPEED_CURVE_CUSTOM, points });
    clip.speedCurve = live;
    syncMedia(false);
  });
  const endDrag = (e) => {
    if (drag < 0) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* */ }
    drag = -1;
    store(true);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    const t = toT(x);
    if (points.length >= MAX_SPEED_CURVE_POINTS) { toast('Speed curve is full (32 points)', true); return; }
    if (!points.length) {
      points = [{ t: 0, v: 1 }, { t: 1, v: 1 }];
    }
    let idx = points.findIndex((p) => p.t > t);
    if (idx <= 0) idx = points.length;
    const prev = points[idx - 1];
    const next = points[idx];
    if (next && next.t - prev.t < 0.04) { toast('Too close to an existing point', true); return; }
    points.splice(idx, 0, { t: round3(t), v: round3(toV(y)) });
    store(true);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  draw();
  return wrap;
}

/** Speed presets + curve + reverse + freeze for the selected clip. */
function appendSpeedSection(grid, apply, track, clip, withFreeze = true) {
  const curve = speedCurveOf(clip);
  const presetRow = el('div', { class: 'full style-presets' },
    ...SPEED_CURVE_PRESET_NAMES.map((name) => {
      const isActive = !!curve && curve.preset === name && name !== 'constant';
      return el('button', {
        class: isActive ? 'btn sm active' : 'btn sm',
        title: isActive ? 'Click to remove this speed curve' : `Apply the ${CURVE_PRESET_LABELS[name]} speed ramp`,
        text: CURVE_PRESET_LABELS[name] || name,
        onclick: () => {
          if (isActive) apply(() => setClipProps(S.timeline, track.id, clip.id, { speedCurve: null }));
          else apply(() => setClipProps(S.timeline, track.id, clip.id, {
            speedCurve: { preset: name, points: SPEED_CURVE_PRESETS[name] },
          }));
        },
      });
    }),
    el('button', {
      class: 'btn sm',
      title: 'Clear the speed curve and go back to constant speed',
      text: 'Clear curve',
      onclick: () => apply(() => setClipProps(S.timeline, track.id, clip.id, { speedCurve: null })),
    }),
  );
  const revOn = normalizeReverse(clip.reverse);
  grid.append(
    el('div', { class: 'full insp-sec' }, 'Speed ramp'),
    presetRow,
    speedCurveEditor(clip, track, apply),
    el('div', { class: 'full', style: 'display:flex;gap:6px;flex-wrap:wrap' },
      el('button', {
        class: revOn ? 'btn sm active' : 'btn sm',
        text: '⟲ Reverse',
        title: 'Play this clip backwards — click again to turn it off',
        onclick: () => apply(() => setClipProps(S.timeline, track.id, clip.id, { reverse: !revOn })),
      }),
      withFreeze ? el('button', {
        class: 'btn sm',
        text: '❄ Freeze frame',
        title: 'Split at the playhead and hold this frame for 2s',
        onclick: () => doFreezeFrame(),
      }) : null,
    ),
  );
}

/** Chroma key (green/blue screen) controls. */
function appendChromaSection(grid, apply, track, clip) {
  const cur = normalizeChroma(clip.chroma);
  const on = !!cur;
  const c = cur || DEFAULT_CHROMA;
  const mk = (label, key, min, max, step) => {
    const rng = el('input', {
      class: 'input range', type: 'range', min: String(min), max: String(max), step: String(step),
      value: String(c[key]), 'aria-label': label,
    });
    const out = el('output', { class: 'grade-val', text: Number(c[key]).toFixed(2) });
    let snap = null;
    rng.addEventListener('input', () => {
      if (!on) return;
      if (!snap) snap = cloneTimeline(S.timeline);
      const g = normalizeChroma(clip.chroma) || { ...DEFAULT_CHROMA };
      g[key] = Number(rng.value);
      clip.chroma = normalizeChroma(g);
      out.textContent = Number(rng.value).toFixed(2);
      syncMedia(false);
    });
    rng.addEventListener('change', () => {
      if (!snap) return;
      const s = snap; snap = null;
      commit(s);
      renderTimeline(); renderInspector(); updateFooter(); syncMedia(false); updatePreviewBadges(); flashPreview();
    });
    rng.disabled = !on;
    return el('label', { class: 'field full grade-field' }, el('span', { text: label }), rng, out);
  };
  const color = el('input', {
    class: 'input', type: 'color', value: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#00ff00',
    'aria-label': 'Key color', disabled: !on || undefined,
    onchange: (e) => { if (on) apply(() => setClipProps(S.timeline, track.id, clip.id, { chroma: { ...(normalizeChroma(clip.chroma) || DEFAULT_CHROMA), color: e.target.value } })); },
  });
  grid.append(
    el('div', { class: 'full insp-sec' }, 'Chroma key'),
    el('div', { class: 'full', style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center' },
      el('button', {
        class: on ? 'btn sm active' : 'btn sm',
        text: on ? 'Key: ON' : 'Key: OFF',
        title: 'Cut out the background colour (green/blue screen) — click to toggle',
        onclick: () => apply(() => setClipProps(S.timeline, track.id, clip.id, { chroma: on ? null : { ...DEFAULT_CHROMA } })),
      }),
      el('span', { class: 'muted', style: 'font-size:11px', text: on ? 'Pick the screen colour, then tune tolerance' : 'Best on PiP / overlay clips' }),
    ),
    on ? el('label', { class: 'field full grade-field' }, el('span', { text: 'Key colour' }), color, el('output', { class: 'grade-val', text: '' })) : null,
    on ? mk('Tolerance', 'similarity', 0, 1, 0.01) : null,
    on ? mk('Edge softness', 'blend', 0, 1, 0.01) : null,
    on ? mk('Spill removal', 'despill', 0, 1, 0.01) : null,
  );
}

/** Shape mask controls (feathered rect / ellipse / circle / line). */
function appendMaskSection(grid, apply, track, clip) {
  const cur = normalizeMask(clip.mask);
  const on = !!cur;
  const m = cur || DEFAULT_MASK;
  const mk = (label, key) => {
    const [lo, hi] = MASK_RANGES[key];
    const step = key === 'feather' ? 0.01 : 1;
    const rng = el('input', {
      class: 'input range', type: 'range', min: String(lo), max: String(hi), step: String(step),
      value: String(m[key]), 'aria-label': label,
    });
    const out = el('output', { class: 'grade-val', text: String(m[key]) });
    let snap = null;
    rng.addEventListener('input', () => {
      if (!on) return;
      if (!snap) snap = cloneTimeline(S.timeline);
      const g = normalizeMask(clip.mask) || { ...DEFAULT_MASK };
      g[key] = Number(rng.value);
      clip.mask = normalizeMask(g);
      out.textContent = rng.value;
      syncMedia(false);
    });
    rng.addEventListener('change', () => {
      if (!snap) return;
      const s = snap; snap = null;
      commit(s);
      renderTimeline(); renderInspector(); updateFooter(); syncMedia(false); updatePreviewBadges(); flashPreview();
    });
    rng.disabled = !on;
    return el('label', { class: 'field full grade-field' }, el('span', { text: label }), rng, out);
  };
  const typeSel = el('select', {
    class: 'input', 'aria-label': 'Mask shape', disabled: !on || undefined,
    onchange: (e) => { if (on) apply(() => setClipProps(S.timeline, track.id, clip.id, { mask: { ...(normalizeMask(clip.mask) || DEFAULT_MASK), type: e.target.value } })); },
  }, MASK_TYPES.map((ty) => el('option', { value: ty, selected: m.type === ty || undefined }, ty)));
  grid.append(
    el('div', { class: 'full insp-sec' }, 'Mask'),
    el('div', { class: 'full', style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center' },
      el('button', {
        class: on ? 'btn sm active' : 'btn sm',
        text: on ? 'Mask: ON' : 'Mask: OFF',
        title: 'Show only the shape — click to toggle',
        onclick: () => apply(() => setClipProps(S.timeline, track.id, clip.id, { mask: on ? null : { ...DEFAULT_MASK } })),
      }),
      on ? el('button', {
        class: (m.invert ? 'btn sm active' : 'btn sm'),
        text: 'Invert',
        title: 'Cut the shape out instead of keeping it',
        onclick: () => apply(() => setClipProps(S.timeline, track.id, clip.id, { mask: { ...(normalizeMask(clip.mask) || DEFAULT_MASK), invert: !m.invert } })),
      }) : null,
    ),
    on ? el('label', { class: 'field full' }, el('span', { text: 'Shape' }), typeSel) : null,
    on ? mk('Width %', 'w') : null,
    on ? mk('Height %', 'h') : null,
    on ? mk('Centre X %', 'x') : null,
    on ? mk('Centre Y %', 'y') : null,
    on ? mk('Feather', 'feather') : null,
    on ? mk('Rotation °', 'rotation') : null,
  );
}

/**
 * Freeze frame: split the selected video clip at the playhead and hold that
 * exact frame for 2s (the still is captured from the live preview).
 */
async function doFreezeFrame() {
  const found = selectedMediaClip() || findFirstMediaClip('video');
  if (!found) { toast('Select a video clip first', true); return; }
  const v = S.videoEl;
  if (!v || !v.videoWidth || v.readyState < 2) { toast('Wait for the preview frame to load', true); return; }
  const { track, clip } = found;
  const local = S.playhead - clip.start;
  const atStart = local <= 0.001;
  if (!atStart && (local < 0.05 || local > clip.duration - 0.05)) {
    toast('Park the playhead inside the clip', true);
    return;
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) { toast('Could not capture the frame', true); return; }
    const file = new File([blob], `freeze-${Date.now()}.png`, { type: 'image/png' });
    const data = await uploadFiles([file], { category: 'image' });
    const asset = data?.media?.[0];
    if (!asset) throw new Error('Freeze frame upload failed');
    await reloadMediaFromServer();

    const snap = cloneTimeline(S.timeline);
    const FREEZE = 2;
    const at = S.playhead;
    // Split at the playhead, ripple later clips, then drop the still in the gap.
    if (local > 0.05) splitClip(S.timeline, track.id, clip.id, at);
    const right = track.clips.filter((c) => c.start >= at - 1e-6).sort((a, b) => a.start - b.start);
    for (const c of right) moveClip(S.timeline, track.id, c.id, c.start + FREEZE);
    const nc = addClip(S.timeline, track.id, {
      kind: 'image', assetId: asset.id, start: at, duration: FREEZE,
      fit: clip.fit || 'cover', scale: clip.scale ?? 1, posX: clip.posX ?? 50, posY: clip.posY ?? 50,
      rotate: clip.rotate || 0, effect: clip.effect || 'none',
      grade: clip.grade || null, transitionIn: normalizeTransition(clip.transitionIn),
      transitionDur: clip.transitionDur ?? DEFAULT_TRANSITION,
    });
    selectOnly(track.id, nc.id);
    commit(snap);
    renderTimeline(); renderInspector(); updateFooter(); updatePreviewText(true); syncMedia(true);
    updatePreviewBadges(); flashPreview(); updateSelBox();
    toast('Freeze frame inserted (2s)');
  } catch (e) { toast(e.message || 'Freeze frame failed', true); }
}

/* ================= library actions (one-click, CapCut-style) =============== */

const EFFECT_LABELS = {
  none: 'Original', bw: 'B&W', vintage: 'Vintage', teal: 'Teal & orange', golden: 'Golden hour',
  noir: 'Noir', neon: 'Neon', luxury: 'Luxury', vignette: 'Vignette', soft: 'Soft focus',
  sepia: 'Sepia', warm: 'Warm', cool: 'Cool', vivid: 'Vivid',
};
const MOTION_LIB = [
  ['push-in', 'Push-in'], ['punch', 'Punch'], ['reveal', 'Zoom reveal'],
  ['kenburns', 'Ken Burns'], ['spin', 'Spin 360°'], ['float', 'Float'],
];
const TRANSITION_LIB = [
  ['fade', 'Crossfade'], ['dip', 'Dip to black'], ['flash', 'White flash'],
  ['zoom', 'Zoom in'], ['slide', 'Slide'], ['none', 'Hard cut'],
];

/** Apply a text style preset to the text at the playhead (creates one if needed). */
function quickTextPreset(name) {
  const preset = TEXT_PRESETS[name];
  if (!preset) return;
  const found = ensureTextAtPlayhead();
  if (!found) { toast('Could not add a text clip', true); return; }
  const { track, clip } = found;
  const t = clip.text || {};
  quickCommit(() => setClipProps(S.timeline, track.id, clip.id, {
    text: { ...preset, content: t.content && t.content !== 'Your text' ? t.content : preset.content },
  }));
  toast(`Text style: ${name}`);
}

/** Apply a one-click filter (grade preset) to the target clip. */
function applyGradePreset(name) {
  const want = normalizeGrade({ ...DEFAULT_GRADE, ...GRADE_PRESETS[name] });
  const found = resolveMediaClip();
  if (!found) { toast('Add a video/image clip first', true); return; }
  const { track, clip } = found;
  selectOnly(track.id, clip.id);
  quickCommit(() => setClipProps(S.timeline, track.id, clip.id, { grade: want }));
  toast(`Filter: ${name}`);
}

/** Toggle a speed-curve ramp on the target clip. */
function applyCurvePreset(name) {
  const found = resolveMediaClip();
  if (!found) { toast('Add a video/image clip first', true); return; }
  const { track, clip } = found;
  selectOnly(track.id, clip.id);
  const on = speedCurveOf(clip)?.preset === name && name !== 'constant';
  quickCommit(() => setClipProps(S.timeline, track.id, clip.id, {
    speedCurve: on ? null : { preset: name, points: SPEED_CURVE_PRESETS[name] },
  }));
  toast(on ? 'Speed curve removed' : `Speed ramp: ${CURVE_PRESET_LABELS[name] || name}`);
}

/** Toggle a transition on the target clip. */
function applyTransitionToSelection(tr) {
  const found = resolveMediaClip();
  if (!found) { toast('Add a video/image clip first', true); return; }
  const { track, clip } = found;
  selectOnly(track.id, clip.id);
  const on = normalizeTransition(clip.transitionIn) === tr && tr !== 'none';
  quickCommit(() => setClipProps(S.timeline, track.id, clip.id, { transitionIn: on ? 'none' : tr }));
  toast(on ? 'Transition removed' : `Transition: ${tr}`);
}

/** Toggle reverse on the target clip. */
function toggleReverse() {
  const found = resolveMediaClip();
  if (!found) { toast('Add a video/image clip first', true); return; }
  const { track, clip } = found;
  selectOnly(track.id, clip.id);
  const on = !normalizeReverse(clip.reverse);
  quickCommit(() => setClipProps(S.timeline, track.id, clip.id, { reverse: on }));
  toast(on ? 'Reversed — plays backwards' : 'Reverse off');
}

/* ================= inspector ================= */

function currentKfValue(clip, prop, localT) {
  const base = normalizeTransform(clip);
  const g = gradeOf(clip);
  if (prop === 'scale') return evalKeyframes(clip, localT, 'scale', base.scale);
  if (prop === 'posX') return evalKeyframes(clip, localT, 'posX', base.posX);
  if (prop === 'posY') return evalKeyframes(clip, localT, 'posY', base.posY);
  if (prop === 'rotate') return evalKeyframes(clip, localT, 'rotate', base.rotate);
  if (prop === 'opacity') return evalKeyframes(clip, localT, 'opacity', 1);
  if (prop === 'volume') return evalKeyframes(clip, localT, 'volume', clip.volume ?? 1);
  if (prop === 'exposure') return evalKeyframes(clip, localT, 'exposure', g.exposure);
  if (prop === 'contrast') return evalKeyframes(clip, localT, 'contrast', g.contrast);
  if (prop === 'saturation') return evalKeyframes(clip, localT, 'saturation', g.saturation);
  if (prop === 'temperature') return evalKeyframes(clip, localT, 'temperature', g.temperature);
  return 0;
}

function summarizeKeyframes(clip) {
  const kf = clip.keyframes || {};
  const parts = KEYFRAME_PROPS
    .filter((p) => Array.isArray(kf[p]) && kf[p].length)
    .map((p) => `${p}[${kf[p].length}]`);
  if (!parts.length) return 'No keyframes — +prop captures the value at the playhead.';
  return `Keyframes: ${parts.join(' · ')}`;
}

function renderInspector(focusText = false) {
  const box = document.getElementById('inspector');
  if (!box) return;
  box.innerHTML = '';
  if (S.quickRefs) S.quickRefs.kf = {}; // rebuilt below; cleared when nothing is selected
  const found = S.selection ? (() => { try { return getClip(S.timeline, S.selection.trackId, S.selection.clipId); } catch { return null; } })() : null;
  if (!found) {
    box.append(
      el('div', { class: 'inspector-empty' },
        el('div', { class: 'ie-icon', text: '▣' }),
        el('div', { class: 'ie-title', text: 'Click a clip on the timeline' }),
        el('div', { class: 'ie-sub', text: 'Size, color, speed, fades, and text styles open here for the selected clip.' }),
        el('div', { class: 'ie-hint', text: 'Quick looks, Motion, and Text FX are under the preview — or open Clip Tools on the right (or bottom sheet on mobile).' })
      )
    );
    refreshQuickStates();
    S.renderLib?.();
    return;
  }
  const { track, clip } = found;
  const num = (label, value, onchange, step = '0.1', min = '0') =>
    el('label', { class: 'field' }, el('span', { text: label }),
      el('input', { class: 'input', type: 'number', step, min, value: String(value), onchange: (e) => onchange(Number(e.target.value)) }));

  const apply = (mut) => {
    const snapshot = cloneTimeline(S.timeline);
    try {
      mut();
      commit(snapshot);
      renderTimeline(); renderInspector(); updateFooter(); updatePreviewText(true); syncMedia(true);
      updatePreviewBadges();
      flashPreview();
      updateSelBox();
    } catch (e) { toast(e.message, true); renderInspector(); }
  };

  const grid = el('div', { class: 'insp-grid' },
    num('Start (s)', clip.start, (v) => apply(() => moveClip(S.timeline, track.id, clip.id, v))),
    num('Duration (s)', clip.duration, (v) => apply(() => trimClip(S.timeline, track.id, clip.id, { duration: v }))),
    clip.kind !== 'text' ? num('Start inside clip (s)', clip.srcIn, (v) => apply(() => trimClip(S.timeline, track.id, clip.id, { srcIn: v })), '0.1', '0') : null,
    (clip.kind === 'audio' || clip.kind === 'video') ? num('Volume (0–4)', clip.volume, (v) => apply(() => setClipProps(S.timeline, track.id, clip.id, { volume: v })), '0.05', '0') : null,
    (clip.kind === 'audio' || clip.kind === 'video')
      ? el('label', { class: 'field' }, el('span', { text: `Speed (${MIN_SPEED}–${MAX_SPEED}×)` }),
          el('div', { class: 'speed-row' },
            el('input', {
              class: 'input', type: 'number', step: '0.05', min: String(MIN_SPEED), max: String(MAX_SPEED),
              value: String(clip.speed ?? 1),
              onchange: (e) => apply(() => setClipProps(S.timeline, track.id, clip.id, { speed: clampSpeed(Number(e.target.value)) })),
            }),
            el('button', { class: 'btn sm', text: '0.5×', onclick: () => apply(() => setClipProps(S.timeline, track.id, clip.id, { speed: clampSpeed(0.5) })) }),
            el('button', { class: 'btn sm', text: '1×', onclick: () => apply(() => setClipProps(S.timeline, track.id, clip.id, { speed: 1 })) }),
            el('button', { class: 'btn sm', text: '2×', onclick: () => apply(() => setClipProps(S.timeline, track.id, clip.id, { speed: clampSpeed(2) })) }),
          ))
      : null,
    (clip.kind === 'audio' || clip.kind === 'video' || clip.kind === 'image')
      ? num('Fade in (s)', clip.fadeIn ?? 0, (v) => apply(() => setClipProps(S.timeline, track.id, clip.id, { fadeIn: clampFade(v) })), '0.05', '0')
      : null,
    (clip.kind === 'audio' || clip.kind === 'video' || clip.kind === 'image')
      ? num('Fade out (s)', clip.fadeOut ?? 0, (v) => apply(() => setClipProps(S.timeline, track.id, clip.id, { fadeOut: clampFade(v) })), '0.05', '0')
      : null,
    (clip.kind === 'video' || clip.kind === 'image')
      ? el('label', { class: 'field' }, el('span', { text: 'Transition in' }),
          el('select', { class: 'input', onchange: (e) => apply(() => setClipProps(S.timeline, track.id, clip.id, { transitionIn: e.target.value })) },
            TRANSITIONS.map((tr) => el('option', {
              value: tr,
              selected: normalizeTransition(clip.transitionIn) === tr || undefined,
            }, tr === 'none' ? 'Hard cut' : tr))))
      : null,
    (clip.kind === 'video' || clip.kind === 'image')
      ? el('label', { class: 'field' }, el('span', { text: 'Cut length (s)' }),
          el('input', {
            class: 'input', type: 'number', step: '0.05',
            min: String(MIN_TRANSITION), max: String(MAX_TRANSITION),
            value: String(normalizeTransitionDur(clip.transitionDur)),
            title: 'How long the transition takes to come in (0.05–2s)',
            onchange: (e) => apply(() => setClipProps(S.timeline, track.id, clip.id, {
              transitionDur: normalizeTransitionDur(Number(e.target.value)),
            })),
          }))
      : null,
    (clip.kind === 'video' || clip.kind === 'image' || clip.kind === 'audio')
      ? el('div', { class: 'field kf-field' },
          el('span', { text: 'Keyframes (at playhead)' }),
          el('div', { class: 'speed-row' },
            ...KEYFRAME_PROPS.filter((p) => {
              if (p === 'volume') return clip.kind === 'audio' || clip.kind === 'video';
              if (GRADE_KEYFRAME_PROPS.includes(p)) return clip.kind === 'video' || clip.kind === 'image';
              if (p === 'rotate' || p === 'scale' || p === 'posX' || p === 'posY') {
                return clip.kind === 'video' || clip.kind === 'image';
              }
              return true;
            }).map((prop) => {
              const kfLabels = {
                scale: '+ Size', posX: '+ Move X', posY: '+ Move Y',
                rotate: '+ Rotate', opacity: '+ Opacity', volume: '+ Volume',
                exposure: '+ Exposure', contrast: '+ Contrast',
                saturation: '+ Saturation', temperature: '+ Temp',
              };
              const kfTips = {
                scale: 'Animate size over time from this point',
                posX: 'Animate horizontal position over time',
                posY: 'Animate vertical position over time',
                rotate: 'Animate rotation (degrees) over time',
                opacity: 'Animate opacity (transparency) over time',
                volume: 'Animate volume over time',
                exposure: 'Animate brightness over time',
                contrast: 'Animate contrast over time',
                saturation: 'Animate color intensity over time',
                temperature: 'Animate warm/cool balance over time',
              };
              const label = kfLabels[prop] || prop;
              const btn = el('button', {
                class: 'btn sm kf-btn',
                title: `${kfTips[prop] || `Add ${prop} keyframe`} — click again to remove the key at the playhead`,
                text: label,
                onclick: () => apply(() => {
                  const localT = Math.max(0, round3(S.playhead - clip.start));
                  const existing = clip.keyframes?.[prop] || [];
                  const has = existing.some((p) => Math.abs(Number(p.t) - localT) <= 0.001);
                  const kf = { ...(clip.keyframes || {}) };
                  if (has) {
                    const rest = existing.filter((p) => Math.abs(Number(p.t) - localT) > 0.001);
                    if (rest.length) kf[prop] = rest; else delete kf[prop];
                    setClipProps(S.timeline, track.id, clip.id, { keyframes: kf });
                    toast(`${label.replace(/^\+\s*/, '')} key removed`);
                    return;
                  }
                  const next = [...existing, { t: localT, v: currentKfValue(clip, prop, localT) }];
                  next.sort((a, b) => a.t - b.t);
                  kf[prop] = next;
                  setClipProps(S.timeline, track.id, clip.id, { keyframes: kf });
                  toast(`${label.replace(/^\+\s*/, '')} key added @ ${fmtDuration(localT)}`);
                }),
              });
              if (S.quickRefs?.kf) S.quickRefs.kf[prop] = btn;
              return btn;
            }),
            el('button', {
              class: 'btn sm', text: 'Smooth', title: 'Ease all keyframes (spline smooth, like Resolve)',
              onclick: () => apply(() => {
                const src = clip.keyframes || {};
                const kf = {};
                let n = 0;
                for (const [prop, pts] of Object.entries(src)) {
                  if (!Array.isArray(pts) || !pts.length) continue;
                  kf[prop] = pts.map((p, i, arr) => (i < arr.length - 1 ? { ...p, ease: 'ease' } : p));
                  n += kf[prop].length;
                }
                if (!n) { toast('No keyframes to smooth — add some with + buttons first', true); return; }
                setClipProps(S.timeline, track.id, clip.id, { keyframes: kf });
                toast('Keyframes smoothed (ease in/out)');
              }),
            }),
            el('button', {
              class: 'btn sm', text: 'Clear animations', title: 'Remove all animated values (keyframes) on this clip',
              onclick: () => apply(() => setClipProps(S.timeline, track.id, clip.id, { keyframes: {} })),
            })
          ),
          el('div', { class: 'kf-list', text: summarizeKeyframes(clip) })
        )
      : null
  );

  if (clip.kind === 'text') {
    const t = clip.text || {};
    const content = el('textarea', { class: 'input', rows: 3 }, t.content || '');
    const role = el('select', { class: 'input' },
      ['hook', 'title', 'quote', 'subtitle', 'cta', 'caption', 'watermark'].map((r) => el('option', { value: r, selected: t.role === r || undefined }, r)));
    const pos = el('select', { class: 'input' },
      ['top', 'center', 'bottom', 'custom'].map((p) => el('option', { value: p, selected: (t.position || 'center') === p || undefined }, p)));
    const xPct = el('input', { class: 'input', type: 'number', min: '0', max: '100', value: String(t.xPct ?? 50) });
    const yPct = el('input', { class: 'input', type: 'number', min: '0', max: '100', value: String(t.yPct ?? 50) });
    const size = el('input', { class: 'input', type: 'number', min: '8', max: '400', value: String(t.size || 72) });
    const color = el('input', { class: 'input', type: 'color', value: /^#[0-9a-fA-F]{6}$/.test(t.color || '') ? t.color : '#ffffff', style: 'padding:2px;height:32px' });
    const bg = el('input', { class: 'input', type: 'text', value: t.bg || '', placeholder: 'e.g. white, #ffffff, black@0.55', 'aria-label': 'Background color' });
    const bgMode = el('select', { class: 'input' },
      BG_MODES.map((m) => el('option', {
        value: m,
        selected: normalizeBgMode(t.bgMode || (t.bg ? 'inline' : 'none')) === m || undefined,
      }, m === 'none' ? 'No box' : m === 'inline' ? 'Inline box' : 'Full-width banner')));
    const bold = el('select', { class: 'input' },
      [['1', 'Bold'], ['0', 'Regular']].map(([v, lab]) =>
        el('option', { value: v, selected: String(t.bold !== false ? '1' : '0') === v || undefined }, lab)));
    const upper = el('select', { class: 'input' },
      [['0', 'As typed'], ['1', 'UPPERCASE']].map(([v, lab]) =>
        el('option', { value: v, selected: String(t.uppercase ? '1' : '0') === v || undefined }, lab)));
    const italic = el('select', { class: 'input' },
      [['0', 'Roman'], ['1', 'Italic']].map(([v, lab]) =>
        el('option', { value: v, selected: String(t.italic ? '1' : '0') === v || undefined }, lab)));
    const alignSel = el('select', { class: 'input' },
      TEXT_ALIGNS.map((a) => el('option', {
        value: a, selected: normalizeTextAlign(t.align || 'center') === a || undefined,
      }, a)));
    const animSel = el('select', { class: 'input' },
      TEXT_ANIMS.map((a) => el('option', {
        value: a, selected: normalizeTextAnim(t.anim || 'none') === a || undefined,
      }, a === 'none' ? 'None'
        : a === 'fade' ? 'Fade in/out'
        : a === 'pop' ? 'Pop'
        : a === 'slide-up' ? 'Slide up'
        : a === 'slide-down' ? 'Slide down'
        : a === 'bounce' ? 'Bounce'
        : a === 'zoom-in' ? 'Zoom in'
        : a === 'flicker' ? 'Flicker'
        : a === 'glitch' ? 'Glitch (digital)'
        : a)));
    const strokeW = el('input', { class: 'input', type: 'number', min: '0', max: '16', step: '1', value: String(Math.round(t.strokeWidth || 0)) });
    const strokeC = el('input', { class: 'input', type: 'color', value: /^#[0-9a-fA-F]{6}$/.test(t.strokeColor || '') ? t.strokeColor : '#000000', style: 'padding:2px;height:32px' });
    const shadowSel = el('select', { class: 'input' },
      [['0', 'Off'], ['1', 'On']].map(([v, lab]) =>
        el('option', { value: v, selected: String(t.shadow ? '1' : '0') === v || undefined }, lab)));
    const ls = el('input', { class: 'input', type: 'number', min: '0', max: '40', value: String(Math.round(t.letterSpacing || 0)) });
    const padX = el('input', { class: 'input', type: 'number', min: '0', max: '160', value: String(Math.round(t.padX ?? 40)) });
    const padY = el('input', { class: 'input', type: 'number', min: '0', max: '120', value: String(Math.round(t.padY ?? 22)) });
    const widthPctIn = el('input', { class: 'input', type: 'number', min: '10', max: '100', value: String(Math.round(t.widthPct ?? 100)) });
    const animDur = el('input', { class: 'input', type: 'number', min: '0.05', max: '2', step: '0.05', value: String(t.animDur ?? 0.3) });
    const fontSel = el('select', { class: 'input' },
      TEXT_FONTS.map((f) => el('option', { value: f, selected: (t.font || 'Arial') === f || undefined }, f)));
    // Premium typography controls
    const opacity = el('input', { class: 'input', type: 'number', min: '0.05', max: '1', step: '0.05', value: String(t.opacity ?? 1) });
    const rotateIn = el('input', { class: 'input', type: 'number', min: '-360', max: '360', step: '1', value: String(Math.round(t.rotate || 0)), title: 'Rotate the text (degrees) — e.g. -90 for vertical' });
    const glowSel = el('select', { class: 'input' },
      [['0', 'Off'], ['1', 'On']].map(([v, lab]) =>
        el('option', { value: v, selected: String(t.glow ? '1' : '0') === v || undefined }, lab)));
    const glowC = el('input', { class: 'input', type: 'color', value: /^#[0-9a-fA-F]{6}$/.test(t.glowColor || '') ? t.glowColor : '#ffffff', style: 'padding:2px;height:32px' });
    const glowSize = el('input', { class: 'input', type: 'number', min: '0', max: '40', value: String(Math.round(t.glowSize || 0)) });
    const staggerSel = el('select', { class: 'input' },
      [['0', 'Off'], ['1', 'Word-by-word']].map(([v, lab]) =>
        el('option', { value: v, selected: String(t.stagger ? '1' : '0') === v || undefined }, lab)));
    const lineHeight = el('input', { class: 'input', type: 'number', min: '0.8', max: '2.4', step: '0.02', value: String(t.lineHeight ?? 1.28) });

    const saveText = () => apply(() => setClipProps(S.timeline, track.id, clip.id, {
      text: {
        content: content.value, role: role.value, position: pos.value,
        xPct: pos.value === 'custom' ? Number(xPct.value) : undefined,
        yPct: pos.value === 'custom' ? Number(yPct.value) : undefined,
        size: Number(size.value), color: color.value, bg: bg.value,
        bgMode: bgMode.value, bold: bold.value === '1', uppercase: upper.value === '1',
        italic: italic.value === '1',
        align: alignSel.value, anim: animSel.value, animDur: Number(animDur.value),
        strokeWidth: Number(strokeW.value), strokeColor: strokeC.value,
        shadow: shadowSel.value === '1', letterSpacing: Number(ls.value),
        padX: Number(padX.value), padY: Number(padY.value),
        widthPct: Number(widthPctIn.value),
        font: fontSel.value,
        opacity: Number(opacity.value), rotate: Number(rotateIn.value),
        glow: glowSel.value === '1', glowColor: glowC.value, glowSize: Number(glowSize.value),
        stagger: staggerSel.value === '1', lineHeight: Number(lineHeight.value),
      },
    }));
    content.addEventListener('input', () => { /* live preview */ updatePreviewText(true); });
    content.addEventListener('change', saveText);
    [role, pos, size, color, bg, xPct, yPct, bgMode, bold, upper, italic,
      alignSel, animSel, strokeW, strokeC, shadowSel, ls, padX, padY, widthPctIn, animDur, fontSel,
      opacity, rotateIn, glowSel, glowC, glowSize, staggerSel, lineHeight,
    ].forEach((c) => c.addEventListener('change', saveText));

    const applyPreset = (name) => {
      const p = TEXT_PRESETS[name];
      if (!p) return;
      apply(() => setClipProps(S.timeline, track.id, clip.id, {
        text: { ...p, content: content.value || p.content },
      }));
      toast(`Style: ${name}`);
    };
    const applyCaptionPreset = (name) => {
      const p = CAPTION_PRESETS[name];
      if (!p) return;
      apply(() => setClipProps(S.timeline, track.id, clip.id, {
        text: { ...p, content: content.value || p.content },
      }));
      toast(`Caption style: ${name}`);
    };

    const isCaptionTrack = track.id === 't2' || t.role === 'caption' || t.role === 'subtitle';

    grid.append(
      el('label', { class: 'field full' }, el('span', { text: 'Content' }), content),
      el('div', { class: 'full' }, el('div', { class: 'insp-sec' }, 'Premium styles')),
      el('div', { class: 'full style-presets' },
        el('button', { class: 'btn sm primary', text: '▣ Top title bar', title: 'Optimized full-width white top card', onclick: () => applyPreset('meme') }),
        el('button', { class: 'btn sm', text: '📰 News', title: 'News-style headline block', onclick: () => applyPreset('news') }),
        el('button', { class: 'btn sm', text: '▭ Lower third', title: 'Lower-third bar for names', onclick: () => applyPreset('lower') }),
        el('button', { class: 'btn sm', text: 'A Outline', title: 'Outlined text', onclick: () => applyPreset('outline') }),
        el('button', { class: 'btn sm', text: '▮ Caption', title: 'Caption bar', onclick: () => applyPreset('caption') }),
        el('button', { class: 'btn sm', text: '▰ Highlight', title: 'Highlighted phrase', onclick: () => applyPreset('highlight') }),
        el('button', { class: 'btn sm', text: '🎬 Cinematic', title: 'Wide-tracked cinematic title with glow', onclick: () => applyPreset('cinematic') }),
        el('button', { class: 'btn sm', text: '👑 Luxury', title: 'Gold luxury serif with glow', onclick: () => applyPreset('luxury') }),
        el('button', { class: 'btn sm', text: '⚡ Neon', title: 'Flickering neon glow title', onclick: () => applyPreset('neon') }),
        el('button', { class: 'btn sm', text: '◻ Minimal', title: 'Clean minimal subtitle', onclick: () => applyPreset('minimal') }),
        el('button', { class: 'btn sm', text: '🛑 Bold hook', title: 'Heavy outlined hook for first 2s', onclick: () => applyPreset('boldhook') }),
        el('button', { class: 'btn sm', text: 'Clear box', title: 'Remove background box from text', onclick: () => apply(() => setClipProps(S.timeline, track.id, clip.id, { text: { bgMode: 'none', bg: '' } })) }),
      ),
      el('div', { class: 'full' }, el('div', { class: 'insp-sec' }, 'Caption styles (word-by-word · safe area)')),
      el('div', { class: 'full style-presets' },
        el('button', { class: 'btn sm', text: 'Clean', title: 'Readable bold white, no box, safe-area bottom', onclick: () => applyCaptionPreset('clean') }),
        el('button', { class: 'btn sm', text: 'Boxed', title: 'Dark rounded box behind caption', onclick: () => applyCaptionPreset('boxed') }),
        el('button', { class: 'btn sm', text: 'Outline', title: 'Heavy black outline — readable on anything', onclick: () => applyCaptionPreset('outline') }),
        el('button', { class: 'btn sm', text: '🔥 Pop', title: 'Yellow pop caption, word-by-word entrance', onclick: () => applyCaptionPreset('pop') }),
        el('button', { class: 'btn sm', text: '🎤 Karaoke', title: 'Word-by-word reveal with box — reels style', onclick: () => applyCaptionPreset('karaoke') }),
        el('button', { class: 'btn sm', text: 'Whisper', title: 'Soft italic serif caption', onclick: () => applyCaptionPreset('whisper') }),
      ),
      el('div', { class: 'full' }, el('div', { class: 'insp-sec' }, 'Layout')),
      el('label', { class: 'field' }, el('span', { text: 'Role' }), role),
      el('label', { class: 'field' }, el('span', { text: 'Position' }), pos),
      pos.value === 'custom' ? el('label', { class: 'field' }, el('span', { text: 'X %' }), xPct) : null,
      pos.value === 'custom' ? el('label', { class: 'field' }, el('span', { text: 'Y %' }), yPct) : null,
      el('label', { class: 'field' }, el('span', { text: 'Align' }), alignSel),
      el('label', { class: 'field' }, el('span', { text: 'Box style' }), bgMode),
      el('label', { class: 'field' }, el('span', { text: 'Width %' }), widthPctIn),
      el('label', { class: 'field' }, el('span', { text: 'Pad X' }), padX),
      el('label', { class: 'field' }, el('span', { text: 'Pad Y' }), padY),
      el('div', { class: 'full' }, el('div', { class: 'insp-sec' }, 'Typography')),
      el('label', { class: 'field full' }, el('span', { text: 'Font' }), fontSel),
      el('label', { class: 'field' }, el('span', { text: 'Size (px @1080)' }), size),
      el('label', { class: 'field' }, el('span', { text: 'Color' }), color),
      el('label', { class: 'field full' }, el('span', { text: 'Background' }), bg),
      el('label', { class: 'field' }, el('span', { text: 'Weight' }), bold),
      el('label', { class: 'field' }, el('span', { text: 'Case' }), upper),
      el('label', { class: 'field' }, el('span', { text: 'Style' }), italic),
      el('label', { class: 'field' }, el('span', { text: 'Letter spacing' }), ls),
      el('label', { class: 'field' }, el('span', { text: 'Line height' }), lineHeight),
      el('label', { class: 'field' }, el('span', { text: 'Opacity (0–1)' }), opacity),
      el('div', { class: 'full' }, el('div', { class: 'insp-sec' }, 'Effects · rotation · motion')),
      el('label', { class: 'field' }, el('span', { text: 'Rotate (°)' }), rotateIn),
      el('label', { class: 'field' }, el('span', { text: 'Stroke px' }), strokeW),
      el('label', { class: 'field' }, el('span', { text: 'Stroke color' }), strokeC),
      el('label', { class: 'field' }, el('span', { text: 'Drop shadow' }), shadowSel),
      el('label', { class: 'field' }, el('span', { text: 'Glow' }), glowSel),
      glowSel.value === '1' ? el('label', { class: 'field' }, el('span', { text: 'Glow color' }), glowC) : null,
      glowSel.value === '1' ? el('label', { class: 'field' }, el('span', { text: 'Glow size' }), glowSize) : null,
      el('label', { class: 'field' }, el('span', { text: 'Word stagger' }), staggerSel),
      el('label', { class: 'field' }, el('span', { text: 'Animation' }), animSel),
      el('label', { class: 'field' }, el('span', { text: 'Anim (s)' }), animDur),
      isCaptionTrack ? el('div', { class: 'full region-hint', html: 'Captions on <b>T2</b> also export to <b>captions.srt</b>. Try <b>Karaoke</b> for word-by-word reveal.' }) : null,
    );
    if (focusText) setTimeout(() => { content.focus(); content.select(); }, 60);
  }

  if (clip.kind === 'image' || clip.kind === 'video') {
    const tr = normalizeTransform(clip);
    const fitSel = el('select', { class: 'input' },
      FIT_MODES.map((f) => el('option', {
        value: f,
        selected: tr.fit === f || undefined,
      }, f === 'cover' ? 'Cover (crop to fill)' : f === 'contain' ? 'Contain (no cut, bars)' : 'Fill (stretch)')));
    fitSel.addEventListener('change', () => apply(() => setClipProps(S.timeline, track.id, clip.id, { fit: fitSel.value })));

    const zoomInput = el('input', {
      class: 'input', type: 'number', step: '0.05', min: String(MIN_ZOOM), max: String(MAX_ZOOM),
      value: String(tr.scale),
      onchange: (e) => apply(() => setClipProps(S.timeline, track.id, clip.id, { scale: clampZoom(Number(e.target.value)) })),
    });
    const zoomRow = el('div', { class: 'speed-row' },
      zoomInput,
      el('button', { class: 'btn sm', text: '0.5×', onclick: () => apply(() => setClipProps(S.timeline, track.id, clip.id, { scale: clampZoom(0.5) })) }),
      el('button', { class: 'btn sm', text: '1×', onclick: () => apply(() => setClipProps(S.timeline, track.id, clip.id, { scale: 1 })) }),
      el('button', { class: 'btn sm', text: '1.5×', onclick: () => apply(() => setClipProps(S.timeline, track.id, clip.id, { scale: clampZoom(1.5) })) }),
    );
    const posX = num('Focus X %', tr.posX,
      (v) => apply(() => setClipProps(S.timeline, track.id, clip.id, { posX: v })), '1', '0');
    const posY = num('Focus Y %', tr.posY,
      (v) => apply(() => setClipProps(S.timeline, track.id, clip.id, { posY: v })), '1', '0');
    const rot = num('Rotation (°)', tr.rotate,
      (v) => apply(() => setClipProps(S.timeline, track.id, clip.id, { rotate: v })), '1', '-360');

    const effectSel = el('select', { class: 'input' },
      EFFECTS.map((ef) => el('option', {
        value: ef,
        selected: normalizeEffect(clip.effect) === ef || undefined,
      }, ef === 'none' ? 'None (original)'
        : ef === 'bw' ? 'Black & white'
        : ef === 'vintage' ? 'Vintage (faded film)'
        : ef === 'teal' ? 'Teal & orange'
        : ef === 'golden' ? 'Golden hour'
        : ef === 'noir' ? 'Noir (high-contrast B&W)'
        : ef === 'neon' ? 'Neon pop'
        : ef === 'luxury' ? 'Luxury gold'
        : ef === 'vignette' ? 'Vignette (dark edges)'
        : ef === 'soft' ? 'Soft focus'
        : ef.charAt(0).toUpperCase() + ef.slice(1))));
    effectSel.addEventListener('change', () => apply(() => setClipProps(S.timeline, track.id, clip.id, { effect: effectSel.value })));

    grid.append(
      el('div', { class: 'full insp-sec' }, 'Fit / size + look'),
      el('label', { class: 'field full' }, el('span', { text: 'Fit mode' }), fitSel),
      el('label', { class: 'field full' }, el('span', { text: `Zoom (${MIN_ZOOM}–${MAX_ZOOM}×)` }), zoomRow),
      posX, posY, rot,
      el('label', { class: 'field full' }, el('span', { text: 'Color effect' }), effectSel),
      el('div', { class: 'full', style: 'display:flex;gap:6px;flex-wrap:wrap' },
        el('button', { class: 'btn sm', text: 'Reset transform', onclick: () => apply(() => setClipProps(S.timeline, track.id, clip.id, { fit: 'cover', scale: 1, posX: 50, posY: 50, rotate: 0, effect: 'none' })) }),
        el('button', { class: 'btn sm', text: 'No crop (contain)', onclick: () => apply(() => setClipProps(S.timeline, track.id, clip.id, { fit: 'contain', scale: 1, posX: 50, posY: 50 })) }),
        el('button', { class: 'btn sm primary', text: 'Make black & white', title: 'Apply black & white color effect', onclick: () => apply(() => setClipProps(S.timeline, track.id, clip.id, { effect: 'bw' })) }),
      ),
      el('div', { class: 'full insp-sec' }, 'Color grading'),
      ...GRADE_KEYS.map((key) => {
        const [lo, hi] = GRADE_RANGES[key];
        const cur = gradeOf(clip)[key];
        const out = el('output', { class: 'grade-val', text: cur.toFixed(2) });
        const rng = el('input', {
          class: 'input range', type: 'range', min: String(lo), max: String(hi), step: '0.01',
          value: String(cur), 'aria-label': GRADE_LABELS[key],
          title: `${GRADE_LABELS[key]} — drag for a live look (undo restores)`,
        });
        let snap = null;
        rng.addEventListener('input', () => {
          const v = Number(rng.value);
          if (!snap) snap = cloneTimeline(S.timeline);
          setClipProps(S.timeline, track.id, clip.id, { grade: { ...gradeOf(clip), [key]: v } });
          out.textContent = v.toFixed(2);
          syncMedia(false);
        });
        rng.addEventListener('change', () => {
          if (!snap) return;
          const s = snap; snap = null;
          commit(s);
          renderTimeline(); renderInspector(); updateFooter(); updatePreviewText(true); syncMedia(false);
          updatePreviewBadges(); flashPreview(); updateSelBox();
        });
        return el('label', { class: 'field full grade-field' },
          el('span', { text: GRADE_LABELS[key] }), rng, out);
      }),
      el('div', { class: 'full insp-sec' }, 'Looks'),
      el('div', { class: 'full style-presets' },
        ...Object.keys(GRADE_PRESETS).map((name) => {
          const want = normalizeGrade({ ...DEFAULT_GRADE, ...GRADE_PRESETS[name] });
          const cur = gradeOf(clip);
          const isActive = GRADE_KEYS.every((k) => Math.abs((cur[k] || 0) - (want[k] || 0)) < 1e-6);
          return el('button', {
            class: isActive ? 'btn sm active' : 'btn sm',
            text: name.charAt(0).toUpperCase() + name.slice(1),
            title: isActive ? 'Active look — click Neutral to reset' : `Apply the ${name} look`,
            onclick: () => apply(() => setClipProps(S.timeline, track.id, clip.id, { grade: want })),
          });
        }),
      ),
      el('div', { class: 'full', style: 'display:flex;gap:6px;flex-wrap:wrap' },
        el('button', {
          class: 'btn sm', text: 'Reset grade', title: 'Neutral color on this clip',
          onclick: () => apply(() => setClipProps(S.timeline, track.id, clip.id, { grade: { ...DEFAULT_GRADE } })),
        }),
        el('button', {
          class: 'btn sm', text: 'Grade all clips', title: 'Copy this clip\u2019s color grading onto every video/image clip',
          onclick: () => { const n = gradeAllClips(gradeOf(clip)); if (n) toast(`Grade copied to ${n} clip(s)`); },
        }),
        el('button', {
          class: 'btn sm', text: 'Clear all grades', title: 'Neutral color everywhere',
          onclick: () => { const n = gradeAllClips({ ...DEFAULT_GRADE }); if (n) toast(`Grades cleared on ${n} clip(s)`); },
        }),
      ),
      ...(clip.kind === 'image'
        ? (() => {
            const asset = S.media.find((m) => m.id === clip.assetId);
            if (!asset || (asset.kind !== 'image' && asset.category !== 'image')) return [];
            return [el('div', { class: 'full', style: 'margin-top:6px' },
              el('button', {
                class: 'btn sm block',
                text: 'Edit source image…',
                title: 'Crop, rotate, adjust and save this image (or a new copy)',
                onclick: () => editAssetImage(asset, () => { reloadMediaFromServer(); }),
              })
            )];
          })()
        : []),
    );
    appendSpeedSection(grid, apply, track, clip);
    appendChromaSection(grid, apply, track, clip);
    appendMaskSection(grid, apply, track, clip);
  }

  if (clip.kind === 'audio') {
    appendSpeedSection(grid, apply, track, clip, false);
  }

  if ((clip.kind === 'image' || clip.kind === 'video') && track.id !== 'v1') {
    const ov = clip.overlay || { xPct: 50, yPct: 50, widthPct: 35 };
    const mk = (label, key) => num(label, ov[key], (v) => apply(() => setClipProps(S.timeline, track.id, clip.id, { overlay: { ...ov, [key]: v } })), '1', '0');
    grid.append(mk('X %', 'xPct'), mk('Y %', 'yPct'), mk('Width %', 'widthPct'));
  }

  box.append(grid,
    el('div', { class: 'row', style: 'margin-top:10px;gap:6px' },
      el('button', { class: 'btn sm', text: 'Split @ playhead', onclick: doSplit }),
      el('button', { class: 'btn sm', text: 'Duplicate', onclick: doDuplicate }),
      el('button', { class: 'btn sm danger', text: 'Delete', onclick: doDelete })
    ),
    el('div', { class: 'muted', style: 'font-size:10.5px;margin-top:8px', text: `Track ${track.id.toUpperCase()} · ${clip.kind}` })
  );
  refreshQuickStates();
  S.renderLib?.();
}

/* ================= save / load / disk sync ================= */

function scheduleSave() {
  S.dirty = true;
  const st = document.getElementById('saveState');
  if (st) { st.textContent = 'Saving…'; st.classList.add('dirty'); }
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveTimeline, 800);
}

async function saveTimeline() {
  try {
    const r = await api(`/api/projects/${S.project.id}/timeline`, { method: 'PUT', body: { timeline: S.timeline } });
    S.diskMtime = r.mtime;
    S.dirty = false;
    const st = document.getElementById('saveState');
    if (st) { st.textContent = 'Saved'; st.classList.remove('dirty'); }
  } catch (e) {
    const st = document.getElementById('saveState');
    if (st) { st.textContent = 'Save failed'; st.classList.add('dirty'); }
    if (e.data?.issues) toast(`Save rejected: ${e.data.issues[0]?.message || 'validation'}`, true);
    else toast(`Save failed: ${e.message}`, true);
  }
}

function startPolling() {
  S.pollTimer = setInterval(async () => {
    if (!S.project) return;
    try {
      const { mtime } = await api(`/api/projects/${S.project.id}/timeline/meta`);
      if (S.diskMtime && mtime !== S.diskMtime && !S.dirty) {
        showDiskBanner(true);
      } else if (S.diskMtime && mtime !== S.diskMtime && S.dirty) {
        showDiskBanner(true); // user can decide
      } else {
        showDiskBanner(false);
      }
    } catch { /* ignore */ }
  }, 3000);
}

function showDiskBanner(show) {
  const b = document.querySelector('.disk-banner');
  if (b) b.style.display = show ? 'flex' : 'none';
}

async function reloadTimeline(fromHistory = false) {
  const { timeline, mtime } = await api(`/api/projects/${S.project.id}/timeline`);
  if (S.dirty && !fromHistory) {
    if (!confirm('Timeline changed on disk AND you have unsaved edits. Reload and discard local edits?')) return;
  }
  S.timeline = timeline;
  S.diskMtime = mtime;
  S.dirty = false;
  clearSelection();
  S.history = [cloneTimeline(S.timeline)];
  S.hIndex = 0;
  showDiskBanner(false);
  renderTimeline(); renderInspector(); updateFooter(); updatePreviewText(true); syncMedia(true);
  const st = document.getElementById('saveState');
  if (st) { st.textContent = 'Reloaded'; st.classList.remove('dirty'); }
  toast('Timeline reloaded from disk');
}

/* ================= preview playback ================= */

function setPlayhead(t) {
  const dur = timelineDuration(S.timeline);
  S.playhead = Math.max(0, Math.min(t, Math.max(dur, 0)));
  const ph = document.querySelector('.tl-playhead');
  if (ph) ph.style.left = `${92 + S.playhead * S.pps}px`;
  updateTimeLabel();
  syncMedia(false);
  updatePreviewText();
  updatePreviewBadges();
  updateSelBox();
  refreshQuickStates(); // keyframe diamonds light up at the playhead
}

function updateTimeLabel() {
  const dur = timelineDuration(S.timeline);
  const label = document.querySelector('.transport-time');
  if (label) label.textContent = `${fmtDuration(S.playhead)} / ${fmtDuration(dur)}`;
  const scrubEl = document.querySelector('.scrub');
  if (scrubEl) {
    scrubEl.setAttribute('aria-valuemax', String(Math.max(0, Math.round(dur * 10) / 10)));
    scrubEl.setAttribute('aria-valuenow', String(Math.max(0, Math.round(S.playhead * 10) / 10)));
    scrubEl.setAttribute('aria-valuetext', `${fmtDuration(S.playhead)} of ${fmtDuration(dur)}`);
  }
  const fill = document.querySelector('.scrub .fill');
  const head = document.querySelector('.scrub .head');
  const f = dur > 0 ? (S.playhead / dur) * 100 : 0;
  if (fill) fill.style.width = `${f}%`;
  if (head) head.style.left = `${f}%`;
  if (S.phoneOpen && S.phoneEls?.time) {
    S.phoneEls.time.textContent = `${fmtDuration(S.playhead)} / ${fmtDuration(dur)}`;
  }
}

function togglePlay() {
  if (S.playing) stopPlayback();
  else startPlayback();
}

function startPlayback() {
  const dur = timelineDuration(S.timeline);
  if (S.playhead >= dur - 0.01) S.playhead = 0;
  // Cancel any stray loop so we never run two RAF chains
  if (S.raf) cancelAnimationFrame(S.raf);
  S.raf = null;
  S.playing = true;
  S.lastTick = performance.now();
  const btnEl = document.querySelector('.preview-transport .btn.primary');
  if (btnEl) btnEl.textContent = '⏸';
  const loop = (now) => {
    if (!S.playing) return;
    const dt = (now - S.lastTick) / 1000;
    S.lastTick = now;
    S.playhead += dt;
    const dur2 = timelineDuration(S.timeline);
    if (S.loop) {
      if (S.playhead >= S.loop.end) S.playhead = S.loop.start;
    } else if (S.playhead >= dur2) {
      S.playhead = dur2;
      setPlayhead(S.playhead);
      stopPlayback();
      return;
    }
    const ph = document.querySelector('.tl-playhead');
    if (ph) ph.style.left = `${92 + S.playhead * S.pps}px`;
    updateTimeLabel();
    syncMedia(false);
    updatePreviewText();
    S.raf = requestAnimationFrame(loop);
  };
  S.raf = requestAnimationFrame(loop);
}

function stopPlayback() {
  S.playing = false;
  if (S.raf) cancelAnimationFrame(S.raf);
  S.raf = null;
  const btnEl = document.querySelector('.preview-transport .btn.primary');
  if (btnEl) btnEl.textContent = '▶';
  // Pause every media surface (main, split, phone, overlays, track audio)
  S.videoEl?.pause?.();
  S.videoEl2?.pause?.();
  S.audioEls.forEach((a) => a.pause());
  const pe = S.phoneEls;
  if (pe) {
    try { pe.v1.pause(); } catch { /* */ }
    try { pe.v2.pause(); } catch { /* */ }
  }
  S.overlayLayer?.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch { /* */ } });
}

function programAt(t) {
  return clipOnTrack('v1', t);
}

function applyLayoutClassOnly() {
  const frame = document.querySelector('.preview-frame');
  if (!frame || !S.timeline) return;
  const mode = getLayoutMode(S.timeline);
  const cls = `layout-${mode}`;
  if (!frame.classList.contains(cls)) {
    frame.classList.remove('layout-none', 'layout-split-h', 'layout-split-v');
    frame.classList.add(cls);
  }
}

function syncMedia(force) {
  const t = S.playhead;
  const video = S.videoEl;
  const img = S.imgEl;
  if (!video || !S.timeline) return;
  void force;

  applyLayoutClassOnly();
  const split = isSplitLayout(S.timeline);
  const v1Clip = clipOnTrack('v1', t);
  const v3Clip = split ? clipOnTrack('v3', t) : null;

  if (split) {
    const trackA = getTrack(S.timeline, 'v1');
    const trackB = getTrack(S.timeline, 'v3');
    const muteA = !v1Clip || v1Clip.muted || trackA.muted;
    const muteB = !v3Clip || v3Clip.muted || trackB.muted;
    const volA = muteA ? 0 : v1Clip.volume;
    const volB = muteB ? 0 : v3Clip.volume;
    S.videoEl2?.classList.remove('hidden');
    S.imgEl2?.classList.remove('hidden');
    syncPane(v1Clip, video, img, { volume: volA, play: S.playing, muted: muteA });
    syncPane(v3Clip, S.videoEl2, S.imgEl2, { volume: volB, play: S.playing, muted: muteB });
    if (S.videoEl2) S.videoEl2.muted = volB <= 0;
    if (!v1Clip && !v3Clip) {
      S.audioEls.forEach((a) => a.pause());
    }
  } else {
    S.videoEl2?.pause?.();
    if (S.videoEl2) S.videoEl2.style.visibility = 'hidden';
    S.imgEl2?.classList.add('hidden');
    if (!v1Clip) {
      video.style.visibility = 'hidden';
      video.pause?.();
      img.classList.add('hidden');
      S.audioEls.forEach((a) => a.pause());
      updatePreviewBadges();
      syncVignetteLayer();
      syncFlashLayer();
      syncPhonePreview();
      return;
    }
    const track = getTrack(S.timeline, 'v1');
    const mute = v1Clip.muted || track.muted;
    const vol = mute ? 0 : v1Clip.volume;
    syncPane(v1Clip, video, img, { volume: vol, play: S.playing, muted: mute });
  }

  // audio tracks
  for (const track of S.timeline.tracks) {
    if (track.type !== 'audio') continue;
    for (const c of track.clips) {
      const key = c.id;
      const inWindow = t >= c.start - 1e-6 && t < clipEnd(c) - 1e-6;
      let a = S.audioEls.get(key);
      if (inWindow) {
        const assetA = S.media.find((m) => m.id === c.assetId);
        if (!a) {
          a = new Audio(assetA?.url || '');
          a.preload = 'auto';
          S.audioEls.set(key, a);
        } else if (a.dataset.src !== (assetA?.url || '')) {
          a.src = assetA?.url || '';
          a.dataset.src = assetA?.url || '';
        }
        const sp = c.speed > 0 ? c.speed : 1;
        const localT = t - c.start;
        const curve = speedCurveOf(c);
        const remapped = !!curve || normalizeReverse(c.reverse);
        const target = sourceTimeAt(c, localT);
        if (Math.abs(a.currentTime - target) > (remapped ? 0.05 : 0.22)) {
          try { a.currentTime = target; } catch { /* ignore */ }
        }
        const rate = curve
          ? Math.min(4, Math.max(0.25, curveSpeedAt(curve, Math.min(1, Math.max(0, localT / Math.max(0.001, c.duration))))))
          : sp;
        if (a.playbackRate !== rate) {
          try { a.playbackRate = rate; } catch { /* ignore */ }
        }
        const volKf = evalKeyframes(c, localT, 'volume', c.volume);
        const gain = fadeGain(c, localT);
        a.volume = Math.min(1, c.muted || track.muted ? 0 : Math.max(0, volKf * gain));
        if (S.playing) a.play().catch(() => {});
        else a.pause();
      } else if (a && !a.paused) {
        a.pause();
      }
    }
  }
  updatePreviewBadges();
  syncVignetteLayer();
  syncFlashLayer();
  syncOverlays();
  syncPhonePreview();
}

function updatePreviewText(force = false) {
  const layer = document.querySelector('.text-layer');
  if (!layer) return;
  const key = textCacheKey();
  if (!force && key === S.lastTextKey) return;
  S.lastTextKey = key;
  const frame = S.previewFrame || document.querySelector('.preview-frame');
  const fw = frame?.clientWidth || 360;
  const frameH = frame?.clientHeight || Math.round(fw * 16 / 9);
  renderTextLayer(layer, fw, frameH);
  const wmL = document.getElementById('watermarkLayer');
  if (wmL) renderWatermarkLayer(wmL, fw, frameH);
  if (S.phoneOpen) renderPhoneText();
  updateSelBox();
}

function textCacheKey() {
  const active = activeClips(S.timeline, S.playhead, ['text']);
  const wm = S.timeline?.watermark || {};
  const wmKey = `wm:${wm.enabled ? 1 : 0}:${wm.text || ''}:${wm.position || ''}:${wm.opacity ?? ''}:${wm.size ?? ''}:${wm.color || ''}:${wm.letterSpacing ?? ''}:${wm.margin ?? ''}:${wm.font || ''}:${wm.bold ? 1 : 0}:${wm.uppercase ? 1 : 0}`;
  return wmKey + '|' + active.map((a) => {
    const s = a.clip.text || {};
    return [
      a.clip.id, s.content, s.role, s.position, s.xPct, s.yPct,
      s.size, s.color, s.bg, s.bgMode, s.bold, s.uppercase, s.italic,
      s.align, s.strokeWidth, s.strokeColor, s.shadow, s.letterSpacing,
      s.padX, s.padY, s.widthPct, s.anim, s.animDur, s.font,
      s.opacity ?? '', s.glow ? 1 : 0, s.glowColor || '', s.glowSize ?? '',
      s.stagger ? 1 : 0, s.lineHeight ?? '', s.rotate ?? '',
      a.clip.start, clipEnd(a.clip),
    ].join(':');
  }).join('|');
}

function renderTextLayer(layer, fw, frameH) {
  if (!layer || !S.timeline) return;
  const active = activeClips(S.timeline, S.playhead, ['text']);
  layer.innerHTML = '';
  const scale = fw / (S.timeline.width || 1080);
  const scaleH = frameH / (S.timeline.height || 1920);
  for (const { clip } of active) {
    const spec = clip.text || {};
    const presets = { top: { x: 50, y: 14 }, center: { x: 50, y: 50 }, bottom: { x: 50, y: 80 } };
    const preset = presets[spec.position] || presets.center;
    const x = spec.position === 'custom' ? (spec.xPct ?? 50) : preset.x;
    const y = spec.position === 'custom' ? (spec.yPct ?? 50) : preset.y;
    const bgMode = BG_MODES.includes(spec.bgMode) ? spec.bgMode : (spec.bg ? 'inline' : 'none');
    const bgCss = bgMode !== 'none' ? (bgToCss(spec.bg) || (bgMode === 'full' ? '#ffffff' : null)) : null;
    const content = spec.uppercase ? String(spec.content || '').toUpperCase() : (spec.content || '');
    const sizePx = Math.max(9, (spec.size || 64) * scale);
    const stroke = Math.max(0, Math.round(Number(spec.strokeWidth) || 0));
    const lsPx = (Number(spec.letterSpacing) || 0) * scale;
    const padXs = Math.round((Number(spec.padX) ?? (bgMode === 'full' ? 40 : 14)) * scale);
    const padYs = Math.round((Number(spec.padY) ?? (bgMode === 'full' ? 22 : 10)) * scaleH);
    const anim = normalizeTextAnim(spec.anim);
    const animDur = Math.max(0.05, Number(spec.animDur) || 0.3);
    const opacity = spec.opacity != null ? Math.min(1, Math.max(0.05, Number(spec.opacity))) : 1;
    const rotate = Number(spec.rotate) || 0;
    const glowOn = !!spec.glow && Number(spec.glowSize) > 0;
    const glowColor = /^#[0-9a-fA-F]{6}$/.test(spec.glowColor || '') ? spec.glowColor : '#ffffff';
    const glowPx = Math.max(2, Math.round((Number(spec.glowSize) || 10) * scale));
    const lineHeight = Number(spec.lineHeight) || 1.28;

    // Multi-layer glow (soft neon / cinematic bloom) + drop shadow.
    const shadows = [];
    if (glowOn) {
      shadows.push(
        `0 0 ${glowPx}px ${glowColor}`,
        `0 0 ${Math.round(glowPx * 2)}px ${glowColor}bb`,
        `0 0 ${Math.round(glowPx * 3.5)}px ${glowColor}66`,
      );
    }
    if (spec.shadow) shadows.push('3px 3px 0 rgba(0,0,0,.75)');
    else if (!glowOn) shadows.push('0 2px 6px rgba(0,0,0,.7), 0 0 2px #000');

    const styleParts = [
      `left:${x}%`, `top:${y}%`,
      `font-size:${sizePx}px`,
      `color:${/^#[0-9a-fA-F]{6}$/.test(spec.color || '') ? spec.color : '#fff'}`,
      spec.bold === false ? 'font-weight:400' : 'font-weight:700',
      spec.italic ? 'font-style:italic' : 'font-style:normal',
      spec.font ? `font-family:${JSON.stringify(spec.font)},Arial,sans-serif` : '',
      lsPx ? `letter-spacing:${lsPx}px` : 'letter-spacing:0',
      'transform:translate(-50%,-50%)',
      stroke ? `-webkit-text-stroke:${Math.max(1, stroke * scale)}px ${/^#[0-9a-fA-F]{6}$/.test(spec.strokeColor || '') ? spec.strokeColor : '#000'}` : '',
      shadows.length ? `text-shadow:${shadows.join(',')}` : '',
      opacity < 0.999 ? `opacity:${opacity}` : '',
      `line-height:${lineHeight}`,
      anim !== 'none' ? `animation:txt-${anim} ${animDur}s ease-out both` : '',
    ].filter(Boolean);

    // Font rotation (any angle) — applied around the text center.
    if (Math.abs(rotate) > 0.05) {
      const base = styleParts.find((s) => s.startsWith('transform:'));
      const idxT = styleParts.indexOf(base);
      const rot = `translate(-50%,-50%) rotate(${rotate}deg)`;
      if (idxT >= 0) styleParts[idxT] = `transform:${rot}`;
      else styleParts.push(`transform:${rot}`);
    }

    if (bgCss) {
      if (bgMode === 'full') {
        styleParts.push(
          'max-width:none', 'box-sizing:border-box',
          `background:${bgCss}`,
          `padding:${padYs}px ${padXs}px`,
          'border-radius:0', `text-align:${normalizeTextAlign(spec.align)}`,
          'line-height:1.28',
          Math.abs(rotate) > 0.05 ? '' : 'transform:translateY(-50%)',
        );
      } else {
        styleParts.push(
          `background:${bgCss}`,
          `padding:${Math.max(4, padYs)}px ${Math.max(8, padXs)}px`,
          'border-radius:8px',
          `text-align:${normalizeTextAlign(spec.align)}`,
        );
        const iw = Math.min(100, Math.max(10, Number(spec.widthPct) || 100));
        if (iw < 99.5 && spec.position === 'custom') {
          styleParts.push(`width:${iw}%`, 'max-width:none');
        }
      }
    } else {
      styleParts.push(`text-align:${normalizeTextAlign(spec.align)}`);
    }

    /* ---- word-by-word stagger (premium captions) ---- */
    const staggerOn = !!spec.stagger && content.trim().split(/\s+/).length >= 2 && Math.abs(rotate) < 0.05;
    const node = el('div', {
      class: bgMode === 'full' ? 'text-ov text-banner' : 'text-ov' + (staggerOn ? ' text-stagger' : ''),
      dataset: { clip: clip.id },
      style: styleParts.filter(Boolean).join(';'),
    });

    if (staggerOn) {
      const words = content.trim().split(/\s+/);
      const wins = staggerWordWindows(content, clip.start, clipEnd(clip));
      const step = wins.length ? wins[0].step : 0.2;
      words.forEach((w, wi) => {
        const delay = Math.max(0, wi * step);
        const span = el('span', {
          class: 'stg-w',
          text: w + (wi < words.length - 1 ? ' ' : ''),
          style: `animation-delay:${delay.toFixed(3)}s`,
          dataset: { wi: String(wi), t0: String((wins[wi]?.t0 ?? clip.start + delay)) },
        });
        // Karaoke: highlight the word currently being spoken based on playhead.
        const win = wins[wi];
        if (win && S.playhead >= win.t0 && S.playhead < (wins[wi + 1]?.t0 ?? clipEnd(clip))) {
          span.classList.add('active');
        } else if (win && S.playhead >= win.t0) {
          span.classList.add('shown');
        }
        node.append(span);
      });
    } else {
      node.textContent = content;
    }

    if (bgMode === 'full') {
      const widthPct = Math.min(100, Math.max(10, Number(spec.widthPct) || 100));
      const lines = estimateBannerLines(content, spec.size || 64, (S.timeline.width || 1080) * (widthPct / 100), Number(spec.padX) ?? 40, Number(spec.letterSpacing) || 0);
      const h = bannerBoxHeight(lines, spec.size || 64, Number(spec.padY) ?? 22) * scaleH;
      node.style.minHeight = `${h}px`;
      node.style.display = 'flex';
      node.style.alignItems = 'center';
      node.style.justifyContent = normalizeTextAlign(spec.align) === 'left' ? 'flex-start'
        : normalizeTextAlign(spec.align) === 'right' ? 'flex-end' : 'center';
      if (widthPct >= 99.5) {
        node.style.left = '0';
        node.style.width = '100%';
      } else {
        const left = Math.max(0, Math.min(100 - widthPct, ((x ?? 50) - widthPct / 2)));
        node.style.left = `${left}%`;
        node.style.width = `${widthPct}%`;
        if (Math.abs(rotate) < 0.05) node.style.transform = 'translateY(-50%)';
      }
    }
    layer.append(node);
  }
}

/** Persistent brand watermark preview (matches renderer vertical/horizontal placement). */
function renderWatermarkLayer(layer, fw, frameH) {
  if (!layer || !S.timeline) return;
  layer.innerHTML = '';
  const wm = normalizeWatermark(S.timeline.watermark);
  if (!wm.enabled || !String(wm.text || '').trim()) return;
  const W = S.timeline.width || 1080;
  const H = S.timeline.height || 1920;
  const scale = fw / W;
  const text = wm.uppercase ? wm.text.toUpperCase() : wm.text;
  const sizePx = Math.max(6, wm.size * scale);
  const marginPx = wm.margin * scale;
  const color = /^#[0-9a-fA-F]{6}$/.test(wm.color) ? wm.color : '#ffffff';
  const vertical = wm.position === 'vertical-left' || wm.position === 'vertical-right';

  const style = [
    `font-size:${sizePx}px`,
    `color:${color}`,
    `opacity:${wm.opacity}`,
    wm.letterSpacing ? `letter-spacing:${Math.max(1, wm.letterSpacing * scale)}px` : 'letter-spacing:0',
    wm.bold ? 'font-weight:700' : 'font-weight:400',
    `font-family:${JSON.stringify(wm.font || 'Arial')},Arial,sans-serif`,
    'text-shadow:1px 1px 2px rgba(0,0,0,.55)',
    'white-space:nowrap',
    'pointer-events:none',
    'position:absolute',
  ];

  if (vertical) {
    style.push('transform-origin:center center');
    if (wm.position === 'vertical-left') {
      style.push(`left:${marginPx}px`, 'top:50%', 'transform:translateY(-50%) rotate(-90deg)');
    } else {
      style.push(`right:${marginPx}px`, 'top:50%', 'transform:translateY(-50%) rotate(90deg)');
    }
  } else {
    const isLeft = wm.position === 'top-left' || wm.position === 'bottom-left';
    const isRight = wm.position === 'top-right' || wm.position === 'bottom-right';
    const isTop = wm.position === 'top-left' || wm.position === 'top-right' || wm.position === 'top';
    const isBottom = wm.position === 'bottom-left' || wm.position === 'bottom-right' || wm.position === 'bottom';
    style.push('transform:translate(0,0)');
    if (isLeft) style.push(`left:${marginPx}px`);
    else if (isRight) style.push(`right:${marginPx}px`);
    else style.push('left:50%', 'transform:translateX(-50%)');
    if (isTop) style.push(`top:${marginPx}px`);
    else if (isBottom) style.push(`bottom:${marginPx}px`);
    else if (wm.position === 'center') style.push('top:50%', 'transform:translate(-50%,-50%)');
    else style.push('top:50%', 'transform:translate(-50%,-50%)');
    if (wm.position === 'center') style.push('left:50%', 'top:50%');
  }

  layer.append(el('div', { class: 'wm-ov', text, style: style.join(';') }));
}

/* ================= footer / render ================= */

function updateFooter() {
  const f = document.getElementById('editorFooter');
  if (!f) return;
  const dur = timelineDuration(S.timeline);
  const clips = S.timeline.tracks.reduce((n, t) => n + t.clips.length, 0);
  const job = S.project.renderJob;
  const rendering = job && ['queued', 'processing'].includes(job.status);
  f.innerHTML = '';
  const history = Array.isArray(S.project.renderHistory) ? S.project.renderHistory.slice(0, 3) : [];
  f.append(
    el('div', { class: 'f-item' }, el('span', { text: 'Style:' }), el('b', { text: S.project.style_name || '—' })),
    el('div', { class: 'f-item' }, el('span', { text: 'Template:' }), el('b', { text: S.project.template_id || '—' })),
    el('div', { class: 'f-item' }, el('b', { text: `${dur.toFixed(1)}s` })),
    el('div', { class: 'f-item' }, el('b', { text: `${S.timeline.width}×${S.timeline.height}` })),
    el('div', { class: 'f-item' }, el('b', { text: `${S.timeline.fps}fps` })),
      el('div', { class: 'f-item' },
        el('span', { text: 'Layout:' }),
        el('b', { text: { 'none': 'Full', 'split-h': '50/50 L|R', 'split-v': '50/50 T|B' }[getLayoutMode(S.timeline)] || 'Full' })
      ),
      (() => {
        const feats = [];
        for (const t of S.timeline.tracks) for (const c of t.clips || []) {
          if (c.kind === 'video' || c.kind === 'image') {
            const ef = normalizeEffect(c.effect); if (ef && ef !== 'none') feats.push(ef === 'bw' ? 'B&W' : ef);
            if (normalizeTransform(c).fit === 'contain') feats.push('contain');
          }
          if (c.kind === 'text' && normalizeBgMode((c.text || {}).bgMode || ((c.text || {}).bg ? 'inline' : 'none')) === 'full') feats.push('banner');
        }
        const uniq = [...new Set(feats)];
        return uniq.length
          ? el('div', { class: 'f-item', title: 'New features active on this timeline' },
              el('span', { text: 'Look:' }),
              ...uniq.map((u) => el('span', { class: 'badge new', text: u })))
          : null;
      })(),
    el('div', { class: 'f-item muted' }, el('span', { text: `${clips} clips` })),
    history.length
      ? el('div', { class: 'f-item history', title: 'Render history (newest first)' },
          el('span', { class: 'muted', text: 'Renders:' }),
          ...history.map((h) => el('span', {
            class: `badge ${h.qc === 'PASS' ? 'ok' : h.qc === 'FAIL' ? 'fail' : 'warn'}`,
            text: `${h.quality}${h.qc ? ' · ' + h.qc : ''}`,
            title: `${h.finishedAt || ''} · ${h.duration ?? ''}s`,
          }))
        )
      : null,
    el('div', { class: 'spacer' })
  );
  if (rendering) {
    f.append(
      el('span', { class: 'muted', text: `${job.quality} render — ${job.stage} ${job.progress || 0}%` }),
      el('div', { class: 'progress-inline' }, el('div', { class: 'bar', style: `width:${job.progress || 0}%` })),
      el('button', { class: 'btn sm danger', text: 'Cancel', onclick: cancelRender })
    );
  } else {
    f.append(el('span', { class: 'muted', text: job?.status === 'completed' ? `Last: ${job.quality} OK` : job?.status === 'failed' ? 'Last render failed' : '' }));
  }
}

async function startRender(quality) {
  try {
    const issues = validateTimeline(S.timeline);
    if (issues.length) { toast(`Timeline invalid: ${issues[0].message}`, true); return; }
    if (S.dirty) await saveTimeline();
    const r = await api(`/api/projects/${S.project.id}/render`, { body: { quality } });
    toast(r.status === 'already_running' ? 'A render is already running' : `${quality} render queued`);
    updateFooter();
    pollRender(quality);
  } catch (e) { toast(e.message, true); }
}

function cancelRender() {
  api(`/api/projects/${S.project.id}/render/cancel`, { body: {} }).then(() => toast('Cancel requested'));
}

function pollRender(quality) {
  clearInterval(S.renderPoll);
  S.renderPoll = setInterval(async () => {
    try {
      const r = await api(`/api/projects/${S.project.id}/render`);
      S.project.renderJob = r.job;
      S.project.last_qc = r.qc;
      updateFooter();
      if (!r.job || !['queued', 'processing'].includes(r.job.status)) {
        clearInterval(S.renderPoll);
        if (r.job?.status === 'completed') {
          const p = await api(`/api/projects/${S.project.id}`);
          S.project = p.project;
          showRenderResult({ qc: r.qc, kind: quality, job: r.job });
          toast(quality === 'final' ? 'Final render complete' : 'Preview render complete');
        } else if (r.job?.status === 'failed') {
          modal({
            title: 'Render failed',
            body: el('div', {},
              el('p', { text: r.job.error || 'Unknown error', style: 'color:var(--red);margin-bottom:8px' }),
              r.job.detail ? el('pre', { class: 'code', text: r.job.detail }) : null
            ),
            actions: [{ label: 'Close', class: 'primary' }],
          });
        }
      }
    } catch { /* ignore */ }
  }, 600);
}

function showRenderResult({ qc, kind, job }) {
  document.querySelector('.render-result')?.remove();
  const outRel = kind === 'preview' ? 'previews/preview.mp4' : 'exports/final.mp4';
  const base = `/api/projects/${S.project.id}/exports`;
  const panel = el('div', { class: 'render-result' },
    el('h4', { text: kind === 'preview' ? 'Preview complete' : 'Render complete' }),
    qc ? el('div', {},
      el('div', { class: 'row', style: 'margin-bottom:6px' },
        el('span', { class: `badge ${qc.overall === 'PASS' ? 'ok' : qc.overall === 'FAIL' ? 'fail' : 'warn'}`, text: `QC ${qc.overall}` }),
        el('span', { class: 'muted', style: 'font-size:11px', text: `${qc.items.filter((i) => i.status !== 'PASS').length} flagged` })
      ),
      el('ul', { class: 'qc-list' },
        qc.items.map((i) => el('li', {},
          el('span', { class: `st ${i.status}`, text: i.status }),
          el('span', { class: 'n', text: i.name }),
          el('span', { class: 'muted', text: i.detail || '' })
        ))
      )
    ) : el('div', { class: 'muted', style: 'font-size:11.5px', text: 'Fast preview — no QC pass on previews.' }),
    el('div', { class: 'row', style: 'margin-top:10px;flex-wrap:wrap;gap:6px' },
      el('button', {
        class: 'btn sm', text: '▶ Open preview',
        onclick: () => {
          const v = el('video', { src: `${base}/${kind === 'preview' ? 'preview.mp4' : 'final.mp4'}?t=${Date.now()}`, controls: true, autoplay: true, style: 'width:100%;max-height:70vh;background:#000;border-radius:8px' });
          modal({ title: kind === 'preview' ? 'Preview render' : 'Final render', body: v, actions: [{ label: 'Close', class: 'primary' }] });
        },
      }),
      kind === 'final' ? el('a', { class: 'btn sm', href: `${base}/final.mp4`, download: `${S.project.name}.mp4`, text: 'Download MP4' }) : null,
      kind === 'final' ? el('a', { class: 'btn sm', href: `${base}/thumbnail.jpg`, download: 'thumbnail.jpg', text: 'Thumbnail' }) : null,
      kind === 'final' ? el('a', { class: 'btn sm', href: `${base}/captions.srt`, download: 'captions.srt', text: 'Captions' }) : null,
      kind === 'final' ? el('a', { class: 'btn sm', href: `${base}/caption.txt`, download: 'caption.txt', text: 'Caption' }) : null,
      kind === 'final' ? el('button', {
        class: 'btn sm', text: 'Make caption',
        onclick: async () => {
          try {
            const r = await api(`/api/projects/${S.project.id}/caption`, { body: {} });
            await copyText(r.caption);
            toast('Caption generated & copied');
          } catch (e) { toast(e.message, true); }
        },
      }) : null,
      kind === 'final' ? el('a', { class: 'btn sm', href: `${base}/timeline.json`, download: 'timeline.json', text: 'Timeline' }) : null,
      el('button', { class: 'btn sm ghost', text: 'All exports', onclick: () => navigate('#/exports') }),
      el('button', { class: 'btn sm ghost', text: '✕', title: 'Close render result', 'aria-label': 'Close render result', onclick: () => panel.remove() })
    ),
    job?.duration ? el('div', { class: 'muted', style: 'font-size:11px;margin-top:6px', text: `${job.duration}s · progress bar done` }) : null
  );
  document.querySelector('.preview-center')?.append(panel);
}

/* ================= keyboard ================= */

function bindKeys() {
  const onKey = (e) => {
    if (!S.project) return;
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      clearTimeout(S.saveTimer);
      saveTimeline();
      return;
    }
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      if (typing && tag === 'textarea') return;
      e.preventDefault(); doUndo(); return;
    }
    if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      if (typing && tag === 'textarea') return;
      e.preventDefault(); doRedo(); return;
    }
    if (typing) return;
    if (e.code === 'Space') {
      e.preventDefault();
      // Avoid double-toggle: focused button also fires click on Space keyup
      const ae = document.activeElement;
      if (ae && ae.tagName === 'BUTTON' && !ae.closest('.palette, .modal-root')) {
        ae.blur();
      }
      togglePlay();
      return;
    }
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); doSplit(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); doDelete(); return; }
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); addMarkerAtPlayhead(); return; }
    if (e.key === 'l' || e.key === 'L') { e.preventDefault(); toggleLoop(); return; }
    if (e.key === '[') { e.preventDefault(); S.pps = Math.max(20, S.pps / 1.25); renderTimeline(); return; }
    if (e.key === ']') { e.preventDefault(); S.pps = Math.min(240, S.pps * 1.25); renderTimeline(); return; }
    if (e.key === '1' && S.selection) { e.preventDefault(); setClipSpeed(0.5); return; }
    if (e.key === '2' && S.selection) { e.preventDefault(); setClipSpeed(1 / (Number(getClipSafe()?.speed) || 1)); return; }
    if (e.key === '3' && S.selection) { e.preventDefault(); setClipSpeed(2); return; }
    if (e.key === '4' && S.selection) { e.preventDefault(); setClipSpeed(4 / (Number(getClipSafe()?.speed) || 1)); return; }
    if (e.key === 'p' || e.key === 'P') { e.preventDefault(); togglePhonePreview(); return; }
    if (e.key === 'Escape') {
      if (S.multi && S.multi.length) { S.multi = null; afterSelectionChange(); return; }
      if (S.selection) { clearSelection(); afterSelectionChange(); return; }
    }
    // Alt+Arrows: nudge selected clip(s) on canvas (Shift = 5%)
    if (e.altKey && e.key.startsWith('Arrow')) {
      e.preventDefault();
      nudgeSelection(e.key, e.shiftKey ? 5 : 1);
      return;
    }
    if (e.key === 'ArrowLeft') { e.preventDefault(); setPlayhead(S.playhead - (e.shiftKey ? 1 : 1 / (S.timeline?.fps || 30))); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); setPlayhead(S.playhead + (e.shiftKey ? 1 : 1 / (S.timeline?.fps || 30))); return; }
    if (e.key === 'Home') { e.preventDefault(); setPlayhead(0); return; }
    if (e.key === 'End') { e.preventDefault(); setPlayhead(timelineDuration(S.timeline)); return; }
  };
  document.addEventListener('keydown', onKey);
  S.unsubs.push(() => document.removeEventListener('keydown', onKey));
}

function getClipSafe() {
  if (!S.selection) return null;
  try { return getClip(S.timeline, S.selection.trackId, S.selection.clipId).clip; } catch { return null; }
}
