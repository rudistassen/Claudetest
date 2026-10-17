// Compliance, beyond the food safety checks: risk assessments (Risk Management), incidents – accidents, near misses,
// complaints and the like – (Incident Management), and compliance documents such as certificates, inspection reports
// and insurance, with their expiry dates (Admin → Documents).
import { can, requirePerm } from '../auth.js';
import { tx } from '../db.js';
import { badRequest, bool, forbidden, id, notFound, num, oneOf, str, date, time, today, addDays } from '../util.js';
import { notify, peopleWith } from '../push.js';

export const RISK_CATEGORIES = ['Food safety', 'Fire', 'Health & safety', 'Manual handling', 'COSHH (chemicals)', 'Equipment', 'Customers & public', 'Staff welfare', 'Other'];
export const INCIDENT_KINDS = {
  accident: 'Accident or injury',
  near_miss: 'Near miss',
  illness: 'Suspected food illness',
  allergen: 'Allergen incident',
  complaint: 'Customer complaint',
  pest: 'Pest sighting',
  security: 'Theft or security',
  damage: 'Damage or breakdown',
  other: 'Something else',
};
const INCIDENT_STATUSES = ['open', 'investigating', 'closed'];
export const DOC_CATEGORIES = {
  certificate: 'Certificates (gas, electrical, PAT, fire…)',
  inspection: 'Inspections and audits (EHO, food hygiene rating)',
  insurance: 'Insurance',
  licence: 'Licences (premises, music, pavement)',
  risk: 'Risk assessments and plans',
  training: 'Training records',
  other: 'Other',
};
export const MAX_COMPLIANCE_DOC_BYTES = 20 * 1024 * 1024;
const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain'];
const BY_EXTENSION = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.doc': 'application/msword',
  '.docx': FILE_TYPES[4], '.xls': 'application/vnd.ms-excel', '.xlsx': FILE_TYPES[6], '.txt': 'text/plain' };
// Documents due to run out within this many days are flagged.
const EXPIRING_DAYS = 30;

const realBuffer = typeof Buffer !== 'undefined' && typeof Buffer.isBuffer === 'function';
const fromBase64 = (b64) => (realBuffer ? Buffer.from(b64, 'base64') : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
const asBody = (bytes) => (realBuffer ? Buffer.from(bytes) : bytes);

export function registerComplianceRoutes(router, db) {
  // Things for every site (no site) are seen by everyone; a site's own by people who work there.
  const visible = (req, row) => row.location_id === null || req.user.site_ids.includes(row.location_id);
  // A site from the request: one they work with, or none ("every site") – which only people with every site can choose.
  const siteFor = (req, raw, { allowAll = true } = {}) => {
    const s = raw === '' || raw === null || raw === undefined || raw === 'all' ? null : id(raw, 'location_id');
    if (s === null) {
      if (!allowAll) throw badRequest('Choose the site');
      if (req.user.role !== 'admin' && !req.user.all_sites) throw forbidden('Only people who work with every site can choose every site – pick a site');
      return null;
    }
    if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(s)) throw notFound('Location');
    if (!req.user.site_ids.includes(s)) throw forbidden('You do not have access to this location');
    return s;
  };
  const siteFilter = (req, rows) => {
    const want = req.query.location_id ? Number(req.query.location_id) : null;
    return rows.filter((r) => visible(req, r) && (!want || r.location_id === want || r.location_id === null));
  };

  // --- Risk Management ---

  const RISK_SELECT = `SELECT r.*, l.name AS location_name, o.name AS owner_name, u.name AS updated_by_name FROM risk_assessments r
    LEFT JOIN locations l ON l.id = r.location_id LEFT JOIN users o ON o.id = r.owner_id LEFT JOIN users u ON u.id = r.updated_by`;
  const shapeRisk = (r) => {
    const score = r.likelihood * r.severity;
    return { ...r, score, rating: score >= 15 ? 'high' : score >= 8 ? 'medium' : 'low', review_due: !!r.review_on && r.review_on <= today() };
  };

  router.get('/risks', requirePerm('risk.view', 'risk.manage'), (req, res) => {
    const rows = siteFilter(req, db.prepare(`${RISK_SELECT} WHERE r.archived = 0 ORDER BY r.category, r.title`).all()).map(shapeRisk);
    const manage = can(req.user, 'risk.manage');
    // Who can own a risk assessment: people at their sites.
    const people = manage && req.user.site_ids.length ? db.prepare(`SELECT id, name FROM users WHERE active = 1 AND (role = 'admin' OR location_id IN (${req.user.site_ids.map(() => '?').join(',')})) ORDER BY name`).all(...req.user.site_ids) : [];
    res.json({ risks: rows, categories: RISK_CATEGORIES, can_manage: manage, people });
  });

  const riskBody = (req) => {
    const b = req.body ?? {};
    const owner = b.owner_id ? id(b.owner_id, 'owner_id') : null;
    if (owner && !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(owner)) throw notFound('Person');
    return {
      location_id: siteFor(req, b.location_id),
      title: str(b.title, 'What the risk assessment covers', { required: true, max: 150 }),
      category: oneOf(b.category, 'category', RISK_CATEGORIES) ?? 'Other',
      hazards: str(b.hazards, 'The hazards', { required: true, max: 4000 }),
      who_at_risk: str(b.who_at_risk, 'Who might be harmed', { max: 1000 }),
      controls: str(b.controls, 'What you do to control it', { required: true, max: 4000 }),
      further_action: str(b.further_action, 'Anything more to do', { max: 4000 }),
      likelihood: num(b.likelihood, 'likelihood', { required: true, int: true, min: 1, max: 5 }),
      severity: num(b.severity, 'severity', { required: true, int: true, min: 1, max: 5 }),
      owner_id: owner,
      review_on: date(b.review_on, 'review_on') ?? addDays(today(), 365),
    };
  };
  const loadRisk = (req) => {
    const r = db.prepare(`${RISK_SELECT} WHERE r.id = ?`).get(Number(req.params.id));
    if (!r || !visible(req, r)) throw notFound('Risk assessment');
    return r;
  };

  router.post('/risks', requirePerm('risk.manage'), (req, res) => {
    const r = riskBody(req);
    const out = db.prepare(`INSERT INTO risk_assessments (location_id, title, category, hazards, who_at_risk, controls, further_action, likelihood, severity, owner_id, review_on, created_by, updated_by, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(r.location_id, r.title, r.category, r.hazards, r.who_at_risk, r.controls, r.further_action,
      r.likelihood, r.severity, r.owner_id, r.review_on, req.user.id, req.user.id);
    res.status(201).json(shapeRisk(db.prepare(`${RISK_SELECT} WHERE r.id = ?`).get(out.lastInsertRowid)));
  });

  router.put('/risks/:id', requirePerm('risk.manage'), (req, res) => {
    const old = loadRisk(req);
    const r = riskBody(req);
    db.prepare(`UPDATE risk_assessments SET location_id = ?, title = ?, category = ?, hazards = ?, who_at_risk = ?, controls = ?, further_action = ?, likelihood = ?, severity = ?,
      owner_id = ?, review_on = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`).run(r.location_id, r.title, r.category, r.hazards, r.who_at_risk, r.controls,
      r.further_action, r.likelihood, r.severity, r.owner_id, r.review_on, req.user.id, old.id);
    res.json(shapeRisk(db.prepare(`${RISK_SELECT} WHERE r.id = ?`).get(old.id)));
  });

  // Reviewed and still right: sets the next review a year on (or to the date given).
  router.post('/risks/:id/reviewed', requirePerm('risk.manage'), (req, res) => {
    const old = loadRisk(req);
    const next = date(req.body?.review_on, 'review_on') ?? addDays(today(), 365);
    db.prepare(`UPDATE risk_assessments SET review_on = ?, reviewed_at = datetime('now'), updated_by = ? WHERE id = ?`).run(next, req.user.id, old.id);
    res.json(shapeRisk(db.prepare(`${RISK_SELECT} WHERE r.id = ?`).get(old.id)));
  });

  router.delete('/risks/:id', requirePerm('risk.manage'), (req, res) => {
    db.prepare(`UPDATE risk_assessments SET archived = 1, updated_by = ?, updated_at = datetime('now') WHERE id = ?`).run(req.user.id, loadRisk(req).id);
    res.json({ ok: true });
  });

  // --- Incident Management ---

  const INCIDENT_SELECT = `SELECT i.*, l.name AS location_name, u.name AS reported_by_name, c.name AS closed_by_name FROM incidents i
    LEFT JOIN locations l ON l.id = i.location_id LEFT JOIN users u ON u.id = i.reported_by LEFT JOIN users c ON c.id = i.closed_by`;
  const managesIncidents = (req) => can(req.user, 'incidents.manage');
  // People who deal with incidents see every one at their sites; everyone else sees the ones they reported.
  const seesIncident = (req, i) => (managesIncidents(req) && req.user.site_ids.includes(i.location_id)) || i.reported_by === req.user.id;
  const loadIncident = (req) => {
    const i = db.prepare(`${INCIDENT_SELECT} WHERE i.id = ?`).get(Number(req.params.id));
    if (!i || !seesIncident(req, i)) throw notFound('Incident');
    return i;
  };

  router.get('/incidents', requirePerm('incidents.report', 'incidents.manage'), (req, res) => {
    const status = oneOf(req.query.status ?? 'active', 'status', ['active', 'closed', 'all']);
    const site = req.query.location_id ? Number(req.query.location_id) : null;
    const rows = db.prepare(`${INCIDENT_SELECT} ORDER BY i.occurred_on DESC, i.occurred_at DESC, i.id DESC`).all()
      .filter((i) => seesIncident(req, i) && (!site || i.location_id === site)
        && (status === 'all' || (status === 'closed' ? i.status === 'closed' : i.status !== 'closed')));
    res.json({ incidents: rows, kinds: INCIDENT_KINDS, can_manage: managesIncidents(req) });
  });

  router.get('/incidents/:id', requirePerm('incidents.report', 'incidents.manage'), (req, res) => {
    const i = loadIncident(req);
    const notes = db.prepare(`SELECT n.id, n.body, n.created_at, u.name AS author FROM incident_notes n LEFT JOIN users u ON u.id = n.user_id
      WHERE n.incident_id = ? ORDER BY n.id`).all(i.id);
    res.json({ incident: i, notes, kinds: INCIDENT_KINDS, can_manage: managesIncidents(req) && req.user.site_ids.includes(i.location_id) });
  });

  const incidentBody = (req) => {
    const b = req.body ?? {};
    const kind = oneOf(b.kind, 'kind', Object.keys(INCIDENT_KINDS), { required: true });
    const occurredOn = date(b.occurred_on, 'occurred_on', { required: true });
    if (occurredOn > today()) throw badRequest('The date can’t be in the future');
    return {
      location_id: siteFor(req, b.location_id, { allowAll: false }),
      kind,
      occurred_on: occurredOn,
      occurred_at: time(b.occurred_at, 'occurred_at'),
      title: str(b.title, 'What happened (in a few words)', { required: true, max: 150 }),
      description: str(b.description, 'What happened', { required: true, max: 6000 }),
      people_involved: str(b.people_involved, 'Who was involved', { max: 2000 }),
      injury: str(b.injury, 'Any injury', { max: 2000 }),
      action_taken: str(b.action_taken, 'What was done', { max: 4000 }),
      riddor: bool(b.riddor),
    };
  };

  router.post('/incidents', requirePerm('incidents.report', 'incidents.manage'), (req, res) => {
    const i = incidentBody(req);
    const r = db.prepare(`INSERT INTO incidents (location_id, kind, occurred_on, occurred_at, title, description, people_involved, injury, action_taken, riddor, reported_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(i.location_id, i.kind, i.occurred_on, i.occurred_at, i.title, i.description, i.people_involved, i.injury, i.action_taken, i.riddor, req.user.id);
    const saved = db.prepare(`${INCIDENT_SELECT} WHERE i.id = ?`).get(r.lastInsertRowid);
    // Whoever deals with incidents at that site hears about it straight away.
    notify(db, peopleWith(db, ['incidents.manage'], i.location_id).filter((u) => u !== req.user.id), 'incident', {
      title: `${INCIDENT_KINDS[i.kind]} at ${saved.location_name}`,
      body: `${i.title} – reported by ${req.user.name}`,
      url: `/#/compliance/incidents/${saved.id}`,
      tag: `incident-${saved.id}`,
    });
    res.status(201).json(saved);
  });

  router.put('/incidents/:id', requirePerm('incidents.manage'), (req, res) => {
    const old = loadIncident(req);
    if (!req.user.site_ids.includes(old.location_id)) throw forbidden();
    const i = incidentBody(req);
    db.prepare(`UPDATE incidents SET location_id = ?, kind = ?, occurred_on = ?, occurred_at = ?, title = ?, description = ?, people_involved = ?, injury = ?,
      action_taken = ?, riddor = ?, updated_at = datetime('now') WHERE id = ?`).run(i.location_id, i.kind, i.occurred_on, i.occurred_at, i.title, i.description,
      i.people_involved, i.injury, i.action_taken, i.riddor, old.id);
    res.json(db.prepare(`${INCIDENT_SELECT} WHERE i.id = ?`).get(old.id));
  });

  // Moves it on: { status: open | investigating | closed, outcome (when closing) }.
  router.post('/incidents/:id/status', requirePerm('incidents.manage'), (req, res) => {
    const old = loadIncident(req);
    if (!req.user.site_ids.includes(old.location_id)) throw forbidden();
    const status = oneOf(req.body?.status, 'status', INCIDENT_STATUSES, { required: true });
    const outcome = str(req.body?.outcome, 'What was the outcome', { required: status === 'closed', max: 4000 });
    tx(db, () => {
      db.prepare(`UPDATE incidents SET status = ?, outcome = COALESCE(?, outcome), closed_by = ?, closed_at = ${status === 'closed' ? "datetime('now')" : 'NULL'}, updated_at = datetime('now') WHERE id = ?`)
        .run(status, outcome, status === 'closed' ? req.user.id : null, old.id);
      const said = { open: 'Reopened', investigating: 'Marked as being investigated', closed: `Closed${outcome ? `: ${outcome}` : ''}` }[status];
      db.prepare('INSERT INTO incident_notes (incident_id, user_id, body) VALUES (?, ?, ?)').run(old.id, req.user.id, said);
    });
    res.json(db.prepare(`${INCIDENT_SELECT} WHERE i.id = ?`).get(old.id));
  });

  // A note on what's happening (calls made, follow-ups, what was found). Whoever reported it can add one too.
  router.post('/incidents/:id/notes', requirePerm('incidents.report', 'incidents.manage'), (req, res) => {
    const i = loadIncident(req);
    const body = str(req.body?.body, 'The note', { required: true, max: 4000 });
    db.prepare('INSERT INTO incident_notes (incident_id, user_id, body) VALUES (?, ?, ?)').run(i.id, req.user.id, body);
    res.status(201).json({ ok: true });
  });

  // --- Compliance documents ---

  const DOC_COLS = 'd.id, d.location_id, d.title, d.category, d.file_name, d.file_type, d.size, d.issued_on, d.expires_on, d.notes, d.created_at, d.updated_at, l.name AS location_name, u.name AS uploaded_by_name';
  const DOC_SELECT = `SELECT ${DOC_COLS} FROM compliance_documents d LEFT JOIN locations l ON l.id = d.location_id LEFT JOIN users u ON u.id = d.uploaded_by`;
  const shapeDoc = (d) => {
    const now = today();
    return { ...d, expiry: !d.expires_on ? 'none' : d.expires_on < now ? 'expired' : d.expires_on <= addDays(now, EXPIRING_DAYS) ? 'soon' : 'ok' };
  };
  const loadDoc = (req) => {
    const d = db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(Number(req.params.id));
    if (!d || !visible(req, d)) throw notFound('Document');
    return d;
  };

  router.get('/compliance-docs', requirePerm('compliance.documents'), (req, res) => {
    res.json({ documents: siteFilter(req, db.prepare(`${DOC_SELECT} ORDER BY d.expires_on IS NULL, d.expires_on, d.title`).all()).map(shapeDoc), categories: DOC_CATEGORIES });
  });

  router.get('/compliance-docs/:id/file', requirePerm('compliance.documents'), (req, res) => {
    const d = loadDoc(req);
    const data = db.prepare('SELECT data FROM compliance_documents WHERE id = ?').get(d.id).data;
    const inline = !req.query.download && /^(application\/pdf|image\/|text\/plain)/.test(d.file_type);
    res.setHeader('Content-Type', d.file_type);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${String(d.file_name).replace(/[^\w.\- ()]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(asBody(data));
  });

  const docBody = (req, existing) => {
    const b = req.body ?? {};
    const doc = {
      location_id: siteFor(req, b.location_id),
      title: str(b.title, 'Title', { required: true, max: 150 }),
      category: oneOf(b.category, 'category', Object.keys(DOC_CATEGORIES)) ?? 'other',
      issued_on: date(b.issued_on, 'issued_on'),
      expires_on: date(b.expires_on, 'expires_on'),
      notes: str(b.notes, 'Notes', { max: 2000 }),
      file: null,
    };
    if (b.data) {
      const name = str(b.file_name, 'file_name', { required: true, max: 200 });
      const type = FILE_TYPES.includes(b.media_type) ? b.media_type : BY_EXTENSION[(name.match(/\.\w+$/)?.[0] ?? '').toLowerCase()];
      if (!type) throw badRequest('Upload a PDF, Word or Excel file, a photo or a text file');
      let bytes;
      try { bytes = fromBase64(String(b.data).replace(/^data:[^,]*,/, '').replace(/\s+/g, '')); } catch { throw badRequest('The file couldn’t be read'); }
      if (!bytes.length) throw badRequest('The file is empty');
      if (bytes.length > MAX_COMPLIANCE_DOC_BYTES) throw badRequest('Documents can be up to 20 MB');
      doc.file = { name, type, bytes };
    } else if (!existing) {
      throw badRequest('Choose the file to upload');
    }
    return doc;
  };

  router.post('/compliance-docs', requirePerm('compliance.documents'), (req, res) => {
    const d = docBody(req, null);
    const r = db.prepare(`INSERT INTO compliance_documents (location_id, title, category, file_name, file_type, size, data, issued_on, expires_on, notes, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(d.location_id, d.title, d.category, d.file.name, d.file.type, d.file.bytes.length, d.file.bytes, d.issued_on, d.expires_on, d.notes, req.user.id);
    res.status(201).json(shapeDoc(db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(r.lastInsertRowid)));
  });

  router.put('/compliance-docs/:id', requirePerm('compliance.documents'), (req, res) => {
    const old = loadDoc(req);
    const d = docBody(req, old);
    tx(db, () => {
      db.prepare(`UPDATE compliance_documents SET location_id = ?, title = ?, category = ?, issued_on = ?, expires_on = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(d.location_id, d.title, d.category, d.issued_on, d.expires_on, d.notes, old.id);
      if (d.file) db.prepare('UPDATE compliance_documents SET file_name = ?, file_type = ?, size = ?, data = ?, uploaded_by = ? WHERE id = ?').run(d.file.name, d.file.type, d.file.bytes.length, d.file.bytes, req.user.id, old.id);
    });
    res.json(shapeDoc(db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(old.id)));
  });

  router.delete('/compliance-docs/:id', requirePerm('compliance.documents'), (req, res) => {
    db.prepare('DELETE FROM compliance_documents WHERE id = ?').run(loadDoc(req).id);
    res.json({ ok: true });
  });

  // For the Compliance tiles: what needs attention (reviews due, open incidents, documents running out).
  router.get('/compliance/summary', (req, res) => {
    const out = {};
    if (can(req.user, 'risk.view') || can(req.user, 'risk.manage')) {
      out.risks_due = db.prepare('SELECT location_id, review_on FROM risk_assessments WHERE archived = 0').all().filter((r) => visible(req, r) && r.review_on && r.review_on <= today()).length;
    }
    if (can(req.user, 'incidents.report') || can(req.user, 'incidents.manage')) {
      out.incidents_open = db.prepare(`SELECT location_id, reported_by FROM incidents WHERE status != 'closed'`).all().filter((i) => seesIncident(req, i)).length;
    }
    if (can(req.user, 'compliance.documents')) {
      const soon = addDays(today(), EXPIRING_DAYS);
      out.documents_expiring = db.prepare('SELECT location_id, expires_on FROM compliance_documents WHERE expires_on IS NOT NULL').all().filter((d) => visible(req, d) && d.expires_on <= soon).length;
    }
    res.json(out);
  });
}
