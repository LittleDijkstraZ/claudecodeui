import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ChatBackupBundle, ChatBackupGroupSnapshot, ChatBackupObservation, ChatBackupScope, LocalChatBackupExport, HubChatBackupStatus, HubChatBackupSummary } from '../../shared/index.js';

import type { createHubGroupStore } from './remote-hub-state.js';

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_EXPORT_BYTES = 80 * 1024 * 1024;
const SOURCE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const BACKUP_ID = /^[a-f0-9]{64}$/;
const SESSION_ID = /^[a-zA-Z0-9_-]{1,160}$/;
type SavedBackup = { backup: HubChatBackupSummary; bundle: ChatBackupBundle; sourceRemoteId?: string; groups?: ChatBackupGroupSnapshot | null };
type Settings = { enabled: boolean; scope: ChatBackupScope; settingsRevision: number; warning?: string };
type SyncInput = { remoteId: string; remoteName: string; sourceUpdatedAt: string | null; bundle: unknown; settingsRevision: number; contentVersion: string | null };
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

function backupId(remoteId: string, bundle: ChatBackupBundle, sourceRemoteId?: string, groups?: ChatBackupGroupSnapshot | null) {
  const identity = [remoteId, bundle.session.provider, bundle.session.id];
  if (sourceRemoteId !== undefined) identity.push(sourceRemoteId, groups?.sourceId ?? '');
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function normalizeObservation(value: unknown): ChatBackupObservation {
  const row = object(value);
  if (!row || !text(row.remoteId, 200) || !row.remoteId || !text(row.remoteName, 200) || !row.remoteName.trim()
    || !text(row.sessionId, 160) || !SESSION_ID.test(row.sessionId) || !['claude', 'codex', 'cursor', 'opencode'].includes(String(row.provider))
    || !text(row.title, 4000) || (row.projectId !== null && !text(row.projectId, 4096)) || (row.projectPath !== null && !text(row.projectPath, 4096))
    || (row.model !== null && !text(row.model, 500)) || (row.effort !== null && !text(row.effort, 100))
    || typeof row.isArchived !== 'boolean' || (row.updatedAt !== null && !date(row.updatedAt))
    || !['native', 'empty', 'unsupported', 'unavailable'].includes(String(row.history))
    || (row.contentVersion !== null && !text(row.contentVersion, 512)) || !['running', 'idle'].includes(String(row.runtimeStatus))
    || !date(row.observedAt) || (row.attention !== null && typeof row.attention !== 'boolean')) fail('Invalid chat backup observation');
  return { remoteId: row.remoteId, remoteName: row.remoteName, sessionId: row.sessionId, provider: row.provider as ChatBackupObservation['provider'],
    title: row.title, projectId: row.projectId as string | null, projectPath: row.projectPath as string | null,
    model: row.model as string | null, effort: row.effort as string | null, isArchived: row.isArchived, updatedAt: row.updatedAt as string | null,
    history: row.history as ChatBackupObservation['history'], contentVersion: row.contentVersion as string | null, runtimeStatus: row.runtimeStatus as ChatBackupObservation['runtimeStatus'],
    observedAt: row.observedAt, attention: row.attention as boolean | null };
}

function normalizeSnapshot(value: unknown): ChatBackupGroupSnapshot {
  const row = object(value);
  if (!row || row.format !== 'cloudcli-chat-groups' || row.version !== 1 || !text(row.sourceId, 100) || !SOURCE_ID.test(row.sourceId)
    || !date(row.capturedAt) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
    || !Array.isArray(row.groups) || row.groups.length > 1000 || !Array.isArray(row.observations) || row.observations.length > 100000) fail('Invalid chat group snapshot');
  const groupIds = new Set<string>(); const members = new Set<string>(); const observed = new Set<string>();
  const groups = row.groups.map(value => {
    const group = object(value);
    if (!group || !text(group.id, 160) || !group.id.trim() || groupIds.has(group.id) || !text(group.name, 80) || !group.name.trim()
      || typeof group.isPinned !== 'boolean' || !Array.isArray(group.members) || group.members.length > 10000) fail('Invalid chat group snapshot');
    groupIds.add(group.id);
    return { id: group.id, name: group.name.trim(), isPinned: group.isPinned, members: group.members.map(value => {
      const member = object(value);
      if (!member || !text(member.remoteId, 200) || !member.remoteId || !text(member.sessionId, 160) || !SESSION_ID.test(member.sessionId)) fail('Invalid chat group member');
      const key = JSON.stringify([member.remoteId, member.sessionId]);
      if (members.has(key)) fail('Duplicate chat group member');
      members.add(key); return { remoteId: member.remoteId, sessionId: member.sessionId };
    }) };
  });
  const observations = row.observations.map(value => {
    const observation = normalizeObservation(value); const key = JSON.stringify([observation.remoteId, observation.sessionId]);
    if (observed.has(key)) fail('Duplicate chat backup observation');
    observed.add(key); return observation;
  });
  const snapshot: ChatBackupGroupSnapshot = { format: 'cloudcli-chat-groups', version: 1, sourceId: row.sourceId, capturedAt: row.capturedAt, revision: Number(row.revision), groups, observations };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) fail('Chat group snapshot exceeds the 8 MB limit', 413);
  return snapshot;
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

/** The local Hub and its routes use this opt-in disk store. Native transcripts,
 * organization snapshots and settings are independent atomic files. */
export function createHubChatBackupStore(stateDirectory: string, remoteIds: string[], groupsStore?: ReturnType<typeof createHubGroupStore>) {
  const root = resolve(stateDirectory);
  const directory = join(root, 'chat-backups');
  const snapshotDirectory = join(root, 'chat-backup-groups');
  const settingsPath = join(root, 'chat-backup-settings.json');
  const identityPath = join(root, 'chat-backup-source.json');
  const allowedRemotes = new Set(remoteIds);
  let captureWarning: string | undefined;
  const summaries = new Map<string, { version: string; backup: HubChatBackupSummary; sourceRemoteId: string; snapshotSourceId: string | null | undefined }>();

  const fileVersion = (id: string) => {
    const info = lstatSync(join(directory, `${id}.json`));
    if (!info.isFile() || info.isSymbolicLink()) fail('Invalid local chat backup file', 500);
    return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  };
  const settings = (): Settings => {
    try {
      const value = object(JSON.parse(readRegularFile(settingsPath, 4096)));
      if (!value || typeof value.enabled !== 'boolean' || (value.scope !== undefined && value.scope !== 'grouped' && value.scope !== 'all')
        || (value.settingsRevision !== undefined && (!Number.isSafeInteger(value.settingsRevision) || Number(value.settingsRevision) < 0))) throw new Error('Invalid settings');
      // Existing installations used all conversations before scopes existed.
      return { enabled: value.enabled, scope: value.scope ?? 'all', settingsRevision: Number(value.settingsRevision ?? 0) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: false, scope: 'grouped', settingsRevision: 0 };
      return { enabled: false, scope: 'grouped', settingsRevision: 0, warning: 'Could not read local chat backup settings; automatic sync is off. The settings file was preserved.' };
    }
  };
  const localSourceId = (): string | null => {
    try {
      const value = object(JSON.parse(readRegularFile(identityPath, 4096)));
      if (!value || typeof value.sourceId !== 'string' || !SOURCE_ID.test(value.sourceId)) throw new Error('Invalid source identity');
      return value.sourceId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      fail('Could not read the local backup source identity; its file was preserved.', 500);
    }
  };
  const ensureSourceId = () => {
    const existing = localSourceId();
    if (existing) return existing;
    const sourceId = randomUUID();
    atomicWrite(root, identityPath, { sourceId });
    return sourceId;
  };
  const getSnapshot = (sourceId: string): ChatBackupGroupSnapshot => {
    if (!SOURCE_ID.test(sourceId)) fail('Invalid chat backup source id');
    try {
      if (lstatSync(snapshotDirectory).isSymbolicLink()) throw new Error('Invalid snapshot directory');
      const snapshot = normalizeSnapshot(JSON.parse(readRegularFile(join(snapshotDirectory, `${sourceId}.json`), MAX_SNAPSHOT_BYTES)));
      if (snapshot.sourceId !== sourceId) throw new Error('Mismatched snapshot source');
      return snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('Chat group snapshot was not found', 404);
      fail('Could not read the chat group snapshot; its file was preserved for recovery.', 500);
    }
  };
  const optionalSnapshot = (sourceId: string | null) => {
    if (!sourceId) return null;
    try { return getSnapshot(sourceId); }
    catch (error) { if ((error as { statusCode?: number }).statusCode === 404) return null; throw error; }
  };
  const saveSnapshot = (snapshot: ChatBackupGroupSnapshot) => {
    atomicWrite(snapshotDirectory, join(snapshotDirectory, `${snapshot.sourceId}.json`), normalizeSnapshot(snapshot));
    return snapshot;
  };
  const memberKeys = () => new Set((groupsStore?.read().groups ?? []).flatMap(group => group.members.map(member => JSON.stringify([member.remoteId, member.sessionId]))));
  const assertSync = (revision: number) => {
    const config = settings();
    if (!config.enabled) fail('Local chat sync is disabled', 409);
    if (!Number.isSafeInteger(revision) || revision !== config.settingsRevision) fail('Local chat backup settings changed; refresh before syncing.', 409);
    return config;
  };
  const capture = (incoming: ChatBackupObservation[] = []) => {
    const sourceId = ensureSourceId();
    const previous = optionalSnapshot(sourceId);
    const groups = groupsStore?.read();
    const observations = new Map((previous?.observations ?? []).map(row => [JSON.stringify([row.remoteId, row.sessionId]), row]));
    for (const row of incoming) {
      const key = JSON.stringify([row.remoteId, row.sessionId]); const old = observations.get(key);
      if (!old || Date.parse(row.observedAt) > Date.parse(old.observedAt)) observations.set(key, row);
    }
    const groupRows = groups ? groups.groups.map(group => ({ id: group.id, name: group.name, isPinned: group.isPinned, members: group.members.map(({ remoteId, sessionId }) => ({ remoteId, sessionId })) })) : previous?.groups ?? [];
    // Group membership is always authoritative, including empty groups. An offline
    // inventory never erases observations from previously reachable remotes.
    const snapshot = normalizeSnapshot({ format: 'cloudcli-chat-groups', version: 1, sourceId, capturedAt: new Date().toISOString(), revision: groups?.revision ?? previous?.revision ?? 0, groups: groupRows, observations: [...observations.values()] });
    if (previous && previous.revision === snapshot.revision && JSON.stringify(previous.groups) === JSON.stringify(snapshot.groups) && JSON.stringify(previous.observations) === JSON.stringify(snapshot.observations)) return previous;
    return saveSnapshot(snapshot);
  };
  const captureGroups = () => {
    if (!settings().enabled) return;
    try { capture(); captureWarning = undefined; }
    catch { captureWarning = 'Could not update the group backup. Saved groups and existing backup files were preserved.'; }
  };
  const importSnapshot = (input: unknown): ChatBackupGroupSnapshot => {
    const snapshot = normalizeSnapshot(input);
    const previous = optionalSnapshot(snapshot.sourceId);
    // Importing this computer's own export must not replace current authoritative groups.
    if (snapshot.sourceId === localSourceId()) {
      if (previous) return previous;
      fail('The local group snapshot is unavailable; preserve the imported file for recovery.', 409);
    }
    if (!previous) return saveSnapshot(snapshot);
    const newer = snapshot.revision > previous.revision || (snapshot.revision === previous.revision && Date.parse(snapshot.capturedAt) > Date.parse(previous.capturedAt));
    const observations = new Map(previous.observations.map(row => [JSON.stringify([row.remoteId, row.sessionId]), row]));
    for (const row of snapshot.observations) {
      const key = JSON.stringify([row.remoteId, row.sessionId]); const old = observations.get(key);
      if (!old || Date.parse(row.observedAt) > Date.parse(old.observedAt)) observations.set(key, row);
    }
    return saveSnapshot(normalizeSnapshot({ ...(newer ? snapshot : previous), observations: [...observations.values()] }));
  };
  const load = (id: string): SavedBackup => {
    if (!BACKUP_ID.test(id)) fail('Invalid chat backup id');
    try {
      const directoryInfo = lstatSync(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Invalid backup directory');
      const value = object(JSON.parse(readRegularFile(join(directory, `${id}.json`), MAX_EXPORT_BYTES)));
      const backup = object(value?.backup); const bundle = normalizeBundle(value?.bundle);
      const sourceRemoteId = value?.sourceRemoteId;
      const groups = value?.groups === undefined || value.groups === null ? null : normalizeSnapshot(value.groups);
      if (!backup || backup.id !== id || !text(backup.remoteId, 200) || !backup.remoteId
        || !text(backup.remoteName, 200) || !backup.remoteName || !date(backup.savedAt)
        || (backup.sourceUpdatedAt !== null && !date(backup.sourceUpdatedAt))
        || (backup.contentVersion !== undefined && backup.contentVersion !== null && !text(backup.contentVersion, 512))
        || (sourceRemoteId !== undefined && (!text(sourceRemoteId, 200) || !sourceRemoteId))
        || backupId(backup.remoteId, bundle, sourceRemoteId as string | undefined, groups) !== id) throw new Error('Invalid backup metadata');
      return { bundle, ...(sourceRemoteId !== undefined ? { sourceRemoteId: sourceRemoteId as string, groups } : {}),
        backup: { id, remoteId: backup.remoteId, remoteName: backup.remoteName, sessionId: bundle.session.id, title: bundle.session.title,
          provider: bundle.session.provider, projectPath: bundle.session.projectPath, savedAt: backup.savedAt,
          sourceUpdatedAt: backup.sourceUpdatedAt as string | null, bytes: Buffer.byteLength(JSON.stringify(bundle)),
          ...(backup.contentVersion !== undefined ? { contentVersion: backup.contentVersion as string | null } : {}) } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('Chat backup was not found', 404);
      fail(`Could not read chat backup ${id}; its file was preserved for recovery`, 500);
    }
  };
  const read = (): HubChatBackupStatus => {
    const config = settings(); const backups: HubChatBackupSummary[] = []; const snapshots: ChatBackupGroupSnapshot[] = [];
    const warnings = config.warning ? [config.warning] : [];
    if (captureWarning) warnings.push(captureWarning);
    let sourceId: string | null = null;
    try { sourceId = localSourceId(); } catch { warnings.push('Could not read the local backup source identity. Its file was preserved.'); }
    try {
      if (lstatSync(directory).isSymbolicLink()) throw new Error('Invalid backup directory');
      for (const name of readdirSync(directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        try {
          const id = name.slice(0, -5); const version = fileVersion(id); const cached = summaries.get(id);
          if (cached?.version === version) backups.push(cached.backup);
          else {
            const saved = load(id);
            summaries.set(id, { version, backup: saved.backup, sourceRemoteId: saved.sourceRemoteId ?? saved.backup.remoteId,
              snapshotSourceId: saved.sourceRemoteId !== undefined ? saved.groups?.sourceId ?? null : saved.backup.remoteId === 'imported' ? null : undefined });
            backups.push(saved.backup);
          }
        } catch { warnings.push(`Could not read chat backup ${name}; its file was preserved for recovery.`); }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('Could not read the local chat backup directory. Existing files were preserved.');
    }
    try {
      if (lstatSync(snapshotDirectory).isSymbolicLink()) throw new Error('Invalid snapshot directory');
      for (const name of readdirSync(snapshotDirectory)) {
        if (!name.endsWith('.json') || !SOURCE_ID.test(name.slice(0, -5))) continue;
        try { snapshots.push(getSnapshot(name.slice(0, -5))); }
        catch { warnings.push(`Could not read group snapshot ${name}; its file was preserved for recovery.`); }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('Could not read the group backup directory. Existing files were preserved.');
    }
    const observationBySource = new Map(snapshots.map(snapshot => [snapshot.sourceId, new Map(snapshot.observations.map(row => [JSON.stringify([row.remoteId, row.sessionId]), row]))]));
    for (let index = 0; index < backups.length; index += 1) {
      const backup = backups[index]; const cached = summaries.get(backup.id);
      const snapshotSourceId = cached?.snapshotSourceId === undefined ? sourceId : cached.snapshotSourceId;
      const observation = snapshotSourceId ? observationBySource.get(snapshotSourceId)?.get(JSON.stringify([cached?.sourceRemoteId, backup.sessionId])) : undefined;
      if (observation?.provider === backup.provider) backups[index] = { ...backup, title: observation.title };
    }
    backups.sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt));
    snapshots.sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt));
    const present = new Set(backups.map(backup => backup.id));
    for (const id of summaries.keys()) if (!present.has(id)) summaries.delete(id);
    return { enabled: config.enabled, scope: config.scope, settingsRevision: config.settingsRevision, sourceId, directory, backups, snapshots, ...(warnings.length ? { warnings } : {}) };
  };
  const save = (input: { remoteId: string; remoteName: string; sourceUpdatedAt: string | null; bundle: ChatBackupBundle; contentVersion?: string | null; sourceRemoteId?: string; groups?: ChatBackupGroupSnapshot | null }, imported: boolean): HubChatBackupSummary => {
    if (!text(input.remoteName, 200) || !input.remoteName.trim() || (input.sourceUpdatedAt !== null && !date(input.sourceUpdatedAt))
      || (input.contentVersion !== undefined && input.contentVersion !== null && !text(input.contentVersion, 512))) fail('Invalid chat backup source');
    const bundle = input.bundle; const id = backupId(input.remoteId, bundle, input.sourceRemoteId, input.groups);
    let previous: SavedBackup | undefined;
    try { previous = load(id); } catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
    if (!imported && previous) {
      const oldUpdated = previous.backup.sourceUpdatedAt; const newUpdated = input.sourceUpdatedAt;
      if ((oldUpdated && (!newUpdated || Date.parse(oldUpdated) > Date.parse(newUpdated)))
        || (oldUpdated === newUpdated && Date.parse(previous.bundle.createdAt) > Date.parse(bundle.createdAt))) return previous.backup;
    }
    const backup: HubChatBackupSummary = { id, remoteId: input.remoteId, remoteName: input.remoteName.trim(), sessionId: bundle.session.id,
      title: bundle.session.title, provider: bundle.session.provider, projectPath: bundle.session.projectPath,
      savedAt: new Date().toISOString(), sourceUpdatedAt: input.sourceUpdatedAt, bytes: Buffer.byteLength(JSON.stringify(bundle)), contentVersion: input.contentVersion ?? null };
    try { atomicWrite(directory, join(directory, `${id}.json`), { backup, bundle, ...(input.sourceRemoteId !== undefined ? { sourceRemoteId: input.sourceRemoteId, groups: input.groups ?? null } : {}) }); }
    catch { fail('Could not save the local chat backup; the previous copy was preserved', 500); }
    summaries.set(id, { version: fileVersion(id), backup, sourceRemoteId: input.sourceRemoteId ?? input.remoteId,
      snapshotSourceId: input.sourceRemoteId !== undefined ? input.groups?.sourceId ?? null : input.remoteId === 'imported' ? null : undefined }); return backup;
  };
  const setSettings = (input: { enabled?: boolean; scope?: ChatBackupScope; settingsRevision?: number }): HubChatBackupStatus => {
    if (!object(input) || (input.enabled === undefined && input.scope === undefined) || (input.enabled !== undefined && typeof input.enabled !== 'boolean')
      || (input.scope !== undefined && input.scope !== 'grouped' && input.scope !== 'all')) fail('Invalid local chat backup settings');
    const previous = settings();
    if (input.settingsRevision !== undefined && input.settingsRevision !== previous.settingsRevision) fail('Local chat backup settings changed; reload and retry.', 409);
    const enabled = input.enabled ?? previous.enabled; const scope = input.scope ?? previous.scope;
    if (previous.settingsRevision >= Number.MAX_SAFE_INTEGER) fail('Local chat backup settings revision limit reached.', 500);
    const settingsRevision = previous.settingsRevision + 1;
    try { atomicWrite(root, settingsPath, { enabled, scope, settingsRevision }); }
    catch { fail('Could not save local chat backup settings', 500); }
    if (enabled) captureGroups();
    return read();
  };
  const getRestoreContext = (id: string) => {
    const saved = load(id);
    const groups = saved.sourceRemoteId !== undefined ? (optionalSnapshot(saved.groups?.sourceId ?? null) ?? saved.groups ?? null)
      : saved.backup.remoteId === 'imported' ? null : optionalSnapshot(localSourceId());
    const sourceRemoteId = saved.sourceRemoteId ?? saved.backup.remoteId;
    const observation = groups?.observations.find(row => row.remoteId === sourceRemoteId && row.sessionId === saved.bundle.session.id && row.provider === saved.bundle.session.provider);
    const bundle = observation ? { ...saved.bundle, session: { ...saved.bundle.session, title: observation.title, model: observation.model, effort: observation.effort } } : saved.bundle;
    return { bundle, sourceRemoteId, groups };
  };
  // An already opted-in Hub captures authoritative organization after a restart,
  // even if no browser is open and no conversation content changed.
  captureGroups();
  return {
    read, setSettings, captureGroups, getSnapshot, importSnapshot, getRestoreContext,
    setEnabled: (enabled: boolean) => setSettings({ enabled }),
    sync: (input: SyncInput) => {
      const config = assertSync(input.settingsRevision);
      if (!allowedRemotes.has(input.remoteId)) fail('Unknown source remote');
      const bundle = normalizeBundle(input.bundle);
      if (config.scope === 'grouped' && !memberKeys().has(JSON.stringify([input.remoteId, bundle.session.id]))) fail('This conversation is outside the current backup scope.', 409);
      if (input.contentVersion !== null && !text(input.contentVersion, 512)) fail('Invalid chat content version');
      return save({ ...input, bundle }, false);
    },
    observe: (input: { settingsRevision: number; observations: unknown }) => {
      if (!object(input)) fail('Invalid chat backup observations');
      const config = assertSync(input.settingsRevision);
      if (!Array.isArray(input.observations) || input.observations.length > 100000) fail('Invalid chat backup observations');
      const rows = input.observations.map(normalizeObservation); const members = memberKeys();
      if (rows.some(row => !allowedRemotes.has(row.remoteId))) fail('Unknown source remote');
      capture(rows.filter(row => config.scope === 'all' || members.has(JSON.stringify([row.remoteId, row.sessionId]))));
      captureWarning = undefined; return read();
    },
    import: (input: unknown, remoteName = 'Imported backup'): { backup?: HubChatBackupSummary; snapshot?: ChatBackupGroupSnapshot } => {
      if (!text(remoteName, 200) || !remoteName.trim()) fail('Invalid chat backup source');
      const raw = object(input);
      if (raw?.format === 'cloudcli-chat-groups') return { snapshot: importSnapshot(input) };
      if (raw?.format === 'cloudcli-local-chat-backup') {
        if (raw.version !== 1 || !text(raw.sourceRemoteId, 200) || !raw.sourceRemoteId || raw.groups === undefined) fail('Invalid portable local chat backup');
        const bundle = normalizeBundle(raw.bundle); const groups = raw.groups === null ? null : normalizeSnapshot(raw.groups);
        const canonical: LocalChatBackupExport = { format: 'cloudcli-local-chat-backup', version: 1, sourceRemoteId: raw.sourceRemoteId, bundle, groups };
        if (Buffer.byteLength(JSON.stringify(canonical)) > MAX_EXPORT_BYTES) fail('Portable chat backup exceeds the 80 MB limit', 413);
        const snapshot = groups ? importSnapshot(groups) : undefined;
        return { backup: save({ remoteId: 'imported', remoteName, sourceUpdatedAt: null, bundle, sourceRemoteId: raw.sourceRemoteId, groups }, true), ...(snapshot ? { snapshot } : {}) };
      }
      return { backup: save({ remoteId: 'imported', remoteName, sourceUpdatedAt: null, bundle: normalizeBundle(input) }, true) };
    },
    get: (id: string): ChatBackupBundle => getRestoreContext(id).bundle,
    exportBackup: (id: string): LocalChatBackupExport => ({ format: 'cloudcli-local-chat-backup', version: 1, ...getRestoreContext(id) }),
    remove: (id: string): HubChatBackupStatus => {
      if (!BACKUP_ID.test(id)) fail('Invalid chat backup id');
      try { unlinkSync(join(directory, `${id}.json`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('Could not delete the local chat backup', 500); }
      summaries.delete(id); return read();
    },
  };
}
