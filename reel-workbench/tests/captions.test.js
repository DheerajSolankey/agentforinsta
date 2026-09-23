import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCaption, captionForProject, textLinesFromTimeline } from '../server/captions.js';
import { createTimeline, addClip } from '../shared/timeline-ops.js';

test('buildCaption includes title, hook line, and CTA', () => {
  const c = buildCaption({
    projectName: 'Morning Routine',
    textLines: ['Wake up stronger', 'Step 1'],
    includeHashtags: false,
    cta: 'Save this.',
  });
  assert.match(c, /Morning Routine/);
  assert.match(c, /Wake up stronger/);
  assert.match(c, /Save this\./);
});

test('buildCaption appends hashtags from content only and respects maxLength', () => {
  const c = buildCaption({
    projectName: 'Gym Motivation',
    tags: ['#fitness'],
    includeCTA: false,
  });
  assert.match(c, /#reels/);
  assert.match(c, /#fitness/);
  assert.match(c, /#gym/);
  assert.ok(c.length <= 2200);

  const long = buildCaption({
    projectName: 'x'.repeat(100),
    description: 'y'.repeat(3000),
    includeHashtags: false,
    includeCTA: false,
    maxLength: 100,
  });
  assert.ok(long.length <= 100);
});

test('textLinesFromTimeline pulls unique t1/t2 content in order', () => {
  const t = createTimeline({ width: 1080, height: 1920, fps: 30 });
  addClip(t, 't1', { kind: 'text', start: 0, duration: 1, text: { content: 'Hook' } });
  addClip(t, 't2', { kind: 'text', start: 0, duration: 1, text: { content: 'Caption line' } });
  addClip(t, 't2', { kind: 'text', start: 1, duration: 1, text: { content: 'Hook' } });
  addClip(t, 't2', { kind: 'text', start: 2, duration: 1, text: { content: '   ' } });
  const lines = textLinesFromTimeline(t);
  assert.deepEqual(lines, ['Hook', 'Caption line']);
});

test('captionForProject wires project + timeline', () => {
  const t = createTimeline({ width: 1080, height: 1920, fps: 30 });
  addClip(t, 't1', { kind: 'text', start: 0, duration: 1, text: { content: 'Do the thing' } });
  const c = captionForProject({ name: 'My Reel', description: 'desc', style_name: 'Cinematic' }, t, {
    includeHashtags: false,
    cta: 'Follow.',
  });
  assert.match(c, /My Reel/);
  assert.match(c, /Do the thing/);
  assert.match(c, /Cinematic/);
  assert.match(c, /Follow\./);
});

test('no external site hardcoding in caption output', () => {
  const c = buildCaption({ projectName: 'Test', tags: ['alpha'], cta: 'Go.' });
  assert.doesNotMatch(c, /couplesexposition|instagram\.com|graph\.instagram/i);
});
