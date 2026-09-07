import { act, renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { useHubPanes } from '@/modules/remote-hub/hooks/useHubPanes';

describe('machine pane lifetime', () => {
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
    expect(result.current.acceptSelection('alpha', 'new')).toBe(true);
    // After requested navigation settles, a sidechat/rewind/new-session action may navigate normally.
    expect(result.current.acceptSelection('alpha', 'created-in-app')).toBe(true);
  });
});
