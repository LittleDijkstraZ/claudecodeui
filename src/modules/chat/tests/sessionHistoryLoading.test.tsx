import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage, Project, ProjectSession } from '@/shared/types';

const { sessionMessages } = vi.hoisted(() => ({ sessionMessages: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { providers: {
  sessionMessages,
  sessionTokenUsage: async () => ({ ok: false }),
} } }));

const project = { projectId: 'project', fullPath: '/repo' } as Project;
const sendMessage = vi.fn();
const statusCheckSentAtRef = { current: new Map() };
const lastSeqRef = { current: new Map() };
const rows = (sessionId: string, total: number): NormalizedMessage[] => Array.from({ length: total }, (_, index) => ({
  id: `${sessionId}-${index}`, sessionId, provider: 'claude', kind: 'text',
  role: index % 2 === 0 ? 'user' : 'assistant', content: `message ${index}`,
  timestamp: new Date(Date.UTC(2026, 8, 9, 0, 0, index)).toISOString(),
}));
const response = (messages: NormalizedMessage[], total: number, hasMore: boolean) => ({
  ok: true, json: async () => ({ data: { messages, total, hasMore } }),
});

type HistoryViewProps = { sessionId: string; active?: boolean; selectedProject?: Project; update?: number };

function renderHistory(initialUpdate = 0) {
  return renderHook(({ sessionId, active = true, selectedProject = project, update = initialUpdate }: HistoryViewProps) => {
    const store = useSessionStore('history-test');
    const state = useChatSessionState({
      isActive: active, selectedProject, selectedSession: { id: sessionId } as ProjectSession,
      ws: null, sendMessage, statusCheckSentAtRef, lastSeqRef, sessionStore: store, externalMessageUpdate: update,
    });
    return { store, state };
  }, { initialProps: { sessionId: 'a', active: true, selectedProject: project } as HistoryViewProps, wrapper: StrictMode });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  localStorage.clear();
  sessionMessages.mockReset();
  sessionMessages.mockImplementation(async (sessionId, { limit = null, offset = 0 }) => {
    const messages = rows(sessionId, sessionId === 'a' ? 350 : 120);
    const end = messages.length - offset;
    const start = limit === null ? 0 : Math.max(0, end - limit);
    return response(messages.slice(start, end), messages.length, start > 0);
  });
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('initial history requests 100 rows once across effect replay and project metadata refresh', async () => {
  const view = renderHistory();
  await act(async () => {});
  expect(sessionMessages).toHaveBeenCalledTimes(1);
  expect(sessionMessages.mock.calls[0][1]).toEqual({ limit: 100, offset: 0 });
  expect(view.result.current.state.chatMessages).toHaveLength(100);
  expect(view.result.current.state.visibleMessages).toHaveLength(100);
  expect(view.result.current.state.isLoadingSessionMessages).toBe(false);
  await act(async () => { view.rerender({ sessionId: 'a', active: true, selectedProject: { ...project, displayName: 'renamed' } }); });
  expect(sessionMessages).toHaveBeenCalledTimes(1);
});

test('switching back preserves older cached pages and reveals them before another network read', async () => {
  const view = renderHistory();
  await act(async () => {});
  const container = document.createElement('div');
  await act(async () => { await view.result.current.state.loadOlderMessages(container); });
  expect(view.result.current.state.chatMessages).toHaveLength(200);
  await act(async () => { view.rerender({ sessionId: 'b', active: true, selectedProject: project }); });
  const reads = sessionMessages.mock.calls.length;
  await act(async () => { view.rerender({ sessionId: 'a', active: true, selectedProject: project }); });
  expect(sessionMessages).toHaveBeenCalledTimes(reads);
  expect(view.result.current.state.chatMessages).toHaveLength(200);
  expect(view.result.current.state.visibleMessages).toHaveLength(100);
  expect(view.result.current.state.hasMoreMessages).toBe(true);
  await act(async () => { await view.result.current.state.loadOlderMessages(container); });
  expect(view.result.current.state.visibleMessages).toHaveLength(200);
  expect(sessionMessages).toHaveBeenCalledTimes(reads);
});

test('stale complete history refreshes the tail without shrinking the cache on return', async () => {
  const view = renderHistory();
  await act(async () => {});
  await act(async () => { await view.result.current.state.loadFullTranscript(); });
  await act(async () => { view.rerender({ sessionId: 'b', active: true, selectedProject: project }); });
  vi.setSystemTime(Date.now() + 31_000);
  await act(async () => { view.rerender({ sessionId: 'a', active: true, selectedProject: project }); });
  expect(sessionMessages.mock.calls.at(-1)?.slice(0, 2)).toEqual(['a', { limit: 100, offset: 0 }]);
  expect(view.result.current.state.chatMessages).toHaveLength(350);
  expect(view.result.current.state.hasMoreMessages).toBe(false);
  expect(view.result.current.state.totalMessages).toBe(350);
});

test('explicit full history works while a modal hides chat and keeps the render window bounded', async () => {
  const view = renderHistory();
  await act(async () => {});
  await act(async () => { view.rerender({ sessionId: 'a', active: false, selectedProject: project }); });
  let full: unknown[] = [];
  await act(async () => { full = await view.result.current.state.loadFullTranscript(); });
  expect(full).toHaveLength(350);
  expect(view.result.current.state.hasMoreMessages).toBe(false);
  expect(view.result.current.state.allMessagesLoaded).toBe(true);
  expect(view.result.current.state.visibleMessages).toHaveLength(100);
  const reads = sessionMessages.mock.calls.length;
  await act(async () => { view.rerender({ sessionId: 'a', active: true, selectedProject: project }); });
  expect(view.result.current.state.chatMessages).toHaveLength(350);
  expect(sessionMessages).toHaveBeenCalledTimes(reads);
});

test('a failed full-history request reports failure instead of returning a partial transcript', async () => {
  const view = renderHistory();
  await act(async () => {});
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  sessionMessages.mockResolvedValueOnce({ ok: false, status: 503 });
  await act(async () => {
    await expect(view.result.current.state.loadFullTranscript()).rejects.toThrow('Could not load');
  });
  errorLog.mockRestore();
  expect(view.result.current.state.chatMessages).toHaveLength(100);
  expect(view.result.current.state.hasMoreMessages).toBe(true);
  expect(view.result.current.state.allMessagesLoaded).toBe(false);
  await act(async () => { await view.result.current.state.loadFullTranscript(); });
  expect(view.result.current.state.chatMessages).toHaveLength(350);
});

test('a late initial read cannot clear another conversation loading indicator or overwrite its totals', async () => {
  let resolveA!: (value: ReturnType<typeof response>) => void;
  let resolveB!: (value: ReturnType<typeof response>) => void;
  sessionMessages.mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }));
  sessionMessages.mockImplementationOnce(() => new Promise(resolve => { resolveB = resolve; }));
  const view = renderHistory();
  await act(async () => {});
  await act(async () => { view.rerender({ sessionId: 'b', active: true, selectedProject: project }); });
  await act(async () => { resolveA(response(rows('a', 100), 350, true)); });
  expect(view.result.current.state.isLoadingSessionMessages).toBe(true);
  expect(view.result.current.state.totalMessages).toBe(0);
  await act(async () => { resolveB(response(rows('b', 100), 120, true)); });
  expect(view.result.current.state.isLoadingSessionMessages).toBe(false);
  expect(view.result.current.state.totalMessages).toBe(120);
  expect(view.result.current.state.chatMessages.every(message => String(message.id).startsWith('b-'))).toBe(true);
});

test('external history events refresh once and are not replayed by metadata updates or cached navigation', async () => {
  const view = renderHistory(5);
  await act(async () => {});
  expect(sessionMessages).toHaveBeenCalledTimes(1);
  await act(async () => { view.rerender({ sessionId: 'a', update: 6 }); });
  expect(sessionMessages).toHaveBeenCalledTimes(2);
  await act(async () => { view.rerender({ sessionId: 'a', update: 6, selectedProject: { ...project, displayName: 'renamed' } }); });
  expect(sessionMessages).toHaveBeenCalledTimes(2);
  await act(async () => { view.rerender({ sessionId: 'b', update: 6 }); });
  expect(sessionMessages).toHaveBeenCalledTimes(3);
  await act(async () => { view.rerender({ sessionId: 'a', update: 6 }); });
  expect(sessionMessages).toHaveBeenCalledTimes(3);
  await act(async () => { view.rerender({ sessionId: 'a', active: false, update: 7 }); });
  await act(async () => { view.rerender({ sessionId: 'a', active: false, update: 8 }); });
  expect(sessionMessages).toHaveBeenCalledTimes(3);
  await act(async () => { view.rerender({ sessionId: 'a', active: true, update: 8 }); });
  expect(sessionMessages).toHaveBeenCalledTimes(4);
  await act(async () => { view.rerender({ sessionId: 'a', active: true, update: 9 }); });
  expect(sessionMessages).toHaveBeenCalledTimes(5);
});

test('explicit Agents history can load while chat is hidden and skips rows already cached for the panel', async () => {
  const view = renderHistory();
  await act(async () => {});
  const container = document.createElement('div');
  await act(async () => { await view.result.current.state.loadOlderMessages(container); });
  await act(async () => { view.rerender({ sessionId: 'b', active: true, selectedProject: project }); });
  await act(async () => { view.rerender({ sessionId: 'a', active: false, selectedProject: project }); });
  // The panel has all 200 cached records; the hidden transcript renders only 100.
  expect(view.result.current.state.chatMessages).toHaveLength(200);
  expect(view.result.current.state.visibleMessages).toHaveLength(100);
  const reads = sessionMessages.mock.calls.length;
  await act(async () => { await view.result.current.state.loadOlderMessages(container); });
  expect(sessionMessages).toHaveBeenCalledTimes(reads);
  await act(async () => { await view.result.current.state.loadOlderMessages(container, { purpose: 'agents' }); });
  expect(sessionMessages.mock.calls.at(-1)?.slice(0, 2)).toEqual(['a', { limit: 100, offset: 200 }]);
  expect(view.result.current.state.chatMessages).toHaveLength(300);
  expect(view.result.current.state.visibleMessages).toHaveLength(100);
  expect(view.result.current.state.isLoadingMoreMessages).toBe(false);
});

test('a retained Agents action cannot load the conversation that was previously selected', async () => {
  const view = renderHistory();
  await act(async () => {});
  const previousAction = view.result.current.state.loadOlderMessages;
  await act(async () => { view.rerender({ sessionId: 'b', active: true, selectedProject: project }); });
  const reads = sessionMessages.mock.calls.length;
  await act(async () => {
    expect(await previousAction(document.createElement('div'), { purpose: 'agents' })).toBe(false);
  });
  expect(sessionMessages).toHaveBeenCalledTimes(reads);
});

test('leaving an older-page read unlocks the next session and its late completion preserves the next request lock', async () => {
  const view = renderHistory();
  await act(async () => {});
  const container = document.createElement('div');
  let resolveA!: (value: ReturnType<typeof response>) => void;
  let resolveB!: (value: ReturnType<typeof response>) => void;
  sessionMessages.mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }));
  let pendingA!: Promise<boolean>;
  await act(async () => { pendingA = view.result.current.state.loadOlderMessages(container); });
  expect(view.result.current.state.isLoadingMoreMessages).toBe(true);
  await act(async () => { view.rerender({ sessionId: 'b', active: true, selectedProject: project }); });
  expect(view.result.current.state.isLoadingMoreMessages).toBe(false);
  sessionMessages.mockImplementationOnce(() => new Promise(resolve => { resolveB = resolve; }));
  let pendingB!: Promise<boolean>;
  await act(async () => { pendingB = view.result.current.state.loadOlderMessages(container); });
  await act(async () => { resolveA(response(rows('a', 350).slice(150, 250), 350, true)); await pendingA; });
  expect(view.result.current.state.isLoadingMoreMessages).toBe(true);
  expect(view.result.current.state.totalMessages).toBe(120);
  await act(async () => { resolveB(response(rows('b', 120).slice(0, 20), 120, false)); await pendingB; });
  expect(view.result.current.state.isLoadingMoreMessages).toBe(false);
  expect(view.result.current.state.chatMessages).toHaveLength(120);
});

test('an old A request cannot release a new A request after navigating A to B to A', async () => {
  const view = renderHistory();
  await act(async () => {});
  const container = document.createElement('div');
  let resolveOld!: (value: ReturnType<typeof response>) => void;
  let resolveNew!: (value: ReturnType<typeof response>) => void;
  sessionMessages.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  let oldRead!: Promise<boolean>;
  await act(async () => { oldRead = view.result.current.state.loadOlderMessages(container); });
  await act(async () => { view.rerender({ sessionId: 'b', active: true, selectedProject: project }); });
  await act(async () => { view.rerender({ sessionId: 'a', active: true, selectedProject: project }); });
  sessionMessages.mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
  let newRead!: Promise<boolean>;
  await act(async () => { newRead = view.result.current.state.loadOlderMessages(container); });
  await act(async () => { resolveOld(response(rows('a', 350).slice(150, 250), 350, true)); await oldRead; });
  expect(view.result.current.state.isLoadingMoreMessages).toBe(true);
  expect(view.result.current.state.visibleMessages).toHaveLength(100);
  expect(sessionMessages.mock.calls.at(-1)?.slice(0, 2)).toEqual(['a', { limit: 100, offset: 200 }]);
  await act(async () => { resolveNew(response(rows('a', 350).slice(50, 150), 350, true)); await newRead; });
  expect(view.result.current.state.isLoadingMoreMessages).toBe(false);
  expect(view.result.current.state.chatMessages).toHaveLength(300);
});

test('jumping while older history loads cancels restoration without leaving the loading lock held', async () => {
  const view = renderHistory();
  await act(async () => {});
  const container = document.createElement('div');
  let resolvePage!: (value: ReturnType<typeof response>) => void;
  sessionMessages.mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve; }));
  let pending!: Promise<boolean>;
  await act(async () => { pending = view.result.current.state.loadOlderMessages(container); });
  act(() => { view.result.current.state.scrollToBottomAndReset(); });
  await act(async () => { resolvePage(response(rows('a', 350).slice(150, 250), 350, true)); await pending; });
  expect(view.result.current.state.isLoadingMoreMessages).toBe(false);
  expect(view.result.current.state.visibleMessages).toHaveLength(100);
  await act(async () => { expect(await view.result.current.state.loadOlderMessages(container)).toBe(true); });
  expect(view.result.current.state.visibleMessages).toHaveLength(200);
});

test('switching from complete history to a hidden cached session replaces its pagination without an automatic read', async () => {
  const view = renderHistory();
  await act(async () => {});
  await act(async () => { view.rerender({ sessionId: 'b', active: true, selectedProject: project }); });
  await act(async () => { view.rerender({ sessionId: 'a', active: true, selectedProject: project }); });
  await act(async () => { await view.result.current.state.loadFullTranscript(); });
  expect(view.result.current.state.allMessagesLoaded).toBe(true);
  const reads = sessionMessages.mock.calls.length;
  await act(async () => { view.rerender({ sessionId: 'b', active: false, selectedProject: project }); });
  expect(sessionMessages).toHaveBeenCalledTimes(reads);
  expect(view.result.current.state.totalMessages).toBe(120);
  expect(view.result.current.state.hasMoreMessages).toBe(true);
  expect(view.result.current.state.allMessagesLoaded).toBe(false);
  await act(async () => { await view.result.current.state.loadOlderMessages(document.createElement('div'), { purpose: 'agents' }); });
  expect(sessionMessages.mock.calls.at(-1)?.slice(0, 2)).toEqual(['b', { limit: 100, offset: 100 }]);
  expect(view.result.current.state.chatMessages).toHaveLength(120);
  expect(view.result.current.state.hasMoreMessages).toBe(false);
  expect(view.result.current.state.allMessagesLoaded).toBe(true);
});

test('a hidden uncached session offers explicit first-page loading followed by ordinary older pages', async () => {
  const view = renderHistory();
  await act(async () => {});
  await act(async () => { await view.result.current.state.loadFullTranscript(); });
  const reads = sessionMessages.mock.calls.length;
  await act(async () => { view.rerender({ sessionId: 'b', active: false, selectedProject: project }); });
  expect(sessionMessages).toHaveBeenCalledTimes(reads);
  expect(view.result.current.state.chatMessages).toHaveLength(0);
  expect(view.result.current.state.totalMessages).toBe(0);
  expect(view.result.current.state.hasMoreMessages).toBe(true);
  expect(view.result.current.state.allMessagesLoaded).toBe(false);
  const container = document.createElement('div');
  await act(async () => { await view.result.current.state.loadOlderMessages(container); });
  expect(sessionMessages).toHaveBeenCalledTimes(reads);
  await act(async () => { await view.result.current.state.loadOlderMessages(container, { purpose: 'agents' }); });
  expect(sessionMessages.mock.calls.at(-1)?.slice(0, 2)).toEqual(['b', { limit: 100, offset: 0 }]);
  expect(view.result.current.state.chatMessages).toHaveLength(100);
  expect(view.result.current.state.totalMessages).toBe(120);
  expect(view.result.current.state.hasMoreMessages).toBe(true);
  await act(async () => { await view.result.current.state.loadOlderMessages(container, { purpose: 'agents' }); });
  expect(sessionMessages.mock.calls.at(-1)?.slice(0, 2)).toEqual(['b', { limit: 100, offset: 100 }]);
  expect(view.result.current.state.chatMessages).toHaveLength(120);
  expect(view.result.current.state.visibleMessages).toHaveLength(100);
  expect(view.result.current.state.allMessagesLoaded).toBe(true);
  const finalReads = sessionMessages.mock.calls.length;
  await act(async () => { view.rerender({ sessionId: 'b', active: true, selectedProject: project }); });
  expect(sessionMessages).toHaveBeenCalledTimes(finalReads);
});

test('failed explicit hidden first-page loading reports failure and leaves a retryable action', async () => {
  const view = renderHistory();
  await act(async () => {});
  await act(async () => { view.rerender({ sessionId: 'b', active: false, selectedProject: project }); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  sessionMessages.mockResolvedValueOnce({ ok: false, status: 503 });
  const container = document.createElement('div');
  await act(async () => {
    await expect(view.result.current.state.loadOlderMessages(container, { purpose: 'agents' })).rejects.toThrow('Could not load earlier');
  });
  expect(view.result.current.state.isLoadingMoreMessages).toBe(false);
  expect(view.result.current.state.hasMoreMessages).toBe(true);
  expect(view.result.current.state.allMessagesLoaded).toBe(false);
  expect(view.result.current.state.chatMessages).toHaveLength(0);
  await act(async () => { await view.result.current.state.loadOlderMessages(container, { purpose: 'agents' }); });
  expect(sessionMessages.mock.calls.at(-1)?.slice(0, 2)).toEqual(['b', { limit: 100, offset: 0 }]);
  expect(view.result.current.state.chatMessages).toHaveLength(100);
});
