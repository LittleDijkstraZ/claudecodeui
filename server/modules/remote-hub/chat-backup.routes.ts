import express from 'express';

import type { createHubChatBackupStore } from './chat-backup-store.service.js';
import type { createHubChatBackupRestoreService } from './chat-backup-restore.service.js';

/** The local Hub mounts these disk-backup endpoints separately from its remote proxy.
 * Mutations require the same loopback origin and JSON transport as Hub group edits. */
export function createHubChatBackupRouter(store: ReturnType<typeof createHubChatBackupStore>, origin: string, restores?: ReturnType<typeof createHubChatBackupRestoreService>) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && (req.headers.origin !== origin || !req.is('application/json'))) { res.sendStatus(403); return; }
    next();
  });
  router.get('/', (_req, res) => res.json(store.read()));
  router.put('/settings', express.json({ limit: '2kb' }), (req, res) => {
    res.json(store.setSettings(req.body));
  });
  router.put('/', express.json({ limit: '65mb' }), (req, res) => {
    const body = req.body;
    if (!body || typeof body.remoteId !== 'string' || typeof body.remoteName !== 'string'
      || (body.sourceUpdatedAt !== null && typeof body.sourceUpdatedAt !== 'string')
      || !Number.isSafeInteger(body.settingsRevision) || (body.contentVersion !== null && typeof body.contentVersion !== 'string')) { res.status(400).json({ error: 'Invalid chat backup source' }); return; }
    res.json({ backup: store.sync({ remoteId: body.remoteId, remoteName: body.remoteName, sourceUpdatedAt: body.sourceUpdatedAt, bundle: body.bundle, settingsRevision: body.settingsRevision, contentVersion: body.contentVersion }) });
  });
  router.post('/import', express.json({ limit: '81mb' }), (req, res) => {
    if (!req.body || (req.body.remoteName !== undefined && typeof req.body.remoteName !== 'string')) { res.status(400).json({ error: 'Invalid chat backup import' }); return; }
    res.json(store.import(req.body.bundle, req.body.remoteName));
  });
  router.route('/observations').put(express.json({ limit: '9mb' }), (req, res) => res.json(store.observe(req.body)))
    .post(express.json({ limit: '9mb' }), (req, res) => res.json(store.observe(req.body)));
  router.get('/snapshots/:sourceId', (req, res) => res.json(store.getSnapshot(req.params.sourceId)));
  router.post('/snapshots/:sourceId/restore', express.json({ limit: '2kb' }), (req, res) => {
    if (!restores) { res.sendStatus(503); return; }
    res.json(restores.restoreGroups(req.params.sourceId));
  });
  router.post('/restored', express.json({ limit: '16kb' }), (req, res) => {
    if (!restores) { res.sendStatus(503); return; }
    res.json(restores.recordRestore(req.body));
  });
  router.get('/:id/export', (req, res) => res.json(store.exportBackup(req.params.id)));
  router.get('/:id', (req, res) => res.json(store.get(req.params.id)));
  router.delete('/:id', (req, res) => res.json(store.remove(req.params.id)));
  router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number') {
      res.status(error.statusCode).json({ error: error.message }); return;
    }
    next(error);
  });
  return router;
}
