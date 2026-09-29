import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProgramSegments, overlayClipsOf, textClipsOf, audioClipsOf,
  videoClipAudios, buildSrt, validateForRender, RenderError, atempoChain,
  splitPaneClipsOf, buildFitFilter, buildEffectFilter, buildRotateFilter,
  buildTextAlpha, buildTextX, buildTextY,
  buildChromaFilter, buildMaskFilter, buildKeyMaskStage, curveSegmentCount,
  buildSpeedCurveGraph, buildSpeedCurveAudioGraph, buildClipPrepArgs, buildWavArgs,
} from '../server/renderer.js';
import {
  createTimeline, addClip, timelineDuration, round3, setLayoutMode,
  makeClip, SPEED_CURVE_PRESETS, sourceSpanOf,
} from '../shared/timeline-ops.js';

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
  assert.ok(buildEffectFilter({ effect: 'vignette' }).includes('vignette'));
  assert.ok(buildEffectFilter({ effect: 'soft' }).includes('gblur'));

  // rotate: identity → empty; static and keyframed emit rotate filter
  assert.equal(buildRotateFilter({}), '');
  assert.equal(buildRotateFilter({ rotate: 0 }), '');
  const rot = buildRotateFilter({ rotate: 90 });
  assert.ok(rot.includes('rotate=a=') && rot.includes('PI/180'));
  const rotKf = buildRotateFilter({ rotate: 0, keyframes: { rotate: [{ t: 0, v: 0 }, { t: 2, v: 360 }] } });
  assert.ok(rotKf.includes('rotate=a=') && rotKf.includes('if(lt('));
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
  const flicker = buildTextAlpha('flicker', 0, 2, 0.45);
  assert.ok(typeof flicker === 'string' && flicker.includes('mod('));

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

const SLOMO = SPEED_CURVE_PRESETS.sloMo;
const RECT = { type: 'rect', x: 50, y: 50, w: 60, h: 60, feather: 0, rotation: 0, invert: false };

test('buildChromaFilter: colorkey + optional despill with similarity floor', () => {
  assert.equal(buildChromaFilter({}), '');
  assert.equal(buildChromaFilter({ chroma: null }), '');
  assert.equal(buildChromaFilter({ chroma: { color: '#00ff00', similarity: 0.3, blend: 0.15 } }),
    'colorkey=color=0x00ff00:similarity=0.3:blend=0.15');
  // ffmpeg rejects similarity=0 (out of range) → clamp to its floor
  assert.equal(buildChromaFilter({ chroma: { color: '#00ff00', similarity: 0, blend: 0 } }),
    'colorkey=color=0x00ff00:similarity=0.00001:blend=0');
  assert.equal(buildChromaFilter({ chroma: { color: '#00ff00', similarity: 0.3, blend: 0.15, despill: 0.6 } }),
    'colorkey=color=0x00ff00:similarity=0.3:blend=0.15,despill=type=green:mix=0.6');
  const blue = buildChromaFilter({ chroma: { color: '#0000ff', similarity: 0.3, blend: 0.15, despill: 0.6 } });
  assert.ok(blue.endsWith('despill=type=blue:mix=0.6'), blue);
  // red keys have no despill channel → despill skipped
  assert.equal(buildChromaFilter({ chroma: { color: '#ff0000', similarity: 0.3, blend: 0.15, despill: 0.6 } }),
    'colorkey=color=0xff0000:similarity=0.3:blend=0.15');
});

test('buildMaskFilter: flatten burns to black, overlay keeps alpha', () => {
  assert.equal(buildMaskFilter({}), '');
  assert.equal(buildMaskFilter({ mask: null }), '');

  const flat = buildMaskFilter({ mask: RECT });
  assert.ok(flat.startsWith('format=rgba,geq='), flat);
  assert.ok(flat.includes("r='clip(floor(r(X,Y)*alpha(X,Y)*"), 'RGB scaled by matte');
  assert.ok(flat.includes("a='clip(floor(alpha(X,Y)*"), 'matte written to alpha');
  assert.ok(flat.includes('max(abs('), 'rect uses chebyshev distance');
  assert.ok(flat.includes('if(lt('), 'feather 0 → hard edge');
  assert.ok(flat.endsWith(',format=yuv420p'), flat);

  const overlay = buildMaskFilter({ mask: RECT }, { flatten: false });
  assert.ok(overlay.startsWith('format=rgba,geq='), overlay);
  assert.ok(overlay.includes("r='r(X,Y)'"), 'RGB passthrough in overlay mode');
  assert.ok(!overlay.includes(',format='), 'no flatten/format suffix', overlay);

  assert.ok(buildMaskFilter({ mask: { ...RECT, type: 'circle' } }).includes('hypot('));
  assert.ok(buildMaskFilter({ mask: { ...RECT, type: 'line' } }).includes('abs('));
  assert.ok(buildMaskFilter({ mask: { ...RECT, type: 'ellipse' } }).includes('sqrt('));
  assert.ok(buildMaskFilter({ mask: { ...RECT, rotation: 45 } }).includes('cos(45*PI/180)'));
  assert.ok(buildMaskFilter({ mask: { ...RECT, rotation: 45 } }).includes('sin(45*PI/180)'));
  assert.ok(buildMaskFilter({ mask: { ...RECT, invert: true } }).includes('255-('));
  assert.ok(buildMaskFilter({ mask: { ...RECT, type: 'ellipse', feather: 0.5 } }).includes('/(2*0.5)'));
});

test('buildKeyMaskStage: chroma / mask / both / neither', () => {
  assert.equal(buildKeyMaskStage({}), '');
  assert.equal(buildKeyMaskStage({ chroma: null, mask: null }), '');

  const chroma = buildKeyMaskStage({ chroma: { color: '#00ff00', similarity: 0.3, blend: 0.15, despill: 0 } });
  assert.ok(chroma.startsWith('format=rgba,colorkey='), chroma);
  assert.ok(chroma.includes("geq=r='clip(floor(r(X,Y)*alpha(X,Y)/255),0,255)'"), 'key flattened to yuv');
  assert.ok(chroma.includes("a='alpha(X,Y)'"), chroma);
  assert.ok(chroma.endsWith('format=yuv420p'), chroma);

  const mask = buildKeyMaskStage({ mask: RECT });
  assert.ok(mask.startsWith('format=rgba,geq='), mask);
  assert.ok(mask.endsWith('format=yuv420p'), mask);

  const both = buildKeyMaskStage({ chroma: { color: '#00ff00', similarity: 0.3, blend: 0.15, despill: 0 }, mask: RECT });
  assert.ok(both.includes('colorkey=') && both.includes('geq='), both);
  assert.ok(both.indexOf('colorkey=') < both.indexOf('geq='), 'key before matte');

  // overlay mode keeps alpha (no yuv flatten)
  const overlay = buildKeyMaskStage({ chroma: { color: '#00ff00', similarity: 0.3, blend: 0.15, despill: 0 } }, { flatten: false });
  assert.ok(overlay.startsWith('format=rgba,colorkey='), overlay);
  assert.ok(!overlay.includes(',format=yuv420p'), overlay);
});

test('curveSegmentCount clamps N for short clips', () => {
  assert.equal(curveSegmentCount({ duration: 3 }), 1); // no curve → constant retime
  assert.equal(curveSegmentCount({ duration: 3, speedCurve: { preset: 'sloMo', points: SLOMO } }, 30), 12);
  assert.equal(curveSegmentCount({ duration: 1, speedCurve: { preset: 'sloMo', points: SLOMO } }, 30), 5);
  assert.equal(curveSegmentCount({ duration: 0.2, speedCurve: { preset: 'sloMo', points: SLOMO } }, 30), 1);
  assert.equal(curveSegmentCount({ duration: 0.1, speedCurve: { preset: 'sloMo', points: SLOMO } }, 30), 1);
  assert.equal(curveSegmentCount({ duration: 3, speedCurve: { preset: 'sloMo', points: SLOMO } }, 1), 1); // fps knob
  assert.equal(curveSegmentCount({ duration: 3, speedCurve: SPEED_CURVE_PRESETS.constant }, 30), 1); // flat curve
});

test('buildSpeedCurveGraph: split → trim/retime/fps → concat', () => {
  const clip = makeClip({ kind: 'video', duration: 3, srcIn: 0, speedCurve: { preset: 'sloMo', points: SLOMO } });
  const g = buildSpeedCurveGraph(clip, 30);
  assert.equal(g.length, 14); // split + 12 branches + concat
  assert.equal(g[0], '[0:v]split=12[cs0][cs1][cs2][cs3][cs4][cs5][cs6][cs7][cs8][cs9][cs10][cs11]');
  assert.match(g[1], /^\[cs0\]trim=start=0:end=[\d.]+,setpts=\(PTS-STARTPTS\)\/[\d.]+,fps=30\[cb0\]$/);
  assert.match(g[g.length - 1],
    /^\[cb0\].*concat=n=12:v=1:a=0\[rt\]$/);

  // trim windows are srcIn-relative and contiguous
  const bounds = g.slice(1, g.length - 1).map((s) => [
    parseFloat(/start=([\d.]+)/.exec(s)[1]),
    parseFloat(/end=([\d.]+)/.exec(s)[1]),
  ]);
  assert.equal(bounds[0][0], 0);
  for (let i = 1; i < bounds.length; i++) assert.equal(bounds[i][0], bounds[i - 1][1]);

  // srcIn offsets the whole window, last edge = sourceSpanOf
  const shifted = makeClip({ kind: 'video', duration: 2, srcIn: 0.5, speedCurve: { preset: 'sloMo', points: SLOMO } });
  const sg = buildSpeedCurveGraph(shifted, 30);
  assert.equal(sg.length, 12); // 10 branches (floor(2*0.35*30/2))
  const sBounds = sg.slice(1, sg.length - 1).map((s) => parseFloat(/end=([\d.]+)/.exec(s)[1]));
  assert.equal(round3(sBounds[sBounds.length - 1]), round3(sourceSpanOf(shifted)));

  // label plumbing
  const custom = buildSpeedCurveGraph(clip, 30, { inLabel: '3:v', outLabel: 'zz' });
  assert.ok(custom[0].startsWith('[3:v]split=12'), custom[0]);
  assert.ok(custom[custom.length - 1].endsWith('[zz]'));

  // short clip → single constant retime, no split/concat
  const tiny = makeClip({ kind: 'video', duration: 0.1, speedCurve: { preset: 'sloMo', points: SLOMO } });
  const one = buildSpeedCurveGraph(tiny, 30);
  assert.equal(one.length, 1);
  assert.match(one[0], /^\[0:v\]setpts=PTS\/[\d.]+\[rt\]$/);
});

test('buildSpeedCurveAudioGraph: varispeed branches, never atempo', () => {
  const clip = makeClip({ kind: 'video', duration: 3, speedCurve: { preset: 'sloMo', points: SLOMO } });
  const g = buildSpeedCurveAudioGraph(clip, 30);
  assert.equal(g.length, 14);
  assert.equal(g[0], '[0:a]aresample=48000,asplit=12[as0][as1][as2][as3][as4][as5][as6][as7][as8][as9][as10][as11]');
  assert.match(g[1],
    /^\[as0\]atrim=start=0:end=[\d.]+,asetpts=PTS-STARTPTS,asetrate=48000\*[\d.]+,aresample=48000\[ab0\]$/);
  assert.match(g[g.length - 1], /\[ab0\].*concat=n=12:v=0:a=1\[ac\]$/);
  assert.ok(!g.join(';').includes('atempo'), 'curves retime with asetrate, not atempo');

  const tiny = makeClip({ kind: 'video', duration: 0.1, speedCurve: { preset: 'sloMo', points: SLOMO } });
  const one = buildSpeedCurveAudioGraph(tiny, 30);
  assert.equal(one.length, 1);
  assert.match(one[0], /^\[0:a\]aresample=48000,asetrate=48000\*[\d.]+,aresample=48000\[ac\]$/);
});

test('buildClipPrepArgs: plain vs curve vs image argv', () => {
  const plainClip = makeClip({ kind: 'video', duration: 1, srcIn: 0.5, speed: 2 });
  const plain = buildClipPrepArgs(plainClip, { path: 'in.mp4', w: 320, h: 240, fps: 30 });
  assert.ok(plain.includes('-vf'));
  assert.ok(!plain.includes('-filter_complex'));
  assert.equal(plain[plain.indexOf('-ss') + 1], '0.5');
  assert.equal(plain[plain.indexOf('-t') + 1], '2'); // duration * speed of source time
  const vf = plain[plain.indexOf('-vf') + 1];
  assert.ok(vf.includes('setpts=PTS/2'), vf);
  assert.ok(vf.endsWith('fps=30,setsar=1,format=yuv420p'), vf);

  const rev = buildClipPrepArgs(makeClip({ kind: 'video', duration: 1, speed: 2, reverse: true }),
    { path: 'in.mp4', w: 320, h: 240, fps: 30 });
  assert.ok(rev[rev.indexOf('-vf') + 1].includes('setpts=PTS/2,reverse'), 'reverse after retime');

  const curveClip = makeClip({
    kind: 'video', duration: 3, srcIn: 0, reverse: true,
    speedCurve: { preset: 'sloMo', points: SLOMO },
    chroma: { color: '#00ff00', similarity: 0.3, blend: 0.15, despill: 0 },
    mask: RECT,
  });
  const curve = buildClipPrepArgs(curveClip, { path: 'in.mp4', w: 320, h: 240, fps: 30 });
  assert.ok(curve.includes('-filter_complex'));
  assert.ok(curve.includes('-map') && curve.includes('[vout]'));
  assert.ok(!curve.includes('-vf'));
  assert.equal(curve[curve.indexOf('-t') + 1], String(sourceSpanOf(curveClip)), 'reads source span, not duration');
  const fc = curve[curve.indexOf('-filter_complex') + 1];
  assert.ok(fc.startsWith('[0:v]split=12'), fc.slice(0, 60));
  assert.ok(fc.includes('[rc]reverse,'), 'reverse runs right after the curve graph');
  const afterRev = fc.slice(fc.indexOf('[rc]reverse,'));
  assert.ok(afterRev.indexOf('colorkey=') < afterRev.indexOf('geq='), 'key stage before mask stage');
  assert.ok(fc.endsWith('[vout]'), fc.slice(-40));

  const img = buildClipPrepArgs(makeClip({ kind: 'image', duration: 2 }),
    { path: 'still.png', w: 320, h: 240, fps: 30 });
  assert.ok(img.includes('-loop') && img.includes('-t'));
  assert.ok(img.includes('-vf'));
  assert.ok(!img.includes('-filter_complex'));
});

test('buildWavArgs: atempo for constant speed, graph for curves', () => {
  const plain = buildWavArgs(makeClip({ kind: 'video', duration: 1, speed: 2, reverse: true, volume: 0.5, fadeIn: 0.2, fadeOut: 0.3 }),
    { path: 'a.wav', out: 'o.wav' });
  assert.ok(plain.includes('-af'));
  const af = plain[plain.indexOf('-af') + 1];
  assert.ok(af.includes('atempo=2'), af);
  assert.ok(af.includes('areverse'), af);
  assert.ok(af.includes('volume=0.5'), af);
  assert.ok(af.includes('afade=t=in:st=0:d=0.2'), af);
  assert.ok(af.includes('afade=t=out:st=0.7:d=0.3'), af);
  assert.equal(plain[plain.length - 1], 'o.wav');

  const curveClip = makeClip({ kind: 'video', duration: 3, srcIn: 0, speedCurve: { preset: 'sloMo', points: SLOMO } });
  const curve = buildWavArgs(curveClip, { path: 'a.wav', out: 'o.wav' });
  assert.ok(curve.includes('-filter_complex'));
  assert.equal(curve[curve.indexOf('-t') + 1], String(sourceSpanOf(curveClip)));
  const fc = curve[curve.indexOf('-filter_complex') + 1];
  assert.ok(fc.startsWith('[0:a]aresample=48000,asplit=12'), fc.slice(0, 60));
  assert.ok(fc.includes('asetrate=48000*'), fc.slice(0, 200));
  assert.ok(fc.includes('concat=n=12:v=0:a=1[ac]'), fc.slice(-80));
  assert.ok(!fc.includes('atempo'), fc);
  assert.ok(fc.endsWith('[ao]'), fc.slice(-40));
  assert.ok(curve.includes('-map') && curve.includes('[ao]'));
});
