import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';

let server;
let base;

before(async () => {
  const db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

async function login(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  assert.equal(res.status, 200, `login ${email}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, headers: r.headers, data: type.includes('json') ? await r.json().catch(() => null) : Buffer.from(await r.arrayBuffer()) };
  };
  call.me = (await call('/auth/me')).data.user;
  return call;
}


test('company documents: shared with every site or chosen sites, opened or downloaded, managed in Setup', async () => {
  const admin = await login('admin@cafe.local');
  const manager = await login('manager1@cafe.local');
  const staffHere = await login('staff1@cafe.local');
  const staffThere = await login('staff2@cafe.local');
  const here = manager.me.location_id;
  const pdf = Buffer.from('%PDF-1.4 handbook').toString('base64');
  const titles = async (who) => (await who('/documents')).data.map((d) => d.title);

  assert.equal((await staffHere('/documents', { method: 'POST', body: { title: 'x', file_name: 'a.pdf', media_type: 'application/pdf', data: pdf } })).status, 403);
  assert.equal((await admin('/documents', { method: 'POST', body: { title: 'No file' } })).status, 400);
  assert.equal((await admin('/documents', { method: 'POST', body: { title: 'Video', file_name: 'a.mp4', media_type: 'video/mp4', data: pdf } })).status, 400, 'only documents');
  assert.equal((await manager('/documents', { method: 'POST', body: { title: 'Everyone', file_name: 'a.pdf', media_type: 'application/pdf', data: pdf } })).status, 403, 'a one-site manager can’t share with every site');

  const handbook = await admin('/documents', { method: 'POST', body: { title: 'Staff handbook', category: 'handbook', file_name: 'Handbook.pdf', media_type: 'application/pdf', data: pdf } });
  assert.equal(handbook.status, 201);
  // A Word file whose type the browser didn't say: recognised from its name.
  const local = await manager('/documents', { method: 'POST', body: { title: 'Our rota rules', category: 'policy', all_sites: false, site_ids: [here], file_name: 'Rota rules.docx', media_type: '', data: Buffer.from('word').toString('base64') } });
  assert.equal(local.status, 201);
  assert.equal(local.data.file_type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

  assert.deepEqual((await titles(staffHere)).sort(), ['Our rota rules', 'Staff handbook']);
  assert.deepEqual(await titles(staffThere), ['Staff handbook']);
  assert.equal((await staffThere(`/documents/${local.data.id}/file`)).status, 404, 'other sites can’t open it');

  const open = await fetch(`${base}/documents/${handbook.data.id}/file`, { headers: { cookie: await cookieOf('staff2@cafe.local') } });
  assert.equal(open.headers.get('content-type'), 'application/pdf');
  assert.match(open.headers.get('content-disposition'), /^inline; filename="Handbook.pdf"/, 'PDFs open in the browser');
  assert.equal(Buffer.from(await open.arrayBuffer()).toString(), '%PDF-1.4 handbook');
  const word = await fetch(`${base}/documents/${local.data.id}/file`, { headers: { cookie: await cookieOf('staff1@cafe.local') } });
  assert.match(word.headers.get('content-disposition'), /^attachment/, 'Word files download');
  const dl = await fetch(`${base}/documents/${handbook.data.id}/file?download=1`, { headers: { cookie: await cookieOf('staff1@cafe.local') } });
  assert.match(dl.headers.get('content-disposition'), /^attachment/);

  // Editing: details only, or a new file; managers can't touch documents for every site.
  assert.equal((await manager(`/documents/${handbook.data.id}`, { method: 'PUT', body: { title: 'x' } })).status, 403);
  const edited = await manager(`/documents/${local.data.id}`, { method: 'PUT', body: { title: 'Our rota rules (2026)', category: 'policy', all_sites: false, site_ids: [here] } });
  assert.deepEqual([edited.status, edited.data.file_name], [200, 'Rota rules.docx'], 'file kept when not replaced');
  const replaced = await manager(`/documents/${local.data.id}`, { method: 'PUT', body: { title: 'Our rota rules (2026)', all_sites: false, site_ids: [here], file_name: 'Rota rules v2.pdf', media_type: 'application/pdf', data: pdf } });
  assert.equal(replaced.data.file_name, 'Rota rules v2.pdf');
  assert.ok(replaced.data.updated_at);
  assert.equal((await manager(`/documents/${local.data.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await titles(staffHere), ['Staff handbook']);
});

async function cookieOf(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  return res.headers.get('set-cookie').split(';')[0];
}
