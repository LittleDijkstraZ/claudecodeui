import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspacePanelsProvider, useWorkspacePanelActions, useWorkspacePanels } from '@/modules/workspace-panels/context/WorkspacePanelsContext';
import { WorkspacePanelLayout } from '@/modules/workspace-panels/WorkspacePanelLayout';
import { SideChatPanel } from '@/modules/workspace-panels/SideChatPanel';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }) }));
vi.mock('@/shared/ui', () => ({ Button: ({ variant: _variant, size: _size, ...props }: Record<string, unknown>) => <button {...props} /> }));
let measure: (() => void) | undefined;
function Main() { const [value, setValue] = useState(''); return <input aria-label="main draft" value={value} onChange={event => setValue(event.target.value)} />; }
function Harness({ navigate, settingsOpen = false }: { navigate?: (sessionId: string) => void; settingsOpen?: boolean }) {
  const actions = useWorkspacePanelActions(); const panel = useWorkspacePanels();
  return <><button onClick={() => actions?.openPanel('shell')}>Shell</button><button onClick={() => actions?.openPanel('files')}>Files</button><button onClick={() => actions?.openPanel('sideChat')}>Branches</button><output>{[...(panel?.visited ?? [])].join(',')}</output><WorkspacePanelLayout sessionId="main" main={<Main />} mainCovered={settingsOpen} title={panel?.tab ?? ''}><textarea aria-label="panel draft" /><SideChatPanel onNavigateToSession={navigate} /></WorkspacePanelLayout></>;
}
function openBranch(sessionId: string, parentSessionId = 'main') { act(() => { window.dispatchEvent(new CustomEvent('cloudcli:side-chat-open', { detail: { sessionId, parentSessionId, sessionName: sessionId } })); }); }

beforeEach(() => {
  localStorage.clear(); window.__CLOUDCLI_SIDE_CHAT__ = false; window.__REMOTE_BASE__ = '/remote/alpha';
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { measure = callback; } observe() {} disconnect() {} });
});

const originalParent = window.parent;
afterEach(() => {
  Object.defineProperty(window, 'parent', { configurable: true, value: originalParent });
  delete window.__CLOUDCLI_EMBEDDED__;
});

describe('retained workspace panel', () => {
  it('does not mark replies as read while settings covers chat and retains all mounted drafts', () => {
    const postMessage = vi.fn();
    Object.defineProperty(window, 'parent', { configurable: true, value: { postMessage } });
    window.__CLOUDCLI_EMBEDDED__ = true;
    const view = render(<WorkspacePanelsProvider><Harness /></WorkspacePanelsProvider>);
    const main = screen.getByLabelText('main draft');
    fireEvent.change(main, { target: { value: 'retained while configuring' } });
    fireEvent.click(screen.getByText('Shell'));
    const terminal = screen.getByLabelText('panel draft');
    view.rerender(<WorkspacePanelsProvider><Harness settingsOpen /></WorkspacePanelsProvider>);
    expect(postMessage).toHaveBeenLastCalledWith({ kind: 'cloudcli:chat-visibility', sessionId: 'main', visible: false }, location.origin);
    expect(screen.getByLabelText('main draft')).toBe(main);
    expect(screen.getByLabelText('panel draft')).toBe(terminal);
    view.rerender(<WorkspacePanelsProvider><Harness /></WorkspacePanelsProvider>);
    expect(postMessage).toHaveBeenLastCalledWith({ kind: 'cloudcli:chat-visibility', sessionId: 'main', visible: true }, location.origin);
    expect((main as HTMLInputElement).value).toBe('retained while configuring');
  });
  it('reports actual chat visibility rather than assuming every selected panel hides chat', () => {
    const postMessage = vi.fn();
    Object.defineProperty(window, 'parent', { configurable: true, value: { postMessage } });
    window.__CLOUDCLI_EMBEDDED__ = true;
    render(<WorkspacePanelsProvider><Harness /></WorkspacePanelsProvider>);
    const layout = screen.getByTestId('workspace-panel-layout');
    Object.defineProperty(layout, 'clientWidth', { configurable: true, value: 1200 }); act(() => measure?.());
    fireEvent.click(screen.getByText('Shell'));
    expect(postMessage).toHaveBeenLastCalledWith({ kind: 'cloudcli:chat-visibility', sessionId: 'main', visible: true }, location.origin);
    fireEvent.click(screen.getByLabelText('Maximize panel'));
    expect(postMessage).toHaveBeenLastCalledWith({ kind: 'cloudcli:chat-visibility', sessionId: 'main', visible: false }, location.origin);
    fireEvent.click(screen.getByLabelText('Restore split view'));
    expect(postMessage).toHaveBeenLastCalledWith({ kind: 'cloudcli:chat-visibility', sessionId: 'main', visible: true }, location.origin);
    Object.defineProperty(layout, 'clientWidth', { configurable: true, value: 390 }); act(() => measure?.());
    expect(postMessage).toHaveBeenLastCalledWith({ kind: 'cloudcli:chat-visibility', sessionId: 'main', visible: false }, location.origin);
    fireEvent.click(screen.getByLabelText('Collapse panel; keep work running'));
    expect(postMessage).toHaveBeenLastCalledWith({ kind: 'cloudcli:chat-visibility', sessionId: 'main', visible: true }, location.origin);
  });
  it('preserves main and auxiliary drafts through tab changes, collapse, maximize and resize', () => {
    render(<WorkspacePanelsProvider><Harness /></WorkspacePanelsProvider>);
    const layout = screen.getByTestId('workspace-panel-layout'); Object.defineProperty(layout, 'clientWidth', { value: 1200 }); act(() => measure?.());
    const main = screen.getByLabelText('main draft'); const draft = screen.getByLabelText('panel draft');
    fireEvent.change(main, { target: { value: 'main keeps running' } }); fireEvent.change(draft, { target: { value: 'saved pane text' } });
    fireEvent.click(screen.getByText('Shell')); const frame = screen.getByTestId('workspace-right-panel');
    expect(frame.style.width).toBe('500px'); fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' }); expect(frame.style.width).toBe('532px');
    fireEvent.click(screen.getByText('Files')); fireEvent.click(screen.getByLabelText('Maximize panel'));
    expect(screen.getByTestId('workspace-main-chat').classList.contains('hidden')).toBe(true);
    fireEvent.click(screen.getByLabelText('Restore split view')); expect(frame.style.width).toBe('532px');
    fireEvent.click(screen.getByLabelText('Collapse panel; keep work running')); fireEvent.click(screen.getByText('Shell'));
    expect(screen.getByLabelText('main draft')).toBe(main); expect((main as HTMLInputElement).value).toBe('main keeps running');
    expect(screen.getByLabelText('panel draft')).toBe(draft); expect((draft as HTMLTextAreaElement).value).toBe('saved pane text');
    expect(screen.getByRole('status').textContent).toBe('shell,files');
  });
  it('retains every side chat and validates forwarded branch origins', () => {
    const navigate = vi.fn(); render(<WorkspacePanelsProvider><Harness navigate={navigate} /></WorkspacePanelsProvider>);
    openBranch('branch-a'); const first = screen.getByTitle('branch-a') as HTMLIFrameElement;
    expect(first.getAttribute('src')).toBe('/remote/alpha/session/branch-a?embedded=1&sideChat=1');
    fireEvent.click(screen.getByText('Files')); openBranch('branch-b'); expect(screen.getByTitle('branch-a')).toBe(first);
    act(() => window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: window, data: { kind: 'cloudcli:side-chat-open', detail: { sessionId: 'spoof', parentSessionId: 'branch-b' } } })));
    expect(screen.queryByTitle('spoof')).toBeNull();
    const second = screen.getByTitle('branch-b') as HTMLIFrameElement;
    act(() => window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: second.contentWindow, data: { kind: 'cloudcli:side-chat-open', detail: { sessionId: 'nested', parentSessionId: 'branch-b', sessionName: 'nested' } } })));
    expect(screen.getByTitle('nested')).toBeDefined(); fireEvent.click(screen.getByLabelText('Return to previous side chat'));
    expect((screen.getByLabelText('Choose side chat') as HTMLSelectElement).value).toBe('branch-b');
    fireEvent.click(screen.getByLabelText('Return to main conversation')); expect(navigate).toHaveBeenCalledWith('main');
    expect(screen.getByTitle('branch-b')).toBe(second); expect(screen.getByTitle('branch-a')).toBe(first);
  });
});
