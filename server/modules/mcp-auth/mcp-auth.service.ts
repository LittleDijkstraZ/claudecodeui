import { randomUUID } from 'node:crypto';

import { AppError } from '@/shared/index.js';

type Target = { name: string; scope: 'user' | 'project' | 'local'; workspacePath?: string };
type ResolvedTarget = Target & { cwd: string; configFingerprint?: string };
type ProcessHandle = { write(value: string): void; kill(): void };
type Dependencies = {
  resolveTarget(target: Target): Promise<{ cwd: string; configFingerprint?: string }>;
  launch(target: ResolvedTarget, onData: (chunk: string) => void, onExit: (code: number) => void): ProcessHandle;
  connected(target: ResolvedTarget): Promise<boolean>;
  now?: () => number;
};
type Attempt = {
  id: string; owner: number; target: ResolvedTarget; expiresAt: number;
  status: 'starting' | 'awaiting-browser' | 'verifying' | 'connected' | 'failed' | 'expired' | 'cancelled';
  authorizationUrl: string | null; redirectUri: string | null; state: string | null;
  error: string | null; process: ProcessHandle | null; output: string; submitted: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

function bad(message: string): never { throw new AppError(message, { code: 'MCP_AUTH_INVALID', statusCode: 400 }); }
function terminal(status: Attempt['status']) { return ['connected', 'failed', 'expired', 'cancelled'].includes(status); }

/** Used by the authenticated MCP routes and synthetic tests; only the injected remote CLI owns OAuth credentials. */
export function createMcpAuthService(deps: Dependencies) {
  const attempts = new Map<string, Attempt>();
  const now = deps.now ?? Date.now;
  const finish = (attempt: Attempt, status: Attempt['status'], error: string | null = null) => {
    attempt.status = status; attempt.error = error;
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.timer = null;
    const process = attempt.process; attempt.process = null;
    try { process?.kill(); } catch { /* The native CLI may already have exited. */ }
    // Authorization URLs and callback state are short-lived secrets, never persisted or logged.
    attempt.authorizationUrl = null; attempt.state = null; attempt.redirectUri = null; attempt.output = '';
  };
  const snapshot = (attempt: Attempt) => ({ id: attempt.id, name: attempt.target.name, scope: attempt.target.scope,
    workspacePath: attempt.target.workspacePath, expiresAt: attempt.expiresAt, status: attempt.status,
    authorizationUrl: attempt.authorizationUrl, error: attempt.error });
  const owned = (owner: number, id: string) => {
    const attempt = attempts.get(id);
    if (!attempt || attempt.owner !== owner) throw new AppError('Authorization attempt not found on this remote.', { code: 'MCP_AUTH_NOT_FOUND', statusCode: 404 });
    if (!terminal(attempt.status) && now() >= attempt.expiresAt) finish(attempt, 'expired', 'Authorization timed out. Start again for a new link.');
    return attempt;
  };
  const verify = async (attempt: Attempt) => {
    if (terminal(attempt.status)) return;
    attempt.status = 'verifying';
    try {
      const connected = await deps.connected(attempt.target);
      if (terminal(attempt.status)) return;
      finish(attempt, connected ? 'connected' : 'failed', connected ? null : 'Authorization returned, but the remote MCP server is not connected. Retry or check the server configuration.');
    } catch {
      if (!terminal(attempt.status)) finish(attempt, 'failed', 'Could not confirm the remote MCP connection. Retry when the remote is available.');
    }
  };
  return {
    async start(owner: number, value: unknown) {
      if (!value || typeof value !== 'object') bad('Choose a configured remote MCP server.');
      const input = value as Record<string, unknown>;
      if (typeof input.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(input.name)) bad('Invalid MCP server name.');
      if (!['user', 'project', 'local'].includes(String(input.scope))) bad('Invalid MCP scope.');
      if (input.workspacePath !== undefined && (typeof input.workspacePath !== 'string' || input.workspacePath.length > 4096 || /[\x00-\x1f]/.test(input.workspacePath))) bad('Invalid remote folder.');
      for (const [id, item] of attempts) {
        if (now() >= item.expiresAt && !terminal(item.status)) finish(item, 'expired', 'Authorization timed out.');
        if (now() >= item.expiresAt + 60_000) attempts.delete(id);
      }
      if (attempts.size >= 32) throw new AppError('Too many pending authorization attempts. Close an earlier attempt and retry.', { code: 'MCP_AUTH_CAPACITY', statusCode: 429 });
      const target: Target = { name: input.name, scope: input.scope as Target['scope'], ...(input.workspacePath ? { workspacePath: input.workspacePath as string } : {}) };
      const resolved = await deps.resolveTarget(target);
      if (attempts.size >= 32) throw new AppError('Too many pending authorization attempts.', { code: 'MCP_AUTH_CAPACITY', statusCode: 429 });
      if ([...attempts.values()].some(item => !terminal(item.status) && item.target.name === target.name && item.target.cwd === resolved.cwd)) throw new AppError('This remote server already has an authorization in progress.', { code: 'MCP_AUTH_BUSY', statusCode: 409 });
      const attempt: Attempt = { id: randomUUID(), owner, target: { ...target, ...resolved }, expiresAt: now() + 10 * 60_000,
        status: 'starting', authorizationUrl: null, redirectUri: null, state: null, error: null, process: null, output: '', submitted: false, timer: null };
      attempts.set(attempt.id, attempt);
      attempt.timer = setTimeout(() => finish(attempt, 'expired', 'Authorization timed out. Start again for a new link.'), 10 * 60_000);
      attempt.timer.unref?.();
      try {
        attempt.process = deps.launch(attempt.target, chunk => {
          if (terminal(attempt.status) || attempt.authorizationUrl) return;
          attempt.output = (attempt.output + chunk.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')).slice(-64 * 1024);
          for (const match of attempt.output.matchAll(/https:\/\/[^\s<>"'`\x00-\x1f]+(?=\s)/g)) {
            try {
              const url = new URL(match[0]); const redirect = new URL(url.searchParams.get('redirect_uri') || '');
              const state = url.searchParams.get('state');
              if (url.username || url.password || !state || state.length > 4096 || redirect.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)
                || Number(redirect.port) < 1024 || Number(redirect.port) > 65535 || redirect.pathname !== '/callback' || redirect.search || redirect.hash || redirect.username || redirect.password) continue;
              attempt.authorizationUrl = url.href; attempt.redirectUri = redirect.href; attempt.state = state; attempt.status = 'awaiting-browser'; attempt.output = ''; break;
            } catch { /* Wait for a complete native authorization URL. */ }
          }
        }, code => {
          attempt.process = null;
          if (terminal(attempt.status)) return;
          if (code === 0) void verify(attempt);
          else finish(attempt, 'failed', 'Claude MCP sign-in did not complete. This remote needs Claude Code with “mcp login --no-browser” support (2.1.191 or later). Retry or use its terminal /mcp menu.');
        });
      } catch { finish(attempt, 'failed', 'Could not start Claude MCP sign-in on this remote. Check its CLI installation.'); }
      return snapshot(attempt);
    },
    read(owner: number, id: string) { return snapshot(owned(owner, id)); },
    callback(owner: number, id: string, value: unknown) {
      const attempt = owned(owner, id);
      if (attempt.status !== 'awaiting-browser' || !attempt.process || !attempt.redirectUri || !attempt.state) throw new AppError('This authorization is no longer waiting for a callback. Start again if it expired.', { code: 'MCP_AUTH_NOT_WAITING', statusCode: 409 });
      if (typeof value !== 'string' || value.length > 16_384 || /[\x00-\x20\x7f]/.test(value)) bad('Paste the complete callback URL from your browser.');
      let url: URL;
      try { url = new URL(value); } catch { bad('Invalid callback URL.'); }
      const expected = new URL(attempt.redirectUri);
      if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash || url.username || url.password || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== attempt.state
        || (!url.searchParams.has('code') && !url.searchParams.has('error'))) bad('This callback belongs to a different authorization. Use the current link for this remote.');
      if (!attempt.submitted) { attempt.process.write(`${url.href}\r`); attempt.submitted = true; attempt.status = 'verifying'; }
      return snapshot(attempt);
    },
    cancel(owner: number, id: string) { const attempt = owned(owner, id); if (!terminal(attempt.status)) finish(attempt, 'cancelled'); return snapshot(attempt); },
    close() { for (const attempt of attempts.values()) if (!terminal(attempt.status)) finish(attempt, 'cancelled'); attempts.clear(); },
  };
}
