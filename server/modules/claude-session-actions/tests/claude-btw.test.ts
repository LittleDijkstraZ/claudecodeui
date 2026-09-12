import assert from 'node:assert/strict';
import test from 'node:test';

import type { Query, Options } from '@anthropic-ai/claude-agent-sdk';

import { createClaudeBtwService } from '@/modules/claude-session-actions/claude-btw.service.js';
import { sessionsDb } from '@/modules/database/index.js';

type Session = ReturnType<typeof sessionsDb.getSessionById>;
const source = { session_id: 'app-a', provider: 'claude', provider_session_id: 'native-a', project_path: '/tmp/project', model: 'sonnet' } as Session;

test('live BTW uses the owning query and releases its hold without starting a prompt or fork', async () => {
  const live = {} as Query; const signal = new AbortController().signal; let releases = 0;
  const history = [{ question: 'earlier', response: 'answer' }];
  const service = createClaudeBtwService({ session: () => source, acquire: id => id === 'native-a' ? { query: live, context: '', release: () => { releases++; } } : null,
    query: () => { throw new Error('must not start another query'); },
    ask: async (reader, question, receivedSignal, receivedHistory) => { assert.deepEqual(receivedHistory, history); assert.equal(reader, live); assert.equal(question, 'why?'); assert.equal(receivedSignal, signal); return 'answer'; },
  });
  assert.deepEqual(await service('app-a', 'why?', signal, history), { answer: 'answer' });
  assert.equal(releases, 1);
});

test('every live BTW question includes fresh main activity while retaining its independent side history', async () => {
  const live = {} as Query;
  const signal = new AbortController().signal;
  let releases = 0;
  let context = 'Assistant: 只有两个调用点，都对了。重跑。';
  const questions: string[] = [];
  const histories: unknown[] = [];
  const service = createClaudeBtwService({
    session: () => source,
    acquire: id => id === 'app-a' ? { query: live, context, release: () => { releases++; } } : null,
    query: () => { throw new Error('must use the existing native side-question channel'); },
    ask: async (reader, question, receivedSignal, history) => {
      assert.equal(reader, live);
      assert.equal(receivedSignal, signal);
      questions.push(question);
      histories.push(history);
      return 'side answer';
    },
  });
  assert.deepEqual(await service('app-a', '刚刚为什么重跑？', signal), { answer: 'side answer' });
  assert.ok(questions[0].includes('只有两个调用点，都对了。重跑。'));
  assert.ok(questions[0].endsWith('Current BTW question:\n刚刚为什么重跑？'));
  assert.deepEqual(histories[0], []);

  context += '\nTool result: loop passed\nAssistant: 循环跑通了。';
  const history = [{ question: '刚刚为什么重跑？', response: 'side answer' }];
  await service('app-a', '现在呢？', signal, history);
  assert.ok(questions[1].includes('循环跑通了。'));
  assert.ok(!questions[0].includes('循环跑通了。'));
  assert.deepEqual(histories[1], history);
  assert.equal(releases, 2);
});

test('idle BTW resumes context without persistence or user input and closes its private reader', async () => {
  let options: Options | undefined; let closed = false; let initialized = false;
  const native = { async *[Symbol.asyncIterator]() {}, supportedCommands: async () => { initialized = true; return []; }, close: () => { closed = true; } } as unknown as Query;
  const service = createClaudeBtwService({ session: () => source, acquire: () => null,
    query: input => { options = input.options; assert.notEqual(typeof input.prompt, 'string'); return native; },
    ask: async (_reader, _question, _signal, history) => { assert.deepEqual(history, [{ question: 'previous', response: 'answer' }]); assert.equal(initialized, true); return 'context answer'; },
  });
  assert.deepEqual(await service('app-a', 'why?', new AbortController().signal, [{ question: 'previous', response: 'answer' }]), { answer: 'context answer' });
  assert.equal(options?.resume, 'native-a'); assert.equal(options?.forkSession, true); assert.equal(options?.persistSession, false);
  assert.deepEqual(options?.tools, []); assert.deepEqual(options?.settings, { disableAllHooks: true }); assert.equal(closed, true);
});

test('live request cancellation propagates and releases the hold without interrupting main work', async () => {
  let released = false; const controller = new AbortController();
  const service = createClaudeBtwService({ session: () => source,
    acquire: () => ({ query: {} as Query, context: 'Assistant: still working', release: () => { released = true; } }),
    ask: async (_reader, _question, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))),
  });
  const request = service('app-a', 'why?', controller.signal); controller.abort();
  await assert.rejects(request, /cancelled/); assert.equal(released, true);
});

test('a starting or closing main query cannot silently fall back to older saved context', async () => {
  for (const activeId of ['app-a', 'native-a']) {
    const service = createClaudeBtwService({ session: () => source,
      acquire: () => null, active: id => id === activeId,
      query: () => { throw new Error('must not open a stale history reader'); },
    });
    await assert.rejects(service('app-a', 'What just happened?', new AbortController().signal),
      (error: { code?: string; statusCode?: number }) => error.code === 'BTW_CONTEXT_NOT_READY' && error.statusCode === 409);
  }
});

test('rejects non-Claude and unsaved conversations before opening a reader', async () => {
  const dependencies = { acquire: () => null, query: () => { throw new Error('must not query'); } };
  await assert.rejects(createClaudeBtwService({ ...dependencies, session: () => ({ ...source, provider: 'codex' }) as Session })('app-a', 'why?', new AbortController().signal), /Claude conversation/);
  await assert.rejects(createClaudeBtwService({ ...dependencies, session: () => ({ ...source, provider_session_id: null }) as Session })('app-a', 'why?', new AbortController().signal), /main-chat message/);
});
