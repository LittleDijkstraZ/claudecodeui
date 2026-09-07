import assert from 'node:assert/strict';
import test from 'node:test';

import { createGroupConversationPager, emptyGroupConversationPage, type GroupConversationPage } from './groupConversationPager';

type Row = { sessionId: string; title?: string };
type Page = GroupConversationPage<Row>;
const row = (sessionId: string): Row => ({ sessionId });
const page = (ids: string[], hasMore = false, total = ids.length): Page => ({ conversations: ids.map(row), hasMore, total });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness() {
  const requests: {
    groupId: string;
    options: { limit: number; offset: number; query: string };
    resolve: (page: Page) => void;
    reject: (error: Error) => void;
  }[] = [];
  let state = emptyGroupConversationPage<Row>();
  let updates = 0;
  const pager = createGroupConversationPager<Row>(
    (groupId, options) => new Promise((resolve, reject) => requests.push({ groupId, options, resolve, reject })),
    (next) => { state = next; updates += 1; },
  );
  return { requests, pager, state: () => state, updates: () => updates };
}

test('switching group ignores the old response, even if it finishes last', async () => {
  const h = harness();
  h.pager.select('a', '');
  h.pager.select('b', '');
  assert.equal(h.state().groupId, 'b');
  assert.deepEqual(h.state().conversations, []);
  h.requests[1].resolve(page(['b1']));
  await settle();
  h.requests[0].resolve(page(['a1']));
  await settle();
  assert.deepEqual(h.state().conversations, [row('b1')]);
  h.pager.dispose();
});

test('search scopes server pagination and ignores stale search errors', async () => {
  const h = harness();
  h.pager.select('a', 'first');
  h.pager.select('a', '  second  ');
  assert.deepEqual(h.requests[1].options, { limit: 40, offset: 0, query: 'second' });
  h.requests[1].resolve(page(['match'], true, 2));
  await settle();
  h.requests[0].reject(new Error('old search failed'));
  await settle();
  assert.equal(h.state().hasError, false);
  h.pager.loadMore();
  assert.equal(h.requests[2].options.query, 'second');
  assert.equal(h.requests[2].options.offset, 1);
  h.pager.dispose();
});

test('load more is single flight and offsets count raw rows despite deduplication', async () => {
  const h = harness();
  h.pager.select('a', '');
  h.requests[0].resolve(page(['1', '2'], true, 8));
  await settle();
  h.pager.loadMore();
  h.pager.loadMore();
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(page(['2', '3'], true, 8));
  await settle();
  assert.deepEqual(h.state().conversations.map((item) => item.sessionId), ['1', '2', '3']);
  h.pager.loadMore();
  assert.equal(h.requests[2].options.offset, 4);
  h.pager.dispose();
});

test('a failed later page keeps earlier rows and retry uses the failed offset', async () => {
  const h = harness();
  h.pager.select('a', '');
  h.requests[0].resolve(page(['1'], true, 2));
  await settle();
  h.pager.loadMore();
  h.requests[1].reject(new Error('offline'));
  await settle();
  assert.equal(h.state().hasError, true);
  assert.deepEqual(h.state().conversations, [row('1')]);
  h.pager.retry();
  assert.equal(h.requests[2].options.offset, 1);
  h.requests[2].resolve(page(['2'], false, 2));
  await settle();
  assert.equal(h.state().hasError, false);
  assert.deepEqual(h.state().conversations, [row('1'), row('2')]);
  h.pager.dispose();
});

test('background refresh retains loaded depth and replaces rows atomically', async () => {
  const h = harness();
  const ids = Array.from({ length: 40 }, (_, index) => String(index));
  h.pager.select('a', '');
  h.requests[0].resolve(page(ids, true, 100));
  await settle();
  h.pager.loadMore();
  h.requests[1].resolve(page(['40', '41'], true, 100));
  await settle();
  h.pager.refresh();
  assert.equal(h.state().isRefreshing, true);
  assert.equal(h.state().conversations.length, 42);
  assert.equal(h.requests[2].options.offset, 0);
  h.requests[2].resolve(page(['new', ...ids.slice(0, 39)], true, 101));
  await settle();
  assert.equal(h.requests[3].options.offset, 40);
  assert.equal(h.state().conversations[0].sessionId, '0');
  h.requests[3].resolve(page(['39', '40', '41'], true, 101));
  await settle();
  assert.equal(h.state().conversations.length, 43);
  assert.equal(h.state().conversations[0].sessionId, 'new');
  assert.equal(h.state().isRefreshing, false);
  h.pager.dispose();
});

test('a revision during pagination refreshes after the new page without losing it', async () => {
  const h = harness();
  h.pager.select('a', '');
  h.requests[0].resolve(page(['1'], true, 2));
  await settle();
  h.pager.loadMore();
  h.pager.refresh();
  h.pager.refresh();
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(page(['2'], false, 2));
  await settle();
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.state().conversations, [row('1'), row('2')]);
  h.requests[2].resolve(page(['2', '1']));
  await settle();
  assert.deepEqual(h.state().conversations, [row('2'), row('1')]);
  h.pager.dispose();
});

test('disposing suppresses pending responses and cancels deferred searches', async () => {
  const h = harness();
  h.pager.select('a', '');
  h.pager.select('b', 'later', 10);
  h.pager.dispose();
  const updates = h.updates();
  h.requests[0].resolve(page(['stale']));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.requests.length, 1);
  assert.equal(h.updates(), updates);
});

test('an empty page cannot leave an endless load-more button', async () => {
  const h = harness();
  h.pager.select('a', '');
  h.requests[0].resolve(page([], true, 3));
  await settle();
  assert.equal(h.state().hasMore, false);
  h.pager.loadMore();
  assert.equal(h.requests.length, 1);
  h.pager.dispose();
});
