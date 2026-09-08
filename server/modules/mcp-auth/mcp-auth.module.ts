import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import pty from 'node-pty';

import { providerMcpService } from '@/modules/providers/index.js';
import { AppError, resolveClaudeCodeExecutablePath } from '@/shared/index.js';

import { createMcpAuthService } from './mcp-auth.service.js';
import { confirmsMcpConnection, fingerprintMcpTarget } from './mcp-auth-status.js';

async function resolveTarget(target: { name: string; scope: string; workspacePath?: string }) {
  // The settings inventory reads the default config hierarchy. Do not authenticate a different native hierarchy under the same name.
  if (process.env.CLAUDE_CONFIG_DIR && path.resolve(process.env.CLAUDE_CONFIG_DIR) !== path.join(os.homedir(), '.claude')) throw new AppError('This remote uses a custom Claude configuration directory. Authorize MCP from its terminal.', { statusCode: 409 });
  const managedPath = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-mcp.json' : process.platform === 'win32' ? 'C:\\Program Files\\ClaudeCode\\managed-mcp.json' : '/etc/claude-code/managed-mcp.json';
  try {
    await stat(managedPath);
    throw new AppError('This remote uses managed MCP definitions. Authorize the managed server from its terminal.', { statusCode: 409 });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const cwd = await realpath(target.workspacePath ? path.resolve(target.workspacePath) : os.homedir());
  if (!(await stat(cwd)).isDirectory()) throw new AppError('Choose an existing remote folder.', { statusCode: 400 });
  const scopes = await providerMcpService.listProviderMcpServers('claude', { workspacePath: cwd });
  const configFingerprint = fingerprintMcpTarget(scopes, target);
  return { cwd, configFingerprint };
}

/** Remote-only adapter consumed by MCP auth routes; never imported by the loopback Hub. */
export const mcpAuthService = createMcpAuthService({
  resolveTarget,
  launch(target, onData, onExit) {
    const executable = resolveClaudeCodeExecutablePath();
    if (!executable) throw new Error('Remote Claude CLI unavailable');
    const process = pty.spawn(executable, ['mcp', 'login', target.name, '--no-browser'], { cwd: target.cwd, name: 'xterm-256color', cols: 4096, rows: 24, env: { ...globalThis.process.env, TERM: 'xterm-256color' } });
    process.onData(onData); process.onExit(event => onExit(event.exitCode));
    return process;
  },
  async connected(target) {
    const before = await resolveTarget(target);
    if (before.cwd !== target.cwd || before.configFingerprint !== target.configFingerprint) return false;
    return new Promise((resolve, reject) => {
      const executable = resolveClaudeCodeExecutablePath();
      if (!executable) { reject(new Error('Remote Claude CLI unavailable')); return; }
      // Native health-check only: no conversation, prompt, token reads or MCP tool invocation.
      execFile(executable, ['mcp', 'get', target.name], { cwd: target.cwd, timeout: 30_000, maxBuffer: 256 * 1024, env: { ...process.env, NO_COLOR: '1' } }, async (error, stdout) => {
        if (error) { reject(new Error('Remote MCP status unavailable')); return; }
        try {
          const after = await resolveTarget(target);
          resolve(after.cwd === target.cwd && after.configFingerprint === target.configFingerprint && confirmsMcpConnection(stdout, target.scope));
        } catch { resolve(false); }
      });
    });
  },
});
