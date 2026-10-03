// Setting staff up in Square from Brewly: adding someone on the Staff page can add them to the Square team too,
// and later changes (name, email, sites, pay, active) are copied across for anyone linked to a Square team
// member. Square doesn't let apps set POS passcodes or till permissions, so those stay in the Square Dashboard.
import { randomBytes } from 'node:crypto';
import { HttpError } from './util.js';

const realEmail = (e) => !!e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !/@(staff|cafe)\.local$/i.test(e);
const splitName = (name) => {
  const [given, ...rest] = String(name).trim().split(/\s+/);
  return { given_name: given, family_name: rest.join(' ') || undefined };
};
const key = () => randomBytes(16).toString('hex');

/** The Square Dashboard's team page, where passcodes and till permissions are set. */
export const squareTeamUrl = (environment) => `https://${environment === 'sandbox' ? 'squareupsandbox.com' : 'squareup.com'}/dashboard/team/team-members`;

/** Which Square team member a Brewly person is linked to, if any. */
export const linkedMember = (db, userId) => db.prepare('SELECT id FROM square_team_members WHERE user_id = ?').get(userId)?.id ?? null;

const squareLocation = (db, locationId) => db.prepare('SELECT square_location_id FROM locations WHERE id = ?').get(locationId)?.square_location_id ?? null;

/**
 * Where they work in Square. New people: their home site, plus any extra sites ticked for them (admins: every
 * location). Brewly's "all sites" is about what they can see in Brewly, not where they work, so it isn't copied.
 * People already in Square keep their locations; their home site is added if it's missing.
 */
function locationsFor(db, user, current = null) {
  if (current) {
    if (user.role === 'admin' || current.assignment_type !== 'EXPLICIT_LOCATIONS') return undefined;
    const home = squareLocation(db, user.location_id);
    const ids = current.location_ids ?? [];
    return home && !ids.includes(home) ? { assignment_type: 'EXPLICIT_LOCATIONS', location_ids: [...ids, home] } : undefined;
  }
  if (user.role === 'admin') return { assignment_type: 'ALL_CURRENT_AND_FUTURE_LOCATIONS' };
  const extra = user.all_sites ? [] : db.prepare('SELECT location_id FROM user_sites WHERE user_id = ?').all(user.id).map((r) => r.location_id);
  const square = [...new Set([user.location_id, ...extra].filter(Boolean).map((id) => squareLocation(db, id)).filter(Boolean))];
  if (!square.length) throw new HttpError(400, `${user.name}’s site isn’t linked to a Square location yet (Setup → Square)`);
  return { assignment_type: 'EXPLICIT_LOCATIONS', location_ids: square };
}

/**
 * Their pay in Square: the job Brewly's rate came from (their best-paid one) gets the new rate; other jobs
 * they have in Square are left as they are. New people get a job matching their role in Brewly.
 */
async function pushWage(client, member, user, { isNew = false } = {}) {
  if (!user.active || !(user.hourly_rate > 0)) return null;
  const amount = Math.round(user.hourly_rate * 100);
  // Read from Square first, so the jobs they already have there are never lost.
  const setting = isNew ? null : await client.getWageSetting(member.id);
  const current = setting?.job_assignments ?? [];
  const top = current.filter((j) => j.pay_type !== 'SALARY')
    .reduce((best, j) => (!best || (j.hourly_rate?.amount ?? 0) > (best.hourly_rate?.amount ?? 0) ? j : best), null);
  if (top?.hourly_rate?.amount === amount) return null;
  let assignment;
  if (top) {
    assignment = { ...(top.job_id ? { job_id: top.job_id } : { job_title: top.job_title }), pay_type: 'HOURLY', hourly_rate: { amount, currency: top.hourly_rate?.currency ?? 'GBP' } };
  } else {
    const title = (user.rota_group || user.position || 'Team member').slice(0, 150);
    const jobs = await client.listJobs();
    const job = jobs.find((j) => j.title?.toLowerCase() === title.toLowerCase()) ?? await client.createJob(title, key());
    assignment = { job_id: job.id, pay_type: 'HOURLY', hourly_rate: { amount, currency: 'GBP' } };
  }
  const others = current.filter((j) => j !== top);
  await client.updateWageSetting(member.id, {
    job_assignments: [assignment, ...others],
    ...(setting?.is_overtime_exempt !== undefined ? { is_overtime_exempt: setting.is_overtime_exempt } : {}),
    ...(setting?.version !== undefined ? { version: setting.version } : {}),
  });
  return true;
}

/**
 * Copies a person to Square. With create, someone not yet linked is linked to the Square team member with the
 * same email, or added as a new one. Returns { status: 'created' | 'linked' | 'updated' | 'not_linked' | 'owner',
 * member_id, warning? }; throws when Square refuses the change.
 */
export async function pushPersonToSquare(db, client, userId, { create = false } = {}) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new HttpError(404, 'User not found');
  let memberId = linkedMember(db, userId);
  let status = 'updated';
  let member = null;

  if (!memberId) {
    if (!create) return { status: 'not_linked', member_id: null };
    if (realEmail(user.email)) {
      for await (const m of client.searchTeamMembers()) {
        if (m.email_address?.toLowerCase() === user.email.toLowerCase()) { member = m; break; }
      }
    }
    const link = db.prepare(`INSERT INTO square_team_members (id, name, email, user_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email, user_id = excluded.user_id`);
    if (member) {
      const other = db.prepare('SELECT user_id FROM square_team_members WHERE id = ?').get(member.id)?.user_id;
      if (other && other !== userId) throw new HttpError(409, `${user.email} is already linked to someone else in Brewly`);
      link.run(member.id, user.name, member.email_address ?? null, userId);
      memberId = member.id;
      status = 'linked';
    } else {
      if (!user.active) return { status: 'not_linked', member_id: null };
      member = await client.createTeamMember({
        ...splitName(user.name),
        ...(realEmail(user.email) ? { email_address: user.email } : {}),
        reference_id: `brewly-${user.id}`,
        assigned_locations: locationsFor(db, user),
      }, key());
      link.run(member.id, user.name, member.email_address ?? null, userId);
      memberId = member.id;
      status = 'created';
    }
  }

  member ??= await client.getTeamMember(memberId);
  // Square doesn't let apps change the account owner.
  if (member.is_owner) return { status: 'owner', member_id: memberId };
  if (status !== 'created') {
    const locations = user.active ? locationsFor(db, user, member.assigned_locations) : undefined;
    member = await client.updateTeamMember(memberId, {
      ...splitName(user.name),
      ...(realEmail(user.email) ? { email_address: user.email } : {}),
      status: user.active ? 'ACTIVE' : 'INACTIVE',
      ...(locations ? { assigned_locations: locations } : {}),
    }) ?? member;
    db.prepare('UPDATE square_team_members SET name = ?, email = ? WHERE id = ?').run(user.name, member.email_address ?? null, memberId);
  }
  let warning;
  try {
    await pushWage(client, member, user, { isNew: status === 'created' });
  } catch (err) {
    warning = `Pay rate not updated in Square: ${err.message.replace(/^Square error: /, '')}`;
  }
  return { status, member_id: memberId, ...(warning ? { warning } : {}) };
}

/** Like pushPersonToSquare, but reports a refusal instead of throwing (the Brewly change is already saved). */
export async function trySquarePush(db, square, userId, opts) {
  if (!square) return null;
  try {
    return await pushPersonToSquare(db, square.client, userId, opts);
  } catch (err) {
    return { status: 'error', error: err.message.replace(/^Square error: /, '') };
  }
}
