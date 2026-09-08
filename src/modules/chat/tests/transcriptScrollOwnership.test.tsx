import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedMessage, Project, ProjectSession, SessionActivityMap } from '@/shared/types';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';

/**
 * The transcript's scroll position is written from five places coordinated by
 * refs and timers rather than by one owner. These are the two cases where that
 * coordination was observably wrong; both are timing bugs, so they are driven
 * on fake timers rather than by clicking.
 */

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }),
    },
  },
}));

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const buildMessage = (index: number, timestamp: string): NormalizedMessage => ({
  id: `m-${index}`,
  kind: 'text',
  role: index % 2 === 0 ? 'user' : 'assistant',
  provider: 'claude',
  sessionId: SESSION_A,
  content: `message ${index}`,
  timestamp,
} as NormalizedMessage);

/**
 * jsdom has no layout, so scrollHeight/clientHeight are always 0 and assigning
 * scrollTop emits nothing. These are the exact reads the scroll code makes.
 */
function createContainer(scrollHeight: number, clientHeight: number) {
  const element = document.createElement('div');
  const content = document.createElement('div');
  content.setAttribute('data-chat-content', '');
  element.appendChild(content);
  const writes: number[] = [];
  let scrollTop = scrollHeight - clientHeight;

  Object.defineProperty(element, 'scrollHeight', { get: () => scrollHeight });
  Object.defineProperty(element, 'clientHeight', { get: () => clientHeight });
  Object.defineProperty(element, 'scrollTop', {
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = Math.max(0, Math.min(next, scrollHeight - clientHeight));
      writes.push(next);
    },
  });

  return {
    element: element as HTMLDivElement, content, writes, scrollHeight,
    grow: (height: number) => { scrollHeight = height; },
    resize: (height: number) => { clientHeight = height; },
    userScroll: (top: number) => { scrollTop = top; element.dispatchEvent(new Event('scroll')); },
  };
}

function createStore(messagesBySession: Map<string, NormalizedMessage[]>) {
  // A hydrated slot, so the session-loading effect takes its early return
  // instead of re-fetching on every render.
  const slotFor = (sessionId: string) => ({
    fetchedAt: 1,
    status: 'idle' as const,
    total: messagesBySession.get(sessionId)?.length ?? 0,
    hasMore: false,
    offset: messagesBySession.get(sessionId)?.length ?? 0,
  });

  return {
    fetchFromServer: vi.fn(async (sessionId: string) => slotFor(sessionId)),
    fetchMore: vi.fn(async (sessionId: string) => ({ slot: slotFor(sessionId), prependedCount: 0 })),
    appendRealtime: vi.fn<(sessionId: string, message: NormalizedMessage) => void>(),
    refreshLatestFromServer: vi.fn(async (sessionId: string) => ({
      slot: slotFor(sessionId),
      applied: true,
      changed: false,
      deferred: false,
    })),
    setActiveSession: vi.fn(),
    isStale: vi.fn(() => false),
    updateStreaming: vi.fn(),
    finalizeStreaming: vi.fn(),
    getMessages: vi.fn((sessionId: string) => messagesBySession.get(sessionId) ?? []),
    getSessionSlot: vi.fn((sessionId: string) => slotFor(sessionId)),
  };
}

async function renderChatSessionState(options: {
  session: ProjectSession;
  store: ReturnType<typeof createStore>;
  processingSessions?: SessionActivityMap;
  active?: boolean;
}) {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');

  return renderHook(
    ({ session, active = true, update = 0 }: { session: ProjectSession; active?: boolean; update?: number }) =>
      useChatSessionState({
        isActive: active,
        externalMessageUpdate: update,
        processingSessions: options.processingSessions,
        selectedProject: project,
        selectedSession: session,
        ws: null,
        sendMessage: vi.fn(),
        statusCheckSentAtRef: { current: new Map() },
        lastSeqRef: { current: new Map() },
        sessionStore: options.store as never,
      }),
    { initialProps: { session: options.session, active: options.active } as { session: ProjectSession; active?: boolean; update?: number } },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  // The initial-scroll effect is a separate writer that re-scrolls to the
  // bottom every animation frame until the height settles. It would satisfy an
  // assertion meant for the deferred timer, so it is silenced here — these
  // tests are about which writer wins, and it is not one of the two.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe('deferred scroll-to-bottom', () => {
  it('does not yank the view back down when the user scrolls up inside the delay', async () => {
    const messages = new Map<string, NormalizedMessage[]>([
      [SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z')]],
    ]);
    const store = createStore(messages);
    const { result, rerender } = await renderChatSessionState({
      session: { id: SESSION_A } as ProjectSession,
      store,
    });

    const container = createContainer(5000, 500);
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;

    // A new row lands while the user is at the bottom: a scroll is armed for +50ms.
    messages.set(SESSION_A, [
      ...messages.get(SESSION_A)!,
      buildMessage(1, '2026-01-01T00:00:01.000Z'),
    ]);
    act(() => {
      rerender({ session: { id: SESSION_A } as ProjectSession });
    });

    // ...and the user drags upward before it fires.
    act(() => {
      result.current.setIsUserScrolledUp(true);
    });
    container.writes.length = 0;

    act(() => {
      vi.advanceTimersByTime(200);
    });

    assert.deepEqual(
      container.writes,
      [],
      `a scroll armed before the user scrolled up must not fire afterwards; got ${JSON.stringify(container.writes)}`,
    );
  });

  it('still sticks to the bottom when the user has not scrolled away', async () => {
    const messages = new Map<string, NormalizedMessage[]>([
      [SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z')]],
    ]);
    const store = createStore(messages);
    const { result, rerender } = await renderChatSessionState({
      session: { id: SESSION_A } as ProjectSession,
      store,
    });

    const container = createContainer(5000, 500);
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;

    messages.set(SESSION_A, [
      ...messages.get(SESSION_A)!,
      buildMessage(1, '2026-01-01T00:00:01.000Z'),
    ]);
    act(() => {
      rerender({ session: { id: SESSION_A } as ProjectSession });
    });
    container.writes.length = 0;

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(container.writes).toContain(container.scrollHeight);
  });
});

describe('search jump ownership', () => {
  it('opens a matching compact summary before scrolling to its content', async () => {
    const timestamp = '2026-01-01T00:00:00.000Z';
    const messages = new Map<string, NormalizedMessage[]>([
      [SESSION_A, [{ ...buildMessage(0, timestamp), isCompactSummary: true }]],
    ]);
    const store = createStore(messages);
    const searchSession = { id: SESSION_A, __searchTargetSnippet: 'message 0', __searchTargetTimestamp: timestamp } as unknown as ProjectSession;
    const { result, rerender } = await renderChatSessionState({ session: { id: SESSION_A } as ProjectSession, store });
    const container = createContainer(5000, 500);
    const row = document.createElement('div');
    row.setAttribute('data-message-timestamp', String(result.current.chatMessages[0].timestamp));
    const summary = document.createElement('details');
    summary.setAttribute('data-compaction-summary', '');
    row.appendChild(summary);
    container.element.appendChild(row);
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;
    const statesAtScroll: boolean[] = [];
    row.scrollIntoView = () => { statesAtScroll.push(summary.open); };
    act(() => { rerender({ session: searchSession }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(summary.open).toBe(true);
    expect(statesAtScroll).toEqual([true]);
  });

  it('does not follow the user into the next session', { timeout: 20_000 }, async () => {
    const messages = new Map<string, NormalizedMessage[]>([
      [SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z')]],
      [SESSION_B, [buildMessage(1, '2026-01-01T00:00:05.000Z')]],
    ]);
    const store = createStore(messages);
    const searchSession = {
      id: SESSION_A,
      __searchTargetSnippet: 'message 0',
      __searchTargetTimestamp: '2026-01-01T00:00:00.000Z',
    } as unknown as ProjectSession;

    const { result, rerender } = await renderChatSessionState({ session: searchSession, store });

    const container = createContainer(5000, 500);
    // The row session B renders. The jump requested against session A resolves
    // by timestamp, and on its last retry it accepts the nearest row it can
    // find — which, after the switch, is this one.
    const sessionBRow = document.createElement('div');
    sessionBRow.setAttribute('data-message-timestamp', '2026-01-01T00:00:05.000Z');
    container.element.appendChild(sessionBRow);

    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    // Let the jump arm and start retrying.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // The user gives up waiting and opens a different session.
    await act(async () => {
      rerender({ session: { id: SESSION_B } as ProjectSession });
    });

    // Let the whole retry budget elapse (20 retries, 150ms apart).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3400);
    });

    assert.equal(
      scrollIntoView.mock.calls.length,
      0,
      'a jump requested in the previous session must not scroll the new one',
    );
    assert.equal(
      container.element.querySelectorAll('.search-highlight-flash').length,
      0,
      'and must not flash the search highlight on one of its rows',
    );
  });
});


describe('external Shell history while Chat is processing', () => {
  it('refreshes a busy visible chat, defers a hidden pane, and flushes it when revealed', async () => {
    const session = { id: SESSION_A } as ProjectSession;
    const store = createStore(new Map([[SESSION_A, [buildMessage(0, '2026-01-01T00:00:00Z')]]]));
    const processingSessions: SessionActivityMap = new Map([[SESSION_A, {
      statusText: 'Background workflow', canInterrupt: true, startedAt: Date.now(),
      phase: 'background', acceptsInput: true,
    }]]);
    const hook = await renderChatSessionState({ session, store, processingSessions });
    expect(hook.result.current.isProcessing).toBe(true);
    store.refreshLatestFromServer.mockClear();
    await act(async () => { hook.rerender({ session, update: 1 }); });
    expect(store.refreshLatestFromServer).toHaveBeenCalledTimes(1);
    expect(store.refreshLatestFromServer.mock.calls[0][0]).toBe(SESSION_A);
    await act(async () => { hook.rerender({ session, active: false, update: 2 }); });
    expect(store.refreshLatestFromServer).toHaveBeenCalledTimes(1);
    await act(async () => { hook.rerender({ session, active: true, update: 2 }); });
    expect(store.refreshLatestFromServer).toHaveBeenCalledTimes(2);
    expect(hook.result.current.isProcessing).toBe(true);
  });
});


it('a first-send echo targets its allocated session directly without a pending single-message slot', async () => {
  const store = createStore(new Map());
  const hook = await renderChatSessionState({ session: { id: '' } as ProjectSession, store });
  act(() => {
    hook.result.current.addMessage({ type: 'user', content: 'First prompt', timestamp: 1, clientMessageId: 'fixture-input', delivery: 'queued' }, 'allocated-session', 'claude');
    hook.result.current.addMessage({ type: 'user', content: 'First prompt', timestamp: 1, clientMessageId: 'fixture-input', delivery: 'failed' }, 'allocated-session', 'claude');
  });
  expect(store.appendRealtime.mock.calls.map(([id, message]) => [id, message.provider, message.clientMessageId, message.delivery])).toEqual([
    ['allocated-session', 'claude', 'fixture-input', 'queued'], ['allocated-session', 'claude', 'fixture-input', 'failed'],
  ]);
});

class DrivenResizeObserver {
  static instances: DrivenResizeObserver[] = [];
  disconnected = false;
  targets: Element[] = [];
  constructor(private callback: ResizeObserverCallback) { DrivenResizeObserver.instances.push(this); }
  observe(target: Element) { this.targets.push(target); }
  disconnect() { this.disconnected = true; }
  fire() { this.callback([], this as unknown as ResizeObserver); }
}

async function followingFixture(withObserver = true, settleInitial = true) {
  DrivenResizeObserver.instances = [];
  if (withObserver) vi.stubGlobal('ResizeObserver', DrivenResizeObserver);
  else vi.stubGlobal('ResizeObserver', undefined);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
  const session = { id: SESSION_A } as ProjectSession;
  const messages = new Map([[SESSION_A, [buildMessage(1, '2026-09-08T00:00:00Z')]]]);
  const store = createStore(messages);
  const hook = await renderChatSessionState({ session, store, active: false });
  const container = createContainer(5000, 500);
  (hook.result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;
  await act(async () => { hook.rerender({ session, active: true }); });
  if (settleInitial) await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  container.writes.length = 0;
  return { hook, container, messages, store, session, observer: DrivenResizeObserver.instances.at(-1)! };
}

describe('following growing replies', () => {
  it('follows fast same-row token updates without waiting for a new message or starving its delay', async () => {
    const { hook, container, messages, session } = await followingFixture(false);
    for (let step = 1; step <= 12; step++) {
      await act(async () => {
        container.grow(5000 + 100 * step);
        messages.set(SESSION_A, [{ ...buildMessage(1, '2026-09-08T00:00:00Z'), content: `same reply growing ${step}` }]);
        hook.rerender({ session });
        await vi.advanceTimersByTimeAsync(10);
      });
    }
    expect(hook.result.current.chatMessages).toHaveLength(1);
    expect(container.writes.length).toBeGreaterThanOrEqual(2);
    expect(container.element.scrollTop).toBeGreaterThanOrEqual(5500);
  });

  it('follows async Markdown height and viewport changes without classifying growth as a user scroll', async () => {
    const { hook, container, observer } = await followingFixture();
    expect(observer.targets).toContain(container.content);
    expect(observer.targets).toContain(container.element);
    await act(async () => {
      container.grow(5600);
      container.element.dispatchEvent(new Event('scroll'));
      observer.fire();
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(hook.result.current.isUserScrolledUp).toBe(false);
    expect(container.element.scrollTop).toBe(5100);
    await act(async () => {
      container.resize(350);
      observer.fire();
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(container.element.scrollTop).toBe(5250);
  });

  it('small upward wheel gestures pause immediately, keep their position through resize, and resume only at the bottom', async () => {
    const { hook, container, observer } = await followingFixture();
    await act(async () => {
      observer.fire();
      await hook.result.current.handleScroll({ type: 'wheel', deltaY: -20 });
      container.userScroll(4480);
      container.grow(5600);
      observer.fire();
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(hook.result.current.isUserScrolledUp).toBe(true);
    expect(container.element.scrollTop).toBe(4480);
    expect(container.writes).toEqual([]);
    await act(async () => {
      container.userScroll(5100);
      container.grow(5800);
      observer.fire();
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(hook.result.current.isUserScrolledUp).toBe(false);
    expect(container.element.scrollTop).toBe(5300);
  });

  it.each([20, 1300])('scrollbar movement of %i pixels pauses following and the jump button explicitly restores it', async distance => {
    const { hook, container, observer } = await followingFixture();
    await act(async () => { container.userScroll(4500 - distance); });
    expect(hook.result.current.isUserScrolledUp).toBe(true);
    await act(async () => {
      container.grow(5600);
      observer.fire();
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(container.element.scrollTop).toBe(4500 - distance);
    await act(async () => {
      hook.result.current.scrollToBottomAndReset();
      container.grow(5800);
      observer.fire();
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(hook.result.current.isUserScrolledUp).toBe(false);
    expect(container.element.scrollTop).toBe(5300);
  });

  it('a reveal owns the viewport while content expands and a hidden pane cannot receive a late resize write', async () => {
    const { hook, container, observer, session } = await followingFixture();
    act(() => { expect(hook.result.current.revealMessage(getIntrinsicMessageKey(hook.result.current.chatMessages[0])!)).toBe(true); });
    container.writes.length = 0;
    await act(async () => {
      container.grow(5600);
      observer.fire();
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(container.writes).toEqual([]);
    await act(async () => {
      hook.result.current.finishMessageReveal();
      hook.result.current.scrollToBottomAndReset();
    });
    container.writes.length = 0;
    act(() => {
      observer.fire();
      hook.rerender({ session, active: false });
    });
    expect(observer.disconnected).toBe(true);
    await act(async () => { observer.fire(); await vi.advanceTimersByTimeAsync(100); });
    expect(container.writes).toEqual([]);
  });
});


it('an upward gesture cancels the pending initial-scroll frame as well as resize following', async () => {
  const { hook, container, observer } = await followingFixture(true, false);
  await act(async () => {
    await hook.result.current.handleScroll({ type: 'wheel', deltaY: -20 });
    container.userScroll(4480);
    container.grow(5500);
    observer.fire();
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(container.writes).toEqual([]);
  expect(container.element.scrollTop).toBe(4480);
  expect(hook.result.current.isUserScrolledUp).toBe(true);
});

it('an explicit jump replaces an old queued follow timer so one later chunk still follows without ResizeObserver', async () => {
  const { hook, container, messages, session } = await followingFixture(false);
  await act(async () => {
    messages.set(SESSION_A, [{ ...buildMessage(1, '2026-09-08T00:00:00Z'), content: 'first live chunk' }]);
    hook.rerender({ session });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
    hook.result.current.scrollToBottomAndReset();
  });
  container.writes.length = 0;
  await act(async () => {
    container.grow(5600);
    messages.set(SESSION_A, [{ ...buildMessage(1, '2026-09-08T00:00:00Z'), content: 'last live chunk' }]);
    hook.rerender({ session });
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(container.element.scrollTop).toBe(5100);
  expect(container.writes).toContain(5600);
});
