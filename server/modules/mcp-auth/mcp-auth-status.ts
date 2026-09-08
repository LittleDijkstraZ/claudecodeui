import { createHash } from 'node:crypto';

import { AppError } from '@/shared/index.js';
import type { McpScope, ProviderMcpServer } from '@/shared/types.js';

/** The native health check must identify the requested scope and a live Connected status. Unknown formats fail closed. */
export function confirmsMcpConnection(stdout: string, scope: 'user' | 'local' | 'project'): boolean {
  const clean = stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const reportedScope = /^\s*Scope:\s*(User|Local|Project)\s+config(?:\s|$)/mi.exec(clean)?.[1]?.toLowerCase();
  return reportedScope === scope && /^\s*Status:\s*(?:[✓✔]\s*)?Connected\s*$/mi.test(clean);
}

/** Resolves the same local → project → user precedence as native Claude, keeping only a digest for later comparison. */
export function fingerprintMcpTarget(scopes: Record<McpScope, ProviderMcpServer[]>, target: { name: string; scope: string }): string {
  const effective = [...scopes.local, ...scopes.project, ...scopes.user].find(server => server.name === target.name);
  if (!effective || effective.scope !== target.scope || !['http', 'sse'].includes(effective.transport)) throw new AppError('This MCP definition is missing, overridden by another scope, or does not support OAuth. Check it in the selected remote folder.', { statusCode: 409 });
  return createHash('sha256').update(JSON.stringify(effective)).digest('hex');
}
