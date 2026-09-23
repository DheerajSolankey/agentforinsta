import { readFileSync } from 'fs';

const base = 'http://127.0.0.1:4173';
const fixture = 'fixtures/clip-1080x1920.mp4';
const file = readFileSync(fixture);
const boundary = '----rw' + Date.now();
const head = Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="import-test.mp4"\r\nContent-Type: video/mp4\r\n\r\n`
);
const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
const body = Buffer.concat([head, file, tail]);

const res = await fetch(base + '/api/media', {
  method: 'POST',
  headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  body,
});
const text = await res.text();
console.log('status', res.status);
console.log(text.slice(0, 1000));

let parsed;
try { parsed = JSON.parse(text); } catch { parsed = null; }
if (parsed?.media?.[0]?.id) {
  const id = parsed.media[0].id;
  const del = await fetch(base + `/api/media/${id}`, { method: 'DELETE' });
  console.log('cleanup delete', del.status, await del.text());
}
const list = await (await fetch(base + '/api/media')).json();
console.log('media ids', (list.media || []).map((m) => m.id));
process.exit(res.status >= 200 && res.status < 300 ? 0 : 1);
