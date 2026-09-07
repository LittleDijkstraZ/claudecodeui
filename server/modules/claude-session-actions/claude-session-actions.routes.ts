import express from 'express';
import type { Request } from 'express';

import { claudeSessionActionsService } from '@/modules/claude-session-actions/claude-session-actions.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/index.js';
import type { ClaudeSessionRewindMode } from '@/shared/index.js';

function invalid(message: string): never { throw new AppError(message, { code: 'INVALID_CLAUDE_SESSION_ACTION', statusCode: 400 }); }
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,160}$/.test(value)) invalid('Invalid session or message id.');
  return value;
}
function userId(request: Request): number {
  const id = Number((request as Request & { user?: { id?: unknown } }).user?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('Authentication required.', { code: 'AUTHENTICATION_REQUIRED', statusCode: 401 });
  return id;
}
function body(request: Request, fields: string[]): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) invalid('Expected an object.');
  if (Object.keys(request.body).some(key => !fields.includes(key))) invalid('Unexpected action field.');
  return request.body;
}
function rewindInput(request: Request) {
  const value = body(request, ['messageId', 'mode', 'previewToken']);
  if (value.mode !== 'conversation' && value.mode !== 'files' && value.mode !== 'both') invalid('Choose conversation, files, or both.');
  return { messageId: identifier(value.messageId), mode: value.mode as ClaudeSessionRewindMode };
}

/** Used by the server and route tests to expose authenticated actions on this remote's Claude sessions. */
export function createClaudeSessionActionsRouter(service = claudeSessionActionsService) {
  const router = express.Router();
  router.get('/:id/capabilities', asyncHandler(async (req, res) => {
    userId(req);
    res.json(createApiSuccessResponse(await service.capabilities(identifier(req.params.id))));
  }));
  router.post('/:id/fork', asyncHandler(async (req, res) => {
    userId(req);
    const input = body(req, ['messageId', 'title']);
    let title: string | undefined;
    if (input.title !== undefined) {
      if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120 || /[\u0000-\u001f\u007f]/.test(input.title)) invalid('Title must contain 1–120 characters.');
      title = input.title.trim();
    }
    const result = await service.fork(identifier(req.params.id), { messageId: input.messageId === undefined ? undefined : identifier(input.messageId), title });
    res.status(201).json(createApiSuccessResponse(result));
  }));
  router.post('/:id/rewind/preview', asyncHandler(async (req, res) => {
    res.json(createApiSuccessResponse(await service.preview(userId(req), identifier(req.params.id), rewindInput(req))));
  }));
  router.post('/:id/rewind', asyncHandler(async (req, res) => {
    const input = rewindInput(req);
    res.json(createApiSuccessResponse(await service.rewind(userId(req), identifier(req.params.id), {
      ...input, previewToken: identifier(req.body.previewToken),
    })));
  }));
  return router;
}
