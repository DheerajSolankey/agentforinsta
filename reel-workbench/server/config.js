import { existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // reel-workbench/
export const DATA_DIR = process.env.REEL_STUDIO_DATA || join(ROOT, 'data');
export const SHARED_DIR = join(ROOT, 'shared');
export const PUBLIC_DIR = join(ROOT, 'public');

const WINDOWS_FIXED = [
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
  'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
];
const UNIX_FIXED = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];

function wingetPackageBin(binName) {
  try {
    const root = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    if (!existsSync(root)) return null;
    for (const pkg of readdirSync(root)) {
      if (!/ffmpeg/i.test(pkg)) continue;
      // packages nest one level: <pkg>/<extract>/bin/<bin>
      const pkgDir = join(root, pkg);
      let subs = [];
      try { subs = readdirSync(pkgDir); } catch { continue; }
      for (const sub of subs) {
        const candidate = join(pkgDir, sub, 'bin', binName);
        if (existsSync(candidate)) return candidate;
      }
      const direct = join(pkgDir, 'bin', binName);
      if (existsSync(direct)) return direct;
    }
  } catch { /* ignore */ }
  return null;
}

function whichSync(binName) {
  // PATH lookup without a shell (Windows).
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(';')) {
    if (!dir) continue;
    try {
      const candidate = join(dir, binName);
      if (existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return null;
}

export function detectFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const isWin = process.platform === 'win32';
  for (const p of isWin ? WINDOWS_FIXED : UNIX_FIXED) {
    if (p && existsSync(p)) return p;
  }
  if (isWin) {
    const wt = wingetPackageBin('ffmpeg.exe');
    if (wt) return wt;
    const onPath = whichSync('ffmpeg.exe');
    if (onPath) return onPath;
    return 'ffmpeg.exe';
  }
  return 'ffmpeg';
}

export function detectFfprobe() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  const isWin = process.platform === 'win32';
  const fixed = isWin
    ? WINDOWS_FIXED.map((p) => p.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'))
    : UNIX_FIXED.map((p) => p.replace(/ffmpeg$/, 'ffprobe'));
  for (const p of fixed) {
    if (p && existsSync(p)) return p;
  }
  if (isWin) {
    const wt = wingetPackageBin('ffprobe.exe');
    if (wt) return wt;
    const onPath = whichSync('ffprobe.exe');
    if (onPath) return onPath;
    return 'ffprobe.exe';
  }
  return 'ffprobe';
}

/** Map TEXT_FONTS names → on-disk filenames (bold preferred, then regular). */
const FONT_FILE_MAP = {
  Arial: ['arialbd.ttf', 'arial.ttf'],
  Impact: ['impact.ttf'],
  Georgia: ['georgiab.ttf', 'georgia.ttf'],
  Verdana: ['verdanab.ttf', 'verdana.ttf'],
  Tahoma: ['tahomabd.ttf', 'tahoma.ttf'],
  'Trebuchet MS': ['trebucbd.ttf', 'trebuc.ttf'],
  'Segoe UI': ['segoeuib.ttf', 'segoeui.ttf'],
  'Courier New': ['courbd.ttf', 'cour.ttf'],
};

function fontSearchDirs() {
  if (process.platform === 'win32') {
    return ['C:\\Windows\\Fonts'];
  }
  return [
    '/usr/share/fonts/truetype/dejavu',
    '/usr/share/fonts/truetype/liberation',
    '/usr/share/fonts/TTF',
    '/usr/share/fonts',
    '/System/Library/Fonts',
    '/System/Library/Fonts/Supplemental',
    '/Library/Fonts',
    join(process.env.HOME || '', 'Library', 'Fonts'),
  ];
}

export function detectFontFile(fontName = '') {
  const name = String(fontName || '').trim();
  const dirs = fontSearchDirs();
  const tryFiles = (files) => {
    for (const dir of dirs) {
      for (const f of files) {
        const p = join(dir, f);
        if (existsSync(p)) return p;
      }
    }
    return null;
  };
  if (name && FONT_FILE_MAP[name]) {
    const hit = tryFiles(FONT_FILE_MAP[name]);
    if (hit) return hit;
  }
  // Fallback: default system stack (bold first for meme/caption look).
  const fallback = process.platform === 'win32'
    ? ['arialbd.ttf', 'arial.ttf', 'segoeuib.ttf', 'segoeui.ttf', 'calibrib.ttf', 'calibri.ttf']
    : ['DejaVuSans-Bold.ttf', 'DejaVuSans.ttf', 'LiberationSans-Bold.ttf', 'Arial Bold.ttf', 'Helvetica.ttc'];
  return tryFiles(fallback);
}

export const DEFAULT_SETTINGS = {
  port: Number(process.env.PORT) || 4173,
  ffmpegPath: '',
  ffprobePath: '',
  defaultWidth: 1080,
  defaultHeight: 1920,
  defaultFps: 30,
  export: {
    crf: 20,
    preset: 'medium',
    audioBitrate: '192k',
    videoCodec: 'libx264',
    audioCodec: 'aac',
  },
  renderConcurrency: 1,
  maxUploadMb: 2048,
  jobTimeoutMs: 30 * 60 * 1000,
};

export function resolveFfmpeg(settings = {}) {
  return settings.ffmpegPath || detectFfmpeg();
}
export function resolveFfprobe(settings = {}) {
  return settings.ffprobePath || detectFfprobe();
}
