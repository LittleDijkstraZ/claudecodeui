import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { broadcastSessionUpserted } from '@/modules/websocket/index.js';
import { AppError, normalizeProjectPath, validateWorkspacePath } from '@/shared/index.js';
import type { ChatBackupBundle } from '@/shared/index.js';

import { restoreNativeChatBackup } from './chat-backup-native.service.js';
import { validateBackupFilePath, validateChatBackupBundle } from './chat-backup-validation.js';

type BackupDependencies = {
  sessions: Pick<typeof sessionsDb, 'getSessionById' | 'createForkedSession' | 'deleteSessionById'>;
  providerHome: (provider: 'claude' | 'codex') => string;
  restoreNative: typeof restoreNativeChatBackup;
  broadcast: (sessionId: string) => Promise<void>;
  validateDestination: typeof validateWorkspacePath;
};

const defaults: BackupDependencies = {
  sessions: sessionsDb,
  providerHome: provider => provider === 'claude'
    ? process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    : process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  restoreNative: restoreNativeChatBackup,
  broadcast: broadcastSessionUpserted,
  validateDestination: validateWorkspacePath,
};

function backupError(message: string, code: string, statusCode = 409): never {
  throw new AppError(message, { code, statusCode });
}

function stamp(info: { size: number; mtimeMs: number; ino: number }): string {
  return `${info.ino}:${info.size}:${info.mtimeMs}`;
}

/** Used by the authenticated router and isolated tests. Export follows only the
 * indexed session's native directory; restore accepts existing destination
 * folders and serializes publication/indexing to avoid watcher races. */
export function createChatBackupService(overrides: Partial<BackupDependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  let restoring = Promise.resolve();
  return {
    async exportSession(sessionId: string): Promise<ChatBackupBundle> {
      const source = dependencies.sessions.getSessionById(sessionId);
      if (!source) backupError('Session was not found.', 'SESSION_NOT_FOUND', 404);
      if (source.provider !== 'claude' && source.provider !== 'codex') {
        backupError('Local conversation backup currently supports Claude and Codex.', 'BACKUP_UNSUPPORTED_PROVIDER');
      }
      if (!source.provider_session_id || !source.jsonl_path || !source.project_path) backupError('This session has no saved conversation yet.', 'BACKUP_EMPTY');
      const provider = source.provider;
      let root: string;
      try { root = await fs.realpath(dependencies.providerHome(provider)); }
      catch { backupError('Provider conversation storage is unavailable.', 'BACKUP_UNAVAILABLE'); }
      const files: ChatBackupBundle['files'] = [];
      const observed: Array<{ filename: string; version: string }> = [];
      let totalBytes = 0;
      const addFile = async (filename: string, portablePath: string) => {
        validateBackupFilePath(portablePath, provider);
        if (files.length >= 512) backupError('Chat backup has too many files.', 'BACKUP_TOO_LARGE', 413);
        const metadata = await fs.lstat(filename);
        if (!metadata.isFile() || metadata.isSymbolicLink()) backupError('Backup cannot follow links or special files.', 'BACKUP_INVALID', 400);
        const actual = await fs.realpath(filename);
        const relative = path.relative(root, actual);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) backupError('Transcript is outside provider storage.', 'BACKUP_INVALID', 400);
        totalBytes += metadata.size;
        if (totalBytes > 64 * 1024 * 1024) backupError('Chat backup exceeds 64 MB.', 'BACKUP_TOO_LARGE', 413);
        const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const before = await file.stat();
          if (stamp(before) !== stamp(metadata)) backupError('Conversation changed while backing up. Retry shortly.', 'BACKUP_CHANGED');
          const content = await file.readFile('utf8');
          if (stamp(await file.stat()) !== stamp(before)) backupError('Conversation changed while backing up. Retry shortly.', 'BACKUP_CHANGED');
          files.push({ path: portablePath, content });
          observed.push({ filename, version: stamp(before) });
        } finally { await file.close(); }
      };
      try {
        await addFile(source.jsonl_path, 'main.jsonl');
        if (provider === 'claude') {
          const sidecarRoot = source.jsonl_path.replace(/\.jsonl$/, '');
          const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
            let stat;
            try { stat = await fs.lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
            if (stat.isSymbolicLink() || !stat.isDirectory() || depth > 7) backupError('Backup sidecar directory is invalid.', 'BACKUP_INVALID', 400);
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
              const name = `${prefix}/${entry.name}`;
              if (entry.isSymbolicLink()) backupError('Backup sidecars cannot be symbolic links.', 'BACKUP_INVALID', 400);
              if (entry.isDirectory()) await visit(path.join(directory, entry.name), name, depth + 1);
              else if ((prefix.startsWith('subagents') && /\.(?:jsonl|meta\.json)$/.test(entry.name)) || (prefix.startsWith('tool-results') && /\.(?:txt|json|jsonl)$/.test(entry.name))) {
                await addFile(path.join(directory, entry.name), name);
              }
            }
          };
          await visit(path.join(sidecarRoot, 'subagents'), 'subagents', 1);
          await visit(path.join(sidecarRoot, 'tool-results'), 'tool-results', 1);
        }
        for (const file of observed) if (stamp(await fs.stat(file.filename)) !== file.version) backupError('Conversation changed while backing up. Retry shortly.', 'BACKUP_CHANGED');
      } catch (error) {
        if (error instanceof AppError) throw error;
        backupError('Saved conversation files are unavailable. Retry after the session is saved.', 'BACKUP_UNAVAILABLE');
      }
      const current = dependencies.sessions.getSessionById(sessionId);
      if (!current || current.provider_session_id !== source.provider_session_id || current.jsonl_path !== source.jsonl_path) backupError('Session context changed while backing up. Retry shortly.', 'BACKUP_CHANGED');
      return validateChatBackupBundle({
        format: 'cloudcli-chat-backup', version: 1, createdAt: new Date().toISOString(),
        session: { id: source.session_id, provider, title: source.custom_name || 'Conversation', projectPath: source.project_path, providerSessionId: source.provider_session_id, model: source.model, effort: source.effort },
        files,
      });
    },
    async restore(input: unknown, requestedProjectPath: unknown) {
      const bundle = validateChatBackupBundle(input);
      if (typeof requestedProjectPath !== 'string' || !requestedProjectPath.trim() || requestedProjectPath.length > 4096 || requestedProjectPath.includes('\0') || !path.isAbsolute(requestedProjectPath)) {
        backupError('Select an existing absolute destination folder.', 'BACKUP_DESTINATION_INVALID', 400);
      }
      let projectPath: string;
      try {
        projectPath = await fs.realpath(requestedProjectPath);
        if (!(await fs.stat(projectPath)).isDirectory()) throw new Error('not a directory');
      } catch { backupError('The destination folder does not exist on this server.', 'BACKUP_DESTINATION_INVALID', 400); }
      // Disk-discovered projects may legitimately live outside the new-project
      // root. Existing project selection preserves its stored path/identity.
      const existingProject = projectsDb.getProjectPath(normalizeProjectPath(requestedProjectPath)) ?? projectsDb.getProjectPath(projectPath);
      if (existingProject) projectPath = existingProject.project_path;
      else {
        const validation = await dependencies.validateDestination(requestedProjectPath);
        if (!validation.valid || !validation.resolvedPath) backupError(validation.error || 'Destination folder is unavailable.', 'BACKUP_DESTINATION_INVALID', 400);
        projectPath = validation.resolvedPath;
      }
      const previous = restoring;
      let release!: () => void;
      restoring = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        const native = await dependencies.restoreNative(bundle, projectPath, dependencies.providerHome(bundle.session.provider));
        const sessionId = randomUUID();
        const sessionName = bundle.session.title.trim() || 'Restored conversation';
        try {
          dependencies.sessions.createForkedSession({ sessionId, provider: bundle.session.provider, projectPath, customName: sessionName,
            providerSessionId: native.providerSessionId, jsonlPath: native.jsonlPath,
            forkedFromSessionId: bundle.session.id, model: bundle.session.model, effort: bundle.session.effort });
        } catch (error) {
          await native.cleanup();
          // A watcher can discover the just-published native id before indexing fails.
          dependencies.sessions.deleteSessionById(native.providerSessionId);
          throw error;
        }
        // A disconnected observer cannot turn a successful durable restore into a retry/duplicate.
        await dependencies.broadcast(sessionId).catch(() => {});
        return { sessionId, provider: bundle.session.provider, projectPath, sessionName };
      } finally { release(); }
    },
  };
}
