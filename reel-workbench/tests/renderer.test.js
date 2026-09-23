import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProgramSegments, overlayClipsOf, textClipsOf, audioClipsOf,
  videoClipAudios, buildSrt, validateForRender, RenderError, atempoChain,
  splitPaneClipsOf, buildFitFilter, buildEffectFilter,
  buildTextAlpha, buildTextX, buildTextY,
} from '../server/renderer.js';
import { createTimeline, addClip, timelineDuration, round3, setLayoutMode } from '../shared/timeline-ops.js';

function tl() {
  return createTimeline({ width: 1080, height: 1920, fps: 30 });
}

test('buildProgramSegments covers gaps with black fillers', () => {
  const t = tl();
  addClip(t, 'v1', { kind: 'video', assetId: 'media-0001', start: 1, duration: 2, srcIn: 0, volume: 1 });
  addClip(t, 'v1', { kind: 'video', assetId: 'media-0002', start: 4, duration: 1, srcIn: 0, volume: 1 });
  const duration = timelineDuration(t);
  const segs = buildProgramSegments(t, duration);
  assert.equal(segs.length, 4);
  assert.equal(segs[0].type, 'gap');
  assert.equal(segs[0].duration, 1);
  assert.equal(segs[1].type, 'clip');
  assert.equal(segs[1].start, 1);
  assert.equal(segs[2].type, 'gap');
  assert.equal(segs[2].duration, 1);
  assert.equal(segs[3].type, 'clip');
  const sum = segs.reduce((a, s) => a + s.duration, 0);
  assert.ok(Math.abs(sum - duration) < 0.01);
});

test('buildProgramSegments with trailing gap', () => {
  const t = tl();
  addClip(t, 'v1', { kind: 'video', assetId: 'media-0001', start: 0, duration: 2, srcIn: 0, volume: 1 });
  const segs = buildProgramSegments(t, 5);
  assert.equal(segs.length, 2);
  assert.equal(segs[1].type, 'gap');
  assert.equal(round3(segs[1].duration), 3);
});

test('buildProgramSegments empty timeline = single gap', () => {
  const t = tl();
  const segs = buildProgramSegments(t, 3);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'gap');
  assert.equal(segs[0].duration, 3);
});

test('overlay / text / audio collectors respect track + hidden/muted', () => {
  const t = tl();
  addClip(t, 'v3', { kind: 'image', assetId: 'media-0009', start: 0, duration: 2, srcIn: 0, volume: 1 });
  addClip(t, 't1', { kind: 'text', start: 0, duration: 1, text: { content: 'Hi' } });
  addClip(t, 't2', { kind: 'text', start: 0, duration: 1, text: { content: '' } });
  addClip(t, 'a2', { kind: 'audio', assetId: 'media-0005', start: 0, duration: 2, srcIn: 0, volume: 0.2 });
  addClip(t, 'a2', { kind: 'audio', assetId: 'media-0006', start: 3, duration: 1, srcIn: 0, volume: 0 });
  addClip(t, 'v1', { kind: 'video', assetId: 'media-0001', start: 0, duration: 2, srcIn: 0, volume: 1 });

  assert.equal(overlayClipsOf(t).length, 1);
  assert.equal(textClipsOf(t).length, 1);
  assert.equal(audioClipsOf(t).length, 1);
  assert.equal(videoClipAudios(t).length, 1);

  t.tracks.find((x) => x.id === 'v3').hidden = true;
  assert.equal(overlayClipsOf(t).length, 0);

  t.tracks.find((x) => x.id === 'a2').muted = true;
  assert.equal(audioClipsOf(t).length, 0);
});

test('buildSrt formats timestamps and cues', () => {
  const srt = buildSrt([
    { content: 'First line', clip: { start: 0, duration: 1.5 } },
    { content: 'Second', clip: { start: 2, duration: 1 } },
  ]);
  assert.match(srt, /^1\n/);
  assert.match(srt, /00:00:00,000 --> 00:00:01,500\nFirst line/);
  assert.match(srt, /00:00:02,000 --> 00:00:03,000\nSecond/);
  assert.match(srt, /\n2\n/);
});

test('validateForRender throws RenderError stage=validate on invalid timeline', () => {
  const broken = { width: 0, height: 1920, fps: 30, tracks: [] };
  assert.throws(() => validateForRender({ id: 'project-001' }, broken), (e) =>
    e instanceof RenderError && e.stage === 'validate');
});

test('RenderError carries stage + detail', () => {
  const e = new RenderError('boom', { stage: 'composite', detail: 'x' });
  assert.equal(e.stage, 'composite');
  assert.equal(e.detail, 'x');
  assert.equal(e.name, 'RenderError');
});

test('atempoChain handles wide speed ranges', () => {
  assert.deepEqual(atempoChain(1), []);
  assert.deepEqual(atempoChain(0), []);
  assert.deepEqual(atempoChain(1.5), ['atempo=1.5']);
  assert.deepEqual(atempoChain(0.5), ['atempo=0.5']);
  const four = atempoChain(4);
  assert.deepEqual(four, ['atempo=2.0', 'atempo=2']); // round3(2) === 2
  const quarter = atempoChain(0.25);
  assert.ok(quarter.includes('atempo=0.5'));
  assert.ok(quarter.length >= 2);
});

test('split layout: splitPaneClipsOf collects v1 + v3, empty when full frame', () => {
  const t = tl();
  addClip(t, 'v1', { kind: 'video', assetId: 'media-0001', start: 0, duration: 3, srcIn: 0, volume: 1 });
  addClip(t, 'v3', { kind: 'video', assetId: 'media-0002', start: 0.5, duration: 2, srcIn: 0, volume: 1 });
  addClip(t, 'v3', { kind: 'image', assetId: 'media-0009', start: 3, duration: 1, srcIn: 0, volume: 1 });

  let panes = splitPaneClipsOf(t);
  assert.deepEqual(panes, { primary: [], secondary: [] });

  setLayoutMode(t, 'split-h');
  panes = splitPaneClipsOf(t);
  assert.equal(panes.primary.length, 1);
  assert.equal(panes.primary[0].trackId, 'v1');
  assert.equal(panes.primary[0].clip.kind, 'video');
  assert.equal(panes.secondary.length, 2);
  assert.equal(panes.secondary[0].trackId, 'v3');
  assert.equal(panes.secondary[0].clip.start, 0.5);

  getTrackHidden(t, 'v3', true);
  panes = splitPaneClipsOf(t);
  assert.equal(panes.secondary.length, 0);
});

test('buildFitFilter: cover/contain/fill + zoom/focus', () => {
  const cover = buildFitFilter({}, 540, 1920);
  assert.ok(cover.includes('force_original_aspect_ratio=increase'));
  assert.ok(cover.includes('crop=540:1920'));
  assert.ok(cover.includes('floor((iw-540)*50/100)'));

  const contain = buildFitFilter({ fit: 'contain' }, 540, 1920);
  assert.ok(contain.includes('force_original_aspect_ratio=decrease'));
  assert.ok(contain.includes('pad=540:1920'));
  assert.ok(contain.includes('color=black'));

  const fill = buildFitFilter({ fit: 'fill' }, 540, 1920);
  assert.ok(fill.includes('scale=540:1920'));
  assert.ok(!fill.includes('crop='));

  const focus = buildFitFilter({ posX: 0, posY: 100 }, 540, 1920);
  assert.ok(focus.includes('floor((iw-540)*0/100)'));
  assert.ok(focus.includes('floor((ih-1920)*100/100)'));

  const zoomIn = buildFitFilter({ scale: 2 }, 540, 1920);
  assert.ok(zoomIn.includes('scale=1080:3840'));
  assert.ok(zoomIn.includes('crop=540:1920'));

  const zoomOut = buildFitFilter({ scale: 0.5 }, 540, 1920);
  assert.ok(zoomOut.includes('scale=270:960'));
  assert.ok(zoomOut.includes('pad=540:1920'));

  const defaults = buildFitFilter(null, 1080, 1920);
  assert.ok(defaults.includes('crop=1080:1920'));
});

test('buildEffectFilter: bw / none / vivid / looks', () => {
  assert.equal(buildEffectFilter({ effect: 'bw' }), 'hue=s=0');
  assert.equal(buildEffectFilter({ effect: 'none' }), '');
  assert.equal(buildEffectFilter({}), '');
  assert.ok(buildEffectFilter({ effect: 'vivid' }).includes('contrast'));
  assert.ok(buildEffectFilter({ effect: 'sepia' }).includes('colorchannelmixer'));
  assert.ok(buildEffectFilter({ effect: 'vintage' }).includes('eq='));
  assert.ok(buildEffectFilter({ effect: 'teal' }).includes('colorbalance'));
  assert.ok(buildEffectFilter({ effect: 'golden' }).includes('gamma_r'));
  assert.ok(buildEffectFilter({ effect: 'noir' }).includes('hue=s=0'));
  assert.ok(buildEffectFilter({ effect: 'neon' }).includes('saturation=1.55'));
  assert.ok(buildEffectFilter({ effect: 'luxury' }).includes('gamma_r'));
});

test('buildTextAlpha / buildTextX / buildTextY for premium text', () => {
  assert.equal(buildTextAlpha('none', 0, 2), null);
  assert.equal(buildTextAlpha('fade', 0, 0.1, 0.3), null);
  const fade = buildTextAlpha('fade', 0, 2, 0.25);
  assert.ok(typeof fade === 'string' && fade.includes('lt(t,'));
  const pop = buildTextAlpha('pop', 1, 3, 0.3);
  assert.ok(typeof pop === 'string' && pop.includes('((t-1)'));
  assert.ok(typeof buildTextAlpha('slide-up', 0, 2, 0.3) === 'string');
  assert.ok(typeof buildTextAlpha('bounce', 0, 2, 0.3) === 'string');
  assert.ok(typeof buildTextAlpha('zoom-in', 0, 2, 0.3) === 'string');

  const ySlide = buildTextY('slide-up', 0, 0.3, '(h-text_h)*50/100');
  assert.ok(ySlide.includes('+48*max'));
  assert.equal(buildTextY('fade', 0, 0.3, 'BASE'), 'BASE');
  assert.equal(buildTextY('slide-down', 1, 0.2, 'B'), 'B+-48*max(0,1-(t-1)/0.2)');

  assert.equal(buildTextX('center', 50, 40), '(w-text_w)*50/100');
  assert.equal(buildTextX('left', 50, 40), '40');
  assert.equal(buildTextX('right', 50, 40), 'w-text_w-40');
  assert.equal(buildTextX('bogus', 25, 0), '(w-text_w)*25/100');
});

test('split layout: videoClipAudios includes v3 when split; overlayClipsOf skips v3', () => {
  const t = tl();
  addClip(t, 'v1', { kind: 'video', assetId: 'media-0001', start: 0, duration: 2, srcIn: 0, volume: 1 });
  addClip(t, 'v3', { kind: 'video', assetId: 'media-0002', start: 0, duration: 2, srcIn: 0, volume: 0.5 });
  addClip(t, 'v2', { kind: 'image', assetId: 'media-0009', start: 0, duration: 2, srcIn: 0, volume: 1 });

  assert.equal(videoClipAudios(t).length, 1);
  assert.equal(overlayClipsOf(t).length, 2); // v2 + v3 floating

  setLayoutMode(t, 'split-v');
  const audios = videoClipAudios(t);
  assert.equal(audios.length, 2);
  assert.ok(audios.some((c) => c.assetId === 'media-0002'));
  const overlays = overlayClipsOf(t);
  assert.equal(overlays.length, 1);
  assert.equal(overlays[0].trackId, 'v2');
});

test('detectFontFile maps font names to existing files', async () => {
  const { detectFontFile } = await import('../server/config.js');
  const def = detectFontFile();
  assert.ok(def, 'default font should exist on this machine');
  const arial = detectFontFile('Arial');
  assert.ok(arial, 'Arial should resolve');
  assert.ok(/arial/i.test(arial) || /arial/i.test(def), arial);
  // Unknown name falls back to default stack, never null when default exists
  const fallback = detectFontFile('NotARealFont');
  assert.ok(fallback);
});

test('buildFitFilter with scale/pos keyframes emits expressions', () => {
  const f = buildFitFilter({
    keyframes: {
      scale: [{ t: 0, v: 1 }, { t: 2, v: 1.4 }],
      posX: [{ t: 0, v: 50 }, { t: 2, v: 80 }],
    },
  }, 540, 1920);
  assert.ok(f.includes('if(lt(t,'), f);
  assert.ok(f.includes('scale=w='), f);
  // static path unchanged when no keyframes
  const plain = buildFitFilter({ scale: 2 }, 540, 1920);
  assert.ok(!plain.includes('if(lt(t,'), plain);
  assert.ok(plain.includes('crop='), plain);
});

function getTrackHidden(t, id, hidden) {
  const tr = t.tracks.find((x) => x.id === id);
  tr.hidden = hidden;
}
