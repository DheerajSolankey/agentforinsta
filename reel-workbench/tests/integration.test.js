/**
 * Integration: boot createApp in-process, import fixture, build timeline, render final, probe.
 * Skips FFmpeg-dependent assertions if ffmpeg is unavailable (still exercises HTTP CRUD).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { ensureFixtures } from '../scripts/make-fixtures.js';
import { createApp } from '../server/app.js';
import { detectFfmpeg, detectFfprobe } from '../server/config.js';
import { ffprobe } from '../server/ffmpeg.js';

const PORT = 4207;
const BASE = `http://127.0.0.1:${PORT}`;

async function req(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(BASE + path, init);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

function uploadForm(filePath) {
  const fd = new FormData();
  fd.append('files', new Blob([readFileSync(filePath)]), filePath.split(/[\\/]/).pop());
  return fd;
}

test('HTTP API integration + final render', { timeout: 240000 }, async (t) => {
  const app = createApp();
  const server = createServer(app);
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  t.after(() => server.close());

  /* ---- health / settings ---- */
  const health = await req('/api/health');
  assert.equal(health.ok, true);
  assert.equal(health.data.app, 'reel-workbench');

  const settings = await req('/api/settings');
  assert.equal(settings.ok, true);
  assert.ok(settings.data.settings.export);

  /* ---- project CRUD ---- */
  const created = await req('/api/projects', { method: 'POST', body: { name: 'IT Project' } });
  assert.equal(created.status, 201);
  const pid = created.data.project.id;
  assert.match(pid, /^project-\d{3}$/);
  assert.equal(created.data.timeline.tracks.length, 8);

  const badId = await req('/api/projects/../evil');
  assert.equal(badId.ok, false);

  const renamed = await req(`/api/projects/${pid}`, { method: 'PATCH', body: { name: 'Renamed' } });
  assert.equal(renamed.data.project.name, 'Renamed');

  const rejectedPatch = await req(`/api/projects/${pid}`, { method: 'PATCH', body: { id: 'hack' } });
  assert.equal(rejectedPatch.status, 400);

  /* ---- timeline validation ---- */
  const badTl = await req(`/api/projects/${pid}/timeline`, {
    method: 'PUT',
    body: { timeline: { width: 1080, height: 1920, fps: 30, tracks: [] } },
  });
  assert.equal(badTl.status, 400);
  assert.ok(badTl.data.issues?.length);

  /* ---- styles / templates ---- */
  const styles = await req('/api/styles');
  assert.equal(styles.ok, true);
  assert.ok(styles.data.styles.length >= 1);
  const templates = await req('/api/templates');
  assert.ok(templates.data.templates.length >= 1);

  const applyStyle = await req(`/api/projects/${pid}/apply-style`, {
    method: 'POST', body: { style: styles.data.styles[0].name },
  });
  assert.equal(applyStyle.ok, true);
  assert.equal(applyStyle.data.project.style_name, styles.data.styles[0].name);

  const applyTmpl = await req(`/api/projects/${pid}/apply-template`, {
    method: 'POST', body: { template: templates.data.templates[0].name },
  });
  assert.equal(applyTmpl.ok, true);
  assert.ok(applyTmpl.data.created >= 1);

  /* ---- inbox ---- */
  const inbox = await req(`/api/projects/${pid}/inbox`, {
    method: 'POST', body: { instruction: 'Make it 15 seconds with bold captions.' },
  });
  assert.equal(inbox.status, 201);
  const inboxList = await req(`/api/projects/${pid}/inbox`);
  assert.equal(inboxList.data.files.length, 1);
  assert.match(inboxList.data.files[0].content, /Make it 15 seconds/);

  /* ---- export traversal ---- */
  const trav = await req(`/api/projects/${pid}/exports/..%2F..%2Fsettings.json`);
  assert.equal(trav.ok, false);

  /* ---- media + render (FFmpeg) ---- */
  const ffmpegOk = !!detectFfmpeg();
  if (!ffmpegOk) {
    t.diagnostic('FFmpeg not found — skipping media/render portion');
    return;
  }

  const fixtures = ensureFixtures();
  const upRes = await fetch(`${BASE}/api/media`, { method: 'POST', body: uploadForm(fixtures.clip) });
  const upData = await upRes.json();
  assert.equal(upRes.status, 201, JSON.stringify(upData));
  const asset = upData.media[0];
  assert.equal(asset.width, 1080);
  assert.equal(asset.height, 1920);
  assert.ok(asset.thumb, 'thumbnail should exist after import');

  // clear template text clips, put real program
  const { data: tlFetch } = await req(`/api/projects/${pid}/timeline`);
  const timeline = tlFetch.timeline;
  for (const tr of timeline.tracks) tr.clips = [];
  timeline.tracks.find((x) => x.id === 'v1').clips.push({
    id: 'it-v1', kind: 'video', start: 0, duration: 2, srcIn: 0, volume: 1, muted: false,
    assetId: asset.id, overlay: { xPct: 50, yPct: 50, widthPct: 100 },
  });
  timeline.tracks.find((x) => x.id === 't1').clips.push({
    id: 'it-t1', kind: 'text', start: 0, duration: 2, srcIn: 0, volume: 1, muted: false,
    text: { content: 'INTEGRATION', role: 'title', font: 'Arial', size: 72, color: '#ffffff', bg: 'black@0.5', position: 'center', xPct: null, yPct: null, align: 'center' },
  });
  const put = await req(`/api/projects/${pid}/timeline`, { method: 'PUT', body: { timeline } });
  assert.equal(put.ok, true);

  // REFERENCE_ONLY cannot render: re-upload as reference, try to use it
  const refRes = await fetch(`${BASE}/api/media`, {
    method: 'POST',
    body: (() => {
      const fd = new FormData();
      fd.append('files', new Blob([readFileSync(fixtures.clip)]), 'ref.mp4');
      fd.append('asReference', 'true');
      return fd;
    })(),
  });
  const refData = await refRes.json();
  const refAsset = refData.media[0];
  assert.equal(refAsset.rights_status, 'REFERENCE_ONLY');

  const badTl2 = structuredClone(timeline);
  badTl2.tracks.find((x) => x.id === 'v1').clips[0].assetId = refAsset.id;
  const putBad = await req(`/api/projects/${pid}/timeline`, { method: 'PUT', body: { timeline: badTl2 } });
  // structural validation passes (asset exists) — render must reject:
  assert.equal(putBad.ok, true);
  const refRender = await req(`/api/projects/${pid}/render`, { method: 'POST', body: { quality: 'final' } });
  assert.equal(refRender.status, 202);
  // wait for failure
  {
    const deadline = Date.now() + 30000;
    let job = null;
    while (Date.now() < deadline) {
      const st = await req(`/api/projects/${pid}/render`);
      job = st.data.job;
      if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(job, 'job should exist');
    assert.equal(job.status, 'failed', 'REFERENCE_ONLY render must fail');
    assert.match(job.error || '', /REFERENCE_ONLY/);
  }

  // restore good timeline + render
  const putGood = await req(`/api/projects/${pid}/timeline`, { method: 'PUT', body: { timeline } });
  assert.equal(putGood.ok, true);

  const q = await req(`/api/projects/${pid}/render`, { method: 'POST', body: { quality: 'final' } });
  assert.equal(q.status, 202);
  {
    const deadline = Date.now() + 180000;
    let job = null;
    while (Date.now() < deadline) {
      const st = await req(`/api/projects/${pid}/render`);
      job = st.data.job;
      if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    assert.equal(job?.status, 'completed', JSON.stringify(job));
  }

  const { data: finalResp } = await req(`/api/projects/${pid}`);
  const finalP = finalResp.project;
  assert.ok(finalP?.dir, 'project.dir should be present');
  const finalPath = join(finalP.dir, 'exports', 'final.mp4');
  assert.ok(existsSync(finalPath));
  assert.ok(statSync(finalPath).size > 1000);

  for (const f of ['captions.srt', 'caption.txt', 'thumbnail.jpg', 'timeline.json']) {
    assert.ok(existsSync(join(finalP.dir, 'exports', f)), f);
  }

  const probe = await ffprobe(detectFfprobe(), finalPath);
  const v = probe.streams.find((s) => s.codec_type === 'video');
  const a = probe.streams.find((s) => s.codec_type === 'audio');
  assert.equal(v.width, 1080);
  assert.equal(v.height, 1920);
  assert.equal(v.codec_name, 'h264');
  assert.ok(a, 'audio stream required');
  assert.equal(a.codec_name, 'aac');
  const dur = Number(probe.format.duration);
  assert.ok(Math.abs(dur - 2) <= 0.4, `duration ${dur}`);

  assert.ok(finalP.last_qc, 'QC stored on project');
  assert.ok(['PASS', 'WARNINGS', 'FAIL'].includes(finalP.last_qc.overall));

  /* ---- delete project ---- */
  const del = await req(`/api/projects/${pid}`, { method: 'DELETE' });
  assert.equal(del.ok, true);
  const gone = await req(`/api/projects/${pid}`);
  assert.equal(gone.status, 404);
});
