import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { createClaudeInputQueue } from '@/modules/providers/list/claude/claude-input-queue.js';

type Delivery = Parameters<Parameters<typeof createClaudeInputQueue>[0]>[0] & { error?: string };
const message = (text: string): SDKUserMessage => ({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } });
function fixture() {
  const deliveries: Delivery[] = [];
  const queue = createClaudeInputQueue((entry, error) => deliveries.push({ ...entry, ...(error ? { error } : {}) }));
  return { queue, deliveries };
}
async function assertWaiting<T>(pending: Promise<T>): Promise<void> {
  let settled = false;
  void pending.then(() => { settled = true; });
  await setImmediate();
  assert.equal(settled, false, 'The same native input stream must stay open while input is being prepared or has not arrived.');
}

test('reserving before asynchronous message construction prevents idle completion and feeds the same live iterable', async (context) => {
  const { queue, deliveries } = fixture(); context.after(() => queue.release());
  const first = queue.begin('initial-input', 'Initial request', true)!;
  assert.equal(queue.hasPending(), true);
  const read = queue.stream.next(); await assertWaiting(read);
  assert.deepEqual(deliveries.map(entry => [entry.id, entry.delivery]), [['initial-input', 'queued']]);
  first.commit([message('Initial request')]);
  const initial = await read;
  assert.equal(initial.done, false); assert.equal(initial.value?.uuid, 'initial-input');
  assert.equal(initial.value?.timestamp, deliveries[0].timestamp); assert.equal(initial.value?.priority, 'next');
  queue.observe({ type: 'result', uuid: 'first-result' });
  assert.equal(queue.hasPending(), false);
  const continued = queue.stream.next(); await assertWaiting(continued);
  const later = queue.begin('later-input', 'Follow-up request')!;
  assert.equal(queue.hasPending(), true); await assertWaiting(continued);
  later.commit([message('Follow-up request')]);
  assert.equal((await continued).value?.message.content, 'Follow-up request');
  assert.equal(queue.isOpen(), true); assert.equal(queue.messageCount(), 2);
});

test('queued remains queued after stdin consumption and becomes delivered only on the correlated native echo', async (context) => {
  const { queue, deliveries } = fixture(); context.after(() => queue.release());
  queue.begin('follow-up', 'Keep discussing')!.commit([message('Keep discussing')]);
  await queue.stream.next();
  assert.equal(deliveries.at(-1)?.delivery, 'queued'); assert.equal(queue.hasPending(), true);
  queue.observe({ type: 'user', uuid: 'other-message' });
  assert.equal(deliveries.length, 1);
  queue.observe({ type: 'user', uuid: 'follow-up' });
  assert.equal(deliveries.at(-1)?.delivery, 'delivered'); assert.equal(queue.hasPending(), true);
  queue.observe({ type: 'user', uuid: 'follow-up' });
  assert.equal(deliveries.length, 2, 'Repeated native echoes do not repeat the delivery transition.');
  queue.observe({ type: 'result', uuid: 'result-for-follow-up', user_message_uuid: 'follow-up' });
  assert.equal(queue.hasPending(), false); assert.equal(queue.isOpen(), true);
});

test('an unrelated Workflow result cannot process a newer delivered input', async (context) => {
  const { queue, deliveries } = fixture(); context.after(() => queue.release());
  queue.begin('initial', 'Start workflow', true)!.commit([message('Start workflow')]); await queue.stream.next();
  queue.observe({ type: 'user', uuid: 'initial' }); queue.observe({ type: 'result', uuid: 'initial-result' });
  queue.begin('later', 'New question')!.commit([message('New question')]); await queue.stream.next();
  queue.observe({ type: 'user', uuid: 'later' });
  queue.observe({ type: 'result', uuid: 'workflow-follow-up-result' });
  queue.observe({ type: 'result', uuid: 'result-for-someone-else', user_message_uuid: 'unrelated' });
  assert.equal(queue.hasPending(), true);
  assert.equal(deliveries.at(-1)?.id, 'later'); assert.equal(deliveries.at(-1)?.delivery, 'delivered');
  queue.observe({ type: 'result', uuid: 'correlated-result', user_message_uuid: 'later' });
  assert.equal(queue.hasPending(), false);
});

test('plural result correlation settles only the matching inputs, including a result that precedes an echo', async (context) => {
  const { queue, deliveries } = fixture(); context.after(() => queue.release());
  for (const id of ['one', 'two', 'three']) queue.begin(id, id)!.commit([message(id)]);
  for (let index = 0; index < 3; index++) await queue.stream.next();
  queue.observe({ type: 'result', uuid: 'batch-result', user_message_uuids: ['one', 'two', 'one', null] });
  assert.equal(deliveries.filter(entry => entry.delivery === 'delivered').length, 2);
  assert.equal(queue.hasPending(), true);
  queue.observe({ type: 'result', uuid: 'last-result', user_message_uuid: 'three' });
  assert.equal(queue.hasPending(), false);
});

test('child, sidechain, synthetic and tool-result messages cannot acknowledge a main user input', async (context) => {
  const { queue, deliveries } = fixture(); context.after(() => queue.release());
  queue.begin('main-input', 'Question')!.commit([message('Question')]); await queue.stream.next();
  for (const extra of [{ parent_tool_use_id: 'child-tool' }, { isSidechain: true }, { isSynthetic: true }, { tool_use_result: {} }]) {
    queue.observe({ type: 'user', uuid: 'main-input', ...extra });
  }
  queue.observe({ type: 'result', user_message_uuid: 'main-input', parent_tool_use_id: 'child-tool' });
  assert.equal(deliveries.length, 1); assert.equal(queue.hasPending(), true);
});

test('duplicate UUID retries replay status without appending stdin; different content is rejected', async (context) => {
  const { queue, deliveries } = fixture(); context.after(() => queue.release());
  const slot = queue.begin('retry-id', 'Original')!;
  assert.equal(queue.begin('retry-id', 'Original'), null); assert.equal(queue.messageCount(), 1);
  assert.throws(() => queue.begin('retry-id', 'Changed'), /different message/);
  slot.commit([message('Original')]); slot.commit([message('Should not be appended')]); slot.fail('Should not replace a committed slot');
  assert.equal((await queue.stream.next()).value?.message.content, 'Original');
  queue.observe({ type: 'user', uuid: 'retry-id' });
  assert.equal(queue.begin('retry-id', 'Original'), null); assert.equal(deliveries.at(-1)?.delivery, 'delivered');
  const next = queue.stream.next(); await assertWaiting(next);
  queue.release(); assert.equal((await next).done, true);
});

test('failed preparation releases its reservation without writing partial input and failure is stable on retry', async (context) => {
  const { queue, deliveries } = fixture(); context.after(() => queue.release());
  const slot = queue.begin('bad-input', 'Attachment question')!;
  const pending = queue.stream.next(); slot.fail('Attachment could not be read');
  await assertWaiting(pending); // Let the live iterator discard the failed reservation without ending stdin.
  assert.equal(queue.hasPending(), false); assert.equal(deliveries.at(-1)?.delivery, 'failed');
  assert.equal(deliveries.at(-1)?.error, 'Attachment could not be read');
  slot.commit([message('Must not reach stdin')]); await assertWaiting(pending);
  assert.equal(queue.begin('bad-input', 'Attachment question'), null); assert.equal(deliveries.at(-1)?.delivery, 'failed');
  queue.begin('next-input', 'Valid retry with a new UUID')!.commit([message('Valid retry with a new UUID')]);
  assert.equal((await pending).value?.uuid, 'next-input');
});

test('release fails unconfirmed buffered and preparing inputs, wakes readers, and prevents later commits or new input', async () => {
  const { queue, deliveries } = fixture();
  queue.begin('already-delivered', 'Known received')!.commit([message('Known received')]); await queue.stream.next();
  queue.observe({ type: 'user', uuid: 'already-delivered' });
  const inPreparation = queue.begin('preparing', 'Still building')!;
  queue.begin('buffered', 'Queued in stdin')!.commit([message('Queued in stdin')]);
  queue.release('Native process ended');
  assert.equal(queue.isOpen(), false);
  assert.equal([...deliveries].reverse().find(entry => entry.id === 'preparing')?.delivery, 'failed');
  assert.equal([...deliveries].reverse().find(entry => entry.id === 'buffered')?.delivery, 'failed');
  assert.equal([...deliveries].reverse().find(entry => entry.id === 'already-delivered')?.delivery, 'delivered');
  const count = deliveries.length; queue.release(); assert.equal(deliveries.length, count);
  inPreparation.commit([message('Too late')]); assert.equal((await queue.stream.next()).done, true);
  assert.throws(() => queue.begin('brand-new', 'Not submitted'), /closed/);
  const empty = fixture().queue; const reader = empty.stream.next(); await assertWaiting(reader); empty.release(); assert.equal((await reader).done, true);
});

test('the 64-input bound includes unfinished preparations, permits idempotent retries, and reopens capacity after handling', async () => {
  const { queue } = fixture();
  try {
    const slots = Array.from({ length: 64 }, (_, index) => queue.begin(`id-${index}`, `question-${index}`)!);
    assert.equal(queue.messageCount(), 64);
    assert.throws(() => queue.begin('overflow', 'Overflow'), /queue is full/);
    assert.equal(queue.begin('id-0', 'question-0'), null);
    slots[0].fail('Failed build frees one slot');
    assert.ok(queue.begin('after-failure', 'New attempt'));
    assert.throws(() => queue.begin('still-overflow', 'Overflow'), /queue is full/);
    slots[1].commit([message('question-1')]);
    assert.equal((await queue.stream.next()).value?.uuid, 'id-1');
    queue.observe({ type: 'result', uuid: 'completed-one', user_message_uuid: 'id-1' });
    assert.ok(queue.begin('after-result', 'Another attempt'));
    assert.throws(() => queue.begin('overflow-again', 'Overflow'), /queue is full/);
  } finally { queue.release(); }
});

test('concurrent prompt construction preserves reservation order even if the later input finishes building first', async (context) => {
  const { queue } = fixture(); context.after(() => queue.release());
  const first = queue.begin('first-with-image', 'First question')!;
  const second = queue.begin('second-text-only', 'Second question')!;
  const pending = queue.stream.next();
  second.commit([message('Second question')]);
  await assertWaiting(pending);
  first.commit([message('First question')]);
  assert.equal((await pending).value?.uuid, 'first-with-image');
  assert.equal((await queue.stream.next()).value?.uuid, 'second-text-only');
});

test('failed earlier construction unblocks later reservations without reordering the remaining inputs', async (context) => {
  const { queue } = fixture(); context.after(() => queue.release());
  const first = queue.begin('failed-first', 'Bad image')!;
  const second = queue.begin('second', 'Second question')!;
  const third = queue.begin('third', 'Third question')!;
  third.commit([message('Third question')]); second.commit([message('Second question')]);
  const pending = queue.stream.next(); await assertWaiting(pending);
  first.fail('Image decoding failed');
  assert.equal((await pending).value?.uuid, 'second');
  assert.equal((await queue.stream.next()).value?.uuid, 'third');
});

test('a repeated UUID is idempotent only when its attachment payload is also unchanged', (context) => {
  const { queue } = fixture(); context.after(() => queue.release());
  const attachments = { images: [{ path: '/remote/image-a.png', mimeType: 'image/png' }], files: [{ path: '/remote/notes-a.txt' }] };
  assert.ok(queue.begin('same-prompt', 'Compare attachments', false, attachments));
  assert.equal(queue.begin('same-prompt', 'Compare attachments', false, structuredClone(attachments)), null);
  assert.throws(() => queue.begin('same-prompt', 'Compare attachments', false, { ...attachments, images: [{ path: '/remote/image-b.png', mimeType: 'image/png' }] }), /different message|attachment/i);
  assert.throws(() => queue.begin('same-prompt', 'Compare attachments', false, { ...attachments, files: [{ path: '/remote/notes-b.txt' }] }), /different message|attachment/i);
  assert.equal(queue.messageCount(), 1);
});
