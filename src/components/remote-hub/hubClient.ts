import { isValidRefreshedToken } from '../../utils/authTokenShape';

import { remoteStorageKey } from './remoteTransport';
export type HubRemote = {
  id: string;
  name: string;
  port: number;
};
export type HubProject = {
  projectId: string;
  displayName: string;
  fullPath: string;
  sessions?: Array<{
    id: string;
    summary?: string;
    __provider?: string;
  }>;
  sessionMeta?: {
    total?: number;
    hasMore?: boolean;
  };
};
export type HubConversation = {
  remoteId: string;
  sessionId: string;
  title: string;
  projectId: string;
  projectPath: string;
  provider: string;
  lastActivity?: string | null;
  isArchived?: boolean;
};
export type HubGroup = {
  id: string;
  name: string;
  isPinned: boolean;
  members: HubConversation[];
};
export type HubGroupState = {
  revision: number;
  groups: HubGroup[];
  imported: string[];
};
export type HubRemoteState = {
  status: 'loading' | 'online' | 'offline' | 'login';
  projects: HubProject[];
  conversations: HubConversation[];
  total: number;
  running: string[];
  error?: string;
};
export const memberKey = (member: Pick<HubConversation, 'remoteId' | 'sessionId'>) => `${member.remoteId}:${member.sessionId}`;
export function remoteToken(remoteId: string) {
  return localStorage.getItem(remoteStorageKey(remoteId, 'auth-token'));
}
export async function remoteRequest(remoteId: string, path: string, options: RequestInit = {}) {
  if (!/^\/(api(?:\/|$)|health$)/.test(path)) throw new Error('Invalid remote API path');
  const token = remoteToken(remoteId);
  const response = await fetch(`/remote/${encodeURIComponent(remoteId)}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(options.method && options.method !== 'GET' ? 60_000 : 12_000),
    headers: {
      ...(token ? {
        Authorization: `Bearer ${token}`
      } : {}),
      ...(options.body ? {
        'Content-Type': 'application/json'
      } : {}),
      ...options.headers
    }
  });
  const refreshed = response.headers.get('X-Refreshed-Token');
  if (isValidRefreshedToken(refreshed)) localStorage.setItem(remoteStorageKey(remoteId, 'auth-token'), refreshed);
  if (response.status === 401 || response.headers.get('X-Auth-Error')) {
    localStorage.removeItem(remoteStorageKey(remoteId, 'auth-token'));
    throw new Error('LOGIN_REQUIRED');
  }
  const body = await response.json();
  if (!response.ok || body?.success === false) throw new Error(typeof body?.error === 'string' ? body.error : body?.error?.message || '远端请求失败');
  return body?.data ?? body;
}
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
export async function loadHubGroups(): Promise<HubGroupState> {
  const response = await fetch('/hub-api/groups');
  if (!response.ok) throw new Error('无法读取本机分组');
  return response.json();
}

/** Reapply the user's operation to the latest revision when another window saves first. */
export async function changeHubGroups(change: (state: HubGroupState) => HubGroupState): Promise<HubGroupState> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await loadHubGroups();
    const updated = change(structuredClone(current));
    const response = await fetch('/hub-api/groups', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...updated,
        revision: current.revision
      })
    });
    if (response.status === 409) continue;
    if (!response.ok) throw new Error('分组保存失败，请重试');
    return response.json();
  }
  throw new Error('另一个窗口正在修改分组，请重试');
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
