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
      () => service.update(2, one.id, { name: 'Hacked' }),
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

test('pinning and renaming persist independently and remain scoped to the group owner', async () => {
  await fixture(async ({ service }) => {
    const first = service.create(1, 'First');
    const second = service.create(1, 'Second');
    const other = service.create(2, 'Other');
    assert.equal(second.isPinned, false);
    const pinned = service.update(1, second.id, { isPinned: true });
    assert.equal(pinned.isPinned, true);
    assert.equal(pinned.name, 'Second');
    assert.equal(service.update(1, second.id, { name: 'Renamed' }).isPinned, true);
    assert.deepEqual(service.list(1).groups.map(group => group.id), [second.id, first.id]);
    assert.throws(() => service.update(2, second.id, { isPinned: false }), (error: unknown) => error instanceof AppError && error.statusCode === 404);
    assert.deepEqual(service.list(2).groups, [{ ...other, isPinned: false }]);
    closeConnection();
    await initializeDatabase();
    assert.equal(service.list(1).groups[0].name, 'Renamed');
    assert.equal(service.list(1).groups[0].isPinned, true);
    const unpinned = service.update(1, second.id, { name: 'Updated together', isPinned: false });
    assert.equal(unpinned.name, 'Updated together');
    assert.equal(unpinned.isPinned, false);
    assert.deepEqual(service.list(1).groups.map(group => group.id), [first.id, second.id]);
  });
});

test('manual membership order survives activity, same-group assignment, creation, move out and return, and restart', async () => {
  await fixture(async ({ project, service }) => {
    const group = service.create(1, 'Ordered');
    const other = service.create(1, 'Other');
    const order = () => service.members(1, group.id, { limit: 40, offset: 0, query: '' }).conversations.map(row => row.sessionId);
    for (const id of ['b', 'a', 'c']) {
      sessionsDb.createAppSession(id, 'claude', project, id);
      service.setMembership(1, id, group.id);
    }
    assert.deepEqual(order(), ['b', 'a', 'c']);
    getConnection().prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run('2099-01-01', 'c');
    service.setMembership(1, 'b', group.id);
    assert.deepEqual(order(), ['b', 'a', 'c']);
    const created = await service.createSession(1, group.id, 'claude', project);
    assert.deepEqual(order(), ['b', 'a', 'c', created.sessionId]);
    service.create(1, 'Unrelated group');
    service.setMembership(1, 'a', other.id);
    service.setMembership(1, 'a', group.id);
    assert.deepEqual(order(), ['b', 'c', created.sessionId, 'a']);
    service.setMembership(1, 'c', null);
    service.setMembership(1, 'c', group.id);
    assert.deepEqual(order(), ['b', created.sessionId, 'a', 'c']);
    closeConnection();
    await initializeDatabase();
    assert.deepEqual(order(), ['b', created.sessionId, 'a', 'c']);
    assert.equal(sessionsDb.getSessionById(created.sessionId)?.provider_session_id, null);
  });
});

test('relative moves preserve all unloaded and search-hidden members with stable pagination', async () => {
  await fixture(({ project, service }) => {
    const group = service.create(1, 'Many ordered members');
    const ids = Array.from({ length: 47 }, (_, index) => `member-${String(index).padStart(2, '0')}`);
    ids.forEach((id, index) => {
      sessionsDb.createAppSession(id, 'claude', project, index === 0 || index === 46 ? 'Search visible' : `Hidden ${index}`);
      service.setMembership(1, id, group.id);
    });
    assert.deepEqual(service.members(1, group.id, { limit: 40, offset: 0, query: 'Search visible' }).conversations.map(row => row.sessionId), [ids[0], ids[46]]);
    service.moveMember(1, group.id, { sessionId: ids[46], targetSessionId: ids[0], position: 'before' });
    const pageOne = service.members(1, group.id, { limit: 40, offset: 0, query: '' });
    const pageTwo = service.members(1, group.id, { limit: 40, offset: 40, query: '' });
    assert.deepEqual([...pageOne.conversations, ...pageTwo.conversations].map(row => row.sessionId), [ids[46], ...ids.slice(0, 46)]);
    assert.equal(pageOne.hasMore, true);
    assert.equal(pageTwo.hasMore, false);
    service.moveMember(1, group.id, { sessionId: ids[0], targetSessionId: ids[45], position: 'after' });
    assert.deepEqual(service.members(1, group.id, { limit: 100, offset: 0, query: '' }).conversations.map(row => row.sessionId), [ids[46], ...ids.slice(1, 46), ids[0]]);
    assert.equal(service.members(1, group.id, { limit: 40, offset: 0, query: 'Search visible' }).total, 2);
  });
});

test('self moves are no-ops and stale or other-user anchors cannot change any ordering', async () => {
  await fixture(({ project, service }) => {
    const group = service.create(1, 'Owned');
    const another = service.create(1, 'Another');
    const otherUser = service.create(2, 'Private');
    for (const id of ['a', 'b', 'c']) sessionsDb.createAppSession(id, 'claude', project);
    service.setMembership(1, 'a', group.id);
    service.setMembership(1, 'b', group.id);
    service.setMembership(1, 'c', another.id);
    service.setMembership(2, 'a', otherUser.id);
    service.setMembership(2, 'b', otherUser.id);
    const before = getConnection().prepare('SELECT * FROM conversation_group_memberships ORDER BY user_id, session_id').all();
    service.moveMember(1, group.id, { sessionId: 'a', targetSessionId: 'a', position: 'after' });
    for (const [owner, source, target] of [[1, 'missing', 'a'], [1, 'a', 'missing'], [1, 'c', 'a'], [1, 'a', 'c'], [2, 'a', 'b']] as const) {
      assert.throws(() => service.moveMember(owner, group.id, { sessionId: source, targetSessionId: target, position: 'before' }),
        (error: unknown) => error instanceof AppError && error.statusCode === 404);
    }
    assert.deepEqual(getConnection().prepare('SELECT * FROM conversation_group_memberships ORDER BY user_id, session_id').all(), before);
    service.moveMember(1, group.id, { sessionId: 'b', targetSessionId: 'a', position: 'before' });
    assert.deepEqual(service.members(2, otherUser.id, { limit: 40, offset: 0, query: '' }).conversations.map(row => row.sessionId), ['a', 'b']);
    service.setMembership(1, 'b', null);
    assert.throws(() => service.moveMember(1, group.id, { sessionId: 'a', targetSessionId: 'b', position: 'before' }),
      (error: unknown) => error instanceof AppError && error.statusCode === 404);
  });
});

test('a storage failure during reorder rolls back all intermediate rank updates', async () => {
  await fixture(({ project, service }) => {
    const group = service.create(1, 'Atomic order');
    for (const id of ['a', 'b', 'c']) {
      sessionsDb.createAppSession(id, 'claude', project);
      service.setMembership(1, id, group.id);
    }
    getConnection().exec(`CREATE TRIGGER fixture_reorder_failure BEFORE UPDATE OF sort_order ON conversation_group_memberships
      WHEN NEW.session_id = 'b' BEGIN SELECT RAISE(ABORT, 'Fixture reorder failure'); END`);
    assert.throws(() => service.moveMember(1, group.id, { sessionId: 'c', targetSessionId: 'a', position: 'before' }), /Fixture reorder failure/);
    assert.deepEqual(service.members(1, group.id, { limit: 40, offset: 0, query: '' }).conversations.map(row => row.sessionId), ['a', 'b', 'c']);
  });
});

test('provider duplicate merges preserve the kept and adopted manual positions for each user', async () => {
  await fixture(({ project, service }) => {
    const owner = service.create(1, 'App owner');
    const other = service.create(2, 'Other owner');
    for (const id of ['head', 'app', 'tail']) sessionsDb.createAppSession(id, 'claude', project);
    sessionsDb.createSession('native', 'claude', project);
    for (const id of ['head', 'app', 'tail', 'native']) service.setMembership(1, id, owner.id);
    for (const id of ['head', 'native', 'tail']) service.setMembership(2, id, other.id);
    sessionsDb.assignProviderSessionId('app', 'native');
    for (const [userId, groupId] of [[1, owner.id], [2, other.id]] as const) {
      assert.deepEqual(service.members(userId, groupId, { limit: 40, offset: 0, query: '' }).conversations.map(row => row.sessionId), ['head', 'app', 'tail']);
      assert.equal((getConnection().prepare('SELECT sort_order FROM conversation_group_memberships WHERE user_id = ? AND session_id = ?').get(userId, 'app') as { sort_order: number }).sort_order, 1);
    }
    assert.deepEqual(getConnection().pragma('foreign_key_check'), []);
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
      const { data: { group } } = await created.json() as { data: { group: { id: string; name: string; isPinned: boolean } } };
      assert.equal(group.name, 'Reading');
      assert.equal(group.isPinned, false);
      for (const input of [{}, { isPinned: 'true' }, { isPinned: 1 }, { isPinned: null }, { name: 'Partial rename', isPinned: 'yes' }, { name: 'Partial rename', extra: true }, { name: '', isPinned: true }, []]) {
        assert.equal((await request(`/${group.id}`, 'PATCH', input)).status, 400);
        assert.equal(service.list(1).groups[0].name, 'Reading');
        assert.equal(service.list(1).groups[0].isPinned, false);
      }
      const pinResponse = await (await request(`/${group.id}`, 'PATCH', { isPinned: true })).json() as { data: { group: { isPinned: boolean; name: string } } };
      assert.equal(pinResponse.data.group.isPinned, true);
      assert.equal(pinResponse.data.group.name, 'Reading');
      assert.equal((await request(`/${group.id}`, 'PATCH', { name: 'Renamed' }, '2')).status, 404);
      assert.equal((await request(`/${group.id}`, 'PATCH', { name: 'Renamed' })).status, 200);
      assert.equal(service.list(1).groups[0].isPinned, true);
      assert.equal((await request(`/${group.id}`, 'PATCH', { name: 'Renamed', isPinned: false })).status, 200);
      assert.equal(service.list(1).groups[0].isPinned, false);
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
      const second = (await (await request(`/${group.id}/sessions`, 'POST', { provider: 'claude', projectPath: project })).json() as { data: { sessionId: string } }).data;
      const reorderPath = `/${group.id}/sessions/reorder`;
      for (const input of [{}, { sessionId: second.sessionId }, { sessionId: second.sessionId, targetSessionId: session.sessionId, position: 'first' },
        { sessionId: second.sessionId, targetSessionId: session.sessionId, position: 'before', extra: true },
        { sessionId: [], targetSessionId: session.sessionId, position: 'before' }]) {
        assert.equal((await request(reorderPath, 'POST', input)).status, 400);
      }
      const move = { sessionId: second.sessionId, targetSessionId: session.sessionId, position: 'before' };
      assert.equal((await request(reorderPath, 'POST', move, '2')).status, 404);
      assert.equal((await request(reorderPath, 'POST', move, null)).status, 401);
      const reordered = await request(reorderPath, 'POST', move);
      assert.equal(reordered.status, 200);
      assert.deepEqual(await reordered.json(), { success: true, data: {} });
      assert.deepEqual(service.members(1, group.id, { limit: 40, offset: 0, query: '' }).conversations.map(row => row.sessionId), [second.sessionId, session.sessionId]);
      assert.equal((await request(reorderPath, 'POST', { ...move, targetSessionId: second.sessionId })).status, 200);
      assert.equal((await request(reorderPath, 'POST', { ...move, targetSessionId: 'missing' })).status, 404);
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
