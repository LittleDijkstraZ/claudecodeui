import assert from 'node:assert/strict';
import test from 'node:test';

import type { Query } from '@anthropic-ai/claude-agent-sdk';

import { askClaudeSideQuestion } from '@/modules/providers/list/claude/claude-side-question.js';

test('native /btw uses only askSideQuestion and forwards its cancellation signal', async () => {
  const signal = new AbortController().signal;
  const native = { askSideQuestion: async (question: string, options: { signal: AbortSignal }) => {
    assert.equal(question, 'question'); assert.equal(options.signal, signal); return { response: 'answer', synthetic: false };
  } } as unknown as Query;
  assert.equal(await askClaudeSideQuestion(native, 'question', signal), 'answer');
});

test('missing native support and empty answers fail explicitly without prompt fallback', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(askClaudeSideQuestion({} as Query, 'question', signal), /does not support/);
  await assert.rejects(askClaudeSideQuestion({ askSideQuestion: async () => null } as unknown as Query, 'question', signal), /no side answer/);
});
