import assert from 'node:assert/strict';
import test from 'node:test';

import type { Request, Response } from 'express';

import { createChatBackupRouter } from '../chat-backup.routes.js';
import type { createChatBackupService } from '../chat-backup.service.js';

test('backup routes return shared envelopes and pass only selected session/destination input to services', async () => {
  const calls: unknown[] = [];
  const bundle = { format: 'cloudcli-chat-backup', version: 1 };
  const restored = { sessionId: 'restored', provider: 'claude', projectPath: '/destination', sessionName: 'Title' };
  const service = {
    exportSession: async (id: string) => { calls.push(['export', id]); return bundle; },
    restore: async (input: unknown, destination: unknown) => { calls.push(['restore', input, destination]); return restored; },
  } as unknown as ReturnType<typeof createChatBackupService>;
  const router = createChatBackupRouter(service);
  const request = (method: string, url: string, body?: unknown) => new Promise((resolve, reject) => {
    router({ method, url, headers: {}, body } as Request, { json: resolve } as unknown as Response, error => error ? reject(error) : reject(new Error('Route did not respond.')));
  });
  assert.deepEqual(await request('GET', '/sessions/session-1'), { success: true, data: bundle });
  assert.deepEqual(await request('POST', '/restore', { bundle, projectPath: '/destination', unwanted: 'ignored' }), { success: true, data: restored });
  assert.deepEqual(calls, [['export', 'session-1'], ['restore', bundle, '/destination']]);
  await assert.rejects(request('GET', '/sessions/%2Fetc%2Fpasswd'), { code: 'INVALID_SESSION_ID', statusCode: 400 });
  assert.equal(calls.length, 2);
});
