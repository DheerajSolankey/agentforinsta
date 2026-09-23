import { createApp } from './app.js';
import { getSettings } from './store.js';
import { detectFfmpeg, detectFfprobe, detectFontFile } from './config.js';
import { log } from './logger.js';

const settings = getSettings();
const app = createApp();
const port = Number(process.env.PORT) || settings.port || 4173;

const server = app.listen(port, '127.0.0.1', () => {
  const ffmpegOk = !!detectFfmpeg();
  const fontOk = !!detectFontFile();
  console.log('');
  console.log('  REEL WORKBENCH');
  console.log(`  Open  →  http://127.0.0.1:${port}`);
  console.log(`  FFmpeg →  ${ffmpegOk ? detectFfmpeg() : 'NOT FOUND (install FFmpeg)'}`);
  console.log(`  FFprobe → ${detectFfprobe()}`);
  console.log(`  Font   →  ${fontOk ? detectFontFile() : 'NOT FOUND'}`);
  console.log('');
  log({ scope: 'server', status: 'START', port });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Set PORT=<other> or close the other instance.`);
    process.exit(1);
  }
  throw err;
});
