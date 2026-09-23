import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTimeline, addClip, removeClip, splitClip, trimClip, moveClip, duplicateClip,
  setClipProps, setTrackProps, timelineDuration, cloneTimeline, validateTimeline,
  getClip, getTrack, clipEnd, findFreeSlot, TimelineError, activeClips, round3,
  addMarker, removeMarker, moveMarker, clampSpeed, MIN_SPEED, MAX_SPEED, makeClip,
  getLayoutMode, setLayoutMode, isSplitLayout, splitPanes, LAYOUT_MODES,
  clampZoom, MIN_ZOOM, MAX_ZOOM, FIT_MODES, normalizeTransform,
  EFFECTS, BG_MODES, normalizeEffect, normalizeBgMode, bgToCss, bgToFfmpeg,
  TEXT_ANIMS, TEXT_ALIGNS, TEXT_PRESETS, normalizeTextAnim, normalizeTextAlign,
  estimateBannerLines, bannerBoxHeight, snapPct,
  evalKeyframes, keyframeExpr, fadeGain, transitionGain, clampFade,
  TRANSITIONS, KEYFRAME_PROPS, MAX_FADE_SEC,
} from '../shared/timeline-ops.js';

function tl() {
  return createTimeline({ width: 1080, height: 1920, fps: 30 });
}

function videoClip(timeline, start = 0, duration = 2) {
  return addClip(timeline, 'v1', {
    kind: 'video', assetId: 'media-0001', start, duration, srcIn: 0, volume: 1,
  });
}

test('createTimeline has 8 canonical tracks', () => {
  const t = tl();
  assert.equal(t.tracks.length, 8);
  assert.deepEqual(t.tracks.map((x) => x.id), ['v1', 'v2', 'v3', 'a1', 'a2', 'a3', 't1', 't2']);
  assert.equal(t.width, 1080);
  assert.equal(t.height, 1920);
  assert.equal(t.fps, 30);
});

test('addClip places clip and validates kind/asset', () => {
  const t = tl();
  const c = videoClip(t, 0, 2);
  assert.equal(c.start, 0);
  assert.equal(c.duration, 2);
  assert.equal(c.assetId, 'media-0001');
  assert.equal(timelineDuration(t), 2);

  assert.throws(() => addClip(t, 't1', { kind: 'video', assetId: 'x', start: 0, duration: 1 }), TimelineError);
  assert.throws(() => addClip(t, 'v1', { kind: 'video', start: 0, duration: 1 }), /assetId/);
  assert.throws(() => addClip(t, 'v1', { kind: 'video', assetId: 'm', start: -1, duration: 1 }), TimelineError);
});

test('overlaps rejected within a track', () => {
  const t = tl();
  videoClip(t, 0, 2);
  assert.throws(() => addClip(t, 'v1', {
    kind: 'video', assetId: 'media-0002', start: 1, duration: 2, srcIn: 0, volume: 1,
  }, { autoSlot: false }), (err) => err.code === 'OVERLAP');
});

test('autoSlot finds free gap', () => {
  const t = tl();
  videoClip(t, 0, 2);
  videoClip(t, 4, 2); // gap 2-4
  assert.equal(findFreeSlot(getTrack(t, 'v1'), 1.5, 0), 2);
  const c = addClip(t, 'v1', {
    kind: 'video', assetId: 'media-0003', start: 0, duration: 1.5, srcIn: 0, volume: 1,
  }, { autoSlot: true });
  assert.equal(c.start, 2);
  // after placement (0-2, 2-3.5, 4-6) next free 1.5s slot is past the end
  assert.equal(findFreeSlot(getTrack(t, 'v1'), 1.5, 0), 6);
});

test('splitClip keeps total duration and advances srcIn', () => {
  const t = tl();
  const c = videoClip(t, 0, 4);
  const { left, right } = splitClip(t, 'v1', c.id, 1.5);
  assert.equal(left.duration, 1.5);
  assert.equal(right.start, 1.5);
  assert.equal(right.duration, 2.5);
  assert.equal(right.srcIn, 1.5);
  assert.equal(timelineDuration(t), 4);
  assert.equal(getTrack(t, 'v1').clips.length, 2);

  assert.throws(() => splitClip(t, 'v1', c.id, 0.01), (e) => e.code === 'SPLIT_OUT_OF_RANGE');
  assert.throws(() => splitClip(t, 'v1', c.id, 3.99), (e) => e.code === 'SPLIT_OUT_OF_RANGE');
});

test('trimClip enforces min duration and source overrun', () => {
  const t = tl();
  const c = videoClip(t, 0, 3);
  trimClip(t, 'v1', c.id, { duration: 1 }, 10);
  assert.equal(getClip(t, 'v1', c.id).clip.duration, 1);
  assert.throws(() => trimClip(t, 'v1', c.id, { duration: 0.01 }, 10), (e) => e.code === 'TOO_SHORT');
  // srcIn + duration > assetDuration
  assert.throws(() => trimClip(t, 'v1', c.id, { srcIn: 9, duration: 2 }, 10), (e) => e.code === 'SOURCE_OVERRUN');
});

test('moveClip rejects overlap, succeeds into free space', () => {
  const t = tl();
  const a = videoClip(t, 0, 2);
  videoClip(t, 3, 2);
  assert.throws(() => moveClip(t, 'v1', a.id, 3.5), (e) => e.code === 'OVERLAP');
  moveClip(t, 'v1', a.id, 0.5);
  assert.equal(getClip(t, 'v1', a.id).clip.start, 0.5);
});

test('duplicateClip places copy after original without overlap', () => {
  const t = tl();
  const a = videoClip(t, 0, 2);
  const copy = duplicateClip(t, 'v1', a.id);
  assert.notEqual(copy.id, a.id);
  assert.equal(copy.duration, 2);
  assert.ok(copy.start >= 2);
  assert.equal(validateTimeline(t).length, 0);
});

test('removeClip + locked track guards', () => {
  const t = tl();
  const a = videoClip(t, 0, 2);
  setTrackProps(t, 'v1', { locked: true });
  assert.throws(() => removeClip(t, 'v1', a.id), (e) => e.code === 'TRACK_LOCKED');
  setTrackProps(t, 'v1', { locked: false });
  removeClip(t, 'v1', a.id);
  assert.equal(getTrack(t, 'v1').clips.length, 0);
  assert.throws(() => removeClip(t, 'v1', 'nope'), (e) => e.code === 'CLIP_NOT_FOUND');
});

test('text clips: setClipProps content/position, no assetId required', () => {
  const t = tl();
  const c = addClip(t, 't1', {
    kind: 'text', start: 0, duration: 2,
    text: { content: 'Hello', role: 'title', position: 'center', size: 72, color: '#ffffff' },
  });
  assert.equal(c.text.content, 'Hello');
  setClipProps(t, 't1', c.id, { text: { content: 'World', size: 80 } });
  const { clip } = getClip(t, 't1', c.id);
  assert.equal(clip.text.content, 'World');
  assert.equal(clip.text.size, 80);
  // volume clamp
  setClipProps(t, 't1', c.id, { volume: 99 });
  assert.equal(clip.volume, 4);
  // bad prop
  assert.throws(() => setClipProps(t, 't1', c.id, { evil: 1 }), (e) => e.code === 'BAD_PROP');
});

test('overlay props normalize and clamp', () => {
  const t = tl();
  const c = addClip(t, 'v3', {
    kind: 'image', assetId: 'media-0009', start: 0, duration: 2, srcIn: 0, volume: 1,
    overlay: { xPct: 150, yPct: -5, widthPct: 200 },
  });
  assert.equal(c.overlay.xPct, 100);
  assert.equal(c.overlay.yPct, 0);
  assert.equal(c.overlay.widthPct, 100);
});

test('cloneTimeline is a deep copy', () => {
  const t = tl();
  const a = videoClip(t, 0, 2);
  const snap = cloneTimeline(t);
  removeClip(t, 'v1', a.id);
  assert.equal(getTrack(snap, 'v1').clips.length, 1);
  assert.equal(getTrack(t, 'v1').clips.length, 0);
});

test('validateTimeline reports structural issues', () => {
  const t = tl();
  videoClip(t, 0, 2);
  const bad = cloneTimeline(t);
  bad.tracks.find((x) => x.id === 'v1').clips.push({
    id: 'c-overlap', kind: 'video', start: 1, duration: 2, srcIn: 0, volume: 1, assetId: 'm',
  });
  const issues = validateTimeline(bad);
  assert.ok(issues.some((i) => i.code === 'OVERLAP'));

  const noTracks = { width: 1080, height: 1920, fps: 30 };
  assert.ok(validateTimeline(noTracks).some((i) => i.code === 'NO_TRACKS'));

  const wrongKind = cloneTimeline(tl());
  wrongKind.tracks.find((x) => x.id === 'v1').clips.push({
    id: 'c-txt', kind: 'text', start: 0, duration: 1, volume: 1, text: { content: 'x' },
  });
  assert.ok(validateTimeline(wrongKind).some((i) => i.code === 'KIND_MISMATCH'));

  // duplicate ids
  const dup = cloneTimeline(tl());
  const c1 = { id: 'same', kind: 'video', start: 0, duration: 1, srcIn: 0, volume: 1, assetId: 'm' };
  dup.tracks.find((x) => x.id === 'v1').clips.push({ ...c1 });
  dup.tracks.find((x) => x.id === 'v3').clips.push({ ...c1, kind: 'image' });
  assert.ok(validateTimeline(dup).some((i) => i.code === 'DUP_CLIP_ID'));
});

test('activeClips respects time window and hidden tracks', () => {
  const t = tl();
  const a = videoClip(t, 0, 2);
  addClip(t, 't1', { kind: 'text', start: 0.5, duration: 1, text: { content: 'hi' } });
  assert.equal(activeClips(t, 1).length, 2);
  assert.equal(activeClips(t, 1, ['text']).length, 1);
  assert.equal(activeClips(t, 2.5).length, 0);
  setTrackProps(t, 't1', { hidden: true });
  assert.equal(activeClips(t, 1).length, 1);
  void a;
});

test('round3 / clipEnd basics', () => {
  assert.equal(round3(1.23456), 1.235);
  assert.equal(clipEnd({ start: 1, duration: 0.5 }), 1.5);
});

test('markers: add / move / remove + validate', () => {
  const t = tl();
  assert.deepEqual(t.markers, []);
  const m = addMarker(t, { time: 2.5, label: 'Beat', color: '#ff0000' });
  assert.ok(m.id);
  assert.equal(m.time, 2.5);
  assert.equal(t.markers.length, 1);
  moveMarker(t, m.id, 4);
  assert.equal(t.markers[0].time, 4);
  assert.equal(validateTimeline(t).length, 0);
  assert.ok(removeMarker(t, m.id));
  assert.equal(t.markers.length, 0);
  assert.ok(!removeMarker(t, m.id));
});

test('speed: clamp, setClipProps, validate', () => {
  assert.equal(clampSpeed(10), MAX_SPEED);
  assert.equal(clampSpeed(0.01), MIN_SPEED);
  assert.equal(clampSpeed(1.5), 1.5);
  assert.equal(clampSpeed('x'), 1);
  assert.equal(clampSpeed(0), 1);

  const t = tl();
  const c = addClip(t, 'v1', { kind: 'video', assetId: 'media-0001', start: 0, duration: 2, srcIn: 0, volume: 1, speed: 2 });
  assert.equal(c.speed, 2);
  setClipProps(t, 'v1', c.id, { speed: 0.5 });
  assert.equal(getClip(t, 'v1', c.id).clip.speed, 0.5);
  assert.equal(validateTimeline(t).length, 0);

  const bad = cloneTimeline(t);
  bad.tracks.find((x) => x.id === 'v1').clips[0].speed = 99;
  assert.ok(validateTimeline(bad).some((i) => i.code === 'BAD_SPEED'));

  const text = makeClip({ kind: 'text', start: 0, duration: 1, text: { content: 'x' } });
  assert.equal(text.speed, 1);
  const tt = tl();
  const tc = addClip(tt, 't1', text);
  assert.throws(() => setClipProps(tt, 't1', tc.id, { speed: 2 }), TimelineError);
});

test('layout: createTimeline default none, setLayoutMode, isSplitLayout', () => {
  const t = tl();
  assert.deepEqual(LAYOUT_MODES, ['none', 'split-h', 'split-v']);
  assert.equal(getLayoutMode(t), 'none');
  assert.equal(isSplitLayout(t), false);
  assert.deepEqual(t.layout, { mode: 'none' });

  setLayoutMode(t, 'split-h');
  assert.equal(getLayoutMode(t), 'split-h');
  assert.equal(isSplitLayout(t), true);

  setLayoutMode(t, 'split-v');
  assert.equal(getLayoutMode(t), 'split-v');
  assert.equal(isSplitLayout(t), true);

  setLayoutMode(t, 'none');
  assert.equal(isSplitLayout(t), false);
  assert.throws(() => setLayoutMode(t, 'split-x'), (e) => e.code === 'BAD_LAYOUT');
});

test('layout: splitPanes covers canvas for split modes, null for none', () => {
  assert.equal(splitPanes(1080, 1920, 'none'), null);
  assert.equal(splitPanes(1080, 1920, 'bogus'), null);

  const h = splitPanes(1080, 1920, 'split-h');
  assert.equal(h.length, 2);
  assert.deepEqual(h[0], { id: 'a', x: 0, y: 0, w: 540, h: 1920 });
  assert.deepEqual(h[1], { id: 'b', x: 540, y: 0, w: 540, h: 1920 });
  assert.equal(h[0].w + h[1].w, 1080);
  assert.equal(h[0].h, 1920);

  const v = splitPanes(1080, 1920, 'split-v');
  assert.deepEqual(v[0], { id: 'a', x: 0, y: 0, w: 1080, h: 960 });
  assert.deepEqual(v[1], { id: 'b', x: 0, y: 960, w: 1080, h: 960 });
  assert.equal(v[0].h + v[1].h, 1920);
});

test('layout: validateTimeline rejects bad layout objects', () => {
  const bad = cloneTimeline(tl());
  bad.layout = 'nope';
  assert.ok(validateTimeline(bad).some((i) => i.code === 'BAD_LAYOUT'));

  const badMode = cloneTimeline(tl());
  badMode.layout = { mode: 'split-z' };
  assert.ok(validateTimeline(badMode).some((i) => i.code === 'BAD_LAYOUT_MODE'));

  const good = tl();
  setLayoutMode(good, 'split-h');
  assert.equal(validateTimeline(good).length, 0);
});

test('transform: makeClip defaults, setClipProps fit/scale/pos, validate', () => {
  assert.deepEqual(FIT_MODES, ['cover', 'contain', 'fill']);
  assert.equal(clampZoom(10), MAX_ZOOM);
  assert.equal(clampZoom(0.01), MIN_ZOOM);
  assert.equal(clampZoom(1.5), 1.5);
  assert.equal(clampZoom('x'), 1);
  assert.equal(clampZoom(0), 1);

  const d = makeClip({ kind: 'video', assetId: 'media-0001', start: 0, duration: 1 });
  assert.equal(d.fit, 'cover');
  assert.equal(d.scale, 1);
  assert.equal(d.posX, 50);
  assert.equal(d.posY, 50);

  const t = tl();
  const c = addClip(t, 'v1', { kind: 'video', assetId: 'media-0001', start: 0, duration: 2, srcIn: 0, volume: 1 });
  setClipProps(t, 'v1', c.id, { fit: 'contain', scale: 1.5, posX: 20, posY: 80 });
  const got = getClip(t, 'v1', c.id).clip;
  assert.equal(got.fit, 'contain');
  assert.equal(got.scale, 1.5);
  assert.equal(got.posX, 20);
  assert.equal(got.posY, 80);
  assert.equal(validateTimeline(t).length, 0);

  setClipProps(t, 'v1', c.id, { scale: 99, posX: -5 });
  const clamped = getClip(t, 'v1', c.id).clip;
  assert.equal(clamped.scale, MAX_ZOOM);
  assert.equal(clamped.posX, 0);

  assert.throws(() => setClipProps(t, 'v1', c.id, { fit: 'nope' }), (e) => e.code === 'BAD_FIT');

  const text = makeClip({ kind: 'text', start: 0, duration: 1, text: { content: 'x' } });
  assert.equal(text.fit, undefined);
  const tt = tl();
  const tc = addClip(tt, 't1', text);
  assert.throws(() => setClipProps(tt, 't1', tc.id, { fit: 'cover' }), (e) => e.code === 'BAD_PROP');

  const bad = cloneTimeline(tl());
  const bc = addClip(bad, 'v1', { kind: 'video', assetId: 'media-0001', start: 0, duration: 1, srcIn: 0, volume: 1 });
  bc.fit = 'stretch';
  assert.ok(validateTimeline(bad).some((i) => i.code === 'BAD_FIT'));
  const bad2 = cloneTimeline(tl());
  const b2 = addClip(bad2, 'v1', { kind: 'video', assetId: 'media-0001', start: 0, duration: 1, srcIn: 0, volume: 1 });
  b2.scale = 10;
  assert.ok(validateTimeline(bad2).some((i) => i.code === 'BAD_ZOOM'));
  const bad3 = cloneTimeline(tl());
  const b3 = addClip(bad3, 'v1', { kind: 'video', assetId: 'media-0001', start: 0, duration: 1, srcIn: 0, volume: 1 });
  b3.posX = 150;
  assert.ok(validateTimeline(bad3).some((i) => i.code === 'BAD_POS'));

  assert.deepEqual(normalizeTransform({ fit: 'contain', scale: 2, posX: 10, posY: 90 }), {
    fit: 'contain', scale: 2, posX: 10, posY: 90,
  });
  assert.deepEqual(normalizeTransform({}), { fit: 'cover', scale: 1, posX: 50, posY: 50 });
  assert.deepEqual(normalizeTransform({ fit: 'bad' }), { fit: 'cover', scale: 1, posX: 50, posY: 50 });
});

test('effects: normalize, setClipProps, validate', () => {
  assert.deepEqual(EFFECTS, ['none', 'bw', 'sepia', 'warm', 'cool', 'vivid', 'vintage', 'teal', 'golden', 'noir', 'neon', 'luxury']);
  assert.equal(normalizeEffect('bw'), 'bw');
  assert.equal(normalizeEffect('nope'), 'none');
  assert.equal(normalizeBgMode('full'), 'full');
  assert.equal(normalizeBgMode('x'), 'none');
  assert.equal(bgToCss('#ffffff'), '#ffffff');
  assert.equal(bgToCss('black@0.55'), 'rgba(0,0,0,0.55)');
  assert.equal(bgToFfmpeg('#ffffff'), 'ffffff@1');
  assert.equal(bgToFfmpeg('white'), 'white');

  const t = tl();
  const c = addClip(t, 'v1', { kind: 'video', assetId: 'media-0001', start: 0, duration: 2, srcIn: 0, volume: 1 });
  assert.equal(c.effect, 'none');
  setClipProps(t, 'v1', c.id, { effect: 'bw' });
  assert.equal(getClip(t, 'v1', c.id).clip.effect, 'bw');
  assert.equal(validateTimeline(t).length, 0);
  assert.throws(() => setClipProps(t, 'v1', c.id, { effect: 'nope' }), (e) => e.code === 'BAD_EFFECT');

  const bad = cloneTimeline(tl());
  const b = addClip(bad, 'v1', { kind: 'video', assetId: 'media-0001', start: 0, duration: 1, srcIn: 0, volume: 1 });
  b.effect = 'ultra-glow';
  assert.ok(validateTimeline(bad).some((i) => i.code === 'BAD_EFFECT'));

  const text = makeClip({
    kind: 'text', start: 0, duration: 2,
    text: { content: 'pov: test', position: 'top', bg: '#ffffff', bgMode: 'full', color: '#000000', bold: true },
  });
  assert.equal(text.text.bgMode, 'full');
  assert.equal(text.text.bg, '#ffffff');
  assert.equal(text.text.color, '#000000');
  assert.equal(text.text.bold, true);
  assert.equal(text.text.uppercase, false);
  assert.equal(text.text.strokeWidth, 0);
  assert.equal(text.text.shadow, false);
  assert.equal(text.text.anim, 'none');
  assert.equal(text.text.align, 'center');
  assert.ok(text.text.padX >= 0 && text.text.padY >= 0);
  assert.deepEqual(BG_MODES, ['none', 'inline', 'full']);
});

test('text premium: presets, anim/align normalize, banner sizing', () => {
  assert.deepEqual(TEXT_ANIMS, ['none', 'fade', 'pop', 'slide-up', 'slide-down', 'bounce', 'zoom-in']);
  assert.ok(TEXT_ALIGNS.includes('center'));
  assert.ok(TEXT_PRESETS.meme.bgMode === 'full');
  assert.ok(TEXT_PRESETS.outline.strokeWidth > 0);
  assert.ok(TEXT_PRESETS.news.letterSpacing >= 0);

  assert.equal(normalizeTextAnim('fade'), 'fade');
  assert.equal(normalizeTextAnim('nope'), 'none');
  assert.equal(normalizeTextAlign('left'), 'left');
  assert.equal(normalizeTextAlign('diag'), 'center');

  const meme = makeClip({
    kind: 'text', start: 0, duration: 2,
    text: { ...TEXT_PRESETS.meme, content: 'HELLO WORLD THIS IS A LONG MEME LINE FOR WRAP' },
  });
  assert.equal(meme.text.bgMode, 'full');
  assert.equal(meme.text.anim, 'fade');
  assert.equal(meme.text.uppercase, true);
  assert.equal(meme.text.padX, 40);

  const short = estimateBannerLines('HI', 64, 1080, 40, 0);
  const long = estimateBannerLines('HELLO WORLD THIS IS A LONG MEME LINE FOR WRAP TEST', 64, 1080, 40, 0);
  assert.equal(short, 1);
  assert.ok(long >= 1);
  assert.ok(bannerBoxHeight(long, 64, 22) > bannerBoxHeight(1, 64, 22));

  // widthPct on text (banner drag-resize) — clamp 10–100, default 100
  const wide = makeClip({ kind: 'text', start: 0, duration: 1, text: { widthPct: 500 } });
  assert.equal(wide.text.widthPct, 100);
  const narrow = makeClip({ kind: 'text', start: 0, duration: 1, text: { widthPct: 2 } });
  assert.equal(narrow.text.widthPct, 10);
  const half = makeClip({ kind: 'text', start: 0, duration: 1, text: { widthPct: 55 } });
  assert.equal(half.text.widthPct, 55);
  const def = makeClip({ kind: 'text', start: 0, duration: 1, text: {} });
  assert.equal(def.text.widthPct, 100);

  // snapPct: center + edges within threshold; Alt/disabled leaves value alone
  assert.equal(snapPct(49).value, 50);
  assert.equal(snapPct(49).snapped, 50);
  assert.equal(snapPct(48.5).snapped, 50); // |48.5-50| = 1.5 = threshold
  assert.equal(snapPct(47.5).snapped, null); // 2.5 away — outside default 1.5
  assert.equal(snapPct(45).snapped, null);
  assert.equal(snapPct(0.8).snapped, 0);
  assert.equal(snapPct(99).snapped, 100);
  assert.equal(snapPct(33, { candidates: [50], threshold: 1 }).snapped, null);
  assert.equal(snapPct(49, { disabled: true }).snapped, null);
  assert.equal(snapPct(49, { disabled: true }).value, 49);
  assert.equal(snapPct(NaN).snapped, null);

  const t = tl();
  const c = addClip(t, 't1', meme);
  assert.equal(validateTimeline(t).length, 0);
  setClipProps(t, 't1', c.id, { text: { anim: 'pop', strokeWidth: 6, align: 'left', shadow: true } });
  const got = getClip(t, 't1', c.id).clip.text;
  assert.equal(got.anim, 'pop');
  assert.equal(got.strokeWidth, 6);
  assert.equal(got.align, 'left');
  assert.equal(got.shadow, true);

  const bad = cloneTimeline(tl());
  const bc = addClip(bad, 't1', { kind: 'text', start: 0, duration: 1, text: { content: 'x' } });
  bc.text.anim = 'explode';
  assert.ok(validateTimeline(bad).some((i) => i.code === 'BAD_TEXT_ANIM'));
});

test('splitClip advances srcIn by leftDur * speed', () => {
  const t = tl();
  const c = addClip(t, 'v1', {
    kind: 'video', assetId: 'media-0001', start: 0, duration: 4, srcIn: 0, volume: 1, speed: 2,
  });
  const { left, right } = splitClip(t, 'v1', c.id, 1.5);
  assert.equal(left.duration, 1.5);
  assert.equal(right.srcIn, 3); // 1.5 timeline s * speed 2
  assert.equal(right.start, 1.5);
  assert.equal(right.speed, 2);
});

test('trimClip source overrun accounts for speed', () => {
  const t = tl();
  const c = addClip(t, 'v1', {
    kind: 'video', assetId: 'media-0001', start: 0, duration: 1, srcIn: 0, volume: 1, speed: 2,
  });
  // 6s timeline at 2× needs 12s source — assetDuration 10 → overrun
  assert.throws(
    () => trimClip(t, 'v1', c.id, { duration: 6, srcIn: 0 }, 10),
    (e) => e.code === 'SOURCE_OVERRUN'
  );
  // 4s timeline at 2× needs 8s source — OK
  trimClip(t, 'v1', c.id, { duration: 4, srcIn: 0 }, 10);
  assert.equal(getClip(t, 'v1', c.id).clip.duration, 4);
});

test('fades, transitions, keyframes: setClipProps + validate + eval', () => {
  const t = tl();
  const c = addClip(t, 'v1', {
    kind: 'video', assetId: 'media-0001', start: 0, duration: 4, srcIn: 0, volume: 1,
    fadeIn: 0.5, fadeOut: 1, transitionIn: 'fade',
    keyframes: { scale: [{ t: 0, v: 1 }, { t: 4, v: 1.5 }] },
  });
  assert.equal(c.fadeIn, 0.5);
  assert.equal(c.fadeOut, 1);
  assert.equal(c.transitionIn, 'fade');
  assert.equal(c.keyframes.scale.length, 2);
  assert.equal(validateTimeline(t).length, 0);

  setClipProps(t, 'v1', c.id, {
    fadeIn: 99, // clamped to MAX_FADE_SEC
    transitionIn: 'flash',
    keyframes: { opacity: [{ t: 0, v: 0 }, { t: 2, v: 1 }], bogus: [{ t: 0, v: 1 }] },
  });
  const got = getClip(t, 'v1', c.id).clip;
  assert.equal(got.fadeIn, MAX_FADE_SEC);
  assert.equal(got.transitionIn, 'flash');
  assert.ok(got.keyframes.opacity);
  assert.equal(got.keyframes.bogus, undefined); // unknown prop dropped
  assert.equal(validateTimeline(t).length, 0);

  // eval: linear midpoints
  assert.equal(evalKeyframes({ keyframes: { scale: [{ t: 0, v: 1 }, { t: 4, v: 2 }] } }, 2, 'scale', 9), 1.5);
  assert.equal(evalKeyframes({ keyframes: { scale: [{ t: 1, v: 3 }] } }, 0, 'scale', 9), 3);
  assert.equal(evalKeyframes({}, 0, 'scale', 7), 7);

  // fadeGain envelope
  const clip = { duration: 4, fadeIn: 1, fadeOut: 1 };
  assert.equal(fadeGain(clip, 0), 0);
  assert.ok(Math.abs(fadeGain(clip, 0.5) - 0.5) < 1e-9);
  assert.equal(fadeGain(clip, 2), 1);
  assert.ok(Math.abs(fadeGain(clip, 3.5) - 0.5) < 1e-9);
  assert.equal(fadeGain(clip, 4), 0);

  // transitionGain: hard cut always 1; fade ramps over 0.3s
  assert.equal(transitionGain({ transitionIn: 'none' }, 0), 1);
  assert.equal(transitionGain({ transitionIn: 'fade' }, 0), 0);
  assert.equal(transitionGain({ transitionIn: 'fade' }, 0.3), 1);
  assert.ok(transitionGain({ transitionIn: 'fade' }, 0.15) > 0.4);

  // invalid transition rejected
  assert.throws(
    () => setClipProps(t, 'v1', c.id, { transitionIn: 'sparkle' }),
    TimelineError
  );

  // split remaps fades + keyframes local times
  const t2 = tl();
  const c2 = addClip(t2, 'v1', {
    kind: 'video', assetId: 'media-0001', start: 0, duration: 4, srcIn: 0, volume: 1,
    fadeIn: 0.5, fadeOut: 1, transitionIn: 'fade',
    keyframes: { scale: [{ t: 0, v: 1 }, { t: 4, v: 2 }] },
  });
  const parts = splitClip(t2, 'v1', c2.id, 2);
  assert.equal(parts.left.fadeIn, 0.5);
  assert.equal(parts.left.transitionIn, 'fade');
  assert.equal(parts.right.fadeIn, 0);
  assert.equal(parts.right.transitionIn, 'none');
  assert.equal(parts.right.fadeOut, 1);
  assert.equal(parts.right.keyframes.scale[0].t, 0);
  assert.ok(parts.right.keyframes.scale[0].v > 1); // value at cut interpolates
  assert.ok(parts.right.keyframes.scale.some((p) => Math.abs(p.t - 2) < 0.011));

  // keyframeExpr builds nested if() with absolute time offset
  const expr = keyframeExpr([{ t: 0, v: 1 }, { t: 2, v: 3 }], 1, 10);
  assert.ok(expr.includes('if(lt(t,'));
  assert.ok(expr.includes('10')); // clipStart shift
  assert.equal(keyframeExpr(null, 0.5, 0), '0.5');
  assert.equal(keyframeExpr([], 2, 0), '2');

  assert.ok(TRANSITIONS.includes('fade'));
  assert.ok(KEYFRAME_PROPS.includes('opacity'));
  assert.equal(clampFade(-1), 0);
  assert.equal(clampFade(100), MAX_FADE_SEC);
});
