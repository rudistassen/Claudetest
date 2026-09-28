import { PUBLIC_USER_FIELDS, hashPassword, requireAdmin, requireManager, validatePassword } from '../auth.js';
import { badRequest, bool, forbidden, id, notFound, num, oneOf, str } from '../util.js';

const ROLES = ['admin', 'manager', 'staff'];

export function registerAdminRoutes(router, db) {
  // --- Locations ---

  router.get('/locations', (req, res) => {
    const rows = req.user.role === 'admin'
      ? db.prepare('SELECT * FROM locations ORDER BY active DESC, name').all()
      : db.prepare('SELECT * FROM locations WHERE id = ?').all(req.user.location_id);
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

  router.get('/users', requireManager, (req, res) => {
    const locationId = req.user.role === 'admin' ? id(req.query.location_id, 'location_id') : req.user.location_id;
    const rows = locationId
      ? db.prepare(`SELECT ${PUBLIC_USER_FIELDS}, l.name AS location_name FROM users u LEFT JOIN locations l ON l.id = u.location_id WHERE u.location_id = ? ORDER BY u.active DESC, u.name`).all(locationId)
      : db.prepare(`SELECT ${PUBLIC_USER_FIELDS}, l.name AS location_name FROM users u LEFT JOIN locations l ON l.id = u.location_id ORDER BY u.active DESC, l.name, u.name`).all();
    res.json(rows);
  });

  // Checks a manager is only creating/editing staff at their own site.
  function userBody(req, existing) {
    const b = req.body;
    const u = {
      name: str(b.name, 'name', { required: true, max: 100 }),
      email: str(b.email, 'email', { required: true, max: 200 }),
      role: oneOf(b.role ?? existing?.role ?? 'staff', 'role', ROLES),
      location_id: id(b.location_id, 'location_id'),
      position: str(b.position, 'position', { max: 100 }),
      hourly_rate: num(b.hourly_rate, 'hourly_rate', { min: 0 }) ?? 0,
      active: b.active === undefined ? 1 : bool(b.active),
    };
    if (!/^[^\s@]+@[^\s@]+$/.test(u.email)) throw badRequest('email is not valid');
    if (u.role !== 'admin' && !u.location_id) throw badRequest('location_id is required for managers and staff');
    if (u.role === 'admin') u.location_id = null;
    if (req.user.role === 'manager') {
      if (u.role !== 'staff') throw forbidden('Managers can only add or edit staff');
      if (u.location_id !== req.user.location_id) throw forbidden('Managers can only manage staff at their own location');
      if (existing && (existing.role !== 'staff' || existing.location_id !== req.user.location_id)) throw forbidden();
    }
    if (u.location_id && !db.prepare('SELECT 1 FROM locations WHERE id = ?').get(u.location_id)) throw notFound('Location');
    return u;
  }

  router.post('/users', requireManager, (req, res) => {
    const u = userBody(req);
    const password = validatePassword(req.body.password);
    const r = db.prepare(`INSERT INTO users (name, email, password_hash, role, location_id, position, hourly_rate, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(u.name, u.email, hashPassword(password), u.role, u.location_id, u.position, u.hourly_rate, u.active);
    res.status(201).json(db.prepare(`SELECT ${PUBLIC_USER_FIELDS} FROM users u WHERE id = ?`).get(r.lastInsertRowid));
  });

  router.put('/users/:id', requireManager, (req, res) => {
    const userId = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!existing) throw notFound('User');
    const u = userBody(req, existing);
    if (userId === req.user.id && (u.role !== req.user.role || !u.active)) {
      throw badRequest('You cannot change your own role or deactivate yourself');
    }
    db.prepare(`UPDATE users SET name = ?, email = ?, role = ?, location_id = ?, position = ?, hourly_rate = ?, active = ? WHERE id = ?`)
      .run(u.name, u.email, u.role, u.location_id, u.position, u.hourly_rate, u.active, userId);
    if (req.body.password) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(validatePassword(req.body.password)), userId);
    }
    if (!u.active || req.body.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    res.json(db.prepare(`SELECT ${PUBLIC_USER_FIELDS} FROM users u WHERE id = ?`).get(userId));
  });
}
