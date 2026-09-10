import express from 'express';

import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/index.js';

import type { createChatBackupService } from './chat-backup.service.js';

/** Used by the module barrel and route tests; authentication is supplied at mount. */
export function createChatBackupRouter(service: ReturnType<typeof createChatBackupService>): express.Router {
  const router = express.Router();
  router.get('/sessions/:sessionId', asyncHandler(async (req, res) => {
    const sessionId = req.params.sessionId;
    if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9._-]{1,120}$/.test(sessionId)) throw new AppError('Invalid session id.', { code: 'INVALID_SESSION_ID', statusCode: 400 });
    res.json(createApiSuccessResponse(await service.exportSession(sessionId)));
  }));
  router.post('/restore', asyncHandler(async (req, res) => {
    res.json(createApiSuccessResponse(await service.restore(req.body?.bundle, req.body?.projectPath)));
  }));
  return router;
}
