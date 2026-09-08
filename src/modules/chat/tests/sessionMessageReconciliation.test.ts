import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import { hasSameUserMessageIdentity } from '@/shared/utils';
import { removeOptimisticUserEchoes } from '@/modules/chat/utils/sessionMessageReconciliation';

const createUserMessage = (
  id: string,
  timestamp: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp,
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content: '',
  ...overrides,
});

test('replaces an optimistic image-only turn with its persisted Claude copy', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    clientMessageId: 'native-image',
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png', name: 'image.png' }],
  });
  const persisted = createUserMessage('claude_image', '2026-07-28T20:30:26.000Z', {
    transcriptAnchorId: 'native-image',
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('does not collapse an attachment-only turn into a server row without attachments', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png' }],
  });
  const persisted = createUserMessage('claude_empty', '2026-07-28T20:30:22.000Z');

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), [local]);
});

test('legacy providers match optimistic attachment turns to persisted turns one-to-one', () => {
  const firstLocal = createUserMessage('local_first', '2026-07-28T20:30:21.000Z', {
    provider: 'codex', images: [{ path: 'C:/Users/test/.cloudcli/assets/first.png' }],
  });
  const secondLocal = createUserMessage('local_second', '2026-07-28T20:30:25.000Z', {
    provider: 'codex', images: [{ path: 'C:/Users/test/.cloudcli/assets/second.png' }],
  });
  const firstPersisted = createUserMessage('claude_first', '2026-07-28T20:30:22.000Z', {
    provider: 'codex', images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  const remainingRealtime = removeOptimisticUserEchoes(
    [firstPersisted],
    [firstLocal, secondLocal],
  );

  assert.deepEqual(remainingRealtime.map((message) => message.id), ['local_second']);
});

test('Claude without verified identity never deduplicates repeated text', () => {
  const local = createUserMessage('local_text', '2026-07-28T20:30:21.000Z', {
    content: 'hello',
  });
  const persisted = createUserMessage('claude_text', '2026-07-28T20:30:26.000Z', {
    content: 'hello',
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), [local]);
});

test('a replacement echo survives a kept turn that repeats its text', () => {
  // The exact shape a rewind that branches produces: the turn that survived
  // the cut is re-stamped to the moment of the copy, one second before the
  // replacement was typed, and happens to say the same thing the user just
  // corrected their message to.
  const userRow = (id: string, content: string, timestamp: string) => ({
    id,
    kind: 'text',
    role: 'user',
    provider: 'codex',
    sessionId: 's1',
    content,
    timestamp,
  }) as NormalizedMessage;

  const kept = [userRow('kept', 'continue', '2026-01-01T00:00:21.000Z')];
  const echo = {
    ...userRow('local_1', 'continue', '2026-01-01T00:00:20.000Z'),
    replacesAnchorId: 'turn-b',
    replacesAfterRowCount: kept.length,
  } as NormalizedMessage;

  assert.deepEqual(removeOptimisticUserEchoes(kept, [echo]), [echo]);

  // Once the provider has written the replacement, it is a row the cut did not
  // keep, so it retires the echo.
  const persisted = [...kept, userRow('persisted', 'continue', '2026-01-01T00:00:25.000Z')];
  assert.deepEqual(removeOptimisticUserEchoes(persisted, [echo]), []);
});


test('UUID-stamped queued and failed repeated sends cannot be retired by an older same-text turn', () => {
  const oldTurn = createUserMessage('old-native', '2026-07-28T20:30:21.000Z', { content: 'continue' });
  for (const delivery of ['queued', 'failed'] as const) {
    const local = createUserMessage('client_new-send', '2026-07-28T20:30:22.000Z', {
      content: 'continue', clientMessageId: 'new-send', delivery,
    });
    assert.deepEqual(removeOptimisticUserEchoes([oldTurn], [local]), [local]);
  }
});

test('replayed client receipts retire only on their exact persisted native identity', () => {
  const local = createUserMessage('client_send-uuid', '2026-07-28T20:30:22.000Z', {
    content: 'continue', clientMessageId: 'send-uuid', delivery: 'delivered',
  });
  for (const identity of [{ id: 'send-uuid' }, { transcriptAnchorId: 'send-uuid' }, { clientMessageId: 'send-uuid' }]) {
    const persisted = createUserMessage('native-row', '2026-07-28T20:30:22.000Z', { content: 'continue', ...identity });
    assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
  }
});


test('an explicitly confirmed native anchor reconciles a rewritten client UUID and all replayed copies', () => {
  const local = createUserMessage('client_send', '2026-07-28T20:30:22.000Z', {
    clientMessageId: 'client-send', transcriptAnchorId: 'native-anchor', content: 'same', delivery: 'delivered',
  });
  const saved = createUserMessage('native-anchor_text_0', '2026-07-28T20:30:23.000Z', { transcriptAnchorId: 'native-anchor', content: 'same' });
  assert.deepEqual(removeOptimisticUserEchoes([saved], [local, { ...local, id: 'local_second-copy' }]), []);
  assert.deepEqual(removeOptimisticUserEchoes([{ ...saved, sessionId: 'other' }], [local]), [local]);
});


test('a shared response never merges two known input UUIDs or native user rows', () => {
  const first = createUserMessage('client_a', '2026-09-07T00:00:00Z', { clientMessageId: 'send-a', responseMessageId: 'shared-response', delivery: 'delivered' });
  const second = { ...first, id: 'client_b', clientMessageId: 'send-b' };
  assert.equal(hasSameUserMessageIdentity(first, second), false);
  const nativeA = { ...first, transcriptAnchorId: 'native-a' };
  const nativeB = { ...first, id: 'native-b_text_0', clientMessageId: undefined, transcriptAnchorId: 'native-b', delivery: undefined };
  assert.equal(hasSameUserMessageIdentity(nativeA, nativeB), false);
  assert.deepEqual(removeOptimisticUserEchoes([nativeB], [nativeA]), [nativeA]);
  // CLI UUID rewriting still reconciles when exactly correlated reply ancestry
  // is available and neither side declares a conflicting native/client identity.
  assert.equal(hasSameUserMessageIdentity(first, nativeB), true);
});
