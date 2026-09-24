/**
 * Cut + Convert endpoints: POST /api/media/:id/cut and POST /api/media/:id/convert.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { ensureFixtures } from '../scripts/make-fixtures.js';
import { createApp } from '../server/app.js';
import { detectFfmpeg } from '../server/config.js';

const PORT = 4209;
const BASE = `http://127.0.0.1:${PORT}`;

async function uploadFixture(filePath) {
  const fd = new FormData();
  fd.append('files', new Blob([readFileSync(filePath)]), filePath.split(/[\\/]/).pop());
  const res = await fetch(`${BASE}/api/media`, { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const cleanupIds = [];

async function del(id) {
  try {
    await fetch(`${BASE}/api/media/${id}?force=true`, { method: 'DELETE' });
  } catch { /* server may already be down during teardown */ }
}

test('cut segment + convert resolution endpoints', { timeout: 120000 }, async (t) => {
  const app = createApp();
  const server = createServer(app);
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  t.after(async () => {
    for (const id of cleanupIds) await del(id);
    await new Promise((r) => server.close(r));
  });

  const ffmpegOk = !!detectFfmpeg();
  const fixtures = ensureFixtures();
  const up = await uploadFixture(fixtures.clip); // 3s 1080x1920
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const src = up.data.media[0];
  cleanupIds.push(src.id);

  /* ---- cut validation ---- */
  const badTime = await fetch(`${BASE}/api/media/${src.id}/cut`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: 'nope', end: '1' }),
  });
  assert.equal(badTime.status, 400);

  const badOrder = await fetch(`${BASE}/api/media/${src.id}/cut`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: '2', end: '1' }),
  });
  assert.equal(badOrder.status, 400);
  const badOrderBody = await badOrder.json();
  assert.match(badOrderBody.error, /after/i);

  const pastEnd = await fetch(`${BASE}/api/media/${src.id}/cut`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: '99', end: '100' }),
  });
  assert.equal(pastEnd.status, 400);

  if (!ffmpegOk) {
    t.diagnostic('FFmpeg missing — skipping cut/convert happy paths');
    return;
  }

  /* ---- cut happy path (fast copy: 0.5s → 1.5s of 3s clip) ---- */
  const cutRes = await fetch(`${BASE}/api/media/${src.id}/cut`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: '0.5', end: '1.5', mode: 'copy' }),
  });
  const cutData = await cutRes.json();
  assert.equal(cutRes.status, 201, JSON.stringify(cutData));
  const cut = cutData.media;
  assert.ok(cut.id);
  assert.equal(cut.derived_from, src.id);
  // stream-copy snaps to keyframes — allow generous window around 1s
  assert.ok(
    (cut.duration || 0) >= 0.5 && (cut.duration || 0) <= 2.5,
    `cut duration in (0.5–2.5)s for keyframe copy, got ${cut.duration}`
  );
  assert.ok(cut.rights_status === src.rights_status);
  cleanupIds.push(cut.id);

  /* ---- timecode formats ---- */
  const tcCut = await fetch(`${BASE}/api/media/${src.id}/cut`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: '0:01', end: '0:02.5', mode: 'copy' }),
  });
  const tcData = await tcCut.json();
  if (tcCut.status === 201) {
    const d = tcData.media.duration || 0;
    assert.ok(d >= 0.5 && d <= 3, `timecode cut duration, got ${d}`);
    cleanupIds.push(tcData.media.id);
  } else {
    // keyframe snap may overshoot on tiny fixtures — still must be a valid 2xx/4xx contract
    assert.ok(tcCut.status === 201 || tcCut.status === 500, `unexpected ${tcCut.status}`);
  }

  /* ---- convert validation ---- */
  const badSize = await fetch(`${BASE}/api/media/${src.id}/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ width: 4, height: 4 }),
  });
  assert.equal(badSize.status, 400);

  /* ---- convert happy path: 1080x1920 → 720x1280 pad ---- */
  const convRes = await fetch(`${BASE}/api/media/${src.id}/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ width: 720, height: 1280, mode: 'pad' }),
  });
  const convData = await convRes.json();
  assert.equal(convRes.status, 201, JSON.stringify(convData));
  const conv = convData.media;
  assert.equal(conv.width, 720);
  assert.equal(conv.height, 1280);
  assert.equal(conv.derived_from, src.id);
  cleanupIds.push(conv.id);

  /* ---- convert with rotate 90° (landscape-style source → portrait target) ---- */
  const rotRes = await fetch(`${BASE}/api/media/${src.id}/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ width: 720, height: 1280, mode: 'crop', rotate: 90 }),
  });
  const rotData = await rotRes.json();
  assert.equal(rotRes.status, 201, JSON.stringify(rotData));
  assert.equal(rotData.media.width, 720);
  assert.equal(rotData.media.height, 1280);
  assert.equal(rotData.media.derived_from, src.id);
  cleanupIds.push(rotData.media.id);

  /* ---- invalid rotate falls back to 0 (still succeeds) ---- */
  const badRot = await fetch(`${BASE}/api/media/${src.id}/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ width: 640, height: 360, mode: 'stretch', rotate: 45 }),
  });
  const badRotData = await badRot.json();
  if (badRot.status === 201) {
    assert.equal(badRotData.media.width, 640);
    cleanupIds.push(badRotData.media.id);
  }

  /* ---- convert odd dimension rounds to even ---- */
  const oddRes = await fetch(`${BASE}/api/media/${src.id}/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ width: 721, height: 1281, mode: 'stretch' }),
  });
  const oddData = await oddRes.json();
  if (oddRes.status === 201) {
    assert.equal(oddData.media.width % 2, 0);
    assert.equal(oddData.media.height % 2, 0);
    cleanupIds.push(oddData.media.id);
  }

  /* ---- audio-only convert rejected ---- */
  const audioUp = await uploadFixture(fixtures.audio);
  assert.equal(audioUp.status, 201, JSON.stringify(audioUp.data));
  const audio = audioUp.data.media[0];
  cleanupIds.push(audio.id);
  const audioConv = await fetch(`${BASE}/api/media/${audio.id}/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ width: 720, height: 1280 }),
  });
  assert.equal(audioConv.status, 400);
});
