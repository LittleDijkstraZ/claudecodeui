import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import { createRemoteHub } from '../index.js';

const listen = async (server: http.Server, port = 0): Promise<number> => {
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  return (server.address() as { port: number }).port;
};
const unusedPort = async () => {
  const server = http.createServer(); const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve())); return port;
};
const fakeRemote = async (name: string) => {
  const received: Array<{ url?: string; method?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const socketRequests: string[] = [];
  const finishStreams: Array<() => void> = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString(); received.push({ url: req.url, method: req.method, headers: req.headers, body });
    if (req.url === '/api/stream') {
      res.setHeader('Content-Type', 'text/plain'); res.write('first-chunk');
      finishStreams.push(() => res.end('second-chunk')); return;
    }
    res.setHeader('Content-Type', 'application/json'); res.setHeader('X-Fixture-Remote', name); res.setHeader('X-Refreshed-Token', `fixture.${name}.token`); res.setHeader('Set-Cookie', 'must-not-escape=yes');
    res.end(JSON.stringify({ remote: name, id: 'same-session', body }));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket, request) => {
    socketRequests.push(request.url ?? '');
    socket.on('message', (data, binary) => {
      if (binary) socket.send(data, { binary: true });
      else socket.send(JSON.stringify({ remote: name, sessionId: 'same-session', input: data.toString() }));
    });
  });
  const port = await listen(server);
  const close = () => new Promise<void>((resolve) => {
    for (const socket of sockets.clients) socket.terminate(); sockets.close(); server.closeAllConnections(); server.close(() => resolve());
  });
  return { port, received, socketRequests, finishStreams, close };
};
let directory: string;
let first: Awaited<ReturnType<typeof fakeRemote>>;
let second: Awaited<ReturnType<typeof fakeRemote>>;
let hub: ReturnType<typeof createRemoteHub>;
let origin: string;
let port: number;
let dist: string;
let stateDirectory: string;

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-hub-fixture-'));
  dist = path.join(directory, 'dist'); stateDirectory = path.join(directory, 'state');
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><html><head><script src="/assets/app.js"></script></head><body>Hub fixture</body></html>');
  await writeFile(path.join(dist, 'assets', 'app.js'), 'window.fixture=true;');
  first = await fakeRemote('first'); second = await fakeRemote('second'); port = await unusedPort();
  hub = createRemoteHub({ port, dist, stateDirectory, remotes: [{ id: 'one', name: 'One </script><script>fixture</script>', port: first.port }, { id: 'two', name: 'Two', port: second.port }] });
  await listen(hub.server, port); origin = `http://127.0.0.1:${port}`;
});
after(async () => { hub.close(); await Promise.all([first.close(), second.close()]); await rm(directory, { recursive: true, force: true }); });
const request = (url: string, options: RequestInit = {}) => fetch(origin + url, { ...options, signal: AbortSignal.timeout(8000) });
const json = async (response: Response) => await response.json() as { revision: number; localExecution: boolean; remotes: unknown[]; remote: string; body: string; groups: Array<{ members: unknown[] }>; imported: string[] };
const put = (body: unknown, headers: Record<string, string> = {}) => request('/hub-api/groups', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) });
const member = (remoteId: string) => ({ remoteId, sessionId: 'same-session', title: 'Fixture title', projectId: 'same-project', projectPath: '/remote/project', provider: 'claude' });
const groups = [{ id: 'fixture-group', name: 'Cross remote', isPinned: true, members: [member('one'), member('two')] }];

test('hub configuration, health and scoped bootstrap expose no local execution path', async () => {
  const health = await json(await request('/health')); assert.equal(health.localExecution, false);
  const config = await json(await request('/hub-api/config')); assert.equal(config.remotes.length, 2);
  const root = await (await request('/')).text(); assert.match(root, /__REMOTE_HUB__/);
  const remote = await (await request('/remote/one/session/same-session')).text();
  assert.match(remote, /__REMOTE_BASE__.*remote\/one/); assert.match(remote, /__ROUTER_BASENAME__/); assert.ok(!remote.includes('One </script>'));
  assert.equal((await request('/assets/app.js')).status, 200);
  assert.match(await (await request('/index.html')).text(), /__REMOTE_HUB__/);
  assert.equal((await request('/remote/unknown/session/one')).status, 404);
  assert.equal((await request('/api/projects')).status, 404);
});

test('HTTP bodies and bearer authentication route only to the chosen remote despite colliding IDs', async () => {
  const beforeFirst = first.received.length; const beforeSecond = second.received.length;
  const response = await request('/remote/one/api/sessions/same-session?project=same-project', { method: 'POST', headers: { Authorization: 'Bearer first-only', Cookie: 'private=no', Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'fixture-only', unicode: '模型' }) });
  assert.equal(response.headers.get('x-fixture-remote'), 'first'); assert.equal(response.headers.get('x-refreshed-token'), 'fixture.first.token'); assert.equal(response.headers.get('set-cookie'), null);
  const payload = await json(response); assert.equal(payload.remote, 'first'); assert.deepEqual(JSON.parse(payload.body), { input: 'fixture-only', unicode: '模型' });
  assert.equal(first.received.length, beforeFirst + 1); assert.equal(second.received.length, beforeSecond);
  assert.equal(first.received.at(-1)?.headers.authorization, 'Bearer first-only'); assert.equal(first.received.at(-1)?.headers.cookie, undefined); assert.equal(first.received.at(-1)?.headers.origin, undefined);
  await request('/remote/two/api/sessions/same-session', { headers: { Authorization: 'Bearer second-only' } });
  assert.equal(second.received.at(-1)?.headers.authorization, 'Bearer second-only');
  assert.equal(first.received.length, beforeFirst + 1);
});

test('proxy forwards streamed response chunks before the remote finishes', async () => {
  const response = await request('/remote/two/api/stream');
  const reader = response.body!.getReader();
  const firstChunk = await reader.read();
  assert.equal(new TextDecoder().decode(firstChunk.value), 'first-chunk');
  assert.equal(firstChunk.done, false);
  second.finishStreams.shift()!();
  const nextChunk = await reader.read();
  assert.equal(new TextDecoder().decode(nextChunk.value), 'second-chunk');
  assert.equal((await reader.read()).done, true);
});

test('foreign browser origins, forged hosts and arbitrary remote targets are rejected', async () => {
  const count = first.received.length;
  assert.equal((await request('/remote/one/api/projects', { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  const forgedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = http.get(origin + '/remote/one/api/projects', { headers: { Host: 'untrusted.invalid' } }, (response) => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject);
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await request('/remote/unknown/api/projects')).status, 404);
  assert.equal((await request('/remote/http%3A%2F%2Fevil.invalid/api/projects')).status, 404);
  assert.equal(first.received.length, count);
});

test('cross-remote groups preserve colliding IDs, use revisions and persist canonical metadata', async () => {
  const response = await put({ revision: 0, groups: groups.map(group => ({ ...group, arbitrary: 'omit-me', members: group.members.map(item => ({ ...item, authorization: 'never-persist' })) })), imported: ['one', 'one'] });
  assert.equal(response.status, 200); const saved = await json(response); assert.equal(saved.revision, 1); assert.equal(saved.groups[0].members.length, 2); assert.deepEqual(saved.imported, ['one']);
  const disk = await readFile(path.join(stateDirectory, 'groups.json'), 'utf8'); assert.ok(!disk.includes('never-persist')); assert.ok(!disk.includes('omit-me')); assert.equal((await stat(path.join(stateDirectory, 'groups.json'))).mode & 0o777, 0o600);
  const updates = await Promise.all([put({ revision: 1, groups, imported: ['one'] }), put({ revision: 1, groups, imported: ['one'] })]);
  assert.deepEqual(updates.map(value => value.status).sort(), [200, 409]);
  assert.equal((await json(await request('/hub-api/groups'))).revision, 2);
});

test('malformed state, duplicate remote membership and invalid providers cannot replace saved groups', async () => {
  for (const body of [null, [], 'string', {}, { revision: 2, groups: [{ ...groups[0], id: '' }], imported: [] }, { revision: 2, groups: [{ ...groups[0], members: [member('one'), member('one')] }], imported: [] }, { revision: 2, groups: [{ ...groups[0], members: [{ ...member('one'), provider: '../../escape' }] }], imported: [] }, { revision: 2, groups: [{ ...groups[0], members: [member('unknown')] }], imported: [] }]) {
    const response = await put(body); assert.equal(response.status, 400); assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  }
  assert.equal((await request('/hub-api/groups', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{broken' })).status, 400);
  assert.equal((await request('/hub-api/groups', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 2, groups, imported: [] }) })).status, 403);
  assert.equal((await put({ revision: 2, groups, imported: [] }, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await json(await request('/hub-api/groups'))).revision, 2);
});

test('websocket text/binary streams and query authentication remain scoped to their remote', async () => {
  for (const [id, expected, remote] of [['one', 'first', first], ['two', 'second', second]] as const) {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + `/remote/${id}/ws?token=fixture-${id}`, { origin });
    await once(socket, 'open');
    const reply = once(socket, 'message'); socket.send('same-session');
    const [text] = await reply; const body = JSON.parse(String(text)); assert.equal(body.remote, expected); assert.equal(body.sessionId, 'same-session');
    const binaryReply = once(socket, 'message'); socket.send(Buffer.from([0, 1, 255])); const [binary, isBinary] = await binaryReply;
    assert.equal(isBinary, true); assert.deepEqual(binary, Buffer.from([0, 1, 255])); assert.equal(remote.socketRequests.at(-1), `/ws?token=fixture-${id}`);
    const closed = once(socket, 'close'); socket.close(); await closed;
  }
  const invalid = new WebSocket(origin.replace('http:', 'ws:') + '/remote/one/ws?token=fixture', { origin: 'https://untrusted.invalid' });
  await once(invalid, 'error'); invalid.terminate();
});

test('one disconnected remote does not block HTTP and websocket access to the other', async () => {
  await first.close();
  const [offline, online] = await Promise.all([request('/remote/one/health'), request('/remote/two/health')]);
  assert.equal(offline.status, 503); assert.equal((await json(online)).remote, 'second');
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/remote/two/shell?token=still-local', { origin });
  await once(socket, 'open'); const result = once(socket, 'message'); socket.send('fixture-shell'); assert.equal(JSON.parse(String((await result)[0])).remote, 'second');
  const closed = once(socket, 'close'); socket.close(); await closed;
});

test('constructor rejects invalid local routing and refuses corrupt persisted state without erasing it', async () => {
  const config = { port, dist, stateDirectory: path.join(directory, 'invalid'), remotes: [{ id: 'one', name: 'One', port: first.port }] };
  assert.throws(() => createRemoteHub({ ...config, remotes: [{ id: 'one', name: 'One', port }] }));
  assert.throws(() => createRemoteHub({ ...config, remotes: [config.remotes[0], config.remotes[0]] }));
  await mkdir(config.stateDirectory); await writeFile(path.join(config.stateDirectory, 'groups.json'), 'null');
  assert.throws(() => createRemoteHub(config), /preserve groups.json/);
  assert.equal(await readFile(path.join(config.stateDirectory, 'groups.json'), 'utf8'), 'null');
});
