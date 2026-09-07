import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import { createConversationGroupsRouter } from '@/modules/conversation-groups/conversation-groups.routes.js';
import { createConversationGroupsService } from '@/modules/conversation-groups/conversation-groups.service.js';
import { closeConnection, conversationGroupsDb, getConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';

async function fixture(run: (input: {
  directory: string;
  project: string;
  service: ReturnType<typeof createConversationGroupsService>;
}) => void | Promise<void>) {
  const previousPath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conversation-groups-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'test.db');
  // Avoid the legacy-database migration path: this file intentionally starts empty.
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  getConnection().prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'fixture-one', 'fixture');
  getConnection().prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(2, 'fixture-two', 'fixture');
  const project = path.join(directory, 'project');
  await mkdir(project);
  projectsDb.createProjectPath(project, 'Fixture project');
  const service = createConversationGroupsService({ validatePath: async requestedPath => ({ valid: true, resolvedPath: requestedPath }) });
  try { await run({ directory, project, service }); } finally {
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

test('users independently group the same cross-project sessions and cannot access each other’s groups', async () => {
  await fixture(({ project, service }) => {
    const one = service.create(1, 'Research');
    const two = service.create(2, 'Private');
    sessionsDb.createAppSession('session-one', 'claude', project, 'One');
    sessionsDb.createAppSession('session-two', 'codex', `${project}-other`, 'Two');
    service.setMembership(1, 'session-one', one.id);
    service.setMembership(1, 'session-two', one.id);
    service.setMembership(2, 'session-one', two.id);
    assert.deepEqual(service.list(1).memberships, { 'session-one': one.id, 'session-two': one.id });
    assert.deepEqual(service.list(2).memberships, { 'session-one': two.id });
    const page = service.members(1, one.id, { limit: 40, offset: 0, query: '' });
    assert.equal(page.total, 2);
    assert.equal(new Set(page.conversations.map(row => row.projectPath)).size, 2);
    for (const operation of [
      () => service.rename(2, one.id, 'Hacked'),
      () => service.delete(2, one.id),
      () => service.members(2, one.id, { limit: 40, offset: 0, query: '' }),
      () => service.setMembership(2, 'session-two', one.id),
    ]) assert.throws(operation, (error: unknown) => error instanceof AppError && error.statusCode === 404);
    assert.throws(() => conversationGroupsDb.setMembership(2, 'session-two', one.id), /FOREIGN KEY/);
  });
});

test('moving, ungrouping, deleting groups and deleting sessions preserve independent user membership semantics', async () => {
  await fixture(({ project, service }) => {
    const a = service.create(1, 'A');
    const b = service.create(1, 'B');
    const other = service.create(2, 'Other');
    sessionsDb.createAppSession('session', 'claude', project);
    service.setMembership(1, 'session', a.id);
    service.setMembership(2, 'session', other.id);
    service.setMembership(1, 'session', b.id);
    assert.equal(service.list(1).groups.find(group => group.id === a.id)?.sessionCount, 0);
    assert.equal(service.list(1).groups.find(group => group.id === b.id)?.sessionCount, 1);
    service.setMembership(1, 'session', null);
    assert.deepEqual(service.list(1).memberships, {});
    service.setMembership(1, 'session', b.id);
    service.delete(1, b.id);
    assert.ok(sessionsDb.getSessionById('session'));
    assert.equal(service.list(2).memberships.session, other.id);
    sessionsDb.deleteSessionById('session');
    assert.deepEqual(service.list(2).memberships, {});
    assert.equal(service.list(2).groups[0].sessionCount, 0);
  });
});

test('all archived members are counted and >40 results have stable, complete pagination with literal search', async () => {
  await fixture(({ project, service }) => {
    const group = service.create(1, 'Many');
    for (let i = 0; i < 47; i++) {
      const id = `session-${String(i).padStart(2, '0')}`;
      sessionsDb.createAppSession(id, i % 2 ? 'claude' : 'codex', project, i === 4 ? '100%_literal' : `Entry ${i}`);
      service.setMembership(1, id, group.id);
    }
    sessionsDb.updateSessionIsArchived('session-03', true);
    const first = service.members(1, group.id, { limit: 40, offset: 0, query: '' });
    const second = service.members(1, group.id, { limit: 40, offset: 40, query: '' });
    assert.equal(first.conversations.length, 40);
    assert.equal(first.hasMore, true);
    assert.equal(second.conversations.length, 7);
    assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.conversations, ...second.conversations].map(row => row.sessionId)).size, 47);
    assert.equal(first.conversations.find(row => row.sessionId === 'session-03')?.isArchived, true);
    assert.equal(service.list(1).groups[0].sessionCount, 47);
    assert.equal(service.members(1, group.id, { limit: 40, offset: 0, query: '%_' }).total, 1);
    assert.equal(service.members(1, group.id, { limit: 40, offset: 0, query: "' OR 1=1 --" }).total, 0);
    assert.equal(service.members(1, group.id, { limit: 40, offset: 0, query: 'Fixture project' }).total, 47);
  });
});

test('duplicate provider-row merge retains app-row membership for each user and moves other users before deletion', async () => {
  await fixture(({ project, service }) => {
    const winner = service.create(1, 'App group');
    const losing = service.create(1, 'Indexed group');
    const other = service.create(2, 'Other user');
    sessionsDb.createAppSession('app-session', 'claude', project);
    sessionsDb.createSession('native-session', 'claude', project);
    service.setMembership(1, 'app-session', winner.id);
    service.setMembership(1, 'native-session', losing.id);
    service.setMembership(2, 'native-session', other.id);
    sessionsDb.assignProviderSessionId('app-session', 'native-session');
    assert.equal(sessionsDb.getSessionById('native-session'), null);
    assert.equal(service.list(1).memberships['app-session'], winner.id);
    assert.deepEqual(service.list(2).memberships, { 'app-session': other.id });
    assert.equal(service.list(1).groups.find(group => group.id === losing.id)?.sessionCount, 0);
    assert.deepEqual(getConnection().pragma('foreign_key_check'), []);
  });
});

test('empty grouped conversation has a stable stored app ID and membership before any model call', async () => {
  await fixture(async ({ project, service }) => {
    const group = service.create(1, 'Drafts');
    const session = await service.createSession(1, group.id, 'claude', project);
    assert.equal(session.projectId, projectsDb.getProjectPath(project)?.project_id);
    const row = sessionsDb.getSessionById(session.sessionId);
    assert.ok(row);
    assert.equal(row.provider_session_id, null);
    assert.equal(row.custom_name, null);
    assert.equal(service.list(1).memberships[session.sessionId], group.id);
    assert.equal(service.members(1, group.id, { limit: 40, offset: 0, query: '' }).conversations[0].sessionTitle, 'Untitled Session');
    assert.equal(service.members(1, group.id, { limit: 40, offset: 0, query: 'Untitled' }).total, 1);
    closeConnection();
    await initializeDatabase();
    const again = createConversationGroupsService();
    assert.equal(again.list(1).memberships[session.sessionId], group.id);
  });
});

test('grouped creation rolls back the empty session if membership fails, and refuses unknown paths or deleted groups', async () => {
  await fixture(async ({ directory, project, service }) => {
    const group = service.create(1, 'Atomic');
    const fail = createConversationGroupsService({
      validatePath: async resolvedPath => ({ valid: true, resolvedPath }),
      groups: { ...conversationGroupsDb, setMembership() { throw new Error('Fixture storage failure'); } },
    });
    await assert.rejects(fail.createSession(1, group.id, 'claude', project), /Fixture storage failure/);
    assert.equal(sessionsDb.getAllSessions().length, 0);
    await assert.rejects(service.createSession(1, group.id, 'claude', path.join(directory, 'missing')), (error: unknown) => error instanceof AppError && error.statusCode === 404);
    const invalidPath = createConversationGroupsService({ validatePath: async () => ({ valid: false, error: 'Fixture policy' }) });
    await assert.rejects(invalidPath.createSession(1, group.id, 'claude', project), (error: unknown) => error instanceof AppError && error.statusCode === 400);
    const raced = createConversationGroupsService({ validatePath: async resolvedPath => {
      service.delete(1, group.id);
      return { valid: true, resolvedPath };
    } });
    await assert.rejects(raced.createSession(1, group.id, 'claude', project), (error: unknown) => error instanceof AppError && error.statusCode === 404);
    assert.equal(sessionsDb.getAllSessions().length, 0);
  });
});

test('HTTP contract validates input and authentication and supports the complete group lifecycle', async () => {
  await fixture(async ({ project, service }) => {
    const app = express().use(express.json());
    app.use((req, _res, next) => {
      const id = req.headers['x-fixture-user'];
      if (typeof id === 'string') (req as Request & { user?: { id: number } }).user = { id: Number(id) };
      next();
    });
    app.use('/api/conversation-groups', createConversationGroupsRouter(service));
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(error instanceof AppError ? error.statusCode : 500).json({ success: false, message: error instanceof Error ? error.message : 'error' });
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/conversation-groups`;
    const request = (suffix: string, method = 'GET', body?: unknown, user: string | null = '1') => fetch(url + suffix, {
      method, headers: { 'content-type': 'application/json', ...(user ? { 'x-fixture-user': user } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    try {
      assert.equal((await request('', 'GET', undefined, null)).status, 401);
      for (const input of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(81) }, { name: 'x\ny' }, { name: 4 }, []]) {
        assert.equal((await request('', 'POST', input)).status, 400);
      }
      const created = await request('', 'POST', { name: '  Reading  ' });
      assert.equal(created.status, 201);
      const { data: { group } } = await created.json() as { data: { group: { id: string; name: string } } };
      assert.equal(group.name, 'Reading');
      assert.equal((await request(`/${group.id}`, 'PATCH', { name: 'Renamed' }, '2')).status, 404);
      assert.equal((await request(`/${group.id}`, 'PATCH', { name: 'Renamed' })).status, 200);
      assert.equal((await request('/bad-id', 'DELETE')).status, 400);
      assert.equal((await request('/00000000-0000-0000-0000-000000000000', 'DELETE')).status, 404);
      for (const query of ['limit=0', 'limit=101', 'offset=-1', 'limit=1.5', 'offset=1000001', 'query=' + 'x'.repeat(201), 'query=a&query=b']) {
        assert.equal((await request(`/${group.id}/sessions?${query}`)).status, 400);
      }
      for (const input of [{}, { provider: 'invalid', projectPath: project }, { provider: 'claude', projectPath: '' }]) {
        assert.equal((await request(`/${group.id}/sessions`, 'POST', input)).status, 400);
      }
      const sessionResponse = await request(`/${group.id}/sessions`, 'POST', { provider: 'claude', projectPath: project });
      assert.equal(sessionResponse.status, 201);
      const session = (await sessionResponse.json() as { data: { sessionId: string; projectId: string } }).data;
      assert.ok(session.projectId);
      const listing = await (await request(`/${group.id}/sessions`)).json() as { success: boolean; data: { total: number; conversations: Array<{ sessionId: string }> } };
      assert.equal(listing.success, true);
      assert.equal(listing.data.total, 1);
      assert.equal(listing.data.conversations[0].sessionId, session.sessionId);
      assert.equal((await request(`/sessions/${session.sessionId}`, 'PUT', {})).status, 400);
      assert.equal((await request('/sessions/missing', 'PUT', { groupId: group.id })).status, 404);
      assert.equal((await request(`/sessions/${session.sessionId}`, 'PUT', { groupId: null })).status, 200);
      assert.equal((await request(`/${group.id}`, 'DELETE')).status, 200);
      assert.ok(sessionsDb.getSessionById(session.sessionId));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
