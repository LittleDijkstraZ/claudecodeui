import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';

import { createHubGroupStore } from './remote-hub-state.js';
import { createOAuthCallbackRelay } from './oauth-callback-relay.js';

/** Standalone local router consumed by the hub entry and fixture tests. It never imports provider runtimes or project filesystem services. */
export function createRemoteHub(options: {
  port: number;
  dist: string;
  stateDirectory: string;
  remotes: Array<{ id: string; name: string; port: number }>;
}) {
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error('Invalid hub port');
  const remotes = options.remotes.map(remote => {
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(remote.id) || !remote.name.trim() || remote.name.length > 80
      || !Number.isInteger(remote.port) || remote.port < 1024 || remote.port > 65535 || remote.port === options.port) throw new Error('Invalid SSH tunnel connection');
    return { ...remote, name: remote.name.trim() };
  });
  if (new Set(remotes.map(remote => remote.id)).size !== remotes.length || remotes.length === 0) throw new Error('Unique remote connections required');
  const groups = createHubGroupStore(options.stateDirectory, remotes.map(remote => remote.id));
  const oauthCallbacks = createOAuthCallbackRelay(remotes);
  const app = express();
  app.disable('x-powered-by');
  const server = http.createServer(app);
  const origin = `http://127.0.0.1:${options.port}`;
  const allowedHost = `127.0.0.1:${options.port}`;
  const validSource = (req: http.IncomingMessage) => req.headers.host === allowedHost
    && (!req.headers.origin || req.headers.origin === origin);
  app.use((req, res, next) => {
    if (!validSource(req)) { res.status(403).json({ error: 'Use the local hub origin' }); return; }
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.get('/hub-api/config', (_req, res) => res.json({ remotes }));
  app.post('/hub-api/oauth-callback', express.json({ limit: '2kb' }), async (req, res) => {
    if (req.headers.origin !== origin || !req.is('application/json')) { res.sendStatus(403); return; }
    try { res.json(await oauthCallbacks.register(String(req.body?.remoteId ?? ''), String(req.body?.attemptId ?? ''), String(req.headers.authorization ?? ''))); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Use manual callback entry.' }); }
  });
  app.delete('/hub-api/oauth-callback', express.json({ limit: '2kb' }), async (req, res) => {
    if (req.headers.origin !== origin || !req.is('application/json')) { res.sendStatus(403); return; }
    try { await oauthCallbacks.cancel(String(req.body?.remoteId ?? ''), String(req.body?.attemptId ?? ''), String(req.headers.authorization ?? '')); res.json({ released: true }); }
    catch { res.status(409).json({ error: 'Callback listener will expire automatically.' }); }
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok', mode: 'remote-hub', localExecution: false }));
  app.get('/hub-api/groups', (_req, res) => res.json(groups.read()));
  app.put('/hub-api/groups', express.json({ limit: '2mb' }), (req, res) => {
    if (req.headers.origin !== origin || !req.is('application/json')) { res.sendStatus(403); return; }
    const result = groups.replace(req.body);
    res.status(result.status).json(result.body);
  });
  // Only configured loopback SSH forwards are reachable. The client cannot supply
  // a URL/hostname, and absolute targets or redirects are never followed by us.
  app.use('/remote/:remoteId', (req, res, next) => {
    const remote = remotes.find(r => r.id === req.params.remoteId);
    if (!remote) { res.sendStatus(404); return; }
    if (!/^\/(api(?:\/|\?|$)|ws(?:\?|$)|shell(?:\?|$)|health(?:\?|$))/.test(req.url)) { next(); return; }
    const headers = { ...req.headers, host: `127.0.0.1:${remote.port}` };
    delete headers.cookie;
    // Remote authentication is the existing bearer JWT. Do not forward the hub
    // browser Origin as a different-site credential request to the remote.
    delete headers.origin;
    const upstream = http.request({ hostname: '127.0.0.1', port: remote.port, path: req.url, method: req.method, headers }, response => {
      res.status(response.statusCode ?? 502);
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined && !['set-cookie','access-control-allow-origin','x-frame-options','content-security-policy'].includes(name.toLowerCase())) res.setHeader(name, value);
      }
      response.pipe(res);
    });
    upstream.setTimeout(120_000, () => upstream.destroy(new Error('Remote request timed out')));
    upstream.on('error', () => { if (!res.headersSent) res.status(503).json({ error: 'Remote disconnected', remoteId: remote.id }); else res.end(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  });
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const match = req.url?.match(/^\/remote\/([a-z0-9-]+)(\/(?:ws|shell|plugin-ws\/[a-zA-Z0-9_-]+)(?:\?.*)?)$/);
    const remote = remotes.find(r => r.id === match?.[1]);
    if (!validSource(req) || req.headers.origin !== origin || !remote || !match) { socket.destroy(); return; }
    wsServer.handleUpgrade(req, socket, head, downstream => {
      const upstream = new WebSocket(`ws://127.0.0.1:${remote.port}${match[2]}`, { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 8000 });
      const queued: Array<{ data: Buffer; binary: boolean }> = [];
      let bytes = 0;
      downstream.on('message', (data, binary) => {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(buffer, { binary });
        else if (upstream.readyState === WebSocket.CONNECTING && (bytes += buffer.length) <= 1024 * 1024) queued.push({ data: buffer, binary });
        else downstream.close(1013, 'Remote not ready');
      });
      upstream.on('open', () => { for (const entry of queued) upstream.send(entry.data, { binary: entry.binary }); queued.length = 0; });
      upstream.on('message', (data, binary) => { if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary }); });
      upstream.on('close', () => { if (downstream.readyState === WebSocket.OPEN) downstream.close(1012, 'Remote disconnected'); });
      upstream.on('error', () => downstream.close(1013, 'Remote unavailable'));
      downstream.on('close', () => upstream.terminate());
      downstream.on('error', () => upstream.terminate());
    });
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error && typeof error === 'object' && 'type' in error && ['entity.parse.failed', 'entity.too.large'].includes(String(error.type))) {
      res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'Invalid JSON request body' }); return;
    }
    next(error);
  });
  app.use('/assets', express.static(join(resolve(options.dist), 'assets'), { immutable: true, maxAge: '1y' }));
  app.get('/index.html', (_req, res) => res.redirect(302, '/'));
  app.use(express.static(resolve(options.dist), { index: false }));
  app.get('*', (req, res) => {
    const match = req.path.match(/^\/remote\/([a-z0-9-]+)(?:\/|$)/);
    const remote = remotes.find(r => r.id === match?.[1]);
    if (match && !remote) { res.sendStatus(404); return; }
    if (req.path.startsWith('/api/') || req.path.startsWith('/hub-api/')) { res.sendStatus(404); return; }
    const config = remote ? { __REMOTE_BASE__: `/remote/${remote.id}`, __ROUTER_BASENAME__: `/remote/${remote.id}`, __REMOTE_ID__: remote.id, __REMOTE_NAME__: remote.name } : { __REMOTE_HUB__: true };
    const bootstrap = `<script>Object.assign(window,${JSON.stringify(config).replace(/</g, '\\u003c')})</script>`;
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(readFileSync(join(options.dist, 'index.html'), 'utf8').replace('<head>', `<head>${bootstrap}`));
  });
  return { server, close: () => { oauthCallbacks.close(); for (const client of wsServer.clients) client.terminate(); wsServer.close(); server.close(); } };
}
