import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './config.js';

const LOG_DIR = join(DATA_DIR, 'logs');
let logFile = null;

function file() {
  if (!logFile) {
    mkdirSync(LOG_DIR, { recursive: true });
    logFile = join(LOG_DIR, `studio-${new Date().toISOString().slice(0, 10)}.log`);
  }
  return logFile;
}

const NL = String.fromCharCode(10);

/**
 * Structured line-delimited JSON log:
 * { ts, project?, job?, stage?, status, durationMs?, message?, error? }
 */
export function log(entry) {
  const record = { ts: new Date().toISOString(), ...entry };
  try {
    appendFileSync(file(), JSON.stringify(record) + NL);
  } catch {
    /* logging must never break the app */
  }
  if (entry.status === 'ERROR' || entry.status === 'FAIL' || process.env.REEL_STUDIO_VERBOSE) {
    const tag = entry.status || 'INFO';
    const parts = [tag, entry.stage || entry.scope || '', entry.message || entry.error || ''].filter(Boolean);
    console.log(`[${record.ts}] ${parts.join(' | ')}`);
  }
  return record;
}

export function logStage(jobId, stage, status, extra = {}) {
  const { startedAt, ...rest } = extra;
  const entry = { job: jobId, stage, status, ...rest };
  if (startedAt) {
    entry.durationMs = Date.now() - (typeof startedAt === 'number' ? startedAt : Date.parse(startedAt));
  }
  return log(entry);
}

export function formatUserError(err) {
  const msg = String((err && err.message) || err || 'Unknown error');
  const rules = [
    [/No such file or directory/i, 'A required file is missing. It may have been moved or deleted outside the studio.'],
    [/Permission denied/i, 'The studio could not read or write a file. Check file permissions.'],
    [/Invalid data found when processing input|could not find codec parameters/i, 'A media file could not be decoded. It may be corrupt or use an unsupported codec.'],
    [/Unknown encoder|Unrecognized option/i, 'This FFmpeg build does not support the requested encoder. Install a full FFmpeg build.'],
    [/Conversion failed/i, 'Rendering failed while processing media. Open Developer Details for the FFmpeg log.'],
    [/timed? ?out/i, 'The operation timed out.'],
  ];
  for (const [re, friendly] of rules) if (re.test(msg)) return friendly;
  return msg.length > 300 ? msg.slice(0, 300) + '...' : msg;
}
