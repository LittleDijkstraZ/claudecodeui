import express from 'express';
import type { Request } from 'express';

import { claudeBtwService } from '@/modules/claude-session-actions/claude-btw.service.js';
import { claudeSessionActionsService } from '@/modules/claude-session-actions/claude-session-actions.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/index.js';
import type { ClaudeSessionRewindMode, ClaudeBtwHistoryTurn } from '@/shared/index.js';

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
function btwHistory(value: unknown): ClaudeBtwHistoryTurn[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) invalid('BTW history must contain at most 32 exchanges.');
  let characters = 0;
  return value.map(turn => {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)
      || Object.keys(turn).some(key => key !== 'question' && key !== 'response')
      || typeof turn.question !== 'string' || !turn.question.trim() || turn.question.length > 16000
      || typeof turn.response !== 'string' || !turn.response.trim()
      || turn.question.includes('\0') || turn.response.includes('\0')) invalid('Invalid BTW history exchange.');
    characters += turn.question.length + turn.response.length;
    if (characters > 64000) invalid('BTW history exceeds 64000 characters.');
    return { question: turn.question, response: turn.response };
  });
}
function rewindInput(request: Request) {
  const value = body(request, ['messageId', 'mode', 'previewToken']);
  if (value.mode !== 'conversation' && value.mode !== 'files' && value.mode !== 'both') invalid('Choose conversation, files, or both.');
  return { messageId: identifier(value.messageId), mode: value.mode as ClaudeSessionRewindMode };
}

/** Used by the server and route tests to expose authenticated actions on this remote's Claude sessions. */
export function createClaudeSessionActionsRouter(service = claudeSessionActionsService, btw = claudeBtwService) {
  const router = express.Router();
  router.get('/:id/capabilities', asyncHandler(async (req, res) => {
    userId(req);
    res.json(createApiSuccessResponse(await service.capabilities(identifier(req.params.id))));
  }));
  router.post('/:id/btw', asyncHandler(async (req, res) => {
    userId(req);
    const input = body(req, ['question', 'history']);
    if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 16000 || input.question.includes('\0')) invalid('Question must contain 1–16000 characters.');
    const history = btwHistory(input.history);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timeout = setTimeout(cancel, 120_000);
    res.on('close', cancel);
    try {
      const result = await btw(identifier(req.params.id), input.question.trim(), controller.signal, history);
      if (!res.destroyed) res.json(createApiSuccessResponse(result));
    } finally { clearTimeout(timeout); res.off('close', cancel); }
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
