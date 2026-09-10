import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type HubMember = {
  remoteId: string;
  sessionId: string;
  title: string;
  projectId: string;
  projectPath: string;
  provider: string;
  lastActivity?: string | null;
  isArchived?: boolean;
};
type HubState = { revision: number; groups: Array<{ id: string; name: string; isPinned: boolean; members: HubMember[] }>; imported: string[] };
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The loopback hub route uses this local metadata store; it never touches project files. */
export function createHubGroupStore(directory: string, remoteIds: string[], onChanged?: () => void) {
  const idsAllowed = new Set(remoteIds);
  const statePath = join(directory, 'groups.json');
  const normalize = (value: unknown): HubState | null => {
    const body = object(value);
    if (!body || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0 || Number(body.revision) >= Number.MAX_SAFE_INTEGER
      || !Array.isArray(body.groups) || body.groups.length > 1000 || !Array.isArray(body.imported) || body.imported.length > 1000
      || body.imported.some((item) => typeof item !== 'string' || item.length > 200)) return null;
    const groups: HubState['groups'] = []; const groupIds = new Set<string>(); const memberIds = new Set<string>();
    for (const raw of body.groups) {
      const group = object(raw);
      if (!group || typeof group.id !== 'string' || !group.id.trim() || group.id.length > 160 || groupIds.has(group.id)
        || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 80 || typeof group.isPinned !== 'boolean'
        || !Array.isArray(group.members) || group.members.length > 10000) return null;
      groupIds.add(group.id); const members: HubMember[] = [];
      for (const rawMember of group.members) {
        const member = object(rawMember);
        if (!member || typeof member.remoteId !== 'string' || !idsAllowed.has(member.remoteId)
          || typeof member.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(member.sessionId)
          || ['title', 'projectId', 'projectPath'].some((key) => typeof member[key] !== 'string' || member[key].length > 4096)
          || typeof member.provider !== 'string' || !['claude', 'codex', 'cursor', 'opencode'].includes(member.provider)
          || (member.lastActivity !== undefined && member.lastActivity !== null && (typeof member.lastActivity !== 'string' || member.lastActivity.length > 100))
          || (member.isArchived !== undefined && typeof member.isArchived !== 'boolean')) return null;
        const key = `${member.remoteId}:${member.sessionId}`;
        if (memberIds.has(key)) return null;
        memberIds.add(key);
        members.push({ remoteId: member.remoteId, sessionId: member.sessionId, title: member.title as string, projectId: member.projectId as string, projectPath: member.projectPath as string, provider: member.provider,
          ...(member.lastActivity !== undefined ? { lastActivity: member.lastActivity as string | null } : {}), ...(member.isArchived !== undefined ? { isArchived: member.isArchived } : {}) });
      }
      groups.push({ id: group.id, name: group.name.trim(), isPinned: group.isPinned, members });
    }
    return { revision: body.revision as number, groups, imported: [...new Set(body.imported as string[])] };
  };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let state: HubState = { revision: 0, groups: [], imported: [] };
  try {
    const saved = normalize(JSON.parse(readFileSync(statePath, 'utf8')));
    if (!saved) throw new Error('Invalid saved hub group state');
    state = saved;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not load local hub groups; preserve groups.json for recovery'); }
  return {
    read: () => state,
    replace: (payload: unknown): { status: number; body: HubState | { error: string } } => {
      const body = normalize(payload);
      if (!body) return { status: 400, body: { error: 'Invalid group state' } };
      if (body.revision !== state.revision) return { status: 409, body: { error: 'Group state changed; reload and retry' } };
      const next = { ...body, revision: state.revision + 1 };
      const temporary = `${statePath}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 }); renameSync(temporary, statePath); state = next;
        // A backup observer cannot turn an already committed group edit into a failed edit.
        try { onChanged?.(); } catch { /* The observer reports its own recoverable backup warning. */ }
        return { status: 200, body: state };
      } catch {
        try { unlinkSync(temporary); } catch { /* The atomic write may not have created its temporary file. */ }
        return { status: 500, body: { error: 'Could not save local groups' } };
      }
    },
  };
}
