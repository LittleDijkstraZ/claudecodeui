import { authenticatedFetch } from '../../../utils/api';

export type RewindMode = 'conversation' | 'files' | 'both';
export type ClaudeSessionCapabilities = {
  sideChat: boolean;
  sideChatWhileRunning?: boolean;
  conversationRewind: boolean;
  fileRewind: 'preview-required';
  isBusy: boolean;
  messageIds: string[];
  userMessageIds: string[];
  relationship: { parentSessionId: string; sourceMessageId: string | null; kind: 'side_chat' | 'rewind_backup' } | null;
  fileScope: string;
  conversationBoundary: 'includes-selected-message';
};

export type ForkedClaudeSession = {
  sessionId: string;
  parentSessionId: string;
  provider: 'claude';
  projectId: string;
  projectPath: string;
  sessionName: string;
  sharesProjectFiles: boolean;
  inheritedFileCheckpoints: boolean;
};

export type RewindPreview = {
  previewToken: string;
  expiresAt: number;
  messageId: string;
  mode: RewindMode;
  canRewind: boolean;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  error: string | null;
  fileScope: string;
  conversationBoundary: 'includes-selected-message';
};

export type RewindResult = {
  sessionId: string;
  provider: 'claude';
  projectId: string;
  projectPath: string;
  sessionName: string;
  mode: RewindMode;
  contextChanged: boolean;
  contextRevision: string;
  backupSessionId: string | null;
};

async function request<T>(sessionId: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await authenticatedFetch(`/api/claude-sessions/${encodeURIComponent(sessionId)}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true || !payload.data) {
    const message = payload?.error?.message ?? payload?.error ?? payload?.message;
    throw new Error(typeof message === 'string' ? message : `Request failed (${response.status})`);
  }
  return payload.data as T;
}

export function getClaudeSessionCapabilities(sessionId: string, signal?: AbortSignal): Promise<ClaudeSessionCapabilities> {
  return request(sessionId, '/capabilities', undefined, signal);
}

export function forkClaudeSession(sessionId: string, messageId?: string): Promise<ForkedClaudeSession> {
  return request(sessionId, '/fork', { ...(messageId ? { messageId } : {}) });
}

export function previewClaudeRewind(sessionId: string, messageId: string, mode: RewindMode, signal?: AbortSignal): Promise<RewindPreview> {
  return request(sessionId, '/rewind/preview', { messageId, mode }, signal);
}

export function rewindClaudeSession(sessionId: string, messageId: string, mode: RewindMode, previewToken: string): Promise<RewindResult> {
  return request(sessionId, '/rewind', { messageId, mode, previewToken });
}
