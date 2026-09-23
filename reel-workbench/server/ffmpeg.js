import { execFile } from 'child_process';
import { log } from './logger.js';

export class FfmpegError extends Error {
  constructor(message, { code = null, stderr = '', argv = [] } = {}) {
    super(message);
    this.name = 'FfmpegError';
    this.code = code;
    this.stderr = stderr;
    this.argv = argv;
  }
}

/**
 * Run an executable with an argv array — never a shell, never string interpolation.
 * Every path argument is pre-validated by callers (paths.js).
 */
export function run(bin, argv, { onProgress = null, timeoutMs = 10 * 60 * 1000, cwd = null, signal = null } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!bin || typeof bin !== 'string') {
      rejectPromise(new FfmpegError('FFmpeg binary path is not configured'));
      return;
    }
    if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) {
      rejectPromise(new FfmpegError('FFmpeg arguments must be an array of strings'));
      return;
    }

    const child = execFile(
      bin,
      argv,
      {
        cwd: cwd || undefined,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        ...(signal ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const errText = String(stderr || stdout || error.message);
          const friendly = classify(errText, error);
          log({ scope: 'ffmpeg', status: 'ERROR', bin, argv, error: friendly, tail: errText.slice(-4000) });
          rejectPromise(new FfmpegError(friendly, { code: error.code ?? null, stderr: errText, argv }));
          return;
        }
        resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
      }
    );

    if (onProgress && child.stdout) {
      let buf = '';
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        const map = {};
        for (const line of lines) {
          const eq = line.indexOf('=');
          if (eq > 0) map[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
        if (Object.keys(map).length) onProgress(map);
      });
    }
  });
}

function classify(errText, error) {
  if (error?.killed && errText === '') return 'FFmpeg timed out or was cancelled.';
  if (/No such file or directory/i.test(errText)) return 'FFmpeg could not find an input or output file.';
  if (/Invalid data found when processing input|could not find codec parameters|Error opening input/i.test(errText)) {
    return 'FFmpeg could not decode a media file. It may be corrupt or use an unsupported codec.';
  }
  if (/Unknown encoder/i.test(errText)) return 'This FFmpeg build does not include the required encoder.';
  if (/Permission denied/i.test(errText)) return 'FFmpeg was denied file access. Check permissions on the data folder.';
  if (/Conversion failed/i.test(errText)) {
    const line = errText.split(/\r?\n/).reverse().find((l) => /error|invalid|failed/i.test(l));
    return `FFmpeg conversion failed${line ? `: ${line.trim().slice(0, 200)}` : '.'}`;
  }
  return (errText.split(/\r?\n/).filter(Boolean).pop() || error?.message || 'FFmpeg failed').slice(0, 400);
}

export function ffprobe(bin, inputPath, { timeoutMs = 60 * 1000, extraArgs = [] } = {}) {
  const argv = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...extraArgs, inputPath];
  return run(bin, argv, { timeoutMs }).then(({ stdout }) => JSON.parse(stdout || '{}'));
}

/** Build a list of -progress friendly fraction from ffmpeg progress map (microseconds). */
export function progressSeconds(map) {
  if (map.out_time_us != null && map.out_time_us !== 'N/A') return Number(map.out_time_us) / 1e6;
  if (map.out_time_ms != null && map.out_time_ms !== 'N/A') return Number(map.out_time_ms) / 1e3; // ffmpeg reports µs here
  if (map.out_time != null && map.out_time !== 'N/A') {
    const parts = String(map.out_time).split(':').map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}
