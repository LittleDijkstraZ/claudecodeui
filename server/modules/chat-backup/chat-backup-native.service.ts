import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { forkSession, type SessionStore, type SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';

import { AppError } from '@/shared/index.js';
import type { ChatBackupBundle } from '@/shared/index.js';

function failure(message: string): AppError {
  return new AppError(message, { code: 'BACKUP_RESTORE_FAILED', statusCode: 502 });
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** A dedicated isolated CLI owns the native fork. No model turn, tools, account
 * files, imported settings, or shared process environment are used here. */
async function forkCodex(staging: string, sourceId: string, projectPath: string): Promise<{ id: string; content: string }> {
  let launcher: string;
  try { launcher = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js'); }
  catch { throw new AppError('Codex CLI is not installed on this server.', { code: 'BACKUP_PROVIDER_UNAVAILABLE', statusCode: 501 }); }
  const child = spawn(process.execPath, [launcher, 'app-server'], {
    cwd: staging, env: { ...process.env, CODEX_HOME: staging }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const reader = readline.createInterface({ input: child.stdout });
  let nextId = 1;
  let stopped = false;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const failAll = () => {
    stopped = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(failure('Codex stopped while restoring the conversation.')); }
    pending.clear();
  };
  child.on('error', failAll);
  child.on('exit', failAll);
  child.stdin.on('error', failAll);
  child.stdout.on('error', failAll);
  child.stderr.on('data', () => {});
  child.stderr.on('error', () => {});
  reader.on('line', line => {
    let message: { id?: number; result?: unknown; error?: unknown };
    try { message = JSON.parse(line); } catch { return; }
    const request = typeof message.id === 'number' ? pending.get(message.id) : undefined;
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id!);
    if (message.error) request.reject(failure('Codex rejected this conversation backup.'));
    else request.resolve(message.result);
  });
  const call = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (stopped) { reject(failure('Codex could not start.')); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(failure('Codex timed out while restoring the conversation.')); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    await call('initialize', { clientInfo: { name: 'cloudcli-backup', version: '1' }, capabilities: {} });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
    const result = await call('thread/fork', { threadId: sourceId, cwd: projectPath }) as { thread?: { id?: unknown; path?: unknown } };
    const id = result?.thread?.id;
    const transcriptPath = result?.thread?.path;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || id === sourceId || typeof transcriptPath !== 'string') {
      throw failure('Codex returned no new conversation.');
    }
    const resolved = await fs.realpath(transcriptPath);
    if (!inside(await fs.realpath(staging), resolved)) throw failure('Codex returned an unexpected transcript location.');
    return { id, content: await fs.readFile(resolved, 'utf8') };
  } finally {
    reader.close();
    child.kill();
    failAll();
  }
}

async function publishFile(filename: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(filename), `.backup-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    // link is an atomic, exclusive publish: even a UUID collision never replaces an existing session.
    await fs.link(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
}

function relocateClaude(content: string, nativeId: string, projectPath: string): string {
  return content.split('\n').filter(line => line.trim()).map(line => {
    const row = JSON.parse(line) as Record<string, unknown>;
    return JSON.stringify({ ...row, ...(row.sessionId !== undefined ? { sessionId: nativeId } : {}),
      ...(row.cwd !== undefined ? { cwd: projectPath } : {}),
      // SDK lookup gives relocation metadata precedence over older cwd fields.
      ...(row.type === 'relocated' ? { relocatedCwd: projectPath } : {}),
    });
  }).join('\n') + '\n';
}

/** Used by Chat Backup service to create native context with provider-owned UUID
 * remapping before recording its app session. Returned cleanup only removes newly
 * created files and is called if indexing fails. */
export async function restoreNativeChatBackup(bundle: ChatBackupBundle, projectPath: string, providerHome: string) {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-chat-restore-'));
  let nativeId = '';
  let mainPath = '';
  let sidecarDirectory = '';
  let mainPublished = false;
  let sidecarCreated = false;
  const main = bundle.files.find(file => file.path === 'main.jsonl')!.content;
  try {
    let content: string;
    let targetDirectory: string;
    if (bundle.session.provider === 'claude') {
      let projectKey = '';
      let output: SessionStoreEntry[] = [];
      const store: SessionStore = {
        load: async key => key.sessionId === bundle.session.providerSessionId && !key.subpath
          ? main.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as SessionStoreEntry) : null,
        append: async (key, entries) => { if (!key.subpath) { projectKey = key.projectKey; output.push(...entries); } },
      };
      const fork = await forkSession(bundle.session.providerSessionId, { dir: projectPath, title: bundle.session.title || 'Restored conversation', sessionStore: store });
      nativeId = fork.sessionId;
      if (!/^[a-zA-Z0-9._-]+$/.test(projectKey) || projectKey === '.' || projectKey === '..' || !output.length) {
        throw failure('Claude returned no portable conversation.');
      }
      targetDirectory = path.join(providerHome, 'projects', projectKey);
      content = relocateClaude(output.map(row => JSON.stringify(row)).join('\n'), nativeId, projectPath);
    } else {
      const sourceDirectory = path.join(staging, 'sessions', '2000', '01', '01');
      await fs.mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(sourceDirectory, `rollout-2000-01-01T00-00-00-${bundle.session.providerSessionId}.jsonl`), main, { mode: 0o600 });
      const fork = await forkCodex(staging, bundle.session.providerSessionId, projectPath);
      nativeId = fork.id;
      content = fork.content;
      const date = new Date().toISOString().slice(0, 10).split('-');
      targetDirectory = path.join(providerHome, 'sessions', ...date);
    }
    if (!/^[0-9a-f-]{36}$/i.test(nativeId) || nativeId === bundle.session.providerSessionId) throw failure('Provider did not allocate a new session identity.');
    await fs.mkdir(providerHome, { recursive: true, mode: 0o700 });
    const root = await fs.realpath(providerHome);
    await fs.mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    if (!inside(root, await fs.realpath(targetDirectory))) throw failure('Provider directory resolves outside its storage root.');
    mainPath = path.join(targetDirectory, bundle.session.provider === 'claude' ? `${nativeId}.jsonl` : `rollout-${new Date().toISOString().replace(/[:.]/g, '-')}-${nativeId}.jsonl`);
    const sidecars = bundle.files.filter(file => file.path !== 'main.jsonl');
    if (sidecars.length) {
      sidecarDirectory = path.join(targetDirectory, nativeId);
      await fs.mkdir(sidecarDirectory, { mode: 0o700 });
      sidecarCreated = true;
      for (const file of sidecars) {
        const filename = path.join(sidecarDirectory, file.path);
        await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        const isSubagentTranscript = file.path.startsWith('subagents/') && file.path.endsWith('.jsonl');
        await fs.writeFile(filename, isSubagentTranscript ? relocateClaude(file.content, nativeId, projectPath) : file.content, { flag: 'wx', mode: 0o600 });
      }
    }
    await publishFile(mainPath, content);
    mainPublished = true;
    return {
      providerSessionId: nativeId, jsonlPath: mainPath,
      cleanup: async () => { await fs.rm(mainPath, { force: true }); if (sidecarDirectory) await fs.rm(sidecarDirectory, { recursive: true, force: true }); },
    };
  } catch (error) {
    // Main file can only be our own after exclusive publication; its UUID was generated by the provider.
    if (mainPublished) await fs.rm(mainPath, { force: true }).catch(() => {});
    if (sidecarCreated) await fs.rm(sidecarDirectory, { recursive: true, force: true }).catch(() => {});
    if (error instanceof AppError) throw error;
    throw failure('Could not restore this native conversation backup.');
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
