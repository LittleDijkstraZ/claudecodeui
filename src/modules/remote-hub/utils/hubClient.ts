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

/** Reorder against the latest saved state without changing either pin section or group contents. */
export function moveHubGroup(state: HubGroupState, sourceGroupId: string, targetGroupId: string, position: 'before' | 'after'): HubGroupState {
  const source = state.groups.find(group => group.id === sourceGroupId);
  const target = state.groups.find(group => group.id === targetGroupId);
  if (!source || !target) throw new Error('分组已被删除，请刷新后重试');
  if (sourceGroupId === targetGroupId) return state;
  if (source.isPinned !== target.isPinned) throw new Error('只能在同一置顶区域内排序，请先通过菜单置顶或取消置顶');

  const section = state.groups.filter(group => group.isPinned === source.isPinned && group.id !== sourceGroupId);
  const targetIndex = section.findIndex(group => group.id === targetGroupId);
  section.splice(targetIndex + (position === 'after' ? 1 : 0), 0, source);

  // Persist only this section's order, keeping every other section slot and all metadata intact.
  let sectionIndex = 0;
  return {
    ...state,
    groups: state.groups.map(group => group.isPinned === source.isPinned ? section[sectionIndex++] : group)
  };
}
