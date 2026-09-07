import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkspaceNavigationBridge } from '@/modules/project-workspace/hooks/useWorkspaceNavigationBridge';
import type { WorkspaceNavigationState } from '@/shared/types';

const originalParent = window.parent;
const parentWindow = { postMessage: vi.fn() } as unknown as Window;
const navigation: WorkspaceNavigationState = { sessionId: 'session-one', activeTab: 'chat', tabs: [{ id: 'chat', label: 'Chat' }, { id: 'shell', label: 'Shell' }] };
const receive = (data: unknown, origin = location.origin, source: Window = parentWindow) => act(() => {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
});

describe('embedded workspace navigation', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'parent', { configurable: true, value: parentWindow });
    window.__CLOUDCLI_EMBEDDED__ = true;
    window.__CLOUDCLI_SIDE_CHAT__ = false;
    vi.mocked(parentWindow.postMessage).mockClear();
  });
  afterEach(() => {
    Object.defineProperty(window, 'parent', { configurable: true, value: originalParent });
    delete window.__CLOUDCLI_EMBEDDED__;
    delete window.__CLOUDCLI_SIDE_CHAT__;
  });
  it('advertises actual available tabs and waits for its parent to acknowledge this session', () => {
    const ready = vi.fn(), select = vi.fn();
    renderHook(() => useWorkspaceNavigationBridge(navigation, select, ready));
    expect(parentWindow.postMessage).toHaveBeenCalledWith({ kind: 'cloudcli:workspace-nav', ...navigation }, location.origin);
    receive({ kind: 'cloudcli:workspace-nav-ready', sessionId: 'session-old' });
    receive({ kind: 'cloudcli:workspace-nav-ready', sessionId: navigation.sessionId }, 'https://unrelated.example');
    receive({ kind: 'cloudcli:workspace-nav-ready', sessionId: navigation.sessionId }, location.origin, window);
    expect(ready).not.toHaveBeenCalled();
    receive({ kind: 'cloudcli:workspace-nav-ready', sessionId: navigation.sessionId });
    expect(ready).toHaveBeenCalledWith(navigation.sessionId);
    receive({ kind: 'cloudcli:workspace-tab', sessionId: navigation.sessionId, tab: 'plugin:disabled' });
    expect(select).not.toHaveBeenCalled();
    receive({ kind: 'cloudcli:workspace-tab', sessionId: navigation.sessionId, tab: 'shell' });
    expect(select).toHaveBeenCalledWith('shell');
  });
  it('ignores late commands and acknowledgements after changing the selected session', () => {
    const ready = vi.fn(), select = vi.fn();
    const hook = renderHook(({ sessionId }) => useWorkspaceNavigationBridge({ ...navigation, sessionId }, select, ready), { initialProps: { sessionId: 'session-one' } });
    hook.rerender({ sessionId: 'session-two' });
    receive({ kind: 'cloudcli:workspace-tab', sessionId: 'session-one', tab: 'shell' });
    receive({ kind: 'cloudcli:workspace-nav-ready', sessionId: 'session-one' });
    expect(ready).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    receive({ kind: 'cloudcli:workspace-nav-ready', sessionId: 'session-two' });
    expect(ready).toHaveBeenCalledWith('session-two');
  });
  it('keeps independent navigation in side chats and standalone windows', () => {
    window.__CLOUDCLI_SIDE_CHAT__ = true;
    const sideChat = renderHook(() => useWorkspaceNavigationBridge(navigation, vi.fn()));
    expect(parentWindow.postMessage).not.toHaveBeenCalled();
    sideChat.unmount();
    window.__CLOUDCLI_SIDE_CHAT__ = false;
    Object.defineProperty(window, 'parent', { configurable: true, value: window });
    renderHook(() => useWorkspaceNavigationBridge(navigation, vi.fn()));
    expect(parentWindow.postMessage).not.toHaveBeenCalled();
  });
});
