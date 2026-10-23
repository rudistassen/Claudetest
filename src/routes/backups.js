// Setup → Backups (admins): the database copies Atlas keeps, making one now, and downloading any of them.
import fs from 'node:fs';
import { requireAdmin } from '../auth.js';
import { logActivity } from '../activity.js';
import { backUp, backupPath, diskUsage, listBackups } from '../backups.js';
import { notFound } from '../util.js';

export function registerBackupRoutes(router, db, backups) {
  router.get('/admin/backups', requireAdmin, (req, res) => {
    res.json(backups ? { available: true, backups: listBackups(backups.dbPath), disk: diskUsage(backups.dbPath) } : { available: false, backups: [] });
  });
  router.post('/admin/backups', requireAdmin, (req, res) => {
    if (!backups) throw notFound('Backups');
    res.status(201).json({ name: backUp(backups.dbPath, 'manual', db) });
  });
  router.get('/admin/backups/:name', requireAdmin, (req, res) => {
    const file = backups && backupPath(backups.dbPath, req.params.name);
    if (!file) throw notFound('Backup');
    logActivity(db, req, { kind: 'change', area: 'Setup', action: 'Downloaded a database backup', detail: req.params.name, path: `GET ${req.path}` });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`);
    res.setHeader('Content-Length', fs.statSync(file).size);
    fs.createReadStream(file).pipe(res);
  });
}
