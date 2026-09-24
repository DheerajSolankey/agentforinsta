/**
 * Image / thumbnail edit endpoints: PUT /api/media/:id/thumb, POST /api/media/:id/replace,
 * derivedFrom on upload, and validation errors.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { ensureFixtures } from '../scripts/make-fixtures.js';
import { createApp } from '../server/app.js';
import { detectFfmpeg } from '../server/config.js';

const PORT = 4208;
const BASE = `http://127.0.0.1:${PORT}`;

// canonical 1×1 PNG
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function singleFileForm(field, buf, filename, type = 'image/png') {
  const fd = new FormData();
  fd.append(field, new Blob([buf], { type }), filename);
  return fd;
}

async function uploadFixture(filePath) {
  const fd = new FormData();
  fd.append('files', new Blob([readFileSync(filePath)]), filePath.split(/[\\/]/).pop());
  const res = await fetch(`${BASE}/api/media`, { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test('image edit endpoints (replace / thumb / derivedFrom)', { timeout: 60000 }, async (t) => {
  const app = createApp();
  const server = createServer(app);
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  t.after(() => server.close());

  const ffmpegOk = !!detectFfmpeg();
  const fixtures = ensureFixtures();

  /* ---- upload a real image fixture ---- */
  const up = await uploadFixture(fixtures.image);
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const img = up.data.media[0];
  assert.ok(img.id);
  assert.equal(img.kind, 'image');
  assert.ok(img.thumb, 'thumbnail generated on ingest');

  /* ---- PUT /thumb: custom thumbnail ---- */
  const thumbRes = await fetch(`${BASE}/api/media/${img.id}/thumb`, {
    method: 'PUT',
    body: singleFileForm('file', PNG_1X1, 'cover.png'),
  });
  const thumbData = await thumbRes.json();
  assert.equal(thumbRes.status, 200, JSON.stringify(thumbData));
  assert.equal(thumbData.media.thumb_edited, true);
  assert.ok(thumbData.media.thumb_rel.includes(`${img.id}.png`));
  assert.equal(thumbData.media.thumb, `/api/media/${img.id}/thumb`);

  const getThumb = await fetch(`${BASE}/api/media/${img.id}/thumb`);
  assert.equal(getThumb.status, 200);
  assert.equal(getThumb.headers.get('cache-control'), 'no-store');
  const thumbBytes = new Uint8Array(await getThumb.arrayBuffer());
  assert.ok(thumbBytes.length > 0);
  assert.equal(thumbBytes[0], 0x89); // PNG magic

  /* ---- PUT /thumb validation ---- */
  const badThumb = await fetch(`${BASE}/api/media/${img.id}/thumb`, {
    method: 'PUT',
    body: singleFileForm('file', Buffer.from('not an image'), 'evil.txt', 'text/plain'),
  });
  assert.equal(badThumb.status, 400);

  const missing = await fetch(`${BASE}/api/media/media-9999/thumb`, { method: 'PUT', body: singleFileForm('file', PNG_1X1, 'x.png') });
  assert.equal(missing.status, 404);

  /* ---- POST /replace: overwrite image pixels ---- */
  const fileBefore = await fetch(`${BASE}/api/media/${img.id}/file`);
  const beforeLen = (await fileBefore.arrayBuffer()).byteLength;

  const repRes = await fetch(`${BASE}/api/media/${img.id}/replace`, {
    method: 'POST',
    body: singleFileForm('file', PNG_1X1, 'edited.png'),
  });
  const repData = await repRes.json();
  assert.equal(repRes.status, 200, JSON.stringify(repData));
  assert.equal(repData.media.id, img.id);
  assert.ok(repData.media.size > 0);
  assert.ok(repData.media.edited_at);

  const fileAfter = await fetch(`${BASE}/api/media/${img.id}/file`);
  assert.equal(fileAfter.status, 200);
  assert.equal(fileAfter.headers.get('cache-control'), 'no-store');
  const afterLen = (await fileAfter.arrayBuffer()).byteLength;
  if (ffmpegOk) {
    assert.equal(repData.media.width, 1);
    assert.equal(repData.media.height, 1);
    assert.notEqual(afterLen, beforeLen, 'file bytes should change after replace');
    assert.ok(repData.media.thumb, 'thumbnail regenerated after replace');
  }

  /* ---- POST /replace rejects non-image assets ---- */
  const vid = await uploadFixture(fixtures.clip);
  assert.equal(vid.status, 201, JSON.stringify(vid.data));
  const vidAsset = vid.data.media[0];
  const badRep = await fetch(`${BASE}/api/media/${vidAsset.id}/replace`, {
    method: 'POST',
    body: singleFileForm('file', PNG_1X1, 'edited.png'),
  });
  assert.equal(badRep.status, 400);
  const badRepMsg = await badRep.json();
  assert.match(badRepMsg.error, /image assets/i);

  /* ---- derivedFrom on upload ---- */
  const derivedRes = await fetch(`${BASE}/api/media`, { method: 'POST', body: (() => {
    const fd = new FormData();
    fd.append('files', new Blob([PNG_1X1], { type: 'image/png' }), 'copy.png');
    fd.append('derivedFrom', img.id);
    return fd;
  })() });
  const derived = await derivedRes.json();
  assert.equal(derivedRes.status, 201, JSON.stringify(derived));
  assert.equal(derived.media[0].derived_from, img.id);

  /* ---- thumbnails work for videos too ---- */
  const vidThumb = await fetch(`${BASE}/api/media/${vidAsset.id}/thumb`, {
    method: 'PUT',
    body: singleFileForm('file', PNG_1X1, 'cover.png'),
  });
  assert.equal(vidThumb.status, 200);
  const vidThumbData = await vidThumb.json();
  assert.equal(vidThumbData.media.thumb_edited, true);
});
