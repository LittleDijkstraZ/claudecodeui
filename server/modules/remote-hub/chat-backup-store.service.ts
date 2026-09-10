import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ChatBackupBundle, HubChatBackupStatus, HubChatBackupSummary } from '../../shared/index.js';

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const BACKUP_ID = /^[a-f0-9]{64}$/;
const SESSION_ID = /^[a-zA-Z0-9_-]{1,160}$/;
type SavedBackup = { backup: HubChatBackupSummary; bundle: ChatBackupBundle };
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !value.includes('\0');
const date = (value: unknown): value is string => text(value, 100) && Number.isFinite(Date.parse(value));
function fail(message: string, statusCode = 400): never { throw Object.assign(new Error(message), { statusCode }); }

function normalizeBundle(value: unknown): ChatBackupBundle {
  const raw = object(value); const session = object(raw?.session);
  if (!raw || raw.format !== 'cloudcli-chat-backup' || raw.version !== 1 || !date(raw.createdAt) || !session
    || !text(session.id, 120) || !SESSION_ID.test(session.id) || !['claude', 'codex'].includes(String(session.provider))
    || !text(session.title, 4000) || !text(session.projectPath, 4096) || !session.projectPath
    || !text(session.providerSessionId, 120) || !SESSION_ID.test(session.providerSessionId)
    || (session.model !== null && !text(session.model, 500)) || (session.effort !== null && !text(session.effort, 100))
    || !Array.isArray(raw.files) || raw.files.length === 0 || raw.files.length > 512) fail('Invalid chat backup bundle');
  const paths = new Set<string>();
  let contentBytes = 0;
  const files = raw.files.map((value) => {
    const file = object(value);
    if (!file || !text(file.path, 512) || typeof file.content !== 'string') fail('Invalid chat backup file');
    const parts = file.path.split('/');
    if (parts.length > 8 || parts.some(part => !/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..') || paths.has(file.path)) fail('Invalid chat backup file path');
    const main = file.path === 'main.jsonl';
    const sidecar = session.provider === 'claude' && (
      (file.path.startsWith('subagents/') && /(?:\.jsonl|\.meta\.json)$/.test(file.path))
      || (file.path.startsWith('tool-results/') && /\.(?:txt|jsonl|json)$/.test(file.path))
    );
    if (!main && !sidecar) fail('Unsupported chat backup file path');
    paths.add(file.path);
    contentBytes += Buffer.byteLength(file.content);
    if (contentBytes > MAX_BUNDLE_BYTES) fail('Chat backup exceeds the 64 MB limit', 413);
    return { path: file.path, content: file.content };
  });
  if (!paths.has('main.jsonl')) fail('Chat backup is missing main.jsonl');
  const bundle: ChatBackupBundle = {
    format: 'cloudcli-chat-backup', version: 1, createdAt: raw.createdAt,
    session: {
      id: session.id, provider: session.provider as 'claude' | 'codex', title: session.title,
      projectPath: session.projectPath, providerSessionId: session.providerSessionId,
      model: session.model as string | null, effort: session.effort as string | null,
    }, files,
  };
  if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_BUNDLE_BYTES) fail('Chat backup exceeds the 64 MB limit', 413);
  return bundle;
}

function sourceId(remoteId: string, bundle: ChatBackupBundle) {
  return createHash('sha256').update(JSON.stringify([remoteId, bundle.session.provider, bundle.session.id])).digest('hex');
}

function readRegularFile(path: string, maximumBytes: number) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes) fail('Invalid local chat backup file', 500);
  return readFileSync(path, 'utf8');
}

function atomicWrite(directory: string, path: string, value: unknown) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) fail('Local chat backup directory must not be a symbolic link', 500);
  chmodSync(directory, 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* A failed write may not have created the temporary file. */ }
    throw error;
  }
}

/** The local Hub and its backup routes use this opt-in disk store. It imports no
 * provider runtime, writes only generated archive names, and keeps one latest copy
 * per remote/provider/session. Reads and disabled sync create no backup files. */
export function createHubChatBackupStore(stateDirectory: string, remoteIds: string[]) {
  const directory = join(resolve(stateDirectory), 'chat-backups');
  const settingsPath = join(resolve(stateDirectory), 'chat-backup-settings.json');
  const allowedRemotes = new Set(remoteIds);
  // Inventory polling should stat unchanged archives, not repeatedly parse their full chat contents.
  const summaries = new Map<string, { version: string; backup: HubChatBackupSummary }>();

  const fileVersion = (id: string) => {
    const info = lstatSync(join(directory, `${id}.json`));
    if (!info.isFile() || info.isSymbolicLink()) fail('Invalid local chat backup file', 500);
    return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  };

  const settings = (): { enabled: boolean; warning?: string } => {
    try {
      const value = object(JSON.parse(readRegularFile(settingsPath, 4096)));
      if (!value || typeof value.enabled !== 'boolean') throw new Error('Invalid settings');
      return { enabled: value.enabled };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: false };
      return { enabled: false, warning: 'Could not read local chat backup settings; automatic sync is off. The settings file was preserved.' };
    }
  };

  const load = (id: string): SavedBackup => {
    if (!BACKUP_ID.test(id)) fail('Invalid chat backup id');
    try {
      const directoryInfo = lstatSync(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Invalid backup directory');
      const value = object(JSON.parse(readRegularFile(join(directory, `${id}.json`), MAX_BUNDLE_BYTES + 32 * 1024)));
      const backup = object(value?.backup);
      const bundle = normalizeBundle(value?.bundle);
      if (!backup || backup.id !== id || !text(backup.remoteId, 200) || !backup.remoteId
        || !text(backup.remoteName, 200) || !backup.remoteName || !date(backup.savedAt)
        || (backup.sourceUpdatedAt !== null && !date(backup.sourceUpdatedAt))
        || sourceId(backup.remoteId, bundle) !== id) throw new Error('Invalid backup metadata');
      return {
        bundle,
        backup: {
          id, remoteId: backup.remoteId, remoteName: backup.remoteName,
          sessionId: bundle.session.id, title: bundle.session.title, provider: bundle.session.provider,
          projectPath: bundle.session.projectPath, savedAt: backup.savedAt,
          sourceUpdatedAt: backup.sourceUpdatedAt as string | null, bytes: Buffer.byteLength(JSON.stringify(bundle)),
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('Chat backup was not found', 404);
      fail(`Could not read chat backup ${id}; its file was preserved for recovery`, 500);
    }
  };

  const read = (): HubChatBackupStatus => {
    const config = settings(); const backups: HubChatBackupSummary[] = [];
    const warnings = config.warning ? [config.warning] : [];
    try {
      if (lstatSync(directory).isSymbolicLink()) throw new Error('Invalid backup directory');
      for (const name of readdirSync(directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        try {
          const id = name.slice(0, -5);
          const version = fileVersion(id);
          const cached = summaries.get(id);
          const backup = cached?.version === version ? cached.backup : load(id).backup;
          summaries.set(id, { version, backup });
          backups.push(backup);
        }
        catch { warnings.push(`Could not read chat backup ${name}; its file was preserved for recovery.`); }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('Could not read the local chat backup directory. Existing files were preserved.');
    }
    backups.sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt));
    const present = new Set(backups.map(backup => backup.id));
    for (const id of summaries.keys()) if (!present.has(id)) summaries.delete(id);
    return { enabled: config.enabled, directory, backups, ...(warnings.length ? { warnings } : {}) };
  };

  const save = (input: { remoteId: string; remoteName: string; sourceUpdatedAt: string | null; bundle: unknown }, imported: boolean): HubChatBackupSummary => {
    if (!imported && !settings().enabled) fail('Local chat sync is disabled', 409);
    if (!imported && !allowedRemotes.has(input.remoteId)) fail('Unknown source remote');
    if (!text(input.remoteName, 200) || !input.remoteName.trim() || (input.sourceUpdatedAt !== null && !date(input.sourceUpdatedAt))) fail('Invalid chat backup source');
    const bundle = normalizeBundle(input.bundle);
    const id = sourceId(input.remoteId, bundle);
    let previous: SavedBackup | undefined;
    try { previous = load(id); }
    catch (error) {
      // A corrupt archive must be recovered explicitly, never silently overwritten.
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }
    if (!imported && previous) {
      const oldUpdated = previous.backup.sourceUpdatedAt; const newUpdated = input.sourceUpdatedAt;
      if ((oldUpdated && (!newUpdated || Date.parse(oldUpdated) > Date.parse(newUpdated)))
        || (oldUpdated === newUpdated && Date.parse(previous.bundle.createdAt) > Date.parse(bundle.createdAt))) return previous.backup;
    }
    const backup: HubChatBackupSummary = {
      id, remoteId: input.remoteId, remoteName: input.remoteName.trim(), sessionId: bundle.session.id,
      title: bundle.session.title, provider: bundle.session.provider, projectPath: bundle.session.projectPath,
      savedAt: new Date().toISOString(), sourceUpdatedAt: input.sourceUpdatedAt, bytes: Buffer.byteLength(JSON.stringify(bundle)),
    };
    try { atomicWrite(directory, join(directory, `${id}.json`), { backup, bundle }); }
    catch { fail('Could not save the local chat backup; the previous copy was preserved', 500); }
    summaries.set(id, { version: fileVersion(id), backup });
    return backup;
  };

  return {
    read,
    setEnabled: (enabled: boolean): HubChatBackupStatus => {
      if (typeof enabled !== 'boolean') fail('enabled must be a boolean');
      try { atomicWrite(resolve(stateDirectory), settingsPath, { enabled }); }
      catch { fail('Could not save local chat backup settings', 500); }
      return read();
    },
    sync: (input: { remoteId: string; remoteName: string; sourceUpdatedAt: string | null; bundle: unknown }) => save(input, false),
    import: (bundle: unknown, remoteName = 'Imported backup') => save({ remoteId: 'imported', remoteName, sourceUpdatedAt: null, bundle }, true),
    get: (id: string): ChatBackupBundle => load(id).bundle,
    remove: (id: string): HubChatBackupStatus => {
      if (!BACKUP_ID.test(id)) fail('Invalid chat backup id');
      try { unlinkSync(join(directory, `${id}.json`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('Could not delete the local chat backup', 500); }
      summaries.delete(id);
      return read();
    },
  };
}
