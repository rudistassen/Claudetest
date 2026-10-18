// Staff chat: group chats that managers set up, choosing who's in each one – particular people, everyone at chosen
// sites, or everyone. Members read and reply (with a photo if they like); each person sees only their own groups.
// Direct messages are private one-to-one chats between two people who share a site; admins can read them.
// Team chats: anyone can start a private chat with a team (Payroll, HR, support…); the people an admin names for that
// team (Setup → Chat teams) see every one of its chats and reply as the team.
import { ACCESS_FIELDS, ACCESS_JOIN, can, PUBLIC_USER_FIELDS, requireAdmin, requirePerm, siteIdsFor, withPermissions } from '../auth.js';
import { logActivity } from '../activity.js';
import { tx } from '../db.js';
import { badRequest, bool, forbidden, id, notFound, str } from '../util.js';
import { notify } from '../push.js';

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const PAGE = 60;

// Real Node Buffers on the server; plain bytes in the standalone (in-browser) demo.
const realBuffer = typeof Buffer !== 'undefined' && typeof Buffer.isBuffer === 'function';
const fromBase64 = (b64) => (realBuffer ? Buffer.from(b64, 'base64') : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
const asBody = (bytes) => (realBuffer ? Buffer.from(bytes) : bytes);

export function registerChatRoutes(router, db) {
  const group = (groupId) => {
    const g = db.prepare('SELECT * FROM chat_groups WHERE id = ?').get(groupId);
    if (!g) return null;
    return {
      ...g,
      site_ids: db.prepare('SELECT location_id FROM chat_group_sites WHERE group_id = ?').all(g.id).map((r) => r.location_id),
      member_ids: db.prepare('SELECT user_id FROM chat_group_members WHERE group_id = ?').all(g.id).map((r) => r.user_id),
    };
  };

  // Everyone active who can use chat, with the sites they work at.
  const chatters = () => db.prepare(`SELECT ${PUBLIC_USER_FIELDS}, ${ACCESS_FIELDS}, l.name AS location_name FROM users u ${ACCESS_JOIN}
      LEFT JOIN locations l ON l.id = u.location_id WHERE u.active = 1 ORDER BY u.name`).all()
    .map(withPermissions).filter((u) => can(u, 'chat.use')).map((u) => ({ ...u, site_ids: siteIdsFor(db, u) }));

  // Someone is in a group if they're named in it, or it's for everyone, or for a site they're based at or work at.
  // (Everyone with all-site access counts as working at every site, so site groups use their home and added sites.)
  const ownSites = (u) => {
    const extra = db.prepare('SELECT location_id FROM user_sites WHERE user_id = ?').all(u.id).map((r) => r.location_id);
    return u.location_id ? [u.location_id, ...extra] : extra;
  };
  // Teams and who answers each.
  const teamById = (teamId) => db.prepare('SELECT * FROM chat_teams WHERE id = ?').get(teamId);
  const answers = (teamId, userId) => !!db.prepare('SELECT 1 FROM chat_team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
  const answererIds = (teamId) => db.prepare('SELECT user_id FROM chat_team_members WHERE team_id = ?').all(teamId).map((r) => r.user_id);
  const inGroup = (g, u) => (g.kind === 'direct' ? g.member_ids.includes(u.id) && can(u, 'chat.direct')
    : g.kind === 'team' ? g.member_ids.includes(u.id) || answers(g.team_id, u.id)
      : g.all_sites || g.member_ids.includes(u.id) || ownSites(u).some((s) => g.site_ids.includes(s)));
  // In a team chat: the person asking sees the team's name; the team's people see who's asking.
  const asking = (g, userId) => g.kind === 'team' && g.member_ids.includes(userId);
  // The sites that count for direct messages: where someone is based or has been added (or, for people with no
  // home site such as head office, every site they can work with).
  const dmSites = (u) => { const own = ownSites(u); return own.length ? own : siteIdsFor(db, u); };
  // A direct message is shown under the other person's name.
  const otherIn = (g, userId) => g.member_ids.find((m) => m !== userId);
  const nameOf = (userId) => db.prepare('SELECT name FROM users WHERE id = ?').get(userId)?.name ?? 'Someone who has left';
  const titleFor = (g, userId) => (g.kind === 'direct' ? nameOf(otherIn(g, userId))
    : g.kind === 'team' ? (asking(g, userId) ? teamById(g.team_id)?.name ?? g.name : nameOf(g.member_ids[0])) : g.name);
  const members = (g) => chatters().filter((u) => inGroup(g, u));

  // The group's creator, admins, and members who can set up chats can change it.
  // (Nobody changes a direct message.)
  const canEdit = (req, g) => g.kind === 'group' && (req.user.role === 'admin' || g.created_by === req.user.id || (can(req.user, 'chat.manage') && inGroup(g, req.user)));

  // A group this person is in (or, for managing it, can edit).
  const mine = (req) => {
    const g = group(Number(req.params.id));
    if (!g || !can(req.user, 'chat.use') || !inGroup(g, req.user)) throw notFound('Chat');
    return g;
  };

  const lastRead = (groupId, userId) => db.prepare('SELECT last_read_id, muted FROM chat_reads WHERE group_id = ? AND user_id = ?').get(groupId, userId);
  const unreadIn = (groupId, userId) => db.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE group_id = ? AND id > ? AND deleted_at IS NULL
      AND (user_id IS NULL OR user_id != ?)`).get(groupId, lastRead(groupId, userId)?.last_read_id ?? 0, userId).n;
  const myGroups = (req) => (can(req.user, 'chat.use') ? db.prepare('SELECT id FROM chat_groups').all().map((r) => group(r.id)).filter((g) => inGroup(g, req.user)) : []);

  const MESSAGE_SELECT = `SELECT m.id, m.group_id, m.user_id, m.body, m.created_at, m.deleted_at, u.name AS author, t.name AS as_team,
      EXISTS (SELECT 1 FROM chat_photos p WHERE p.message_id = m.id) AS has_photo
    FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN chat_teams t ON t.id = m.as_team`;
  // A team's reply shows as the team to the person asking ("Payroll"), and as the team and who sent it to the team.
  const shapeMessage = (req, g, m) => ({
    ...m,
    author: m.as_team ? (asking(g, req.user.id) ? m.as_team : `${m.as_team} · ${m.author ?? 'someone who has left'}`) : m.author,
    body: m.deleted_at ? '' : m.body,
    has_photo: !m.deleted_at && !!m.has_photo,
    mine: m.user_id === req.user.id,
    can_delete: !m.deleted_at && (m.user_id === req.user.id || canEdit(req, g)),
  });

  // The person's chats, newest activity first, with the last message and how many they haven't read.
  router.get('/chat', (req, res) => {
    const list = myGroups(req).map((g) => {
      const last = db.prepare(`${MESSAGE_SELECT} WHERE m.group_id = ? ORDER BY m.id DESC LIMIT 1`).get(g.id);
      return {
        id: g.id, kind: g.kind, name: titleFor(g, req.user.id), description: g.kind === 'direct' ? null : g.description,
        team: g.kind === 'team' ? teamById(g.team_id)?.name ?? null : null, answering: g.kind === 'team' && !asking(g, req.user.id),
        last: last ? { author: last.as_team && asking(g, req.user.id) ? last.as_team : last.author, body: last.deleted_at ? 'Message deleted' : last.body || (last.has_photo ? '📷 Photo' : ''), created_at: last.created_at, mine: last.user_id === req.user.id } : null,
        unread: unreadIn(g.id, req.user.id),
        muted: !!lastRead(g.id, req.user.id)?.muted,
        can_edit: canEdit(req, g),
        sort: last?.created_at ?? g.created_at,
      };
    }).sort((a, b) => (a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : b.id - a.id));
    // The teams they can start a chat with: active ones with someone to answer.
    const teams = can(req.user, 'chat.use') ? db.prepare(`SELECT t.id, t.name, t.description FROM chat_teams t WHERE t.active = 1
      AND EXISTS (SELECT 1 FROM chat_team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = t.id AND u.active = 1) ORDER BY t.sort_order, t.name`).all() : [];
    res.json({ groups: list, teams, can_create: can(req.user, 'chat.manage'), can_direct: can(req.user, 'chat.direct') });
  });

  // --- Team chats ---

  // Opens this person's chat with a team: the one they already have, or a new one. { team_id } → { id }
  router.post('/chat/team', requirePerm('chat.use'), (req, res) => {
    const team = teamById(id(req.body.team_id, 'team_id', { required: true }));
    if (!team || !team.active) throw notFound('Team');
    const existing = db.prepare(`SELECT g.id FROM chat_groups g JOIN chat_group_members m ON m.group_id = g.id
      WHERE g.kind = 'team' AND g.team_id = ? AND m.user_id = ?`).get(team.id, req.user.id);
    if (existing) return res.json({ id: existing.id });
    const newId = tx(db, () => {
      const r = db.prepare(`INSERT INTO chat_groups (kind, team_id, name, created_by) VALUES ('team', ?, ?, ?)`).run(team.id, team.name, req.user.id);
      db.prepare('INSERT INTO chat_group_members (group_id, user_id) VALUES (?, ?)').run(r.lastInsertRowid, req.user.id);
      return Number(r.lastInsertRowid);
    });
    res.status(201).json({ id: newId });
  });

  // Setup → Chat teams (admins): each team, what it's for and who answers it.
  const teamList = () => db.prepare('SELECT * FROM chat_teams ORDER BY sort_order, name').all().map((t) => ({
    ...t, active: !!t.active,
    answerers: db.prepare(`SELECT u.id, u.name FROM chat_team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY u.name`).all(t.id),
    chats: db.prepare(`SELECT COUNT(*) AS n FROM chat_groups WHERE kind = 'team' AND team_id = ?`).get(t.id).n,
  }));
  router.get('/chat-teams', requireAdmin, (req, res) => {
    res.json({ teams: teamList(), people: chatters().map((u) => ({ id: u.id, name: u.name, location_name: u.location_name })) });
  });
  const readTeam = (b) => {
    const t = { name: str(b.name, 'name', { required: true, max: 60 }), description: str(b.description, 'description', { max: 200 }), active: b.active === undefined ? 1 : bool(b.active),
      answerer_ids: [...new Set((Array.isArray(b.answerer_ids) ? b.answerer_ids : []).map((x) => id(x, 'answerer_ids')))] };
    for (const u of t.answerer_ids) if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(u)) throw notFound('Person');
    return t;
  };
  const saveAnswerers = (teamId, ids) => {
    db.prepare('DELETE FROM chat_team_members WHERE team_id = ?').run(teamId);
    for (const u of ids) db.prepare('INSERT INTO chat_team_members (team_id, user_id) VALUES (?, ?)').run(teamId, u);
  };
  router.post('/chat-teams', requireAdmin, (req, res) => {
    const t = readTeam(req.body);
    const newId = tx(db, () => {
      const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM chat_teams').get().n;
      const r = db.prepare('INSERT INTO chat_teams (name, description, active, sort_order) VALUES (?, ?, ?, ?)').run(t.name, t.description, t.active, next);
      saveAnswerers(r.lastInsertRowid, t.answerer_ids);
      return Number(r.lastInsertRowid);
    });
    res.status(201).json({ id: newId });
  });
  router.put('/chat-teams/:id', requireAdmin, (req, res) => {
    const existing = teamById(Number(req.params.id));
    if (!existing) throw notFound('Team');
    const t = readTeam(req.body);
    tx(db, () => {
      db.prepare('UPDATE chat_teams SET name = ?, description = ?, active = ? WHERE id = ?').run(t.name, t.description, t.active, existing.id);
      db.prepare(`UPDATE chat_groups SET name = ? WHERE kind = 'team' AND team_id = ?`).run(t.name, existing.id);
      saveAnswerers(existing.id, t.answerer_ids);
    });
    res.json({ id: existing.id });
  });
  // Deleting a team deletes its chats too.
  router.delete('/chat-teams/:id', requireAdmin, (req, res) => {
    const existing = teamById(Number(req.params.id));
    if (!existing) throw notFound('Team');
    tx(db, () => {
      db.prepare(`DELETE FROM chat_groups WHERE kind = 'team' AND team_id = ?`).run(existing.id);
      db.prepare('DELETE FROM chat_teams WHERE id = ?').run(existing.id);
    });
    res.json({ ok: true });
  });

  // Unread messages across all their chats (for the menu badge).
  router.get('/chat/unread', (req, res) => {
    res.json({ count: myGroups(req).reduce((n, g) => n + (lastRead(g.id, req.user.id)?.muted ? 0 : unreadIn(g.id, req.user.id)), 0) });
  });

  // --- Direct messages ---

  // Who this person can message: people who share a site with them (admins can message anyone).
  const reachable = (req) => {
    const mine = dmSites(req.user);
    return chatters().filter((u) => u.id !== req.user.id && can(u, 'chat.direct')
      && (req.user.role === 'admin' || dmSites(u).some((s) => mine.includes(s))));
  };
  router.get('/chat/direct/people', requirePerm('chat.direct'), (req, res) => {
    res.json(reachable(req).map((u) => ({ id: u.id, name: u.name, location_name: u.location_name, rota_group: u.rota_group })));
  });

  // Opens the direct message with someone: the one they already have, or a new one. { user_id } → { id }
  router.post('/chat/direct', requirePerm('chat.direct'), (req, res) => {
    const other = id(req.body.user_id, 'user_id', { required: true });
    if (!reachable(req).some((u) => u.id === other)) throw forbidden('You can only message people at your sites');
    const existing = db.prepare(`SELECT g.id FROM chat_groups g WHERE g.kind = 'direct'
      AND EXISTS (SELECT 1 FROM chat_group_members m WHERE m.group_id = g.id AND m.user_id = ?)
      AND EXISTS (SELECT 1 FROM chat_group_members m WHERE m.group_id = g.id AND m.user_id = ?)`).get(req.user.id, other);
    if (existing) return res.json({ id: existing.id });
    const newId = tx(db, () => {
      const r = db.prepare(`INSERT INTO chat_groups (kind, name, created_by) VALUES ('direct', '', ?)`).run(req.user.id);
      for (const u of [req.user.id, other]) db.prepare('INSERT INTO chat_group_members (group_id, user_id) VALUES (?, ?)').run(r.lastInsertRowid, u);
      return Number(r.lastInsertRowid);
    });
    res.status(201).json({ id: newId });
  });

  // --- Admins: reading direct messages (each look is recorded in the Staff log) ---

  const directChats = () => db.prepare(`SELECT g.id, g.created_at,
      (SELECT COUNT(*) FROM chat_messages m WHERE m.group_id = g.id AND m.deleted_at IS NULL) AS messages,
      (SELECT MAX(m.created_at) FROM chat_messages m WHERE m.group_id = g.id) AS last_at
    FROM chat_groups g WHERE g.kind = 'direct'`).all();
  const peopleIn = (groupId) => db.prepare(`SELECT u.id, u.name, l.name AS location_name FROM chat_group_members m JOIN users u ON u.id = m.user_id
    LEFT JOIN locations l ON l.id = u.location_id WHERE m.group_id = ? ORDER BY u.name`).all(groupId);
  router.get('/chat-admin/direct', requireAdmin, (req, res) => {
    res.json(directChats().filter((c) => c.messages > 0).map((c) => ({ ...c, people: peopleIn(c.id) }))
      .sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0)));
  });
  const directFor = (req) => {
    const g = group(Number(req.params.id));
    if (!g || g.kind !== 'direct') throw notFound('Direct message');
    return g;
  };
  router.get('/chat-admin/direct/:id', requireAdmin, (req, res) => {
    const g = directFor(req);
    const people = peopleIn(g.id);
    // Deleted messages stay hidden here too.
    const rows = db.prepare(`${MESSAGE_SELECT} WHERE m.group_id = ? ORDER BY m.id`).all(g.id);
    logActivity(db, req, { kind: 'change', area: 'Chat', action: 'Read a direct message conversation', detail: people.map((p) => p.name).join(' and '), path: `GET ${req.path}` });
    res.json({ id: g.id, people, messages: rows.map((m) => ({ ...m, body: m.deleted_at ? '' : m.body, has_photo: !m.deleted_at && !!m.has_photo })) });
  });
  router.get('/chat-admin/direct/:id/photos/:messageId', requireAdmin, (req, res) => {
    const g = directFor(req);
    const p = db.prepare(`SELECT p.file_type, p.data FROM chat_photos p JOIN chat_messages m ON m.id = p.message_id
      WHERE p.message_id = ? AND m.group_id = ?`).get(Number(req.params.messageId), g.id);
    if (!p) throw notFound('Photo');
    res.setHeader('Content-Type', p.file_type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(asBody(p.data));
  });

  // A chat's messages: the latest page, older ones (?before=id) or new ones since the last fetch (?after=id).
  router.get('/chat/:id', (req, res) => {
    const g = mine(req);
    const after = req.query.after ? id(req.query.after, 'after') : null;
    const before = req.query.before ? id(req.query.before, 'before') : null;
    const rows = after
      ? db.prepare(`${MESSAGE_SELECT} WHERE m.group_id = ? AND m.id > ? ORDER BY m.id LIMIT 500`).all(g.id, after)
      : db.prepare(`${MESSAGE_SELECT} WHERE m.group_id = ? ${before ? 'AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ${PAGE}`).all(...(before ? [g.id, before] : [g.id])).reverse();
    const people = members(g);
    const team = g.kind === 'team' ? teamById(g.team_id) : null;
    res.json({
      group: { id: g.id, kind: g.kind, name: titleFor(g, req.user.id), description: g.kind === 'direct' ? null : team ? team.description : g.description,
        team: team?.name ?? null, answering: !!team && !asking(g, req.user.id), all_sites: !!g.all_sites, site_ids: g.site_ids, member_ids: g.member_ids, can_edit: canEdit(req, g), muted: !!lastRead(g.id, req.user.id)?.muted },
      // The person asking a team doesn't see who's on it – just the team.
      members: (team && asking(g, req.user.id) ? people.filter((u) => u.id === req.user.id) : people).map((u) => ({ id: u.id, name: u.name, location_name: u.location_name, answers: !!team && u.id !== g.member_ids[0] })),
      messages: rows.map((m) => shapeMessage(req, g, m)),
      more: !after && rows.length === PAGE,
      // Messages edited away since (deleted ones) are re-sent with each poll of the latest ones.
      deleted: after ? db.prepare('SELECT id FROM chat_messages WHERE group_id = ? AND deleted_at IS NOT NULL AND id <= ? AND deleted_at >= datetime(\'now\', \'-1 day\')').all(g.id, after).map((r) => r.id) : [],
    });
  });

  router.post('/chat/:id/read', (req, res) => {
    const g = mine(req);
    const upTo = req.body.last_id ? id(req.body.last_id, 'last_id') : (db.prepare('SELECT MAX(id) AS id FROM chat_messages WHERE group_id = ?').get(g.id).id ?? 0);
    db.prepare(`INSERT INTO chat_reads (group_id, user_id, last_read_id) VALUES (?, ?, ?)
      ON CONFLICT (group_id, user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`).run(g.id, req.user.id, upTo);
    res.json({ ok: true });
  });

  // Turn phone notifications for one chat off or on.
  router.post('/chat/:id/mute', (req, res) => {
    const g = mine(req);
    const muted = bool(req.body.muted);
    db.prepare(`INSERT INTO chat_reads (group_id, user_id, muted) VALUES (?, ?, ?)
      ON CONFLICT (group_id, user_id) DO UPDATE SET muted = excluded.muted`).run(g.id, req.user.id, muted);
    res.json({ muted: !!muted });
  });

  // Send a message: { body, photo: { file_name, media_type, data (base64) } } – text, a photo, or both.
  router.post('/chat/:id/messages', requirePerm('chat.use'), (req, res) => {
    const g = mine(req);
    const body = str(req.body.body, 'body', { max: 4000 }) ?? '';
    let photo = null;
    if (req.body.photo) {
      const type = String(req.body.photo.media_type ?? '');
      if (!PHOTO_TYPES.includes(type)) throw badRequest('Send photos as JPEG, PNG, WebP or GIF');
      let bytes;
      try { bytes = fromBase64(String(req.body.photo.data ?? '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '')); } catch { throw badRequest('The photo couldn’t be read'); }
      if (!bytes.length) throw badRequest('The photo is empty');
      if (bytes.length > MAX_PHOTO_BYTES) throw badRequest('Photos can be up to 8 MB');
      photo = { type, bytes };
    }
    if (!body.trim() && !photo) throw badRequest('Write a message');
    // In a team chat, the team's people reply as the team.
    const asTeam = g.kind === 'team' && !asking(g, req.user.id) ? g.team_id : null;
    const msgId = tx(db, () => {
      const r = db.prepare('INSERT INTO chat_messages (group_id, user_id, body, as_team) VALUES (?, ?, ?, ?)').run(g.id, req.user.id, body.trim(), asTeam);
      if (photo) db.prepare('INSERT INTO chat_photos (message_id, file_type, data) VALUES (?, ?, ?)').run(r.lastInsertRowid, photo.type, photo.bytes);
      db.prepare(`INSERT INTO chat_reads (group_id, user_id, last_read_id) VALUES (?, ?, ?)
        ON CONFLICT (group_id, user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`).run(g.id, req.user.id, r.lastInsertRowid);
      return Number(r.lastInsertRowid);
    });
    // Everyone else in the chat who hasn't muted it gets a phone notification (not kept on the Notifications page).
    const muted = new Set(db.prepare('SELECT user_id FROM chat_reads WHERE group_id = ? AND muted = 1').all(g.id).map((r) => r.user_id));
    const teamName = g.kind === 'team' ? teamById(g.team_id)?.name ?? g.name : null;
    notify(db, members(g).map((u) => u.id).filter((u) => u !== req.user.id && !muted.has(u)), 'chat', {
      title: g.kind === 'direct' ? req.user.name : g.kind === 'team' ? (asTeam ? teamName : `${req.user.name} · to ${teamName}`) : `${req.user.name} · ${g.name}`,
      body: body.trim() ? body.trim().replace(/\s+/g, ' ').slice(0, 140) : '📷 Photo',
      url: `/#/chat/${g.id}`,
      tag: `chat-${g.id}`,
    });
    const m = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(msgId);
    res.status(201).json(shapeMessage(req, g, m));
  });

  // Delete a message: your own, or anyone's in a chat you look after. It shows as "Message deleted".
  router.delete('/chat/:id/messages/:messageId', requirePerm('chat.use'), (req, res) => {
    const g = mine(req);
    const m = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND group_id = ?').get(Number(req.params.messageId), g.id);
    if (!m) throw notFound('Message');
    if (m.user_id !== req.user.id && !canEdit(req, g)) throw forbidden('You can only delete your own messages');
    tx(db, () => {
      db.prepare(`UPDATE chat_messages SET body = '', deleted_at = datetime('now') WHERE id = ?`).run(m.id);
      db.prepare('DELETE FROM chat_photos WHERE message_id = ?').run(m.id);
    });
    res.json({ ok: true });
  });

  router.get('/chat/:id/photos/:messageId', (req, res) => {
    const g = mine(req);
    const p = db.prepare(`SELECT p.file_type, p.data FROM chat_photos p JOIN chat_messages m ON m.id = p.message_id
      WHERE p.message_id = ? AND m.group_id = ?`).get(Number(req.params.messageId), g.id);
    if (!p) throw notFound('Photo');
    res.setHeader('Content-Type', p.file_type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(asBody(p.data));
  });

  // --- Setting chats up ---

  // Who can be put in a chat: people (who can use chat) at the sites this person works with, and those sites.
  router.get('/chat-setup/people', requirePerm('chat.manage'), (req, res) => {
    const sites = req.user.site_ids;
    res.json({
      people: chatters().filter((u) => req.user.role === 'admin' || req.user.all_sites || u.site_ids.some((s) => sites.includes(s)))
        .map((u) => ({ id: u.id, name: u.name, location_id: u.location_id, location_name: u.location_name, rota_group: u.rota_group })),
      sites: db.prepare(`SELECT id, name FROM locations WHERE active = 1 AND id IN (${sites.map(() => '?').join(', ') || 'NULL'}) ORDER BY name`).all(...sites),
      can_all: req.user.role === 'admin' || !!req.user.all_sites,
    });
  });

  const readGroup = (req, existing = null) => {
    const b = req.body;
    const g = {
      name: str(b.name, 'name', { required: true, max: 80 }),
      description: str(b.description, 'description', { max: 300 }),
      all_sites: bool(b.all_sites),
      site_ids: [...new Set((Array.isArray(b.site_ids) ? b.site_ids : []).map((x) => id(x, 'site_ids')))],
      member_ids: [...new Set((Array.isArray(b.member_ids) ? b.member_ids : []).map((x) => id(x, 'member_ids')))],
    };
    if (g.all_sites) g.site_ids = [];
    if (g.all_sites && req.user.role !== 'admin' && !req.user.all_sites && !existing?.all_sites) throw forbidden('Only people who work with every site can make a chat for everyone');
    for (const s of g.site_ids) {
      if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(s)) throw notFound('Location');
      // A site already on the chat can stay; adding one needs access to it.
      if (!req.user.site_ids.includes(s) && !existing?.site_ids.includes(s)) throw forbidden('You can only add sites you work with');
    }
    for (const u of g.member_ids) if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(u)) throw notFound('Person');
    // Whoever sets a chat up is always in it.
    if (!existing && !g.all_sites && !g.member_ids.includes(req.user.id)) g.member_ids.push(req.user.id);
    if (!g.all_sites && !g.site_ids.length && g.member_ids.length < 2) throw badRequest('Choose who’s in this chat');
    return g;
  };
  const saveMembers = (groupId, g) => {
    db.prepare('DELETE FROM chat_group_sites WHERE group_id = ?').run(groupId);
    db.prepare('DELETE FROM chat_group_members WHERE group_id = ?').run(groupId);
    for (const s of g.site_ids) db.prepare('INSERT INTO chat_group_sites (group_id, location_id) VALUES (?, ?)').run(groupId, s);
    for (const u of g.member_ids) db.prepare('INSERT INTO chat_group_members (group_id, user_id) VALUES (?, ?)').run(groupId, u);
  };
  const editable = (req) => {
    const g = group(Number(req.params.id));
    if (!g) throw notFound('Chat');
    if (!canEdit(req, g)) throw forbidden('Only whoever set this chat up (or an admin) can change it');
    return g;
  };

  // A chat's settings, for changing who's in it.
  router.get('/chat-setup/:id', requirePerm('chat.manage'), (req, res) => {
    const g = editable(req);
    res.json({ id: g.id, name: g.name, description: g.description, all_sites: !!g.all_sites, site_ids: g.site_ids, member_ids: g.member_ids });
  });

  router.post('/chat', requirePerm('chat.manage'), (req, res) => {
    const g = readGroup(req);
    const newId = tx(db, () => {
      const r = db.prepare('INSERT INTO chat_groups (name, description, all_sites, created_by) VALUES (?, ?, ?, ?)').run(g.name, g.description, g.all_sites, req.user.id);
      saveMembers(r.lastInsertRowid, g);
      return Number(r.lastInsertRowid);
    });
    const saved = group(newId);
    notify(db, members(saved).map((u) => u.id).filter((u) => u !== req.user.id), 'chat', {
      title: `You’re in a new chat: ${saved.name}`, body: `${req.user.name} added you.`, url: `/#/chat/${newId}`, tag: `chat-${newId}`,
    });
    res.status(201).json({ id: newId });
  });

  router.put('/chat/:id', requirePerm('chat.manage'), (req, res) => {
    const existing = editable(req);
    const g = readGroup(req, existing);
    const before = new Set(members(existing).map((u) => u.id));
    tx(db, () => {
      db.prepare(`UPDATE chat_groups SET name = ?, description = ?, all_sites = ?, updated_at = datetime('now') WHERE id = ?`).run(g.name, g.description, g.all_sites, existing.id);
      saveMembers(existing.id, g);
    });
    const added = members(group(existing.id)).map((u) => u.id).filter((u) => !before.has(u) && u !== req.user.id);
    notify(db, added, 'chat', { title: `You’re in a new chat: ${g.name}`, body: `${req.user.name} added you.`, url: `/#/chat/${existing.id}`, tag: `chat-${existing.id}` });
    res.json({ id: existing.id });
  });

  router.delete('/chat/:id', requirePerm('chat.manage'), (req, res) => {
    db.prepare('DELETE FROM chat_groups WHERE id = ?').run(editable(req).id);
    res.json({ ok: true });
  });
}
