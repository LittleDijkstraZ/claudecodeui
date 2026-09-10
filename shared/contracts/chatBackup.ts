import type { LLMProvider } from './providers.js';

//----------------- PORTABLE CHAT BACKUP ------------
/** Versioned native conversation backup exchanged by Chat Backup and the local
 * Remote Hub store. Content is opaque provider JSONL, never executable settings.
 * File paths are portable relative names: main.jsonl or session-owned sidecars.
 * A source native id is required; restoring always allocates a fresh identity. */
export type ChatBackupBundle = {
  format: 'cloudcli-chat-backup';
  version: 1;
  createdAt: string;
  session: {
    id: string;
    provider: 'claude' | 'codex';
    title: string;
    projectPath: string;
    providerSessionId: string;
    model: string | null;
    effort: string | null;
  };
  files: Array<{ path: string; content: string }>;
};


/** Chooses whether automatic content sync follows Hub group membership or every conversation. */
export type ChatBackupScope = 'grouped' | 'all';

/** Read-only remote inventory metadata. Runtime status is an observation, never a request to restart work. */
export type ChatBackupSessionSnapshot = {
  sessionId: string;
  provider: LLMProvider;
  title: string;
  projectId: string | null;
  projectPath: string | null;
  model: string | null;
  effort: string | null;
  isArchived: boolean;
  updatedAt: string | null;
  history: 'native' | 'empty' | 'unsupported' | 'unavailable';
  contentVersion: string | null;
  runtimeStatus: 'running' | 'idle';
};

/** A stable inventory page, or one complete explicit-ID batch; absent IDs are reported separately. */
export type ChatBackupInventoryPage = {
  sessions: ChatBackupSessionSnapshot[];
  nextCursor: string | null;
  missingSessionIds: string[];
};

/** A Hub-scoped observation retained independently of transcript writes, including empty conversations. */
export type ChatBackupObservation = ChatBackupSessionSnapshot & {
  remoteId: string;
  remoteName: string;
  observedAt: string;
  attention: boolean | null;
};

/** Portable Hub organization record. Array order is significant; source identities are never destination IDs. */
export type ChatBackupGroupSnapshot = {
  format: 'cloudcli-chat-groups';
  version: 1;
  sourceId: string;
  capturedAt: string;
  revision: number;
  groups: Array<{
    id: string;
    name: string;
    isPinned: boolean;
    members: Array<{ remoteId: string; sessionId: string }>;
  }>;
  observations: ChatBackupObservation[];
};

/** A portable single-chat export with the companion group record needed to restore its original placement. */
export type LocalChatBackupExport = {
  format: 'cloudcli-local-chat-backup';
  version: 1;
  sourceRemoteId: string;
  bundle: ChatBackupBundle;
  groups: ChatBackupGroupSnapshot | null;
};

/** Independent destination conversation allocated during a native backup restore. */
export type RestoredChatBackup = {
  sessionId: string;
  provider: 'claude' | 'codex';
  projectPath: string;
  sessionName: string;
};
