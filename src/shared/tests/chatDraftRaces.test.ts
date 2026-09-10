import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), remove: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { user: { drafts: mocks.read, saveDraft: mocks.save, deleteDraft: mocks.remove } } }));

const response = (drafts: unknown[] = [], status = 200) => new Response(JSON.stringify({ drafts }), { status });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const loadStore = async () => {
  vi.resetModules();
  return import('@/shared/chatDrafts');
};

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  mocks.read.mockReset().mockImplementation(async () => response());
  mocks.save.mockReset().mockImplementation(async () => response());
  mocks.remove.mockReset().mockImplementation(async () => response());
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('a slow read cannot overwrite text typed and saved after that read began', async () => {
  const store = await loadStore();
  const oldRead = deferred<Response>();
  mocks.read.mockReturnValueOnce(oldRead.promise);
  const hydration = store.hydrateChatDrafts();
  store.writeDraftText('session-a', 'New local text');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(mocks.save).toHaveBeenCalledWith('session-a', { text: 'New local text', queuedMessage: null });
  oldRead.resolve(response([{ scope: 'session-a', text: 'Older server text' }]));
  await hydration;
  expect(store.readDraftText('session-a')).toBe('New local text');
  expect(JSON.parse(localStorage.getItem('chat-drafts')!)['session-a'].text).toBe('New local text');

  mocks.read.mockResolvedValueOnce(response([{ scope: 'session-a', text: 'Later edit from another device' }]));
  await store.hydrateChatDrafts();
  expect(store.readDraftText('session-a')).toBe('Later edit from another device');
});

test('a read started during queue persistence cannot remove its text, attachments or native context', async () => {
  const store = await loadStore();
  const save = deferred<Response>();
  const oldRead = deferred<Response>();
  mocks.save.mockReturnValueOnce(save.promise);
  mocks.read.mockReturnValueOnce(oldRead.promise);
  const queued = { content: 'Send when idle', providerSessionId: 'native-a', attachments: [{ path: '/uploads/notes.txt' }] };
  store.writeQueuedMessage('session-a', queued);
  const hydration = store.hydrateChatDrafts();
  save.resolve(response());
  await vi.advanceTimersByTimeAsync(0);
  oldRead.resolve(response());
  await hydration;
  expect(store.readQueuedMessage('session-a')).toEqual(queued);

  // A later fresh inventory can still report that the dispatcher claimed it.
  await store.hydrateChatDrafts();
  expect(store.readQueuedMessage('session-a')).toBeNull();
});

test('an older read cannot resurrect a draft deleted while it was pending', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'Remove this');
  await vi.advanceTimersByTimeAsync(1_000);
  const oldRead = deferred<Response>();
  mocks.read.mockReturnValueOnce(oldRead.promise);
  const hydration = store.hydrateChatDrafts();
  store.writeDraftText('session-a', '');
  await vi.advanceTimersByTimeAsync(1_000);
  oldRead.resolve(response([{ scope: 'session-a', text: 'Remove this' }]));
  await hydration;
  expect(store.readDraftText('session-a')).toBe('');
  expect(mocks.remove).toHaveBeenCalledWith('session-a');
});

test('queue cancellation waits for its pending save and is sent next without another user action', async () => {
  const store = await loadStore();
  const save = deferred<Response>();
  mocks.save.mockReturnValueOnce(save.promise);
  store.writeQueuedMessage('session-a', { content: 'Cancel this', providerSessionId: 'native-a' });
  store.clearQueuedMessage('session-a');
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(store.readQueuedMessage('session-a')).toBeNull();
  save.resolve(response());
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.save).toHaveBeenCalledOnce();
  expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('session-a');
});

test.each(['http', 'network'])('a failed %s write stays protected until an explicit reviewed queue write', async failure => {
  const store = await loadStore();
  if (failure === 'http') mocks.save.mockResolvedValueOnce(response([], 503));
  else mocks.save.mockRejectedValueOnce(new Error('offline'));
  const queued = { content: 'Retain through failure', providerSessionId: 'native-a', attachments: [{ path: '/uploads/keep.txt' }] };
  store.writeQueuedMessage('session-a', queued);
  await vi.advanceTimersByTimeAsync(0);
  await store.hydrateChatDrafts();
  expect(store.readQueuedMessage('session-a')).toEqual(queued);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.save).toHaveBeenCalledOnce();
  const reviewed = { ...queued, content: 'Reviewed retry' };
  store.writeQueuedMessage('session-a', reviewed);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(mocks.save).toHaveBeenLastCalledWith('session-a', { text: '', queuedMessage: reviewed });
});

test('typing during a pending save sends only the newest subsequent draft after it settles', async () => {
  const store = await loadStore();
  const firstSave = deferred<Response>();
  mocks.save.mockReturnValueOnce(firstSave.promise);
  store.writeDraftText('session-a', 'First version');
  await vi.advanceTimersByTimeAsync(1_000);
  store.writeDraftText('session-a', 'Second version');
  store.writeDraftText('session-a', 'Final version');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(mocks.save).toHaveBeenCalledOnce();
  firstSave.resolve(response());
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(mocks.save).toHaveBeenLastCalledWith('session-a', { text: 'Final version', queuedMessage: null });
});

test('saving another conversation cannot retry an ambiguously persisted queue', async () => {
  const store = await loadStore();
  mocks.save.mockRejectedValueOnce(new Error('response lost'));
  store.writeQueuedMessage('session-a', { content: 'Possibly already queued', providerSessionId: 'native-a' });
  await vi.advanceTimersByTimeAsync(0);
  store.writeDraftText('session-b', 'Unrelated text');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(mocks.save.mock.calls.map(call => call[0])).toEqual(['session-a', 'session-b']);
  expect(store.readQueuedMessage('session-a')?.content).toBe('Possibly already queued');
});

test('sign-out discards an old read and prevents retrying an old account failed save', async () => {
  const store = await loadStore();
  const oldRead = deferred<Response>();
  const oldWrite = deferred<Response>();
  mocks.read.mockReturnValueOnce(oldRead.promise);
  mocks.save.mockReturnValueOnce(oldWrite.promise);
  const hydration = store.hydrateChatDrafts();
  store.writeQueuedMessage('session-a', { content: 'Old account queue' });
  store.resetChatDrafts();
  oldRead.resolve(response([{ scope: 'session-a', text: 'Old account private text' }]));
  oldWrite.reject(new Error('old request failed'));
  await hydration;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(store.readDraftText('session-a')).toBe('');
  expect(store.readQueuedMessage('session-a')).toBeNull();
  expect(localStorage.getItem('chat-drafts')).toBeNull();
  expect(mocks.save).toHaveBeenCalledOnce();
});

test('out-of-order reads cannot replace a newer remote draft snapshot', async () => {
  const store = await loadStore();
  const oldRead = deferred<Response>();
  mocks.read.mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(response([{ scope: 'session-a', text: 'Latest remote draft' }]));
  const oldHydration = store.hydrateChatDrafts();
  await store.hydrateChatDrafts();
  oldRead.resolve(response([{ scope: 'session-a', text: 'Outdated remote draft' }]));
  await oldHydration;
  expect(store.readDraftText('session-a')).toBe('Latest remote draft');
});
