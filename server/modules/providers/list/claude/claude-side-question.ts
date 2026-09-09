import type { Query } from '@anthropic-ai/claude-agent-sdk';

import type { ClaudeBtwHistoryTurn } from '@/shared/index.js';
import { AppError } from '@/shared/index.js';

/** Used by session actions to call the SDK's native /btw control channel, never its prompt stream. */
export async function askClaudeSideQuestion(query: Query, question: string, signal: AbortSignal, history: ClaudeBtwHistoryTurn[] = []): Promise<string> {
  // SDK 0.3.263 ships this method in sdk.mjs but omits it from the public declarations.
  const native = query as Query & {
    askSideQuestion?: (question: string, options: { signal: AbortSignal; history?: ClaudeBtwHistoryTurn[] }) => Promise<{ response: string; synthetic: boolean } | null>;
  };
  if (typeof native.askSideQuestion !== 'function') {
    throw new AppError('This Claude SDK does not support native /btw. Update the remote SDK.', { code: 'BTW_UNAVAILABLE', statusCode: 409 });
  }
  const result = await native.askSideQuestion(question, { signal, ...(history.length ? { history } : {}) });
  if (!result || typeof result.response !== 'string' || !result.response.trim()) {
    throw new AppError('Claude returned no side answer. Please try again.', { code: 'BTW_EMPTY_RESPONSE', statusCode: 502 });
  }
  return result.response;
}
