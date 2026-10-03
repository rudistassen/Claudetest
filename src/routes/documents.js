// Company documents on My Brew: handbooks, policies and forms uploaded in Setup → Documents, for every site or
// chosen sites. Managed by people with the "My Brew news & documents" permission.
import { can, requirePerm } from '../auth.js';
import { tx } from '../db.js';
import { badRequest, bool, forbidden, id, notFound, oneOf, str } from '../util.js';

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const CATEGORIES = ['handbook', 'policy', 'form', 'guide', 'other'];
const TYPES = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/plain': '.txt',
  'image/jpeg': '.jpg',
  'image/png': '.png',
};
// Browsers sometimes don't say what a file is; go by its name then.
const BY_EXTENSION = Object.fromEntries(Object.entries(TYPES).map(([type, ext]) => [ext, type]));
BY_EXTENSION['.jpeg'] = 'image/jpeg';

const realBuffer = typeof Buffer !== 'undefined' && typeof Buffer.isBuffer === 'function';
const fromBase64 = (b64) => (realBuffer ? Buffer.from(b64, 'base64') : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
const asBody = (bytes) => (realBuffer ? Buffer.from(bytes) : bytes);

export function registerDocumentRoutes(router, db) {
  const COLS = 'd.id, d.title, d.description, d.category, d.file_name, d.file_type, d.size, d.all_sites, d.created_at, d.updated_at, u.name AS author';
  const sitesOf = (docId) => db.prepare('SELECT location_id FROM document_sites WHERE document_id = ?').all(docId).map((r) => r.location_id);
  const withSites = (d) => ({ ...d, site_ids: sitesOf(d.id) });
  const list = () => db.prepare(`SELECT ${COLS} FROM documents d LEFT JOIN users u ON u.id = d.created_by ORDER BY d.category, d.title`).all().map(withSites);
  const reaches = (d, user) => d.all_sites || d.site_ids.some((s) => s === user.location_id || user.site_ids.includes(s));
  const canManage = (req, d) => req.user.role === 'admin' || (d.all_sites ? !!req.user.all_sites : d.site_ids.every((s) => req.user.site_ids.includes(s)));
  const load = (req) => {
    const d = db.prepare(`SELECT ${COLS} FROM documents d LEFT JOIN users u ON u.id = d.created_by WHERE d.id = ?`).get(Number(req.params.id));
    if (!d) throw notFound('Document');
    return withSites(d);
  };

  router.get('/documents', (req, res) => res.json(list().filter((d) => reaches(d, req.user))));

  router.get('/documents/manage', requirePerm('news.manage'), (req, res) => res.json(list().map((d) => ({ ...d, can_edit: canManage(req, d) }))));

  // The file: opened in the browser (PDFs, pictures, text) or downloaded (?download=1, and Office files).
  router.get('/documents/:id/file', (req, res) => {
    const d = load(req);
    if (!reaches(d, req.user) && !can(req.user, 'news.manage')) throw notFound('Document');
    const data = db.prepare('SELECT data FROM documents WHERE id = ?').get(d.id).data;
    const inline = !req.query.download && /^(application\/pdf|image\/|text\/plain)/.test(d.file_type);
    const safe = String(d.file_name).replace(/[^\w.\- ()]/g, '_');
    res.setHeader('Content-Type', d.file_type);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safe}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(asBody(data));
  });

  // { title, description, category, all_sites, site_ids, and for a new file: file_name, media_type, data (base64) }
  const body = (req, existing) => {
    const b = req.body;
    const allSites = b.all_sites === undefined ? 1 : bool(b.all_sites);
    const siteIds = allSites ? [] : [...new Set((Array.isArray(b.site_ids) ? b.site_ids : []).map((x) => id(x, 'site_ids')))];
    if (!allSites && !siteIds.length) throw badRequest('Choose which sites should see this');
    for (const s of siteIds) if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(s)) throw notFound('Location');
    const doc = {
      title: str(b.title, 'title', { required: true, max: 150 }),
      description: str(b.description, 'description', { max: 1000 }),
      category: oneOf(b.category, 'category', CATEGORIES) ?? 'policy',
      all_sites: allSites,
      site_ids: siteIds,
      file: null,
    };
    if (!canManage(req, doc)) throw forbidden(allSites ? 'Only people who work with every site can share with every site – choose your sites instead' : 'You can only share with sites you work with');
    if (b.data) {
      const fileName = str(b.file_name, 'file_name', { required: true, max: 200 });
      const ext = (fileName.match(/\.\w+$/)?.[0] ?? '').toLowerCase();
      const type = TYPES[b.media_type] ? b.media_type : BY_EXTENSION[ext];
      if (!type) throw badRequest('Share PDFs, Word, Excel or PowerPoint files, text files or pictures');
      let bytes;
      try { bytes = fromBase64(String(b.data).replace(/^data:[^,]*,/, '').replace(/\s+/g, '')); } catch { throw badRequest('The file couldn’t be read'); }
      if (!bytes.length) throw badRequest('The file is empty');
      if (bytes.length > MAX_DOCUMENT_BYTES) throw badRequest('Documents can be up to 20 MB');
      doc.file = { name: fileName, type, bytes };
    } else if (!existing) {
      throw badRequest('Choose the file to share');
    }
    return doc;
  };
  const saveSites = (docId, doc) => {
    db.prepare('DELETE FROM document_sites WHERE document_id = ?').run(docId);
    for (const s of doc.site_ids) db.prepare('INSERT INTO document_sites (document_id, location_id) VALUES (?, ?)').run(docId, s);
  };

  router.post('/documents', requirePerm('news.manage'), (req, res) => {
    const doc = body(req, null);
    const newId = tx(db, () => {
      const r = db.prepare(`INSERT INTO documents (title, description, category, file_name, file_type, size, data, all_sites, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(doc.title, doc.description, doc.category, doc.file.name, doc.file.type, doc.file.bytes.length, doc.file.bytes, doc.all_sites, req.user.id);
      saveSites(r.lastInsertRowid, doc);
      return r.lastInsertRowid;
    });
    res.status(201).json(load({ params: { id: newId } }));
  });

  router.put('/documents/:id', requirePerm('news.manage'), (req, res) => {
    const existing = load(req);
    if (!canManage(req, existing)) throw forbidden('This document is shared with sites you don’t work with');
    const doc = body(req, existing);
    tx(db, () => {
      db.prepare(`UPDATE documents SET title = ?, description = ?, category = ?, all_sites = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(doc.title, doc.description, doc.category, doc.all_sites, existing.id);
      if (doc.file) {
        db.prepare('UPDATE documents SET file_name = ?, file_type = ?, size = ?, data = ? WHERE id = ?')
          .run(doc.file.name, doc.file.type, doc.file.bytes.length, doc.file.bytes, existing.id);
      }
      saveSites(existing.id, doc);
    });
    res.json(load(req));
  });

  router.delete('/documents/:id', requirePerm('news.manage'), (req, res) => {
    const d = load(req);
    if (!canManage(req, d)) throw forbidden('This document is shared with sites you don’t work with');
    db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
    res.json({ ok: true });
  });
}
