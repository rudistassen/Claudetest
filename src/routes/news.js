// My Brew news feed: announcements and policy updates posted in Setup → News, shown to staff on My Brew.
// A post goes to every site or to chosen sites; policy posts can ask people to confirm they've read them.
import { can, requirePerm } from '../auth.js';
import { tx } from '../db.js';
import { badRequest, bool, forbidden, id, notFound, oneOf, str } from '../util.js';

const CATEGORIES = ['announcement', 'policy', 'event', 'reminder'];
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const MEDIA_TYPES = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'image',
  'video/mp4': 'video', 'video/webm': 'video', 'video/quicktime': 'video',
};
const MAX_MEDIA_PER_POST = 10;

// Real Node Buffers on the server; plain bytes in the standalone (in-browser) demo.
const realBuffer = typeof Buffer !== 'undefined' && typeof Buffer.isBuffer === 'function';
const fromBase64 = (b64) => (realBuffer ? Buffer.from(b64, 'base64') : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
const asBody = (bytes) => (realBuffer ? Buffer.from(bytes) : bytes);

export function registerNewsRoutes(router, db) {
  const sitesOf = (postId) => db.prepare('SELECT location_id FROM news_post_sites WHERE post_id = ?').all(postId).map((r) => r.location_id);
  // Someone sees a post meant for every site, or for their home site or any site they work at.
  const reaches = (post, user) => post.all_sites || post.site_ids.some((s) => s === user.location_id || user.site_ids.includes(s));
  const mediaOf = (postId) => db.prepare('SELECT id, kind, file_type, file_name FROM news_media WHERE post_id = ? ORDER BY position, id').all(postId);
  const withSites = (p) => ({ ...p, site_ids: sitesOf(p.id), media: mediaOf(p.id) });
  const posts = () => db.prepare(`SELECT p.*, u.name AS author FROM news_posts p LEFT JOIN users u ON u.id = p.created_by
    ORDER BY p.pinned DESC, p.created_at DESC, p.id DESC`).all().map(withSites);

  // Everyone who should see a post (for "who has read it").
  const audience = (post) => {
    const people = db.prepare(`SELECT u.id, u.name, u.location_id, u.role, u.all_sites, l.name AS location_name FROM users u
      LEFT JOIN locations l ON l.id = u.location_id WHERE u.active = 1 ORDER BY l.name, u.name`).all();
    if (post.all_sites) return people;
    const extra = new Map();
    for (const r of db.prepare('SELECT user_id, location_id FROM user_sites').all()) extra.set(r.user_id, [...(extra.get(r.user_id) ?? []), r.location_id]);
    return people.filter((u) => u.role === 'admin' || u.all_sites || post.site_ids.includes(u.location_id) || (extra.get(u.id) ?? []).some((s) => post.site_ids.includes(s)));
  };

  // A manager (not an admin) can post to the sites they work with, and edit posts that only go to those sites.
  const canManage = (req, post) => req.user.role === 'admin' || (!post.all_sites && post.site_ids.every((s) => req.user.site_ids.includes(s)))
    || (post.all_sites && req.user.all_sites);

  router.get('/news', (req, res) => {
    const read = new Set(db.prepare('SELECT post_id FROM news_reads WHERE user_id = ?').all(req.user.id).map((r) => r.post_id));
    res.json(posts().filter((p) => reaches(p, req.user)).map((p) => ({ ...p, read: read.has(p.id) })));
  });

  // How many posts are waiting for this person to confirm they've read them (for the menu).
  router.get('/news/unread', (req, res) => {
    const read = new Set(db.prepare('SELECT post_id FROM news_reads WHERE user_id = ?').all(req.user.id).map((r) => r.post_id));
    res.json({ count: posts().filter((p) => p.requires_ack && !read.has(p.id) && reaches(p, req.user)).length });
  });

  router.post('/news/:id/read', (req, res) => {
    const post = db.prepare('SELECT * FROM news_posts WHERE id = ?').get(Number(req.params.id));
    if (!post || !reaches(withSites(post), req.user)) throw notFound('Post');
    db.prepare('INSERT OR IGNORE INTO news_reads (post_id, user_id) VALUES (?, ?)').run(post.id, req.user.id);
    res.json({ ok: true });
  });

  // --- Photos and videos ---

  // Upload one photo or video: { file_name, media_type, data (base64) }. It's attached when the post is saved.
  router.post('/news/media', requirePerm('news.manage'), (req, res) => {
    const type = String(req.body.media_type ?? '');
    const kind = MEDIA_TYPES[type];
    if (!kind) throw badRequest('Add photos (JPEG, PNG) or videos (MP4, MOV, WebM)');
    const data = String(req.body.data ?? '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    let bytes;
    try { bytes = fromBase64(data); } catch { throw badRequest('The file couldn’t be read'); }
    if (!bytes.length) throw badRequest('The file is empty');
    const max = kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (bytes.length > max) throw badRequest(kind === 'video' ? 'Videos can be up to 25 MB (about 30–60 seconds from a phone) – try a shorter clip' : 'Photos can be up to 8 MB');
    // Uploads that never made it onto a post are cleared out after a day.
    db.prepare(`DELETE FROM news_media WHERE post_id IS NULL AND created_at < datetime('now', '-1 day')`).run();
    const r = db.prepare('INSERT INTO news_media (kind, file_name, file_type, size, data, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(kind, str(req.body.file_name, 'file_name', { max: 200 }), type, bytes.length, bytes, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid, kind, file_type: type });
  });

  // The file itself. Videos support byte ranges, which phones need to play and skip through them.
  router.get('/news/media/:id', (req, res) => {
    const m = db.prepare('SELECT id, post_id, kind, file_type, size, created_by FROM news_media WHERE id = ?').get(Number(req.params.id));
    if (!m) throw notFound('Photo or video');
    if (m.post_id) {
      const post = db.prepare('SELECT * FROM news_posts WHERE id = ?').get(m.post_id);
      if (!reaches(withSites(post), req.user) && !can(req.user, 'news.manage')) throw notFound('Photo or video');
    } else if (!can(req.user, 'news.manage')) throw notFound('Photo or video');
    const data = db.prepare('SELECT data FROM news_media WHERE id = ?').get(m.id).data;
    res.setHeader('Content-Type', m.file_type);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, m.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), m.size - 1) : m.size - 1;
      if (start >= m.size || start > end) {
        res.setHeader('Content-Range', `bytes */${m.size}`);
        return res.status(416).end();
      }
      res.setHeader('Content-Range', `bytes ${start}-${end}/${m.size}`);
      return res.status(206).send(asBody(data.subarray(start, end + 1)));
    }
    res.send(asBody(data));
  });

  // --- Setup → News ---

  router.get('/news/manage', requirePerm('news.manage'), (req, res) => {
    const reads = new Map(db.prepare('SELECT post_id, COUNT(*) AS n FROM news_reads GROUP BY post_id').all().map((r) => [r.post_id, r.n]));
    res.json(posts().map((p) => ({ ...p, can_edit: canManage(req, p), audience: audience(p).length, reads: reads.get(p.id) ?? 0 })));
  });

  router.get('/news/:id/reads', requirePerm('news.manage'), (req, res) => {
    const post = db.prepare('SELECT * FROM news_posts WHERE id = ?').get(Number(req.params.id));
    if (!post) throw notFound('Post');
    const p = withSites(post);
    const at = new Map(db.prepare('SELECT user_id, read_at FROM news_reads WHERE post_id = ?').all(p.id).map((r) => [r.user_id, r.read_at]));
    res.json(audience(p).map((u) => ({ id: u.id, name: u.name, location_name: u.location_name, read_at: at.get(u.id) ?? null })));
  });

  const body = (req) => {
    const b = req.body;
    const allSites = b.all_sites === undefined ? 1 : bool(b.all_sites);
    const siteIds = allSites ? [] : [...new Set((Array.isArray(b.site_ids) ? b.site_ids : []).map((x) => id(x, 'site_ids')))];
    if (!allSites && !siteIds.length) throw badRequest('Choose which sites should see this');
    for (const s of siteIds) if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(s)) throw notFound('Location');
    const post = {
      title: str(b.title, 'title', { required: true, max: 150 }),
      body: str(b.body, 'body', { required: true, max: 10000 }),
      category: oneOf(b.category, 'category', CATEGORIES) ?? 'announcement',
      pinned: bool(b.pinned),
      requires_ack: bool(b.requires_ack),
      all_sites: allSites,
      site_ids: siteIds,
      media_ids: [...new Set((Array.isArray(b.media_ids) ? b.media_ids : []).map((x) => id(x, 'media_ids')))],
    };
    if (post.media_ids.length > MAX_MEDIA_PER_POST) throw badRequest(`Add at most ${MAX_MEDIA_PER_POST} photos and videos to a post`);
    if (!canManage(req, post)) throw forbidden(allSites ? 'Only people who work with every site can post to every site – choose your sites instead' : 'You can only post to sites you work with');
    return post;
  };
  // Attaches the uploaded photos/videos in order; ones taken off the post are deleted.
  const saveMedia = (req, postId, post) => {
    for (const [i, mediaId] of post.media_ids.entries()) {
      const m = db.prepare('SELECT post_id, created_by FROM news_media WHERE id = ?').get(mediaId);
      if (!m || (m.post_id && m.post_id !== postId) || (!m.post_id && m.created_by !== req.user.id && req.user.role !== 'admin')) throw notFound('Photo or video');
      db.prepare('UPDATE news_media SET post_id = ?, position = ? WHERE id = ?').run(postId, i, mediaId);
    }
    const keep = new Set(post.media_ids);
    for (const m of mediaOf(postId)) if (!keep.has(m.id)) db.prepare('DELETE FROM news_media WHERE id = ?').run(m.id);
  };
  const saveSites = (postId, post) => {
    db.prepare('DELETE FROM news_post_sites WHERE post_id = ?').run(postId);
    for (const s of post.site_ids) db.prepare('INSERT INTO news_post_sites (post_id, location_id) VALUES (?, ?)').run(postId, s);
  };
  const load = (req) => {
    const post = db.prepare('SELECT * FROM news_posts WHERE id = ?').get(Number(req.params.id));
    if (!post) throw notFound('Post');
    const p = withSites(post);
    if (!canManage(req, p)) throw forbidden('This post goes to sites you don’t work with');
    return p;
  };

  router.post('/news', requirePerm('news.manage'), (req, res) => {
    const post = body(req);
    const newId = tx(db, () => {
      const r = db.prepare('INSERT INTO news_posts (title, body, category, pinned, requires_ack, all_sites, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(post.title, post.body, post.category, post.pinned, post.requires_ack, post.all_sites, req.user.id);
      saveSites(r.lastInsertRowid, post);
      saveMedia(req, r.lastInsertRowid, post);
      return r.lastInsertRowid;
    });
    res.status(201).json(withSites(db.prepare('SELECT * FROM news_posts WHERE id = ?').get(newId)));
  });

  router.put('/news/:id', requirePerm('news.manage'), (req, res) => {
    const existing = load(req);
    const post = body(req);
    tx(db, () => {
      db.prepare(`UPDATE news_posts SET title = ?, body = ?, category = ?, pinned = ?, requires_ack = ?, all_sites = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(post.title, post.body, post.category, post.pinned, post.requires_ack, post.all_sites, existing.id);
      saveSites(existing.id, post);
      saveMedia(req, existing.id, post);
      // A changed policy needs reading again.
      if (bool(req.body.ask_again)) db.prepare('DELETE FROM news_reads WHERE post_id = ?').run(existing.id);
    });
    res.json(withSites(db.prepare('SELECT * FROM news_posts WHERE id = ?').get(existing.id)));
  });

  router.delete('/news/:id', requirePerm('news.manage'), (req, res) => {
    db.prepare('DELETE FROM news_posts WHERE id = ?').run(load(req).id);
    res.json({ ok: true });
  });
}
