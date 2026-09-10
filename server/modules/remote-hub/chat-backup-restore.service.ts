import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ChatBackupGroupSnapshot, RestoredChatBackup } from '../../shared/index.js';

import type { createHubChatBackupStore } from './chat-backup-store.service.js';
import type { createHubGroupStore } from './remote-hub-state.js';

type GroupState = ReturnType<ReturnType<typeof createHubGroupStore>['read']>;
type Member = GroupState['groups'][number]['members'][number];
type RestoreMapping = { sourceId: string; sourceRemoteId: string; sourceSessionId: string; target: Member };
const MAX_MAPPING_BYTES = 8 * 1024 * 1024;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= maximum && !value.includes('\0');
const sessionId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const sourceKey = (sourceId: string, remoteId: string, id: string) => JSON.stringify([sourceId, remoteId, id]);
const targetKey = (member: Pick<Member, 'remoteId' | 'sessionId'>) => JSON.stringify([member.remoteId, member.sessionId]);
function fail(message: string, statusCode = 400): never { throw Object.assign(new Error(message), { statusCode }); }

/** The local backup router uses this metadata-only restore coordinator. Native
 * chat restoration happens on the chosen remote first; this service never sends
 * prompts or starts processes. Durable source-to-destination mappings make a
 * failed group update retryable without copying the native conversation again. */
export function createHubChatBackupRestoreService(
  stateDirectory: string,
  remoteIds: string[],
  backups: ReturnType<typeof createHubChatBackupStore>,
  groups: ReturnType<typeof createHubGroupStore>,
) {
  const directory = resolve(stateDirectory);
  const mappingPath = join(directory, 'chat-backup-restores.json');
  const allowedRemotes = new Set(remoteIds);

  const readMappings = (): RestoreMapping[] => {
    try {
      const info = lstatSync(mappingPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MAPPING_BYTES) throw new Error('Invalid mapping file');
      const value = object(JSON.parse(readFileSync(mappingPath, 'utf8')));
      if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 10000) throw new Error('Invalid mappings');
      const seen = new Set<string>();
      return value.entries.map(raw => {
        const row = object(raw); const member = object(row?.target);
        if (!row || !text(row.sourceId, 160) || !text(row.sourceRemoteId, 200) || !sessionId(row.sourceSessionId)
          || !member || !text(member.remoteId, 200) || !sessionId(member.sessionId)
          || typeof member.title !== 'string' || member.title.length > 4000 || member.title.includes('\0')
          || typeof member.projectId !== 'string' || member.projectId.length > 4096 || member.projectId.includes('\0')
          || !text(member.projectPath, 4096) || !['claude', 'codex'].includes(String(member.provider))) throw new Error('Invalid mapping');
        const key = sourceKey(row.sourceId, row.sourceRemoteId, row.sourceSessionId);
        if (seen.has(key)) throw new Error('Duplicate mapping');
        seen.add(key);
        return { sourceId: row.sourceId, sourceRemoteId: row.sourceRemoteId, sourceSessionId: row.sourceSessionId,
          target: { remoteId: member.remoteId, sessionId: member.sessionId, title: member.title,
            projectId: member.projectId, projectPath: member.projectPath, provider: member.provider as string } };
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      fail('Could not read restored conversation mappings; the existing file was preserved.', 500);
    }
  };

  const saveMappings = (entries: RestoreMapping[]) => {
    const contents = JSON.stringify({ version: 1, entries });
    if (entries.length > 10000 || Buffer.byteLength(contents) > MAX_MAPPING_BYTES) fail('Too many restored conversation mappings.', 413);
    const temporary = `${mappingPath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (lstatSync(directory).isSymbolicLink()) throw new Error('Invalid directory');
      chmodSync(directory, 0o700);
      writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, mappingPath);
    } catch {
      try { unlinkSync(temporary); } catch { /* A failed write may not create a temporary file. */ }
      fail('Could not save restored conversation mappings; the earlier copy was preserved.', 500);
    }
  };

  const apply = (snapshot: ChatBackupGroupSnapshot, mappings: RestoreMapping[], onlySource?: string): GroupState => {
    const next = structuredClone(groups.read());
    const localSource = backups.read().sourceId === snapshot.sourceId;
    const mapped = new Map(mappings.filter(row => row.sourceId === snapshot.sourceId && allowedRemotes.has(row.target.remoteId))
      .map(row => [sourceKey(row.sourceId, row.sourceRemoteId, row.sourceSessionId), row.target]));
    const affected = new Set([...mapped.entries()].filter(([key]) => !onlySource || key === onlySource).map(([, member]) => targetKey(member)));
    const placements = new Map<string, Array<{ member: Member; index: number }>>();
    const destinationId = (id: string) => localSource ? id : `backup-${createHash('sha256').update(sourceKey(snapshot.sourceId, 'group', id)).digest('hex').slice(0, 40)}`;
    for (const source of snapshot.groups) {
      const id = destinationId(source.id);
      let target = next.groups.find(group => group.id === id);
      if (!target) {
        target = { id, name: source.name, isPinned: source.isPinned, members: [] };
        next.groups.push(target);
      } else if (!onlySource) {
        // Explicit "restore groups" reapplies metadata only for this source's
        // groups. Adding one restored chat keeps subsequent local renames.
        target.name = source.name;
        target.isPinned = source.isPinned;
      }
      const selected: Array<{ member: Member; index: number }> = [];
      source.members.forEach((member, index) => {
        const key = sourceKey(snapshot.sourceId, member.remoteId, member.sessionId);
        const restored = mapped.get(key);
        if (restored && (!onlySource || key === onlySource)) selected.push({ member: restored, index });
      });
      placements.set(id, selected);
    }
    // A source conversation that is now ungrouped stays ungrouped. Other local
    // members and groups are never removed by restoring this source's metadata.
    for (const group of next.groups) group.members = group.members.filter(member => !affected.has(targetKey(member)));
    for (const source of snapshot.groups) {
      const id = destinationId(source.id);
      const target = next.groups.find(group => group.id === id)!;
      const rank = new Map<string, number>();
      source.members.forEach((member, index) => {
        const restored = mapped.get(sourceKey(snapshot.sourceId, member.remoteId, member.sessionId));
        if (restored) rank.set(targetKey(restored), index);
      });
      if (onlySource) {
        // Insert the newly restored chat in its recorded position without
        // reordering members the user has already arranged on this Hub.
        for (const entry of placements.get(id) ?? []) {
          const before = target.members.findIndex(member => (rank.get(targetKey(member)) ?? Number.MAX_SAFE_INTEGER) > entry.index);
          target.members.splice(before < 0 ? target.members.length : before, 0, entry.member);
        }
      } else {
        const combined = [...target.members, ...(placements.get(id) ?? []).map(entry => entry.member)];
        target.members = combined.sort((left, right) => (rank.get(targetKey(left)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(targetKey(right)) ?? Number.MAX_SAFE_INTEGER));
      }
    }
    if (!onlySource) {
      const ordered = snapshot.groups.map(source => next.groups.find(group => group.id === destinationId(source.id))!);
      const ids = new Set(ordered.map(group => group.id));
      let index = 0;
      // Replace only this source's existing slots; unrelated local groups keep
      // both their positions and relative order when the source was reordered.
      next.groups = next.groups.map(group => ids.has(group.id) ? ordered[index++] : group);
    }
    const result = groups.replace(next);
    if (result.status !== 200 || !('groups' in result.body)) fail('The chat was restored, but its group could not be saved. Retry the group update.', result.status);
    return result.body;
  };

  return {
    restoreGroups(sourceId: unknown): GroupState {
      if (!text(sourceId, 160)) fail('Invalid backup source.');
      return apply(backups.getSnapshot(sourceId), readMappings());
    },
    recordRestore(input: unknown): GroupState {
      const value = object(input); const result = object(value?.result);
      if (!value || typeof value.backupId !== 'string' || !/^[a-f0-9]{64}$/.test(value.backupId)
        || typeof value.remoteId !== 'string' || !allowedRemotes.has(value.remoteId)
        || !result || !sessionId(result.sessionId) || !text(result.projectPath, 4096)
        || typeof result.sessionName !== 'string' || result.sessionName.length > 4000 || result.sessionName.includes('\0')
        || !['claude', 'codex'].includes(String(result.provider))) fail('Invalid restored conversation.');
      const context = backups.getRestoreContext(value.backupId);
      if (context.bundle.session.provider !== result.provider) fail('Restored conversation provider does not match its backup.');
      if (!context.groups) return groups.read();
      const restored = result as unknown as RestoredChatBackup;
      const key = sourceKey(context.groups.sourceId, context.sourceRemoteId, context.bundle.session.id);
      const mappings = readMappings().filter(row => sourceKey(row.sourceId, row.sourceRemoteId, row.sourceSessionId) !== key);
      mappings.push({ sourceId: context.groups.sourceId, sourceRemoteId: context.sourceRemoteId, sourceSessionId: context.bundle.session.id,
        target: { remoteId: value.remoteId, sessionId: restored.sessionId, title: restored.sessionName,
          projectId: '', projectPath: restored.projectPath, provider: restored.provider } });
      saveMappings(mappings);
      return apply(context.groups, mappings, key);
    },
  };
}
