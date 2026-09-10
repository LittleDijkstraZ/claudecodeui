import express from 'express';

import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/index.js';

import type { createChatBackupService } from './chat-backup.service.js';

/** Used by the module barrel and route tests; authentication is supplied at mount. */
export function createChatBackupRouter(service: ReturnType<typeof createChatBackupService>): express.Router {
  const router = express.Router();
  router.post('/inventory', asyncHandler(async (req, res) => {
    const input = req.body;
    const invalid = () => { throw new AppError('Invalid backup inventory selection.', { code: 'BACKUP_INVENTORY_INVALID', statusCode: 400 }); };
    const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9._-]{1,120}$/.test(id);
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['sessionIds', 'cursor', 'limit'].includes(key))) invalid();
    if (input.sessionIds !== undefined) {
      if (!Array.isArray(input.sessionIds) || input.sessionIds.length > 500 || !input.sessionIds.every(validId)
        || input.cursor !== undefined || input.limit !== undefined) invalid();
      res.json(createApiSuccessResponse(await service.inventory({ sessionIds: [...new Set<string>(input.sessionIds)] })));
    } else {
      if ((input.cursor !== undefined && !validId(input.cursor))
        || (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500))) invalid();
      res.json(createApiSuccessResponse(await service.inventory({ cursor: input.cursor, limit: input.limit ?? 100 })));
    }
  }));
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
