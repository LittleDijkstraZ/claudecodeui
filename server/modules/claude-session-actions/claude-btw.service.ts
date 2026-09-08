import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { sessionsDb } from '@/modules/database/index.js';
import { acquireClaudeSideQuestionQuery, askClaudeSideQuestion } from '@/modules/providers/index.js';
import { AppError, resolveClaudeCodeExecutablePath } from '@/shared/index.js';

type Dependencies = {
  session: typeof sessionsDb.getSessionById;
  acquire: typeof acquireClaudeSideQuestionQuery;
  query: typeof query;
  ask: typeof askClaudeSideQuestion;
};

/** Used by authenticated session routes and tests; side answers are never persisted or broadcast to chat. */
export function createClaudeBtwService(overrides: Partial<Dependencies> = {}) {
  const dependencies = { session: sessionsDb.getSessionById, acquire: acquireClaudeSideQuestionQuery, query, ask: askClaudeSideQuestion, ...overrides };
  return async (sessionId: string, question: string, signal: AbortSignal) => {
    const session = dependencies.session(sessionId);
    if (!session) throw new AppError('Conversation was not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    if (session.provider !== 'claude') throw new AppError('/btw requires a Claude conversation.', { code: 'CLAUDE_SESSION_REQUIRED', statusCode: 400 });
    const live = dependencies.acquire(sessionId) ?? (session.provider_session_id ? dependencies.acquire(session.provider_session_id) : null);
    if (live) {
      try { return { answer: await dependencies.ask(live.query, question, signal) }; }
      finally { live.release(); }
    }
    if (!session.provider_session_id || !session.project_path) throw new AppError('Send a main-chat message before using /btw.', { code: 'CLAUDE_HISTORY_UNAVAILABLE', statusCode: 409 });
    // Resume the saved context without sending a user turn. Fork + no persistence
    // prevents this control-only reader from writing to the source transcript.
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const input: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({ next: async () => { await held; return { done: true, value: undefined }; } }),
    };
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let reader: Query | undefined;
    let drained: Promise<void> | undefined;
    try {
      reader = dependencies.query({ prompt: input, options: {
        resume: session.provider_session_id, cwd: session.project_path,
        forkSession: true, persistSession: false,
        ...(session.model ? { model: session.model } : {}),
        pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH),
        abortController, env: { ...process.env },
        settingSources: ['user', 'project', 'local'], settings: { disableAllHooks: true },
        tools: [], mcpServers: {}, strictMcpConfig: true,
      } });
      // Drain status frames only; they must never enter the main chat websocket.
      const activeReader = reader;
      drained = (async () => { for await (const _message of activeReader) { /* control-only */ } })();
      void drained.catch(() => {});
      await reader.supportedCommands();
      return { answer: await dependencies.ask(reader, question, signal) };
    } finally {
      release(); reader?.close();
      signal.removeEventListener('abort', abort);
      await drained?.catch(() => {});
    }
  };
}

/** Used by the Claude session actions router on the owning local or remote machine. */
export const claudeBtwService = createClaudeBtwService();
