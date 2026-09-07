import { createHash, randomUUID } from 'node:crypto';
import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';

import { deleteSession, forkSession, getSessionMessages, query } from '@anthropic-ai/claude-agent-sdk';
import type { RewindFilesResult, SessionMessage } from '@anthropic-ai/claude-agent-sdk';

import { claudeUsageService } from '@/modules/claude-usage/index.js';
import { claudeSessionActionsDb, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { isClaudeSessionActive } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { AppError, resolveClaudeCodeExecutablePath } from '@/shared/index.js';
import type { ClaudeSessionRewindMode } from '@/shared/index.js';

const FILE_SCOPE = 'Only checkpointed Write, Edit, and NotebookEdit changes can be restored. Shell commands, scripts, database operations, and most subagent edits are not covered. Old conversations and newly forked branches may have no file checkpoints.';
type Mode = ClaudeSessionRewindMode;
type Session = NonNullable<ReturnType<typeof sessionsDb.getSessionById>> & { provider_session_id: string; project_path: string; jsonl_path: string };
type Preview = { userId: number; sessionId: string; providerId: string; messageId: string; mode: Mode; fingerprint: string; filesFingerprint: string; files: RewindFilesResult; expiresAt: number };
type Dependencies = {
  fork: typeof forkSession;
  discardFork: typeof deleteSession;
  messages: typeof getSessionMessages;
  rewind: (session: Session, messageId: string, dryRun: boolean) => Promise<RewindFilesResult>;
  transcriptFingerprint: (session: Session) => Promise<string>;
  filesFingerprint: (session: Session, files: string[]) => Promise<string>;
  ensureFork: (session: Session, providerId: string) => Promise<string>;
  active: typeof isClaudeSessionActive;
  now: () => number;
};

function fail(message: string, code: string, statusCode = 409): never {
  throw new AppError(message, { code, statusCode });
}
function sourceSession(sessionId: string): Session {
  const row = sessionsDb.getSessionById(sessionId);
  if (!row) fail('Conversation was not found.', 'SESSION_NOT_FOUND', 404);
  if (row.provider !== 'claude') fail('This action is supported for Claude conversations only.', 'CLAUDE_SESSION_REQUIRED', 400);
  if (!row.provider_session_id || !row.project_path || !row.jsonl_path) fail('This conversation has no saved Claude history yet.', 'CLAUDE_HISTORY_UNAVAILABLE');
  return row as Session;
}
function isUserPrompt(message: SessionMessage): boolean {
  if (message.type !== 'user' || message.parent_tool_use_id) return false;
  const content = (message.message as { content?: unknown })?.content;
  return typeof content === 'string' ? Boolean(content.trim()) : Array.isArray(content) && content.some(item => item?.type === 'text' || item?.type === 'image');
}
function nativeMessageId(messages: SessionMessage[], input: string, userOnly: boolean): string {
  const matched = messages.find(message => (message.uuid === input || input.startsWith(`${message.uuid}_`)) && (!userOnly || isUserPrompt(message)));
  if (!matched) fail('This message is not in the current saved conversation. Refresh before trying again.', 'CLAUDE_MESSAGE_NOT_FOUND', 404);
  return matched.uuid;
}
async function fileStamp(filePath: string): Promise<unknown> {
  try {
    const value = await lstat(filePath);
    return [filePath, value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs, value.isSymbolicLink()];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [filePath, 'missing'];
    throw error;
  }
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

async function rewindTrackedFiles(session: Session, messageId: string, dryRun: boolean): Promise<RewindFilesResult> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 30_000);
  timeout.unref?.();
  // The SDK documents an empty prompt as the control-only resume path. No model
  // question is sent. Disable startup hooks and MCP tools for this file action.
  const response = query({ prompt: '', options: {
    resume: session.provider_session_id,
    cwd: session.project_path,
    pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH),
    env: { ...process.env },
    abortController,
    enableFileCheckpointing: true,
    extraArgs: { 'replay-user-messages': null },
    settingSources: ['project', 'user', 'local'],
    settings: { disableAllHooks: true },
    tools: [], mcpServers: {}, strictMcpConfig: true,
  } });
  try {
    for await (const message of response) {
      if (message.type === 'result' && message.subtype !== 'success') {
        fail('Claude could not open this checkpoint. The session may still be running elsewhere.', 'CLAUDE_CHECKPOINT_UNAVAILABLE');
      }
      return await response.rewindFiles(messageId, { dryRun });
    }
    return { canRewind: false, error: 'Claude did not open a checkpoint control session.' };
  } finally {
    clearTimeout(timeout);
    response.close();
  }
}

const defaults: Dependencies = {
  fork: forkSession, discardFork: deleteSession, messages: getSessionMessages, rewind: rewindTrackedFiles,
  transcriptFingerprint: async session => hash([session.provider_session_id, await fileStamp(session.jsonl_path)]),
  filesFingerprint: async (session, files) => hash(await Promise.all(files.slice().sort().map(file => fileStamp(path.resolve(session.project_path, file))))),
  ensureFork: async (session, providerId) => {
    const filename = path.join(path.dirname(session.jsonl_path), `${providerId}.jsonl`);
    if (!(await stat(filename)).isFile()) throw new Error('Claude did not persist the new branch.');
    return filename;
  },
  active: isClaudeSessionActive, now: Date.now,
};

/** Used by authenticated routes and focused tests; all SDK mutations remain on the owning remote. */
export function createClaudeSessionActionsService(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  const previews = new Map<string, Preview>();

  async function idle<T>(sessionId: string, operation: (session: Session) => Promise<T>, lockFiles = false): Promise<T> {
    const release = chatRunRegistry.reserveSessionMutation(sessionId);
    if (!release) fail('Wait until this conversation finishes before using this action.', 'CLAUDE_SESSION_BUSY');
    let releaseProject: (() => void) | null = null;
    try {
      const session = sourceSession(sessionId);
      if (lockFiles) {
        releaseProject = chatRunRegistry.reserveProjectMutation(session.project_path);
        if (!releaseProject || sessionsDb.getSessionsByProjectPathIncludingArchived(session.project_path).some(row => dependencies.active(row.session_id) || Boolean(row.provider_session_id && dependencies.active(row.provider_session_id)))) {
          fail('A conversation in this project still has active work. Wait before restoring shared files.', 'CLAUDE_PROJECT_BUSY');
        }
      }
      if (dependencies.active(session.provider_session_id) || dependencies.active(sessionId)) fail('Claude still has background work in this conversation. Stop it before continuing.', 'CLAUDE_SESSION_BUSY');
      return await operation(session);
    } finally { releaseProject?.(); release(); }
  }

  async function discardPreparedBranch(session: Session, branch: { sessionId: string; filename: string; fingerprint: string }): Promise<void> {
    const branchId = branch.sessionId;
    if (dependencies.active(branchId) || !claudeSessionActionsDb.canDiscardPreparedBranch(branchId)) return;
    const release = chatRunRegistry.reserveSessionMutation(branchId);
    if (!release) return;
    try {
      // A user may have discovered the fork through the watcher while restore
      // was pending. Never remove a transcript that has since been continued.
      if (branch.fingerprint !== await dependencies.transcriptFingerprint({ ...session, provider_session_id: branchId, jsonl_path: branch.filename })) return;
      await dependencies.discardFork(branchId, { dir: session.project_path });
      claudeSessionActionsDb.discardPreparedBranchRow(branchId);
    } catch {
      // Cleanup must never replace the useful restore error. A branch claimed by
      // another caller, or not safely removable, is retained as ordinary history.
    } finally { release(); }
  }

  async function messages(session: Session) {
    return dependencies.messages(session.provider_session_id, { dir: session.project_path, includeSystemMessages: true });
  }
  function detail(sessionId: string) {
    const row = sessionsDb.getSessionById(sessionId)!;
    const project = row.project_path ? projectsDb.getProjectPath(row.project_path) : null;
    return { sessionId, provider: 'claude' as const, projectId: project?.project_id ?? null, projectPath: row.project_path, sessionName: row.custom_name ?? '' };
  }

  return {
    async capabilities(sessionId: string) {
      const session = sourceSession(sessionId);
      const history = await messages(session);
      return {
        sideChat: true, sideChatWhileRunning: true, conversationRewind: true, fileRewind: 'preview-required',
        isBusy: chatRunRegistry.isProcessing(sessionId) || dependencies.active(session.provider_session_id) || dependencies.active(sessionId),
        messageIds: history.map(message => message.uuid), userMessageIds: history.filter(isUserPrompt).map(message => message.uuid),
        relationship: claudeSessionActionsDb.relationship(sessionId) ?? null,
        fileScope: FILE_SCOPE, conversationBoundary: 'includes-selected-message',
      };
    },

    async fork(sessionId: string, input: { messageId?: string; title?: string }) {
      const createBranch = async (session: Session) => {
        await claudeUsageService.getSnapshot(sessionId);
        const history = await messages(session);
        if (!history.length) fail('There are no saved messages to branch from.', 'CLAUDE_HISTORY_UNAVAILABLE');
        const messageId = input.messageId ? nativeMessageId(history, input.messageId, false) : undefined;
        const title = input.title?.trim() || `${session.custom_name || 'Conversation'} — side chat`;
        const fork = await dependencies.fork(session.provider_session_id, { dir: session.project_path, upToMessageId: messageId, title });
        const filename = await dependencies.ensureFork(session, fork.sessionId);
        const newSessionId = claudeSessionActionsDb.createBranch(sessionId, fork.sessionId, filename, title, messageId);
        await claudeUsageService.inheritContext(sessionId, newSessionId);
        return { ...detail(newSessionId), parentSessionId: sessionId, sharesProjectFiles: true, inheritedFileCheckpoints: false };
      };
      // A fixed saved message is an immutable boundary: SDK fork reads a buffer
      // and writes only a new transcript, so the parent's live query can continue.
      // A latest-history fork has no fixed boundary and remains idle-only.
      return input.messageId ? createBranch(sourceSession(sessionId)) : idle(sessionId, createBranch);
    },

    async preview(userId: number, sessionId: string, input: { messageId: string; mode: Mode }) {
      return idle(sessionId, async session => {
        const messageId = nativeMessageId(await messages(session), input.messageId, true);
        const files = input.mode === 'conversation' ? { canRewind: true, filesChanged: [] } : await dependencies.rewind(session, messageId, true);
        const token = randomUUID();
        const expiresAt = dependencies.now() + 5 * 60_000;
        for (const [key, value] of previews) if (value.expiresAt <= dependencies.now()) previews.delete(key);
        if (previews.size >= 100) previews.delete(previews.keys().next().value!);
        previews.set(token, { userId, sessionId, providerId: session.provider_session_id, messageId, mode: input.mode,
          fingerprint: await dependencies.transcriptFingerprint(session), filesFingerprint: await dependencies.filesFingerprint(session, files.filesChanged ?? []), files, expiresAt });
        return { previewToken: token, expiresAt, messageId, mode: input.mode, canRewind: files.canRewind,
          filesChanged: files.filesChanged ?? [], insertions: files.insertions ?? 0, deletions: files.deletions ?? 0,
          error: files.error ?? null, fileScope: FILE_SCOPE, conversationBoundary: 'includes-selected-message' };
      }, input.mode !== 'conversation');
    },

    async rewind(userId: number, sessionId: string, input: { messageId: string; mode: Mode; previewToken: string }) {
      return idle(sessionId, async session => {
        const preview = previews.get(input.previewToken);
        if (!preview || preview.userId !== userId || preview.sessionId !== sessionId || preview.mode !== input.mode ||
          preview.expiresAt <= dependencies.now() || preview.providerId !== session.provider_session_id ||
          (input.messageId !== preview.messageId && !input.messageId.startsWith(`${preview.messageId}_`))) {
          fail('The preview expired or does not match this action. Preview again.', 'REWIND_PREVIEW_STALE');
        }
        if (preview.fingerprint !== await dependencies.transcriptFingerprint(session) ||
          preview.filesFingerprint !== await dependencies.filesFingerprint(session, preview.files.filesChanged ?? [])) {
          fail('The conversation or files changed after the preview. Preview again.', 'REWIND_PREVIEW_STALE');
        }
        if (!preview.files.canRewind) fail(preview.files.error || 'This message has no usable file checkpoint.', 'CLAUDE_CHECKPOINT_UNAVAILABLE');
        await claudeUsageService.getSnapshot(sessionId);
        // Consume once: a failed or partially successful restore must be freshly inspected.
        previews.delete(input.previewToken);
        let branch: { sessionId: string; filename: string; fingerprint: string } | null = null;
        if (input.mode !== 'files') {
          const fork = await dependencies.fork(session.provider_session_id, { dir: session.project_path, upToMessageId: preview.messageId, title: session.custom_name ?? undefined });
          const filename = await dependencies.ensureFork(session, fork.sessionId);
          branch = { sessionId: fork.sessionId, filename, fingerprint: await dependencies.transcriptFingerprint({ ...session, provider_session_id: fork.sessionId, jsonl_path: filename }) };
        }
        try {
          if (preview.fingerprint !== await dependencies.transcriptFingerprint(session)) {
            fail('The conversation changed while preparing its branch. Preview again.', 'REWIND_PREVIEW_STALE');
          }
          const files = input.mode === 'conversation' ? null : await dependencies.rewind(session, preview.messageId, false);
          if (files && (!files.canRewind || (files.skippedLinks ?? 0) > 0)) {
            throw new AppError(files.error || 'Some files were not restored. Conversation context was kept; inspect the files and preview again.', {
              code: 'CLAUDE_FILE_REWIND_INCOMPLETE', statusCode: 409, details: { files, contextChanged: false },
            });
          }
          let backupSessionId: string | null = null;
          try {
            backupSessionId = branch ? claudeSessionActionsDb.replaceContext(sessionId, session.provider_session_id, branch.sessionId, branch.filename, preview.messageId) : null;
          } catch (error) {
            if (files) throw new AppError('Files were restored, but conversation context could not be changed. The original conversation is retained.', { code: 'CLAUDE_CONTEXT_REWIND_FAILED', statusCode: 500, details: { files, contextChanged: false } });
            throw error;
          }
          const contextRevision = randomUUID();
          if (branch) {
            if (backupSessionId) await claudeUsageService.inheritContext(sessionId, backupSessionId);
            await claudeUsageService.getSnapshot(sessionId);
            chatRunRegistry.forgetCompletedRun(sessionId);
            chatRunRegistry.notifyContextReset(sessionId, contextRevision);
          }
          return { ...detail(sessionId), mode: input.mode, contextChanged: Boolean(branch), contextRevision, backupSessionId,
            files, conversationBoundary: 'includes-selected-message', inheritedFileCheckpoints: branch ? false : undefined };
        } catch (error) {
          if (branch && sessionsDb.getSessionById(sessionId)?.provider_session_id !== branch.sessionId) await discardPreparedBranch(session, branch);
          throw error;
        }
      }, input.mode !== 'conversation');
    },
  };
}

/** Used by the authenticated Claude session-actions router. */
export const claudeSessionActionsService = createClaudeSessionActionsService();
