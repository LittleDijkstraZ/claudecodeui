import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import { createClaudeSessionActionsRouter } from '@/modules/claude-session-actions/claude-session-actions.routes.js';
import type { claudeSessionActionsService } from '@/modules/claude-session-actions/claude-session-actions.service.js';
import { AppError } from '@/shared/index.js';

test('routes validate action shape and bind previews to the authenticated user', async () => {
  const calls: unknown[][] = [];
  const service = {
    capabilities: async (...args: unknown[]) => { calls.push(['capabilities', ...args]); return {}; },
    fork: async (...args: unknown[]) => { calls.push(['fork', ...args]); return { sessionId: 'new-branch' }; },
    preview: async (...args: unknown[]) => { calls.push(['preview', ...args]); return { previewToken: 'preview-one' }; },
    rewind: async (...args: unknown[]) => { calls.push(['rewind', ...args]); return { contextChanged: true }; },
  } as unknown as typeof claudeSessionActionsService;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as Request & { user: { id: number } }).user = { id: 7 }; next(); });
  app.use('/api/claude-sessions', createClaudeSessionActionsRouter(service, async (id, question, signal) => { calls.push(['btw', id, question, signal instanceof AbortSignal]); return { answer: 'side answer' }; }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ error: String(error) });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/claude-sessions/app-one`;
  const post = (suffix: string, data: unknown) => fetch(`${base}${suffix}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  try {
    assert.equal((await post('/btw', { question: '  side question  ' })).status, 200);
    assert.deepEqual(calls.pop(), ['btw', 'app-one', 'side question', true]);
    assert.equal((await post('/fork', { title: '  Side discussion  ', messageId: 'message_text_0' })).status, 201);
    assert.deepEqual(calls.pop(), ['fork', 'app-one', { title: 'Side discussion', messageId: 'message_text_0' }]);
    assert.equal((await post('/rewind/preview', { messageId: 'message', mode: 'files' })).status, 200);
    assert.deepEqual(calls.pop(), ['preview', 7, 'app-one', { messageId: 'message', mode: 'files' }]);
    assert.equal((await post('/rewind', { messageId: 'message', mode: 'both', previewToken: 'preview-one' })).status, 200);
    assert.deepEqual(calls.pop(), ['rewind', 7, 'app-one', { messageId: 'message', mode: 'both', previewToken: 'preview-one' }]);
    for (const [suffix, input] of [
      ['/btw', { question: '' }], ['/btw', { question: 'x'.repeat(16001) }], ['/btw', { question: 'hello', sessionId: 'other' }], ['/btw', { question: 1 }],
      ['/fork', []], ['/fork', { title: 'bad\u0000title' }], ['/fork', { unexpected: true }],
      ['/rewind', { messageId: 'message', mode: 'conversation' }],
      ['/rewind/preview', { messageId: '../other', mode: 'files' }],
      ['/rewind/preview', { messageId: 'message', mode: 'all' }],
      ['/rewind/preview', { messageId: 'message', mode: 'files', userId: 2 }],
    ] as const) assert.equal((await post(suffix, input)).status, 400);
    assert.deepEqual(calls, []);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
