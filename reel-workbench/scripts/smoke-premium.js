/** Smoke: watermark + rotated text + glow + stagger captions → FFmpeg render → probe. */
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { ensureFixtures } from './make-fixtures.js';
import { renderProject } from '../server/renderer.js';
import { listProjects, readTimeline, writeTimeline, getProject, getSettings } from '../server/store.js';
import { ffprobe } from '../server/ffmpeg.js';
import { resolveFfprobe } from '../server/config.js';
import { addClip, validateTimeline, createTimeline, setClipProps, cloneTimeline } from '../shared/timeline-ops.js';

async function main() {
  await ensureFixtures();
  const projects = listProjects();
  const base = projects.find((p) => /fixture|smoke|demo/i.test(p.name)) || projects[0];
  if (!base) throw new Error('No project found');
  const pid = base.id;
  let timeline = readTimeline(pid);
  if (!timeline) {
    timeline = createTimeline();
    writeTimeline(pid, timeline);
  }

  const snap = cloneTimeline(timeline);
  // Clear t1/t2 to avoid overlaps
  for (const tid of ['t1', 't2']) {
    const tr = timeline.tracks.find((t) => t.id === tid);
    tr.clips = [];
  }

  const dur = Math.max(3, Math.min(6, timeline.tracks.find((t) => t.id === 'v1')?.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0) || 4));

  // Rotated title with glow
  addClip(timeline, 't1', {
    kind: 'text', start: 0, duration: Math.min(2.5, dur),
    text: {
      content: 'DIAGONAL TITLE', role: 'title', position: 'center',
      size: 84, color: '#7df9ff', rotate: -18, glow: true, glowColor: '#00e5ff', glowSize: 18,
      bold: true, uppercase: true, anim: 'fade', animDur: 0.4, shadow: true, font: 'Impact',
      strokeWidth: 3, strokeColor: '#0a0a1a', letterSpacing: 4, opacity: 1,
    },
  });

  // Word-by-word stagger caption
  addClip(timeline, 't2', {
    kind: 'text', start: 0, duration: Math.min(3.5, dur),
    text: {
      content: 'word by word captions feel premium', role: 'caption', position: 'bottom',
      size: 48, color: '#ffffff', bg: 'black@0.55', bgMode: 'inline',
      bold: true, stagger: true, anim: 'pop', animDur: 0.25,
      yPct: 84, align: 'center', shadow: true, padX: 20, padY: 12, font: 'Segoe UI',
      glow: false, opacity: 1, lineHeight: 1.3,
    },
  });

  // Glitch hook
  if (dur > 4) {
    addClip(timeline, 't1', {
      kind: 'text', start: 3.6, duration: 1.6,
      text: {
        content: 'GLITCH HOOK', role: 'hook', position: 'top',
        size: 72, color: '#ffffff', anim: 'glitch', animDur: 0.5,
        bold: true, uppercase: true, yPct: 14, strokeColor: '#ff003c', strokeWidth: 4,
      },
    });
  }

  // Watermark (FRAMEFLOW-style vertical left)
  timeline.watermark = {
    enabled: true, text: 'FRAMEFLOW', position: 'vertical-left',
    opacity: 0.55, size: 26, color: '#ffffff', font: 'Arial',
    bold: false, uppercase: true, letterSpacing: 12, margin: 36,
  };

  const issues = validateTimeline(timeline);
  if (issues.length) throw new Error(JSON.stringify(issues, null, 2));
  writeTimeline(pid, timeline);

  console.log('rendering preview with watermark + premium text…');
  const job = await renderProject({
    projectId: pid,
    quality: 'preview',
    onProgress: (p) => { if (p.stagePct % 25 === 0) console.log(`  ${p.stage} ${p.stagePct}%`); },
  });
  console.log('out:', job.outFile, 'dur:', job.fileDuration);

  const probe = await ffprobe(resolveFfprobe(getSettings()), job.outFile);
  console.log('probe:', JSON.stringify(probe.meta, null, 2));

  if (!existsSync(job.outFile)) throw new Error('output missing');
  const size = (await import('fs')).statSync(job.outFile).size;
  console.log(`OK ${size} bytes`);
}

main().catch((e) => { console.error('SMOKE FAIL:', e.message); if (e.detail) console.error(e.detail); process.exit(1); });
