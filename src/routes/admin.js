import { ACCESS_FIELDS, ACCESS_JOIN, PUBLIC_USER_FIELDS, assertLocation, hashPassword, requireAdmin, requirePerm, validatePassword, withPermissions } from '../auth.js';
import { tx } from '../db.js';
import { ALL_PERMISSIONS, cleanPermissions, parsePermissions, PERMISSION_AREAS, roleForPermissions } from '../permissions.js';
import { badRequest, bool, forbidden, id, notFound, num, oneOf, str } from '../util.js';

const ROLES = ['admin', 'manager', 'staff'];

export function registerAdminRoutes(router, db) {
  // --- Locations ---

  router.get('/locations', (req, res) => {
    // Admins see every site (including inactive ones); everyone else the sites they can access.
    const ids = new Set(req.user.site_ids);
    const rows = db.prepare('SELECT * FROM locations ORDER BY active DESC, name').all()
      .filter((l) => req.user.role === 'admin' || ids.has(l.id));
    res.json(rows);
  });

  const locationBody = (b) => ({
    name: str(b.name, 'name', { required: true, max: 100 }),
    address: str(b.address, 'address'),
    phone: str(b.phone, 'phone', { max: 50 }),
    active: b.active === undefined ? 1 : bool(b.active),
  });

  router.post('/locations', requireAdmin, (req, res) => {
    const l = locationBody(req.body);
    const r = db.prepare('INSERT INTO locations (name, address, phone, active) VALUES (?, ?, ?, ?)')
      .run(l.name, l.address, l.phone, l.active);
    res.status(201).json(db.prepare('SELECT * FROM locations WHERE id = ?').get(r.lastInsertRowid));
  });

  router.put('/locations/:id', requireAdmin, (req, res) => {
    const l = locationBody(req.body);
    const r = db.prepare('UPDATE locations SET name = ?, address = ?, phone = ?, active = ? WHERE id = ?')
      .run(l.name, l.address, l.phone, l.active, Number(req.params.id));
    if (!r.changes) throw notFound('Location');
    res.json(db.prepare('SELECT * FROM locations WHERE id = ?').get(Number(req.params.id)));
  });

  // --- Staff / users ---

  const setById = db.prepare('SELECT * FROM permission_sets WHERE id = ?');
  const permsOf = (set) => parsePermissions(set?.permissions);
  // What a person can currently do (for checking a non-admin only hands out access they have themselves).
  const currentPerms = (user) => withPermissions(db.prepare(`SELECT ${PUBLIC_USER_FIELDS}, ${ACCESS_FIELDS} FROM users u ${ACCESS_JOIN} WHERE u.id = ?`).get(user.id)).permissions;
  // A non-admin can hand out access they have themselves, except managing staff (so managers can't create managers).
  const covers = (mine, theirs) => theirs.every((p) => mine.includes(p)) && !theirs.includes('staff.manage');

  // Each person's extra sites (used when they don't have access to every site).
  const extraSites = () => {
    const m = new Map();
    for (const r of db.prepare('SELECT user_id, location_id FROM user_sites').all()) m.set(r.user_id, [...(m.get(r.user_id) ?? []), r.location_id]);
    return m;
  };

  router.get('/users', requirePerm('staff.manage'), (req, res) => {
    const locationId = id(req.query.location_id, 'location_id');
    if (locationId) assertLocation(req, locationId);
    const sql = `SELECT ${PUBLIC_USER_FIELDS}, ${ACCESS_FIELDS}, l.name AS location_name FROM users u ${ACCESS_JOIN}
      LEFT JOIN locations l ON l.id = u.location_id`;
    let rows = locationId
      ? db.prepare(`${sql} WHERE u.location_id = ? ORDER BY u.active DESC, u.name`).all(locationId)
      : db.prepare(`${sql} ORDER BY u.active DESC, l.name, u.name`).all();
    // People who aren't admins see staff based at the sites they can access.
    if (req.user.role !== 'admin') {
      const mine = new Set(req.user.site_ids);
      rows = rows.filter((u) => u.role !== 'admin' && mine.has(u.location_id));
    }
    const extra = extraSites();
    res.json(rows.map((u) => ({ ...withPermissions(u), site_ids: extra.get(u.id) ?? [] })));
  });

  // Access is 'admin' or a permission set id (permission_set_id). The older role field (admin/manager/staff) still
  // works and means the built-in set for that role. People who aren't admins can only manage staff at their own
  // site, and only hand out access they have themselves.
  function userBody(req, existing) {
    const b = req.body;
    const u = {
      name: str(b.name, 'name', { required: true, max: 100 }),
      email: str(b.email, 'email', { required: true, max: 200 }),
      location_id: id(b.location_id, 'location_id'),
      position: str(b.position, 'position', { max: 100 }),
      // Left as it is when not sent (e.g. by older screens).
      rota_group: b.rota_group === undefined ? existing?.rota_group ?? null : str(b.rota_group, 'rota_group', { max: 50 }),
      hourly_rate: num(b.hourly_rate, 'hourly_rate', { min: 0 }) ?? 0,
      active: b.active === undefined ? 1 : bool(b.active),
    };
    const access = b.permission_set_id ?? null;
    let set = null;
    if (access === 'admin' || (access === null && b.role === 'admin')) {
      u.role = 'admin';
    } else if (access !== null && access !== '') {
      set = setById.get(id(access, 'permission_set_id'));
      if (!set) throw notFound('Permission set');
    } else if (b.role) {
      set = db.prepare('SELECT * FROM permission_sets WHERE built_in = ?').get(oneOf(b.role, 'role', ROLES));
    } else if (existing) {
      if (existing.role === 'admin') u.role = 'admin';
      else set = existing.permission_set_id ? setById.get(existing.permission_set_id) : db.prepare('SELECT * FROM permission_sets WHERE built_in = ?').get(existing.role);
    } else {
      set = db.prepare(`SELECT * FROM permission_sets WHERE built_in = 'staff'`).get();
    }
    if (u.role !== 'admin') {
      u.permission_set_id = set?.id ?? null;
      u.role = set?.built_in ?? roleForPermissions(permsOf(set));
    } else {
      u.permission_set_id = null;
    }

    // Sites: every site (the default), or their home site plus the ones ticked.
    // New people get every site, unless whoever adds them only has some sites themselves.
    const defaultAll = req.user.role === 'admin' || req.user.all_sites ? 1 : 0;
    u.all_sites = u.role === 'admin' ? 1 : b.all_sites === undefined ? (existing?.all_sites ?? defaultAll) : bool(b.all_sites);
    const rawSites = b.site_ids === undefined ? null : Array.isArray(b.site_ids) ? b.site_ids : String(b.site_ids ?? '').split(',').filter(Boolean);
    u.site_ids = u.all_sites ? [] : rawSites
      ? [...new Set(rawSites.map((x) => id(x, 'site_ids')))]
      : existing ? db.prepare('SELECT location_id FROM user_sites WHERE user_id = ?').all(existing.id).map((r) => r.location_id) : [];
    for (const siteId of u.site_ids) if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(siteId)) throw notFound('Location');

    if (!/^[^\s@]+@[^\s@]+$/.test(u.email)) throw badRequest('email is not valid');
    const clash = db.prepare('SELECT id, name, active FROM users WHERE email = ? COLLATE NOCASE').get(u.email);
    if (clash && clash.id !== existing?.id) {
      throw badRequest(req.user.role === 'admin'
        ? `${clash.name}${clash.active ? '' : ' (deactivated)'} already uses that email. Give them a different email first.`
        : 'Someone else already uses that email');
    }
    if (u.role !== 'admin' && !u.location_id) throw badRequest('A home site is required for everyone except admins');
    if (u.role === 'admin') u.location_id = null;
    if (req.user.role !== 'admin') {
      const mine = currentPerms(req.user);
      if (u.role === 'admin') throw forbidden('Only admins can make someone an admin');
      if (permsOf(set).includes('staff.manage')) throw forbidden('Only admins can give someone access to manage staff');
      if (!covers(mine, permsOf(set))) throw forbidden('You can only give people access you have yourself');
      const mySites = new Set(req.user.site_ids);
      if (!mySites.has(u.location_id)) throw forbidden('You can only manage staff at sites you have access to');
      if (existing && (existing.role === 'admin' || !mySites.has(existing.location_id) || !covers(mine, currentPerms(existing)))) {
        throw forbidden('You can’t change this person');
      }
      if (u.all_sites && !req.user.all_sites) throw forbidden('You can only give people access to sites you have yourself');
      if (u.site_ids.some((s) => !mySites.has(s))) throw forbidden('You can only give people access to sites you have yourself');
    }
    if (u.location_id && !db.prepare('SELECT 1 FROM locations WHERE id = ?').get(u.location_id)) throw notFound('Location');
    return u;
  }

  const userOut = (userId) => ({
    ...withPermissions(db.prepare(`SELECT ${PUBLIC_USER_FIELDS}, ${ACCESS_FIELDS} FROM users u ${ACCESS_JOIN} WHERE u.id = ?`).get(userId)),
    site_ids: db.prepare('SELECT location_id FROM user_sites WHERE user_id = ?').all(userId).map((r) => r.location_id),
  });
  const saveSites = (userId, u) => {
    db.prepare('DELETE FROM user_sites WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT INTO user_sites (user_id, location_id) VALUES (?, ?)');
    for (const siteId of u.site_ids) if (siteId !== u.location_id) ins.run(userId, siteId);
  };

  router.post('/users', requirePerm('staff.manage'), (req, res) => {
    const u = userBody(req);
    const password = validatePassword(req.body.password);
    const userId = tx(db, () => {
      const r = db.prepare(`INSERT INTO users (name, email, password_hash, role, location_id, position, rota_group, hourly_rate, active, permission_set_id, all_sites)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(u.name, u.email, hashPassword(password), u.role, u.location_id, u.position, u.rota_group, u.hourly_rate, u.active, u.permission_set_id, u.all_sites);
      saveSites(r.lastInsertRowid, u);
      return r.lastInsertRowid;
    });
    res.status(201).json(userOut(userId));
  });

  router.put('/users/:id', requirePerm('staff.manage'), (req, res) => {
    const userId = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!existing) throw notFound('User');
    const u = userBody(req, existing);
    if (userId === req.user.id && (u.role !== existing.role || u.permission_set_id !== existing.permission_set_id || !u.active)) {
      throw badRequest('You cannot change your own access or deactivate yourself');
    }
    tx(db, () => {
      db.prepare(`UPDATE users SET name = ?, email = ?, role = ?, location_id = ?, position = ?, rota_group = ?, hourly_rate = ?, active = ?, permission_set_id = ?, all_sites = ? WHERE id = ?`)
        .run(u.name, u.email, u.role, u.location_id, u.position, u.rota_group, u.hourly_rate, u.active, u.permission_set_id, u.all_sites, userId);
      saveSites(userId, u);
    });
    if (req.body.password) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(validatePassword(req.body.password)), userId);
    }
    if (!u.active || req.body.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    res.json(userOut(userId));
  });

  // Bulk edit: the same change for several people at once – their role, home site, access, hourly rate or whether
  // they're active. Each person goes through the same checks as editing them one at a time; if anyone can't be
  // changed, nobody is.
  router.post('/users/bulk', requirePerm('staff.manage'), (req, res) => {
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map((x) => id(x, 'ids')))];
    if (!ids.length) throw badRequest('Choose at least one person');
    if (ids.length > 500) throw badRequest('Edit at most 500 people at a time');
    const c = req.body.changes ?? {};
    const keys = ['rota_group', 'location_id', 'permission_set_id', 'hourly_rate', 'active'].filter((k) => c[k] !== undefined);
    if (!keys.length) throw badRequest('Choose something to change');
    const updated = tx(db, () => ids.map((userId) => {
      const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!existing) throw notFound('User');
      const body = {
        name: existing.name, email: existing.email, location_id: existing.location_id, position: existing.position,
        rota_group: existing.rota_group, hourly_rate: existing.hourly_rate, active: existing.active,
        permission_set_id: existing.role === 'admin' ? 'admin' : existing.permission_set_id ?? setByRole(existing.role)?.id ?? null,
        ...Object.fromEntries(keys.map((k) => [k, c[k]])),
      };
      let u;
      try {
        u = userBody({ ...req, body }, existing);
        if (userId === req.user.id && (u.role !== existing.role || u.permission_set_id !== existing.permission_set_id || !u.active)) {
          throw badRequest('You cannot change your own access or deactivate yourself');
        }
      } catch (err) {
        err.message = `${existing.name}: ${err.message}`;
        throw err;
      }
      db.prepare(`UPDATE users SET role = ?, location_id = ?, rota_group = ?, hourly_rate = ?, active = ?, permission_set_id = ?, all_sites = ? WHERE id = ?`)
        .run(u.role, u.location_id, u.rota_group, u.hourly_rate, u.active, u.permission_set_id, u.all_sites, userId);
      saveSites(userId, u);
      if (!u.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      return userId;
    }));
    res.json({ updated: updated.length });
  });
  const setByRole = (role) => db.prepare('SELECT * FROM permission_sets WHERE built_in = ?').get(role);

  // --- Permission sets (Setup → Permissions). Anyone who manages staff can list them to assign; only admins edit. ---

  router.get('/permissions', requirePerm('staff.manage'), (req, res) => {
    const admin = req.user.role === 'admin';
    const mine = admin ? ALL_PERMISSIONS : currentPerms(req.user);
    const people = db.prepare(`SELECT COALESCE(u.permission_set_id, dps.id) AS set_id, COUNT(*) AS n FROM users u
      LEFT JOIN permission_sets dps ON u.permission_set_id IS NULL AND dps.built_in = u.role
      WHERE u.active = 1 AND u.role != 'admin' GROUP BY 1`).all();
    const count = new Map(people.map((r) => [r.set_id, r.n]));
    res.json({
      admins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND role = 'admin'").get().n,
      areas: PERMISSION_AREAS.map(([area, perms]) => ({ area, permissions: perms.map(([key, label]) => ({ key, label })) })),
      sets: db.prepare('SELECT * FROM permission_sets ORDER BY built_in IS NULL, name').all().map((ps) => {
        const perms = permsOf(ps);
        return { ...ps, permissions: perms, people: count.get(ps.id) ?? 0, assignable: admin || covers(mine, perms) };
      }),
    });
  });

  function setBody(req, existingId = 0) {
    const name = str(req.body.name, 'name', { required: true, max: 60 });
    if (/^admin$/i.test(name)) throw badRequest('“Admin” is reserved for people who can do everything');
    if (db.prepare('SELECT 1 FROM permission_sets WHERE name = ? AND id != ?').get(name, existingId)) throw badRequest('There is already a permission set with that name');
    return { name, description: str(req.body.description, 'description', { max: 300 }), permissions: cleanPermissions(req.body.permissions) };
  }

  // People in a set are sorted as managers or staff by what the set allows.
  const syncRoles = (setId, perms) => db.prepare(`UPDATE users SET role = ? WHERE permission_set_id = ? AND role != 'admin'`).run(roleForPermissions(perms), setId);

  router.post('/permission-sets', requireAdmin, (req, res) => {
    const b = setBody(req);
    const r = db.prepare('INSERT INTO permission_sets (name, description, permissions) VALUES (?, ?, ?)').run(b.name, b.description, JSON.stringify(b.permissions));
    res.status(201).json({ ...setById.get(r.lastInsertRowid), permissions: b.permissions });
  });

  router.put('/permission-sets/:id', requireAdmin, (req, res) => {
    const set = setById.get(Number(req.params.id));
    if (!set) throw notFound('Permission set');
    const b = setBody(req, set.id);
    db.prepare('UPDATE permission_sets SET name = ?, description = ?, permissions = ? WHERE id = ?').run(b.name, b.description, JSON.stringify(b.permissions), set.id);
    if (!set.built_in) syncRoles(set.id, b.permissions);
    res.json({ ...setById.get(set.id), permissions: b.permissions });
  });

  router.delete('/permission-sets/:id', requireAdmin, (req, res) => {
    const set = setById.get(Number(req.params.id));
    if (!set) throw notFound('Permission set');
    if (set.built_in) throw badRequest(`${set.name} is built in and can’t be deleted, but you can change what it allows`);
    const n = db.prepare('SELECT COUNT(*) AS n FROM users WHERE permission_set_id = ?').get(set.id).n;
    if (n) throw badRequest(`${n} ${n === 1 ? 'person uses' : 'people use'} this set. Give them a different one on the Staff page first.`);
    db.prepare('DELETE FROM permission_sets WHERE id = ?').run(set.id);
    res.json({ ok: true });
  });
}
