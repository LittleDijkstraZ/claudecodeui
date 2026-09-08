import http from 'node:http';

type Remote = { id: string; port: number };
type Lease = { remoteId: string; attemptId: string; authorization: string; redirect: URL; state: string; expiresAt: number; servers: http.Server[]; timer: ReturnType<typeof setTimeout>; forwarding: boolean; ready: Promise<{ ready: true }> };

function requestRemote(remote: Remote, authorization: string, attemptId: string, callbackUrl?: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const body = callbackUrl ? JSON.stringify({ callbackUrl }) : null;
    const request = http.request({ hostname: '127.0.0.1', port: remote.port, path: `/api/mcp-auth/attempts/${encodeURIComponent(attemptId)}${body ? '/callback' : ''}`,
      method: body ? 'POST' : 'GET', headers: { authorization, ...(body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}) } }, response => {
      let data = '';
      response.on('data', chunk => { data += String(chunk); if (data.length > 64 * 1024) { response.destroy(); reject(new Error('Remote authorization response too large')); } });
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(new Error('The remote authorization attempt is unavailable.')); return; }
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid remote authorization response')); }
      });
      response.on('error', () => reject(new Error('Remote authorization disconnected')));
    });
    request.setTimeout(10_000, () => request.destroy());
    request.on('error', () => reject(new Error('Remote authorization disconnected')));
    request.end(body);
  });
}

/** Used only by the Mac loopback Hub. A registered remote attempt fixes every relay target; it cannot execute Claude or proxy arbitrary URLs. */
export function createOAuthCallbackRelay(remotes: Remote[]) {
  const leases = new Map<string, Lease>();
  let closed = false;
  const release = (key: string) => {
    const lease = leases.get(key); if (!lease) return;
    leases.delete(key); clearTimeout(lease.timer);
    for (const server of lease.servers) server.close();
    lease.authorization = ''; lease.state = '';
  };
  return {
    async register(remoteId: string, attemptId: string, authorization: string) {
      const remote = remotes.find(item => item.id === remoteId);
      if (!remote || !/^[a-zA-Z0-9-]{1,80}$/.test(attemptId) || !/^Bearer [^\r\n]{1,8192}$/.test(authorization)) throw new Error('Choose an authenticated remote authorization attempt.');
      // Neither callback port nor URL is accepted from the browser: ask the fixed remote over its configured SSH tunnel.
      const attempt = await requestRemote(remote, authorization, attemptId);
      if (closed) throw new Error('The local callback service has closed.');
      if (attempt.id !== attemptId || attempt.status !== 'awaiting-browser' || typeof attempt.authorizationUrl !== 'string' || typeof attempt.expiresAt !== 'number') throw new Error('The remote is not waiting for browser authorization.');
      const url = new URL(attempt.authorizationUrl);
      const redirect = new URL(url.searchParams.get('redirect_uri') || ''); const state = url.searchParams.get('state');
      const port = Number(redirect.port);
      if (url.protocol !== 'https:' || url.username || url.password || redirect.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(redirect.hostname) || !Number.isInteger(port) || port < 1024 || port > 65535
        || redirect.pathname !== '/callback' || redirect.username || redirect.password || redirect.search || redirect.hash || !state || state.length > 4096) throw new Error('This authorization requires manual callback entry.');
      const key = `${remoteId}:${attemptId}`;
      const existing = leases.get(key);
      if (existing) return existing.ready;
      if (leases.size >= 8 || [...leases.values()].some(item => item.redirect.port === redirect.port)) throw new Error('The local callback port is busy. Paste the callback URL manually, or retry after the other authorization finishes.');
      const remaining = Math.min(attempt.expiresAt - Date.now(), 10 * 60_000);
      if (remaining <= 0) throw new Error('This authorization expired. Start again.');
      const lease: Lease = { remoteId, attemptId, authorization, redirect, state, expiresAt: Date.now() + remaining, servers: [], timer: setTimeout(() => release(key), remaining), forwarding: false, ready: Promise.resolve({ ready: true }) };
      lease.timer.unref?.(); leases.set(key, lease);
      const handle = async (request: http.IncomingMessage, response: http.ServerResponse) => {
        response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('X-Content-Type-Options','nosniff'); response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        const validHosts = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
        let incoming: URL;
        try { incoming = new URL(request.url || '', redirect.origin); } catch { response.writeHead(400); response.end('Invalid callback'); return; }
        if (request.method !== 'GET' || !validHosts.includes(String(request.headers.host)) || incoming.origin !== redirect.origin || incoming.pathname !== redirect.pathname || incoming.searchParams.getAll('state').length !== 1 || incoming.searchParams.get('state') !== lease.state || (!incoming.searchParams.has('code') && !incoming.searchParams.has('error')) || Date.now() >= lease.expiresAt || incoming.href.length > 16_384) {
          response.writeHead(400); response.end('This callback does not belong to the pending authorization.'); return;
        }
        if (lease.forwarding) { response.writeHead(409); response.end('Authorization callback is already being delivered. Return to CloudCLI to check its status.'); return; }
        lease.forwarding = true;
        try {
          await requestRemote(remote, lease.authorization, attemptId, incoming.href);
          response.end('回调已送到对应远端。请返回 CloudCLI，等待远端 MCP 显示“已连接”。');
          release(key);
        } catch {
          lease.forwarding = false;
          response.writeHead(503); response.end('远端暂时不可用。请回到 CloudCLI，手动粘贴当前地址栏中的完整回调 URL，或重新授权。');
        }
      };
      lease.ready = (async () => {
      try {
        // localhost may resolve to either family. Bind both loopback addresses, never an unspecified/LAN address.
        for (const host of ['127.0.0.1', '::1']) {
          const server = http.createServer((request, response) => { void handle(request, response); });
          lease.servers.push(server);
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject); server.listen({ host, port, ipv6Only: true }, () => { server.removeListener('error', reject); resolve(); });
          });
          if (closed || leases.get(key) !== lease) { server.close(); throw new Error('Authorization was cancelled.'); }
        }
      } catch { release(key); throw new Error('This Mac cannot reserve the callback port. Use manual callback entry; no existing listener was changed.'); }
      return { ready: true as const };
      })();
      return lease.ready;
    },
    async cancel(remoteId: string, attemptId: string, authorization: string) {
      const key = `${remoteId}:${attemptId}`;
      const lease = leases.get(key);
      if (!lease) return;
      const remote = remotes.find(item => item.id === remoteId);
      if (!remote) throw new Error('Unknown remote');
      // Validate the current bearer against the remote attempt, including after JWT refresh.
      const attempt = await requestRemote(remote, authorization, attemptId);
      if (attempt.id !== attemptId) throw new Error('Authorization attempt mismatch');
      release(key);
    },
    close() { closed = true; for (const key of leases.keys()) release(key); },
  };
}
