// Removing sites that aren't linked to Square and staff who aren't in the Square team, e.g. the demo data
// left over once a real Square account is connected. Always previewed first; a backup of the database file
// is written before anything is deleted.
import { tx } from './db.js';
import { HttpError } from './util.js';

// Tables whose rows belong to a site and aren't removed automatically when the site is deleted.
const SITE_TABLES = ['shifts', 'safety_checks', 'wastage', 'purchase_orders', 'stock_takes'];
// Columns that record who did something; cleared (not deleted) when that person is removed.
const USER_COLUMNS = [
  ['wastage', 'recorded_by'], ['safety_checks', 'completed_by'], ['purchase_orders', 'created_by'],
  ['purchase_orders', 'received_by'], ['stock_takes', 'started_by'], ['stock_takes', 'completed_by'],
];

/** What removing unlinked sites and staff not in Square would delete. Changes nothing. */
export function planCleanup(db, { currentUserId }) {
  const linkedSites = db.prepare('SELECT id, name FROM locations WHERE square_location_id IS NOT NULL ORDER BY name').all();
  const inSquare = new Set(db.prepare('SELECT user_id FROM square_team_members WHERE user_id IS NOT NULL').all().map((r) => r.user_id));

  const count = (table, id) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE location_id = ?`).get(id).n;
  const locations = db.prepare('SELECT id, name FROM locations WHERE square_location_id IS NULL ORDER BY name').all()
    .map((l) => ({ ...l, shifts: count('shifts', l.id), checks: count('safety_checks', l.id), wastage: count('wastage', l.id), orders: count('purchase_orders', l.id) }));
  const staff = db.prepare(`SELECT u.id, u.name, u.email, u.role, u.active, l.name AS location FROM users u
    LEFT JOIN locations l ON l.id = u.location_id ORDER BY l.name, u.name`).all()
    .filter((u) => u.id !== currentUserId && !inSquare.has(u.id));

  // People who stay (they're in Square) but whose home site is going: move them to a linked site.
  const removedSites = new Set(locations.map((l) => l.id));
  const removedStaff = new Set(staff.map((u) => u.id));
  const usualSite = db.prepare(`SELECT location_id FROM timecards WHERE user_id = ? AND location_id IN (SELECT id FROM locations WHERE square_location_id IS NOT NULL)
    GROUP BY location_id ORDER BY COUNT(*) DESC LIMIT 1`);
  const moves = db.prepare('SELECT id, name, location_id FROM users WHERE location_id IS NOT NULL').all()
    .filter((u) => removedSites.has(u.location_id) && !removedStaff.has(u.id))
    .map((u) => {
      const to = usualSite.get(u.id)?.location_id ?? linkedSites[0]?.id;
      return { id: u.id, name: u.name, to_location_id: to, to_location: linkedSites.find((s) => s.id === to)?.name };
    });

  return {
    ready: linkedSites.length > 0 && inSquare.size > 0,
    linked_sites: linkedSites.map((s) => s.name),
    team_linked: inSquare.size,
    locations,
    staff,
    moves,
  };
}

/** Deletes what planCleanup lists, for the parts asked for. Returns how many sites and people were removed. */
export function applyCleanup(db, { currentUserId, removeLocations, removeStaff }) {
  const plan = planCleanup(db, { currentUserId });
  if (removeLocations && !plan.linked_sites.length) throw new HttpError(400, 'Link at least one site to Square first, or every site would be removed');
  if (removeStaff && !plan.team_linked) throw new HttpError(400, 'Import your staff from Square first (Setup → Staff), or every staff member would be removed');
  const backup = backupDatabase(db);

  tx(db, () => {
    if (removeStaff) {
      for (const u of plan.staff) {
        for (const [table, column] of USER_COLUMNS) db.prepare(`UPDATE ${table} SET ${column} = NULL WHERE ${column} = ?`).run(u.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(u.id); // shifts and sessions go with them
      }
    }
    if (removeLocations) {
      for (const m of plan.moves) db.prepare('UPDATE users SET location_id = ? WHERE id = ?').run(m.to_location_id, m.id);
      // Anyone else still based at a removed site (staff not in Square, if they're being kept) moves too.
      const fallback = db.prepare('SELECT id FROM locations WHERE square_location_id IS NOT NULL ORDER BY name').get().id;
      for (const l of plan.locations) {
        db.prepare('UPDATE users SET location_id = ? WHERE location_id = ?').run(fallback, l.id);
        for (const table of SITE_TABLES) db.prepare(`DELETE FROM ${table} WHERE location_id = ?`).run(l.id);
        db.prepare('DELETE FROM locations WHERE id = ?').run(l.id); // sales, checks set up for the site, pars etc. go with it
      }
    }
  });
  return {
    locations_removed: removeLocations ? plan.locations.length : 0,
    staff_removed: removeStaff ? plan.staff.length : 0,
    backup,
  };
}

// Copies the database file next to itself before a big delete. Returns the backup's file name, or null for an
// in-memory database.
function backupDatabase(db) {
  const file = db.prepare('PRAGMA database_list').all().find((d) => d.name === 'main')?.file;
  if (!file) return null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const target = file.replace(/(\.db)?$/, `-before-cleanup-${stamp}.db`);
  db.prepare('VACUUM INTO ?').run(target);
  return target.split(/[\\/]/).pop();
}
