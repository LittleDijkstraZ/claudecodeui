import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createCommandsRouter } from '../commands.routes.js';

// Fixed metadata adapter: no runtime, filesystem contents, credentials or model transport is involved.
const compact = { name: '/compact', description: 'Compact remote context', type: 'native', namespace: 'native', metadata: { availability: 'documented', type: 'documented', argumentHint: '[focus]' } };
async function withRouter(run: (request: (endpoint: string, body: unknown) => Promise<{ status: number; body: Record<string, any> }>, calls: unknown[]) => Promise<void>) {
  const calls: unknown[] = [];
  const router = createCommandsRouter({
    fileSystem: { access: async () => { throw Object.assign(new Error('Fixture directory absent'), { code: 'ENOENT' }); } } as never,
    homeDirectory: () => '/fixture/home', appRoot: '/fixture/app', models: {} as never,
    nativeCommands: { list: (projectPath, sessionId) => { calls.push([projectPath, sessionId]); return { native: [compact], unavailable: [{ name: '/clear', reason: 'Use New Conversation; native identity changes are not integrated.' }], source: 'documentation' }; } },
    runtime: { uptime: () => 0, memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }), version: 'fixture', platform: 'linux', pid: 1 },
  });
  const server = express().use(express.json()).use('/commands', router).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(async (endpoint, body) => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/commands/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    }, calls);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('listing retains UI built-ins and exposes native commands only for the requested Claude session', async () => withRouter(async (request, calls) => {
  const claude = await request('list', { projectPath: '/remote/project', sessionId: 'app-session', provider: 'claude' });
  assert.equal(claude.status, 200); assert.deepEqual(claude.body.native, [compact]);
  assert.ok(claude.body.builtIn.some((command: { name: string }) => command.name === '/help'));
  assert.deepEqual(calls, [['/remote/project', 'app-session']]);
  const codex = await request('list', { projectPath: '/remote/project', sessionId: 'other', provider: 'codex' });
  assert.equal(codex.body.native, undefined); assert.equal(calls.length, 1);
}));

test('native execution endpoint prepares exact input only; session-changing commands explain the supported UI alternative', async () => withRouter(async request => {
  const prepared = await request('execute', { commandName: '/compact', args: ['keep', 'research context'], context: { projectPath: '/remote/project', sessionId: 'app-session', provider: 'claude' } });
  assert.equal(prepared.status, 200); assert.deepEqual(prepared.body, { type: 'native', command: '/compact', content: '/compact keep research context' });
  const blocked = await request('execute', { commandName: '/clear', context: { provider: 'claude' } });
  assert.equal(blocked.status, 400); assert.match(blocked.body.error, /New Conversation/);
  const help = await request('execute', { commandName: '/help', context: { provider: 'claude' } });
  assert.match(help.body.data.content, /Native Remote Commands/);
  assert.match(help.body.data.content, /does not erase spent tokens/);
}));
