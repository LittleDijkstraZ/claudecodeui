import express from 'express';

import { AppError, asyncHandler } from '@/shared/index.js';

import { mcpAuthService } from './mcp-auth.module.js';

/** Mounted behind the existing remote JWT middleware; every attempt is also bound to its initiating user. */
export function createMcpAuthRouter(service = mcpAuthService) {
  const router = express.Router();
  const owner = (req: express.Request) => {
    const id = Number((req as express.Request & { user?: { id?: unknown } }).user?.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new AppError('Authentication required.', { statusCode: 401 });
    return id;
  };
  const id = (req: express.Request) => String(req.params.id);
  router.post('/attempts', asyncHandler(async (req, res) => { res.status(201).json(await service.start(owner(req), req.body)); }));
  router.get('/attempts/:id', asyncHandler(async (req, res) => { res.json(service.read(owner(req), id(req))); }));
  router.post('/attempts/:id/callback', asyncHandler(async (req, res) => { res.json(service.callback(owner(req), id(req), req.body?.callbackUrl)); }));
  router.delete('/attempts/:id', asyncHandler(async (req, res) => { res.json(service.cancel(owner(req), id(req))); }));
  return router;
}
