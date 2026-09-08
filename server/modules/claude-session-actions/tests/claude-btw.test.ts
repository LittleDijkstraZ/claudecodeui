import assert from 'node:assert/strict';
import test from 'node:test';

import type { Query, Options } from '@anthropic-ai/claude-agent-sdk';

import { createClaudeBtwService } from '@/modules/claude-session-actions/claude-btw.service.js';
import { sessionsDb } from '@/modules/database/index.js';

type Session = ReturnType<typeof sessionsDb.getSessionById>;
const source = { session_id: 'app-a', provider: 'claude', provider_session_id: 'native-a', project_path: '/tmp/project', model: 'sonnet' } as Session;

test('live BTW uses the owning query and releases its hold without starting a prompt or fork', async () => {
  const live = {} as Query; const signal = new AbortController().signal; let releases = 0;
  const service = createClaudeBtwService({ session: () => source, acquire: id => id === 'native-a' ? { query: live, release: () => { releases++; } } : null,
    query: () => { throw new Error('must not start another query'); },
    ask: async (reader, question, receivedSignal) => { assert.equal(reader, live); assert.equal(question, 'why?'); assert.equal(receivedSignal, signal); return 'answer'; },
  });
  assert.deepEqual(await service('app-a', 'why?', signal), { answer: 'answer' });
  assert.equal(releases, 1);
});

test('idle BTW resumes context without persistence or user input and closes its private reader', async () => {
  let options: Options | undefined; let closed = false; let initialized = false;
  const native = { async *[Symbol.asyncIterator]() {}, supportedCommands: async () => { initialized = true; return []; }, close: () => { closed = true; } } as unknown as Query;
  const service = createClaudeBtwService({ session: () => source, acquire: () => null,
    query: input => { options = input.options; assert.notEqual(typeof input.prompt, 'string'); return native; },
    ask: async () => { assert.equal(initialized, true); return 'context answer'; },
  });
  assert.deepEqual(await service('app-a', 'why?', new AbortController().signal), { answer: 'context answer' });
  assert.equal(options?.resume, 'native-a'); assert.equal(options?.forkSession, true); assert.equal(options?.persistSession, false);
  assert.deepEqual(options?.tools, []); assert.deepEqual(options?.settings, { disableAllHooks: true }); assert.equal(closed, true);
});

test('live request cancellation propagates and releases the hold without interrupting main work', async () => {
  let released = false; const controller = new AbortController();
  const service = createClaudeBtwService({ session: () => source,
    acquire: () => ({ query: {} as Query, release: () => { released = true; } }),
    ask: async (_reader, _question, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))),
  });
  const request = service('app-a', 'why?', controller.signal); controller.abort();
  await assert.rejects(request, /cancelled/); assert.equal(released, true);
});

test('rejects non-Claude and unsaved conversations before opening a reader', async () => {
  const dependencies = { acquire: () => null, query: () => { throw new Error('must not query'); } };
  await assert.rejects(createClaudeBtwService({ ...dependencies, session: () => ({ ...source, provider: 'codex' }) as Session })('app-a', 'why?', new AbortController().signal), /Claude conversation/);
  await assert.rejects(createClaudeBtwService({ ...dependencies, session: () => ({ ...source, provider_session_id: null }) as Session })('app-a', 'why?', new AbortController().signal), /main-chat message/);
});
