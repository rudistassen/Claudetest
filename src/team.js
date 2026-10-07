// Importing Square Team members as the staff list: creates or updates a user for each team member and links
// the two, so the rota, clock-ins and staff list all refer to the same people.
import { randomBytes } from 'node:crypto';
import { hashPassword } from './auth.js';
import { tx } from './db.js';

const memberName = (m) => [m.given_name, m.family_name].filter(Boolean).join(' ') || m.email_address || 'Unnamed team member';
const validEmail = (e) => !!e && /^[^\s@]+@[^\s@]+$/.test(e);
const placeholderEmail = (m) => `square-${m.id.toLowerCase().replace(/[^a-z0-9]/g, '')}@staff.local`;

/** Fetches every Square team member plus their hourly pay (from wage settings, or the older wages endpoint). */
export async function fetchTeam(client) {
  const members = [];
  for await (const m of client.searchTeamMembers()) members.push(m);
  const wages = new Map();
  for (const m of members) {
    for (const j of m.wage_setting?.job_assignments ?? []) addWage(wages, m.id, j.job_title, j.hourly_rate);
  }
  if (!wages.size) {
    try {
      for await (const w of client.listTeamMemberWages()) addWage(wages, w.team_member_id, w.title, w.hourly_rate);
    } catch {
      // Pay rates are optional; people are still imported without them.
    }
  }
  return { members, wages };
}

function addWage(wages, memberId, title, rate) {
  if (!rate?.amount) return;
  const list = wages.get(memberId) ?? [];
  list.push({ title: title ?? null, rate: rate.amount / 100 });
  wages.set(memberId, list);
}

/**
 * Works out what importing the team would do, without changing anything.
 * Each row: { member, action: 'create' | 'update' | 'deactivate' | 'skip', user?, values?, reason? }.
 */
export function planTeamImport(db, { members, wages }, { deactivateOthers = false, currentUserId } = {}) {
  const sites = db.prepare('SELECT id, name, square_location_id FROM locations WHERE square_location_id IS NOT NULL AND active = 1 ORDER BY name').all();
  const siteBySquare = new Map(sites.map((s) => [s.square_location_id, s]));
  const activeSites = new Set(db.prepare('SELECT id FROM locations WHERE active = 1').all().map((l) => l.id));
  const linked = new Map(db.prepare('SELECT id, user_id FROM square_team_members WHERE user_id IS NOT NULL').all().map((r) => [r.id, r.user_id]));
  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const userByEmail = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE');
  const userByName = db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE');
  // The site each team member clocks in at most, for people Square assigns to every location.
  const usualSite = new Map(db.prepare(`SELECT team_member_id, location_id, COUNT(*) AS n FROM timecards
    WHERE team_member_id IS NOT NULL GROUP BY team_member_id, location_id ORDER BY n DESC`).all().reverse().map((r) => [r.team_member_id, r.location_id]));

  const claimed = new Set();
  // Emails given out by this plan so far, so two rows never end up with the same one.
  const planned = new Set();
  const emailFree = (email, userId) => {
    if (planned.has(email.toLowerCase())) return false;
    const holder = userByEmail.get(email);
    return !holder || holder.id === userId;
  };
  const current = currentUserId ? userById.get(currentUserId) : null;
  const currentLinked = current && [...linked.values()].includes(current.id);
  const rows = [];
  for (const m of members) {
    const name = memberName(m);
    const active = m.status !== 'INACTIVE';
    let user = linked.has(m.id) ? userById.get(linked.get(m.id)) : null;
    if (!user && validEmail(m.email_address)) user = userByEmail.get(m.email_address);
    if (!user) user = userByName.get(name);
    if (user && claimed.has(user.id)) user = null;
    // The Square account owner is almost always the admin running the import: link them rather than
    // creating a second admin account with the owner's email.
    if (!user && m.is_owner && current?.role === 'admin' && !currentLinked && !claimed.has(current.id)) user = current;
    if (user) claimed.add(user.id);

    if (!active) {
      rows.push(user?.active ? { member: m, name, action: 'deactivate', user } : { member: m, name, action: 'skip', user, reason: 'Inactive in Square' });
      continue;
    }

    const explicit = m.assigned_locations?.assignment_type === 'EXPLICIT_LOCATIONS'
      ? (m.assigned_locations.location_ids ?? []).map((id) => siteBySquare.get(id)).filter(Boolean)
      : [];
    const role = user?.role ?? (m.is_owner ? 'admin' : 'staff');
    // Someone already here keeps the home site set in Atlas (it can be changed on the Staff page); only new
    // people take theirs from Square.
    let locationId = null;
    if (role !== 'admin') {
      locationId = (activeSites.has(user?.location_id) ? user.location_id : null)
        ?? explicit[0]?.id
        ?? usualSite.get(m.id)
        ?? sites[0]?.id
        ?? null;
    }
    if (role !== 'admin' && !locationId) {
      rows.push({ member: m, name, action: 'skip', user, reason: 'Link your sites to Square locations first' });
      continue;
    }

    const jobs = wages.get(m.id) ?? [];
    const top = jobs.reduce((best, j) => (!best || j.rate > best.rate ? j : best), null);
    // Never change the sign-in email of the person running the import.
    let email = user?.email;
    if (validEmail(m.email_address) && user?.id !== currentUserId && emailFree(m.email_address, user?.id)) email = m.email_address;
    if (!email) {
      email = placeholderEmail(m);
      for (let n = 2; !emailFree(email, user?.id); n++) email = placeholderEmail(m).replace('@', `-${n}@`);
    }
    planned.add(email.toLowerCase());
    rows.push({
      member: m,
      name,
      action: user ? 'update' : 'create',
      user,
      values: {
        name,
        email,
        role,
        location_id: locationId,
        position: top?.title ?? user?.position ?? null,
        hourly_rate: top?.rate ?? user?.hourly_rate ?? 0,
      },
      no_email: !validEmail(m.email_address),
    });
  }

  if (deactivateOthers) {
    const keep = new Set([...claimed, currentUserId]);
    for (const u of db.prepare('SELECT * FROM users WHERE active = 1 ORDER BY name').all()) {
      if (!keep.has(u.id)) rows.push({ member: null, name: u.name, action: 'deactivate', user: u, reason: 'Not in Square' });
    }
  }
  return rows;
}

/** Applies a plan from planTeamImport. New people get a random password, so they can't sign in until one is set. */
export function applyTeamImport(db, rows, { currentUserId } = {}) {
  const counts = { created: 0, updated: 0, deactivated: 0, skipped: 0 };
  tx(db, () => {
    const link = db.prepare(`INSERT INTO square_team_members (id, name, email, user_id) VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, email = excluded.email, user_id = excluded.user_id`);
    for (const r of rows) {
      if (r.action === 'skip') {
        counts.skipped++;
        continue;
      }
      if (r.action === 'deactivate') {
        if (r.user.id === currentUserId) continue;
        db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(r.user.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(r.user.id);
        if (r.member) link.run(r.member.id, r.name, r.member.email_address ?? null, r.user.id);
        counts.deactivated++;
        continue;
      }
      const v = r.values;
      let userId = r.user?.id;
      if (userId) {
        db.prepare('UPDATE users SET name = ?, email = ?, location_id = ?, position = ?, hourly_rate = ?, active = 1 WHERE id = ?')
          .run(v.name, v.email, v.location_id, v.position, v.hourly_rate, userId);
        counts.updated++;
      } else {
        userId = Number(db.prepare(`INSERT INTO users (name, email, password_hash, role, location_id, position, hourly_rate, active)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
          .run(v.name, v.email, hashPassword(randomBytes(24).toString('hex')), v.role, v.location_id, v.position, v.hourly_rate)
          .lastInsertRowid);
        counts.created++;
      }
      link.run(r.member.id, r.name, r.member.email_address ?? null, userId);
      // Clock-ins already synced for this person now line up with their rota.
      db.prepare('UPDATE timecards SET user_id = ? WHERE team_member_id = ?').run(userId, r.member.id);
    }
  });
  return counts;
}
