// My Brew news feed: announcements and policy updates posted in Setup → News, shown to staff on My Brew.
// A post goes to every site or to chosen sites; policy posts can ask people to confirm they've read them.
import { requirePerm } from '../auth.js';
import { tx } from '../db.js';
import { badRequest, bool, forbidden, id, notFound, oneOf, str } from '../util.js';

const CATEGORIES = ['announcement', 'policy', 'event', 'reminder'];

export function registerNewsRoutes(router, db) {
  const sitesOf = (postId) => db.prepare('SELECT location_id FROM news_post_sites WHERE post_id = ?').all(postId).map((r) => r.location_id);
  // Someone sees a post meant for every site, or for their home site or any site they work at.
  const reaches = (post, user) => post.all_sites || post.site_ids.some((s) => s === user.location_id || user.site_ids.includes(s));
  const withSites = (p) => ({ ...p, site_ids: sitesOf(p.id) });
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
    };
    if (!canManage(req, post)) throw forbidden(allSites ? 'Only people who work with every site can post to every site – choose your sites instead' : 'You can only post to sites you work with');
    return post;
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
