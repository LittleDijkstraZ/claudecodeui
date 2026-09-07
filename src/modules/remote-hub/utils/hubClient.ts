import type { HubConversation, HubGroupState } from '@/shared/types';

export const memberKey = (member: Pick<HubConversation, 'remoteId' | 'sessionId'>) => `${member.remoteId}:${member.sessionId}`;
export function normalizeConversation(remoteId: string, row: Record<string, unknown>): HubConversation {
  return {
    remoteId,
    sessionId: String(row.sessionId ?? row.id),
    title: String(row.sessionTitle ?? row.summary ?? row.title ?? '新对话'),
    projectId: String(row.projectId ?? row.__projectId ?? ''),
    projectPath: String(row.projectPath ?? ''),
    provider: String(row.provider ?? row.__provider ?? 'claude'),
    lastActivity: row.lastActivity as string | null,
    isArchived: Boolean(row.isArchived)
  };
}
export function moveHubMember(state: HubGroupState, groupId: string, source: string, target: string, position: 'before' | 'after'): HubGroupState {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) throw new Error('分组已被删除');
  const from = group.members.findIndex(m => memberKey(m) === source);
  if (from < 0 || !group.members.some(m => memberKey(m) === target)) throw new Error('会话已移出分组，请刷新');
  if (source === target) return state;
  const [member] = group.members.splice(from, 1);
  group.members.splice(group.members.findIndex(m => memberKey(m) === target) + (position === 'after' ? 1 : 0), 0, member);
  return state;
}
