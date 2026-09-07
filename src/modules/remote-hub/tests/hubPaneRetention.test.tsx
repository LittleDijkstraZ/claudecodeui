import { act, renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { useHubPanes } from '@/modules/remote-hub/hooks/useHubPanes';

describe('machine pane lifetime', () => {
  test('empty navigation rejects the deleted session until the remote acknowledges its cleared workspace', () => {
    const { result } = renderHook(useHubPanes);
    act(() => { result.current.navigate('alpha', 'old'); result.current.acceptSelection('alpha', 'old'); result.current.navigate('beta', 'other'); result.current.acceptSelection('beta', 'other'); });
    const retained = result.current.panes[0];
    act(() => result.current.navigate('alpha', null));
    expect(result.current.acceptSelection('alpha', 'old')).toBe(false);
    act(() => result.current.acceptNavigation('alpha', { sessionId: 'old', activeTab: 'chat', tabs: [{ id: 'chat', label: 'Chat' }] }));
    expect(result.current.navigation.alpha).toBeUndefined();
    act(() => result.current.acceptNavigation('alpha', { sessionId: null, activeTab: 'chat', tabs: [{ id: 'chat', label: 'Chat' }] }));
    expect(result.current.navigation.alpha.sessionId).toBeNull();
    expect(result.current.selections.alpha).toBeUndefined();
    expect(result.current.selections.beta).toBe('other');
    expect(result.current.panes[0]).toBe(retained);
    act(() => { expect(result.current.acceptSelection('alpha', 'created-in-empty-chat')).toBe(true); });
  });
  test('switching conversations and machines keeps the initial iframe URLs and sends navigation inside the existing app', () => {
    const { result } = renderHook(useHubPanes);
    const postMessage = vi.fn();
    const source = { postMessage } as unknown as Window;
    const frame = { contentWindow: source } as HTMLIFrameElement;
    act(() => result.current.navigate('alpha', 'first'));
    const firstPane = result.current.panes[0];
    act(() => { result.current.register('alpha', frame); result.current.markReady('alpha'); });
    expect(postMessage).toHaveBeenLastCalledWith({ kind: 'cloudcli:navigate', sessionId: 'first' }, location.origin);
    act(() => result.current.navigate('beta', 'first'));
    act(() => result.current.navigate('alpha', 'second'));
    expect(result.current.panes).toHaveLength(2);
    expect(result.current.panes[0]).toBe(firstPane);
    expect(result.current.panes[0].initialSessionId).toBe('first');
    expect(postMessage).toHaveBeenLastCalledWith({ kind: 'cloudcli:navigate', sessionId: 'second' }, location.origin);
    expect(result.current.remoteForSource(source)).toBe('alpha');
    expect(result.current.remoteForSource(null)).toBeNull();
    expect(result.current.remoteForSource(window)).toBeNull();
  });
  test('a late selection from the previously displayed conversation cannot undo new navigation', () => {
    const { result } = renderHook(useHubPanes);
    act(() => result.current.navigate('alpha', 'new'));
    expect(result.current.acceptSelection('alpha', 'old')).toBe(false);
    act(() => { expect(result.current.acceptSelection('alpha', 'new')).toBe(true); });
    // After requested navigation settles, a sidechat/rewind/new-session action may navigate normally.
    act(() => { expect(result.current.acceptSelection('alpha', 'created-in-app')).toBe(true); });
  });
});


test('a retained frame supplies its own navigation and stale or unknown tab commands are ignored', () => {
  const { result } = renderHook(useHubPanes);
  const postMessage = vi.fn();
  act(() => { result.current.register('alpha', { contentWindow: { postMessage } } as unknown as HTMLIFrameElement); result.current.navigate('alpha', 'new'); });
  act(() => result.current.acceptNavigation('alpha', { sessionId: 'old', activeTab: 'chat', tabs: [{ id: 'chat', label: 'Chat' }] }));
  expect(result.current.navigation.alpha).toBeUndefined();
  act(() => result.current.acceptNavigation('alpha', { sessionId: 'new', activeTab: 'chat', tabs: [{ id: 'chat', label: 'Chat' }, { id: 'shell', label: 'Shell' }] }));
  expect(postMessage).toHaveBeenLastCalledWith({ kind: 'cloudcli:workspace-nav-ready', sessionId: 'new' }, location.origin);
  act(() => result.current.selectTab('alpha', 'shell'));
  expect(postMessage).toHaveBeenLastCalledWith({ kind: 'cloudcli:workspace-tab', tab: 'shell', sessionId: 'new' }, location.origin);
  const count = postMessage.mock.calls.length;
  act(() => result.current.selectTab('alpha', 'plugin:unavailable'));
  act(() => result.current.selectTab('beta', 'shell'));
  expect(postMessage.mock.calls).toHaveLength(count);
});

test('settings clicked before readiness stays bound to its machine after switching panes', () => {
  const { result } = renderHook(useHubPanes);
  const alpha = vi.fn(), beta = vi.fn();
  act(() => result.current.openSettings('alpha'));
  expect(result.current.panes[0]).toEqual({ remoteId: 'alpha', initialSessionId: null });
  act(() => result.current.navigate('beta', 'other-session'));
  act(() => {
    result.current.register('alpha', { contentWindow: { postMessage: alpha } } as unknown as HTMLIFrameElement);
    result.current.register('beta', { contentWindow: { postMessage: beta } } as unknown as HTMLIFrameElement);
    result.current.markReady('beta');
  });
  expect(beta.mock.calls.some(([message]) => message.kind === 'cloudcli:settings')).toBe(false);
  expect(alpha).not.toHaveBeenCalled();
  act(() => result.current.markReady('alpha'));
  expect(alpha).toHaveBeenCalledWith({ kind: 'cloudcli:settings', remoteId: 'alpha', requestId: expect.any(String) }, location.origin);
  const requestId = alpha.mock.calls.at(-1)![0].requestId;
  // Startup remounts can lose the first delivery; only an explicit receipt
  // retires this request so closing it cannot cause a later replay.
  act(() => result.current.markReady('alpha'));
  expect(alpha).toHaveBeenLastCalledWith({ kind: 'cloudcli:settings', remoteId: 'alpha', requestId }, location.origin);
  act(() => result.current.acceptSettingsOpened('alpha', requestId));
  const delivered = alpha.mock.calls.length;
  act(() => result.current.markReady('alpha'));
  expect(alpha).toHaveBeenCalledTimes(delivered);
  act(() => result.current.openSettings('beta'));
  expect(beta).toHaveBeenLastCalledWith({ kind: 'cloudcli:settings', remoteId: 'beta', requestId: expect.any(String) }, location.origin);
  expect(alpha).toHaveBeenCalledTimes(delivered);
  act(() => result.current.openSettings('alpha'));
  const newerId = alpha.mock.calls.at(-1)![0].requestId;
  expect(newerId).not.toBe(requestId);
  act(() => result.current.acceptSettingsOpened('alpha', requestId));
  act(() => result.current.markReady('alpha'));
  expect(alpha).toHaveBeenLastCalledWith({ kind: 'cloudcli:settings', remoteId: 'alpha', requestId: newerId }, location.origin);
});

test('drawer requests retain machine identity and explicit intent through readiness and stale acknowledgements', () => {
  const { result } = renderHook(useHubPanes);
  const alpha = vi.fn(), beta = vi.fn();
  act(() => {
    result.current.setPanelOpen('alpha', true);
    result.current.navigate('beta', 'other-session');
    result.current.register('alpha', { contentWindow: { postMessage: alpha } } as unknown as HTMLIFrameElement);
    result.current.register('beta', { contentWindow: { postMessage: beta } } as unknown as HTMLIFrameElement);
    result.current.markReady('beta');
  });
  expect(beta.mock.calls.some(([message]) => message.kind === 'cloudcli:workspace-panel')).toBe(false);
  act(() => result.current.markReady('alpha'));
  const opening = alpha.mock.calls.at(-1)![0];
  expect(opening).toMatchObject({ kind: 'cloudcli:workspace-panel', remoteId: 'alpha', open: true });
  act(() => result.current.setPanelOpen('alpha', false));
  const closing = alpha.mock.calls.at(-1)![0];
  act(() => result.current.acceptPanelState('alpha', { remoteId: 'alpha', requestId: opening.requestId, open: true, maximized: false, settingsOpen: false }));
  expect(result.current.panelStates.alpha.pendingOpen).toBe(false);
  act(() => result.current.acceptPanelState('alpha', { remoteId: 'beta', requestId: closing.requestId, open: false, maximized: false, settingsOpen: false }));
  expect(result.current.panelStates.alpha.pendingOpen).toBe(false);
  act(() => result.current.acceptPanelState('alpha', { remoteId: 'alpha', requestId: closing.requestId, open: false, maximized: false, settingsOpen: false }));
  expect(result.current.panelStates.alpha).toEqual({ open: false, maximized: false, settingsOpen: false, overlayOpen: false, pendingOpen: undefined });
  const delivered = alpha.mock.calls.length;
  act(() => result.current.markReady('alpha'));
  expect(alpha).toHaveBeenCalledTimes(delivered);
  act(() => result.current.acceptPanelState('beta', { remoteId: 'beta', open: true, maximized: true, settingsOpen: true }));
  expect(result.current.panelStates.alpha.open).toBe(false);
  expect(result.current.panelStates.beta).toMatchObject({ open: true, maximized: true, settingsOpen: true });
});
