import type { LLMProvider } from './app';

/** Personal organization metadata; a group never changes a session's working folder. */
export type ConversationGroup = {
  id: string;
  name: string;
  sessionCount: number;
  isPinned: boolean;
};

export type ConversationGroupsSnapshot = {
  groups: ConversationGroup[];
  memberships: Record<string, string>;
};

export type GroupConversation = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  lastActivity: string | null;
  isArchived: boolean;
};

export type GroupConversationsPage = {
  conversations: GroupConversation[];
  total: number;
  hasMore: boolean;
};

export type CreatedGroupConversation = {
  sessionId: string;
  provider: LLMProvider;
  projectPath: string;
  projectId: string;
  sessionName: string;
};
