import { readFileSync } from 'fs';

const base = 'http://127.0.0.1:4173';
const fails = [];

async function get(path, opts) {
  const r = await fetch(base + path, opts);
  const t = await r.text();
  let body;
  try { body = JSON.parse(t); } catch { body = t; }
  return { status: r.status, body, cc: r.headers.get('cache-control') };
}

function check(name, r, pred) {
  const ok = r.status >= 200 && r.status < 400 && (!pred || pred(r));
  console.log((ok ? 'OK  ' : 'FAIL') + ' ' + r.status + ' ' + name + (r.cc ? ' cc=' + r.cc : ''));
  if (!ok) fails.push(name + ' status=' + r.status);
}

const appjs = readFileSync('public/js/app.js', 'utf8');
const apijs = readFileSync('public/js/api.js', 'utf8');
const edjs = readFileSync('public/js/editor.js', 'utf8');

check('health', await get('/api/health'));
check('settings', await get('/api/settings'));
check('styles', await get('/api/styles'));
check('media', await get('/api/media'));
check('media 0037', await get('/api/media/media-0037'), (r) => r.body.media && r.body.media.id === 'media-0037');
check('projects', await get('/api/projects'), (r) => Array.isArray(r.body.projects));

const c = await get('/api/projects', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Final Probe' }),
});
check('create', c, (r) => r.body.project && r.body.project.id);
const id = c.body?.project?.id;
if (id) {
  check('get project', await get('/api/projects/' + id));
  check('timeline', await get('/api/projects/' + id + '/timeline'));
  check('caption', await get('/api/projects/' + id + '/caption', { method: 'POST' }),
    (r) => typeof r.body.caption === 'string' && r.body.caption.includes('Final Probe'));
  check('delete', await get('/api/projects/' + id, { method: 'DELETE' }));
}

check('spa', await get('/'), (r) => String(r.body).toLowerCase().includes('html'));
check('app.js routes', await get('/js/app.js'),
  (r) => r.body.includes('renderMediaView(root') && r.body.includes('renderReferencesView(root)'));
check('api.js dataset', await get('/js/api.js'),
  (r) => r.body.includes('dataset') && r.body.includes('Object.assign(node.style') && r.body.includes('Action failed'));
check('editor.js force', await get('/js/editor.js'),
  (r) => r.body.includes('updatePreviewText(true)') && !r.body.includes('forceText'));
check('media.js', await get('/js/media.js'));
check('styles.js', await get('/js/styles.js'));
check('shared', await get('/shared/timeline-ops.js'));

const media = (await get('/api/media')).body.media || [];
console.log('media ids', media.map((m) => m.id).join(','));
console.log('file checks', {
  appjs_routes: appjs.includes('renderMediaView(root'),
  apijs_dataset: apijs.includes("k === 'dataset'"),
  edjs_no_forceText: !edjs.includes('forceText'),
});
console.log(fails.length ? 'FAILS: ' + fails.join(', ') : 'ALL_OK');
process.exit(fails.length ? 1 : 0);
