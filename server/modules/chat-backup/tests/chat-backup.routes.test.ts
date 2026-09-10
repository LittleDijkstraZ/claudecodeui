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

test('inventory route validates and separates complete ID batches from keyset pages', async () => {
  const calls: unknown[] = [];
  const result = { sessions: [], nextCursor: null, missingSessionIds: [] };
  const router = createChatBackupRouter({ inventory: async (input: unknown) => { calls.push(input); return result; } } as unknown as ReturnType<typeof createChatBackupService>);
  const request = (body: unknown) => new Promise((resolve, reject) => {
    router({ method: 'POST', url: '/inventory', headers: {}, body } as Request,
      { json: resolve } as unknown as Response, error => reject(error || new Error('Route did not respond.')));
  });
  assert.deepEqual(await request({}), { success: true, data: result });
  await request({ cursor: 'previous-id', limit: 500 });
  await request({ sessionIds: ['one', 'one', 'two'] });
  await request({ sessionIds: [] });
  assert.deepEqual(calls, [{ cursor: undefined, limit: 100 }, { cursor: 'previous-id', limit: 500 }, { sessionIds: ['one', 'two'] }, { sessionIds: [] }]);
  for (const body of [null, [], { unexpected: true }, { sessionIds: null }, { sessionIds: ['/etc'] },
    { sessionIds: Array(501).fill('one') }, { sessionIds: ['one'], cursor: 'a' }, { sessionIds: [], limit: 100 },
    { cursor: '' }, { cursor: '../bad/path' }, { limit: 0 }, { limit: 501 }, { limit: 1.5 }, { limit: '100' }]) {
    await assert.rejects(request(body), { code: 'BACKUP_INVENTORY_INVALID', statusCode: 400 });
  }
  assert.equal(calls.length, 4);
});
