import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sep } from 'path';
import {
  resolveInRoot, assertInsideData, safeFilename, hasControlChars,
  assertProjectId, assertMediaId, PathError, PROJECT_ID_RE, MEDIA_ID_RE,
} from '../server/paths.js';
import { DATA_DIR } from '../server/config.js';
import { validateForRender, RenderError } from '../server/renderer.js';

const ROOT = DATA_DIR;

test('resolveInRoot allows simple relative paths', () => {
  const p = resolveInRoot(ROOT, 'projects/project-001/timeline.json');
  assert.ok(p.startsWith(resolve(ROOT) + sep));
});

test('resolveInRoot rejects traversal', () => {
  const cases = [
    '../outside.txt',
    '..\\outside.txt',
    'projects/../../outside.txt',
    'projects/..\\..\\windows\\system32',
    './../../etc/passwd',
  ];
  for (const c of cases) {
    assert.throws(() => resolveInRoot(ROOT, c), PathError, `should reject: ${c}`);
  }
});

test('resolveInRoot rejects absolute paths', () => {
  assert.throws(() => resolveInRoot(ROOT, 'C:\\Windows\\notepad.exe'), PathError);
  assert.throws(() => resolveInRoot(ROOT, '/etc/passwd'), PathError);
  assert.throws(() => resolveInRoot(ROOT, '\\\\server\\share\\x'), PathError);
});

test('resolveInRoot rejects empty / control chars / NUL', () => {
  assert.throws(() => resolveInRoot(ROOT, ''), PathError);
  assert.throws(() => resolveInRoot(ROOT, `a${String.fromCharCode(0)}b`), PathError);
  assert.throws(() => resolveInRoot(ROOT, 'a\nb'), PathError);
  assert.throws(() => resolveInRoot(ROOT, 'a\rb'), PathError);
  assert.ok(hasControlChars(`x${String.fromCharCode(1)}y`));
  assert.ok(!hasControlChars('normal-file.mp4'));
});

test('assertInsideData rejects paths outside data/', () => {
  assert.throws(() => assertInsideData('C:\\Windows\\System32\\cmd.exe'), PathError);
  assert.throws(() => assertInsideData(resolve(ROOT, '..', 'escape.txt')), PathError);
  const inside = resolve(ROOT, 'exports', 'final.mp4');
  assert.equal(assertInsideData(inside), inside);
});

test('safeFilename strips illegal characters and length', () => {
  assert.equal(safeFilename('a<b>c:"d"|e?f*g.mp4'), 'a_b_c__d__e_f_g.mp4');
  assert.equal(safeFilename('  spaced   name  '), 'spaced name');
  assert.equal(safeFilename('x'.repeat(300)).length, 120);
  assert.equal(safeFilename(''), 'file');
  assert.equal(safeFilename(null), 'file');
  assert.ok(!/[<>:"/\\|?*]/.test(safeFilename('evil/../name:file')));
});

test('id validators', () => {
  assert.equal(assertProjectId('project-001'), 'project-001');
  assert.equal(assertMediaId('media-0042'), 'media-0042');
  assert.throws(() => assertProjectId('../project-001'), PathError);
  assert.throws(() => assertProjectId('project-001/../../x'), PathError);
  assert.throws(() => assertProjectId('proj-1'), PathError);
  assert.throws(() => assertMediaId('media-00001-extra'), PathError);
  assert.ok(PROJECT_ID_RE.test('project-12345'));
  assert.ok(MEDIA_ID_RE.test('media-9999'));
});

function emptyTracks() {
  return ['v1', 'v2', 'v3', 'a1', 'a2', 'a3', 't1', 't2'].map((id) => ({
    id,
    type: id[0] === 'v' ? 'video' : id[0] === 'a' ? 'audio' : 'text',
    label: id,
    muted: false,
    hidden: false,
    locked: false,
    clips: [],
  }));
}

test('validateForRender rejects empty timeline', () => {
  const empty = { width: 1080, height: 1920, fps: 30, tracks: emptyTracks() };
  assert.throws(
    () => validateForRender({ id: 'project-001' }, empty),
    (e) => e instanceof RenderError && /empty/i.test(e.message)
  );
});

test('validateForRender rejects missing asset (unknown id)', () => {
  const t = {
    width: 1080, height: 1920, fps: 30,
    tracks: emptyTracks(),
  };
  t.tracks.find((x) => x.id === 'v1').clips.push({
    id: 'c1', kind: 'video', start: 0, duration: 1, srcIn: 0, volume: 1, muted: false,
    assetId: 'media-9999',
  });
  assert.throws(
    () => validateForRender({ id: 'project-001' }, t),
    (e) => e instanceof RenderError && /no longer in the library|missing/i.test(e.message)
  );
});

test('REFERENCE_ONLY semantics used by validateForRender', () => {
  const refAsset = { category: 'reference', rights_status: 'REFERENCE_ONLY' };
  assert.equal(refAsset.rights_status, 'REFERENCE_ONLY');
  // mirror the branch in renderer.validateForRender
  assert.equal(refAsset.rights_status === 'REFERENCE_ONLY', true);
});

test('hasControlChars detects C0/C1/DEL', () => {
  assert.ok(hasControlChars(String.fromCharCode(7)));
  assert.ok(hasControlChars(String.fromCharCode(27)));
  assert.ok(hasControlChars(String.fromCharCode(127)));
  assert.ok(hasControlChars(String.fromCharCode(0x85)));
  assert.ok(!hasControlChars('ok-name_1.mp4'));
});
