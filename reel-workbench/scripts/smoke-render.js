/**
 * Smoke: create a project, import fixture clip, build a short timeline, render final, probe it.
 * Requires the server running on PORT (default 4173) OR boots its own in-process app.
 * Usage: npm run smoke
 */
import { createServer } from 'http';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { ensureFixtures } from './make-fixtures.js';
import { createApp } from '../server/app.js';
import { detectFfmpeg, detectFfprobe } from '../server/config.js';
import { ffprobe } from '../server/ffmpeg.js';

const PORT = Number(process.env.PORT) || 4199;
const BASE = `http://127.0.0.1:${PORT}`;

async function req(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  if (opts.form) { init.method = 'POST'; init.body = opts.form; delete init.headers['Content-Type']; }
  const res = await fetch(BASE + path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${data.error || ''}`);
  return data;
}

function formDataWithFile(filePath, fields = {}) {
  const fd = new FormData();
  const buf = readFileSync(filePath);
  const name = filePath.split(/[\\/]/).pop();
  fd.append('files', new Blob([buf]), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  return fd;
}

async function main() {
  console.log('ffmpeg:', detectFfmpeg());
  console.log('ffprobe:', detectFfprobe());
  const fixtures = ensureFixtures();
  console.log('fixtures:', fixtures);

  const app = createApp();
  const server = createServer(app);
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('test server on', BASE);

  try {
    const health = await req('/api/health');
    if (!health.ok) throw new Error('health not ok');
    console.log('health ok');

    // import media
    const up = await fetch(`${BASE}/api/media`, { method: 'POST', body: formDataWithFile(fixtures.clip) });
    const upData = await up.json();
    if (!up.ok) throw new Error(`upload failed: ${upData.error}`);
    const asset = upData.media[0];
    console.log('imported asset', asset.id, asset.filename, `${asset.width}x${asset.height}`);

    // create project
    const { project } = await req('/api/projects', { method: 'POST', body: { name: 'Smoke Test' } });
    console.log('project', project.id);

    // build timeline: video 0-2.5s + text + music-ish silence gap ok
    const { timeline } = await req(`/api/projects/${project.id}/timeline`);
    timeline.tracks.find((t) => t.id === 'v1').clips.push({
      id: 'clip-smoke-1', kind: 'video', start: 0, duration: 2.5, srcIn: 0,
      volume: 1, muted: false, assetId: asset.id, overlay: { xPct: 50, yPct: 50, widthPct: 100 },
    });
    timeline.tracks.find((t) => t.id === 't1').clips.push({
      id: 'clip-smoke-t1', kind: 'text', start: 0.2, duration: 2.0, srcIn: 0,
      volume: 1, muted: false,
      text: { content: 'SMOKE', role: 'title', font: 'Arial', size: 96, color: '#ffffff', bg: 'black@0.5', position: 'center', xPct: null, yPct: null, align: 'center' },
    });
    timeline.tracks.find((t) => t.id === 't2').clips.push({
      id: 'clip-smoke-t2', kind: 'text', start: 0.5, duration: 1.5, srcIn: 0,
      volume: 1, muted: false,
      text: { content: 'caption line', role: 'caption', font: 'Arial', size: 48, color: '#ffe08a', bg: '', position: 'bottom', xPct: null, yPct: 78, align: 'center' },
    });
    await req(`/api/projects/${project.id}/timeline`, { method: 'PUT', body: { timeline } });
    console.log('timeline saved');

    // REFERENCE_ONLY guard: mark a ref and ensure render rejects if used — quick check via validate path
    // (skip network dance; covered in tests)

    // render final
    const q = await req(`/api/projects/${project.id}/render`, { method: 'POST', body: { quality: 'final' } });
    console.log('queued', q.status, q.job?.id);

    // poll
    let job = null;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const st = await req(`/api/projects/${project.id}/render`);
      job = st.job;
      process.stdout.write(`\r${job?.stage || '?'} ${job?.progress || 0}%   `);
      if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log('');
    if (!job || job.status !== 'completed') {
      throw new Error(`render not completed: ${JSON.stringify(job)}`);
    }
    console.log('render completed');

    const { project: p2 } = await req(`/api/projects/${project.id}`);
    const finalPath = join(p2.dir, 'exports', 'final.mp4');
    if (!existsSync(finalPath)) throw new Error('final.mp4 missing');
    const size = statSync(finalPath).size;
    console.log('final.mp4', size, 'bytes');

    const probe = await ffprobe(detectFfprobe(), finalPath);
    const v = (probe.streams || []).find((s) => s.codec_type === 'video');
    const a = (probe.streams || []).find((s) => s.codec_type === 'audio');
    const dur = Number(probe.format?.duration || 0);
    console.log('probe:', {
      w: v?.width, h: v?.height, vcodec: v?.codec_name, acodec: a?.codec_name, dur,
      fps: v?.r_frame_rate,
    });
    if (v?.width !== 1080 || v?.height !== 1920) throw new Error(`bad resolution ${v?.width}x${v?.height}`);
    if (v?.codec_name !== 'h264') throw new Error(`bad video codec ${v?.codec_name}`);
    if (!a || a.codec_name !== 'aac') throw new Error(`bad audio codec ${a?.codec_name}`);
    if (Math.abs(dur - 2.5) > 0.5) throw new Error(`bad duration ${dur}`);
    if (p2.last_qc) console.log('QC overall:', p2.last_qc.overall);

    // captions + thumbnail
    for (const f of ['captions.srt', 'caption.txt', 'thumbnail.jpg', 'timeline.json']) {
      const p = join(p2.dir, 'exports', f);
      if (!existsSync(p)) throw new Error(`missing export ${f}`);
      console.log('export ok:', f, statSync(p).size, 'bytes');
    }

    const cap = await req(`/api/projects/${project.id}/caption`);
    if (!cap.caption || !cap.caption.includes('Smoke Test')) throw new Error('caption API missing project title');
    console.log('caption api ok:', cap.caption.length, 'chars');

    console.log('\nSMOKE PASS');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('\nSMOKE FAIL:', err.message);
  process.exit(1);
});
