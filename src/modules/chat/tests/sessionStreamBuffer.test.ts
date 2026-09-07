import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { LLMProvider } from '@/shared/types';

import { createSessionStreamBuffer } from '@/modules/chat/utils/sessionStreamBuffer';

function fixture() {
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const updates: Array<{ sessionId: string; content: string; provider: LLMProvider }> = [];
  const current = new Map<string, string>();
  const completed = new Map<string, string[]>();
  const buffer = createSessionStreamBuffer({
    updateStreaming(sessionId, content, provider) {
      updates.push({ sessionId, content, provider });
      current.set(sessionId, content);
    },
    finalizeStreaming(sessionId) {
      const content = current.get(sessionId);
      if (content !== undefined) {
        completed.set(sessionId, [...(completed.get(sessionId) ?? []), content]);
        current.delete(sessionId);
      }
    },
  }, {
    schedule(callback, delayMs) {
      assert.equal(delayMs, 100);
      const timer = nextTimer++;
      timers.set(timer, callback);
      return timer;
    },
    cancel(timer) { timers.delete(timer); },
  });

  return {
    buffer, timers, updates, current, completed,
    append(sessionId: string, content: string, provider: LLMProvider) {
      return buffer.handleEvent({ kind: 'stream_delta', content, provider }, sessionId, 'claude');
    },
    end(sessionId: string | null) {
      return buffer.handleEvent({ kind: 'stream_end' }, sessionId, 'claude');
    },
    tick() {
      for (const [timer, callback] of [...timers]) {
        if (timers.delete(timer)) callback();
      }
    },
  };
}

test('interleaved sessions keep full content, provider and render timers separate', () => {
  const f = fixture();
  f.append('a', 'Hello ', 'claude');
  f.append('b', 'Other ', 'codex');
  f.append('a', 'world', 'claude');
  f.append('b', 'reply', 'codex');
  assert.equal(f.timers.size, 2);
  f.tick();
  assert.deepEqual(f.updates, [
    { sessionId: 'a', content: 'Hello world', provider: 'claude' },
    { sessionId: 'b', content: 'Other reply', provider: 'codex' },
  ]);
});

test('background output retains its prefix while another session receives replies', () => {
  const f = fixture();
  f.append('a', 'prefix ', 'claude');
  f.tick();
  // The view can switch without resetting any session's stream controller.
  f.append('b', 'second session', 'claude');
  f.append('a', 'middle ', 'claude');
  f.tick();
  f.append('a', 'suffix', 'claude');
  f.end('a');
  assert.deepEqual(f.completed.get('a'), ['prefix middle suffix']);
  assert.equal(f.current.get('b'), 'second session');
});

test('finishing a background session cannot cancel a foreground render timer', () => {
  const f = fixture();
  f.append('a', 'still running', 'claude');
  f.append('b', 'finished', 'claude');
  f.end('b');
  assert.equal(f.timers.size, 1);
  assert.deepEqual(f.completed.get('b'), ['finished']);
  assert.equal(f.completed.has('a'), false);
  f.tick();
  assert.equal(f.current.get('a'), 'still running');
});

test('the first reply needs a session id but no selected-view state', () => {
  const f = fixture();
  f.append('new-session', 'First ', 'claude');
  f.tick();
  f.append('new-session', 'reply', 'claude');
  f.end('new-session');
  assert.deepEqual(f.completed.get('new-session'), ['First reply']);
});

test('block boundaries flush immediately and start the next block from empty text', () => {
  const f = fixture();
  f.append('a', 'One', 'claude');
  f.end('a');
  f.append('a', 'Two', 'claude');
  f.end('a');
  f.tick();
  assert.deepEqual(f.completed.get('a'), ['One', 'Two']);
  assert.equal(f.updates.length, 2);
  assert.equal(f.timers.size, 0);
});

test('abort/error completion preserves pending partial text and is idempotent', () => {
  const f = fixture();
  f.append('a', 'Partial', 'claude');
  f.end('a');
  f.end('a');
  f.tick();
  assert.deepEqual(f.completed.get('a'), ['Partial']);
  assert.equal(f.updates.length, 1);
});

test('cleanup cancels all callbacks and allows a fresh stream after remount', () => {
  const f = fixture();
  f.append('a', 'old a', 'claude');
  f.append('b', 'old b', 'claude');
  f.buffer.clear();
  f.tick();
  assert.deepEqual(f.updates, []);
  f.append('a', 'new', 'claude');
  f.end('a');
  assert.deepEqual(f.completed.get('a'), ['new']);
});

test('a canceled stale callback cannot overwrite a newer block for the same session', () => {
  const f = fixture();
  f.append('a', 'old', 'claude');
  const staleCallback = [...f.timers.values()][0];
  f.end('a');
  f.append('a', 'new', 'claude');
  staleCallback();
  assert.equal(f.current.has('a'), false);
  f.tick();
  assert.equal(f.current.get('a'), 'new');
});

test('empty deltas and missing session ids do not create orphan streams', () => {
  const f = fixture();
  f.append('', 'orphan', 'claude');
  f.append('a', '', 'claude');
  f.end(null);
  f.end('absent');
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.updates, []);
});

test('raw complete flushes only its session and falls through for idle and notification handling', () => {
  const f = fixture();
  assert.equal(f.append('a', 'Foreground', 'claude'), true);
  assert.equal(f.append('b', 'Background', 'codex'), true);
  const fullyHandled = f.buffer.handleEvent({ kind: 'complete' }, 'b', 'claude');
  assert.equal(fullyHandled, false);
  assert.deepEqual(f.completed.get('b'), ['Background']);
  assert.equal(f.completed.has('a'), false);
  assert.equal(f.timers.size, 1);
  f.tick();
  assert.equal(f.current.get('a'), 'Foreground');
});

test('stream end is fully handled while repeated complete still reaches lifecycle handling', () => {
  const f = fixture();
  f.append('a', 'Done', 'claude');
  assert.equal(f.end('a'), true);
  assert.equal(f.buffer.handleEvent({ kind: 'complete' }, 'a', 'claude'), false);
  assert.deepEqual(f.completed.get('a'), ['Done']);
  assert.equal(f.updates.length, 1);
});

test('informational errors and full messages pass through without prematurely closing partial text', () => {
  const f = fixture();
  f.append('a', 'Partial', 'claude');
  assert.equal(f.buffer.handleEvent({ kind: 'error', content: 'warning' }, 'a', 'claude'), false);
  assert.equal(f.buffer.handleEvent({ kind: 'text', content: 'tool output' }, 'a', 'claude'), false);
  assert.equal(f.completed.has('a'), false);
  f.buffer.handleEvent({ kind: 'complete' }, 'a', 'claude');
  assert.deepEqual(f.completed.get('a'), ['Partial']);
});

test('event dispatch rejects malformed text and uses the fallback for an unknown provider', () => {
  const f = fixture();
  f.buffer.handleEvent({ kind: 'stream_delta', content: { invalid: true } }, 'a', 'claude');
  assert.equal(f.timers.size, 0);
  f.buffer.handleEvent({ kind: 'stream_delta', content: 'Valid', provider: 'unknown' }, 'a', 'cursor');
  f.end('a');
  assert.deepEqual(f.updates, [{ sessionId: 'a', content: 'Valid', provider: 'cursor' }]);
});
