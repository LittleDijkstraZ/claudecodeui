import type { LLMProvider } from '../types/app';
import type {
  ConversationGroup,
  ConversationGroupsSnapshot,
  CreatedGroupConversation,
  GroupConversationsPage,
} from '../types/conversationGroups';

import { authenticatedFetch } from './api';

const BASE = '/api/conversation-groups';

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await authenticatedFetch(`${BASE}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true || !payload.data) {
    const message = payload?.error?.message ?? payload?.error ?? payload?.message;
    throw new Error(typeof message === 'string' ? message : `Request failed (${response.status})`);
  }
  return payload.data as T;
}

export function listConversationGroups(): Promise<ConversationGroupsSnapshot> {
  return request('');
}

export async function createConversationGroup(name: string): Promise<ConversationGroup> {
  const data = await request<{ group: ConversationGroup }>('', 'POST', { name });
  return data.group;
}

export async function renameConversationGroup(id: string, name: string): Promise<ConversationGroup> {
  const data = await request<{ group: ConversationGroup }>(`/${encodeURIComponent(id)}`, 'PATCH', { name });
  return data.group;
}

export async function pinConversationGroup(id: string, isPinned: boolean): Promise<ConversationGroup> {
  const data = await request<{ group: ConversationGroup }>(`/${encodeURIComponent(id)}`, 'PATCH', { isPinned });
  return data.group;
}

/** Move relative to a known member without replacing unloaded or filtered rows. */
export async function moveGroupConversation(
  groupId: string,
  sessionId: string,
  targetSessionId: string,
  position: 'before' | 'after',
): Promise<void> {
  await request(`/${encodeURIComponent(groupId)}/sessions/reorder`, 'POST', { sessionId, targetSessionId, position });
}

export async function deleteConversationGroup(id: string): Promise<void> {
  await request(`/${encodeURIComponent(id)}`, 'DELETE');
}

export async function assignConversationGroup(sessionId: string, groupId: string | null): Promise<void> {
  await request(`/sessions/${encodeURIComponent(sessionId)}`, 'PUT', { groupId });
}

export function listGroupConversations(
  groupId: string,
  { limit = 40, offset = 0, query = '' }: { limit?: number; offset?: number; query?: string } = {},
): Promise<GroupConversationsPage> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset), query });
  return request(`/${encodeURIComponent(groupId)}/sessions?${params}`);
}

export function createGroupConversation(
  groupId: string,
  provider: LLMProvider,
  projectPath: string,
): Promise<CreatedGroupConversation> {
  return request(`/${encodeURIComponent(groupId)}/sessions`, 'POST', { provider, projectPath });
}
