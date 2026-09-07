import express from 'express';
import type { Request } from 'express';

import { conversationGroupsService } from '@/modules/conversation-groups/conversation-groups.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/index.js';
import type { ConversationGroupPageOptions, LLMProvider } from '@/shared/index.js';

function invalid(message: string): never {
  throw new AppError(message, { code: 'INVALID_GROUP_INPUT', statusCode: 400 });
}

function userId(request: Request): number {
  const user = (request as Request & { user?: { id?: unknown } }).user;
  const id = typeof user?.id === 'number' ? user.id : typeof user?.id === 'string' && /^\d+$/.test(user.id) ? Number(user.id) : NaN;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new AppError('Authenticated user is required.', { code: 'AUTHENTICATION_REQUIRED', statusCode: 401 });
  }
  return id;
}

function body(request: Request): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) invalid('Request body must be an object.');
  return request.body as Record<string, unknown>;
}

function groupId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)) invalid('Invalid group id.');
  return value;
}

function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,120}$/.test(value)) invalid('Invalid session id.');
  return value;
}

function name(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    invalid('Group name must contain 1–80 characters without control characters.');
  }
  return value.trim();
}

function page(request: Request): ConversationGroupPageOptions {
  function integer(value: unknown, fallback: number, minimum: number, maximum: number) {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) invalid('Invalid pagination.');
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) invalid('Invalid pagination.');
    return parsed;
  }
  const query = request.query.query ?? '';
  if (typeof query !== 'string' || query.length > 200 || query.includes('\0')) invalid('Search query must be at most 200 characters.');
  return { limit: integer(request.query.limit, 40, 1, 100), offset: integer(request.query.offset, 0, 0, 1_000_000), query: query.trim() };
}

/** Used by the application and route tests to expose authenticated, user-owned conversation groups. */
export function createConversationGroupsRouter(service = conversationGroupsService) {
  const router = express.Router();
  router.get('/', asyncHandler(async (req, res) => res.json(createApiSuccessResponse(service.list(userId(req))))));
  router.post('/', asyncHandler(async (req, res) => {
    const group = service.create(userId(req), name(body(req).name));
    res.status(201).json(createApiSuccessResponse({ group }));
  }));
  router.put('/sessions/:sessionId', asyncHandler(async (req, res) => {
    const input = body(req).groupId;
    service.setMembership(userId(req), sessionId(req.params.sessionId), input === null ? null : groupId(input));
    res.json(createApiSuccessResponse({}));
  }));
  router.get('/:id/sessions', asyncHandler(async (req, res) => {
    res.json(createApiSuccessResponse(service.members(userId(req), groupId(req.params.id), page(req))));
  }));
  router.post('/:id/sessions', asyncHandler(async (req, res) => {
    const input = body(req);
    const provider = input.provider;
    if (provider !== 'claude' && provider !== 'codex' && provider !== 'cursor' && provider !== 'opencode') invalid('Unsupported provider.');
    if (typeof input.projectPath !== 'string' || !input.projectPath.trim() || input.projectPath.length > 4096 || input.projectPath.includes('\0')) {
      invalid('projectPath must identify an existing project directory.');
    }
    const session = await service.createSession(userId(req), groupId(req.params.id), provider as LLMProvider, input.projectPath.trim());
    res.status(201).json(createApiSuccessResponse(session));
  }));
  router.patch('/:id', asyncHandler(async (req, res) => {
    const group = service.rename(userId(req), groupId(req.params.id), name(body(req).name));
    res.json(createApiSuccessResponse({ group }));
  }));
  router.delete('/:id', asyncHandler(async (req, res) => {
    service.delete(userId(req), groupId(req.params.id));
    res.json(createApiSuccessResponse({}));
  }));
  return router;
}
