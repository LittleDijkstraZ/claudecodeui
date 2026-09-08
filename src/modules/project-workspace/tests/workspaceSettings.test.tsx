import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { AgentSettingsProject, Project } from '@/shared/types';
import { ProjectsStateProvider, useProjectMainState, useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';
import ProjectWorkspaceShell from '@/modules/project-workspace/ProjectWorkspaceShell';
import { useWorkspacePanels } from '@/modules/workspace-panels';
import { useModalPresence } from '@/shared/hooks/useModalVisibility';

const fixture = vi.hoisted(() => ({ projects: [] as Project[], activeTab: 'shell', clearSessionSelection: vi.fn() }));
vi.mock('@/modules/project-workspace/hooks/useProjectsState', () => ({ useProjectsState: () => {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('agents');
  const openSettings = (tab = 'agents') => { setSettingsInitialTab(tab); setShowSettings(true); };
  return { projects: fixture.projects, selectedProject: null, selectedSession: null,
    activeTab: fixture.activeTab, setActiveTab: vi.fn(), showSettings, settingsInitialTab, openSettings,
    closeSettings: () => setShowSettings(false), sidebarOpen: true,
    clearSessionSelection: fixture.clearSessionSelection,
    sidebarSharedProps: { onShowSettings: () => openSettings() } };
} }));
vi.mock('@/modules/project-workspace/ProjectMainRegion', () => ({ default: function MockProjectMainRegion() {
  const { openSettings } = useProjectMainState();
  const panel = useWorkspacePanels();
  return <><button onClick={() => openSettings('git')}>Open from tool panel</button><output data-testid="panel-state">{String(panel?.open)}:{panel?.tab}</output></>;
} }));
vi.mock('@/modules/project-workspace/ProjectSidebarRegion', () => ({ default: function MockProjectSidebarRegion() {
  const { sidebarSharedProps } = useProjectSidebarState();
  return <button onClick={sidebarSharedProps.onShowSettings}>Sidebar settings</button>;
} }));
vi.mock('@/modules/settings', () => ({ Settings: ({ remoteName, projects, initialTab, onClose }: { remoteName?: string; projects: AgentSettingsProject[]; initialTab: string; onClose: () => void }) =>
  <div role="dialog" aria-label={`Settings · ${remoteName ?? 'standalone'}`}><span>{initialTab}</span><output>{JSON.stringify(projects)}</output><button onClick={onClose}>Close settings</button></div>,
}));
vi.mock('@/modules/plugins', () => ({ usePlugins: () => ({ plugins: [{ name: 'fixture-tool', enabled: true }] }) }));
vi.mock('@/modules/quick-settings-panel', () => ({ QuickSettingsPanel: () => null }));
vi.mock('@/modules/project-workspace/controllers/ProjectEffects', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/ProjectCommandPalette', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/ProjectGroupDialogs', () => ({ default: () => null }));

const originalParent = window.parent;
const parentWindow = { postMessage: vi.fn() } as unknown as Window;
const receive = (remoteId: string, origin = location.origin, source = parentWindow) => act(() => {
  window.dispatchEvent(new MessageEvent('message', { origin, source, data: { kind: 'cloudcli:settings', remoteId, requestId: `open-${remoteId}` } }));
});
const workspace = () => render(<ProjectsStateProvider navigate={vi.fn()} subscribe={() => () => {}} isMobile={false} isSessionProcessing={() => false}>
  <ProjectWorkspaceShell isMobile={false} navigate={vi.fn()} sendMessage={vi.fn()} ws={null} />
</ProjectsStateProvider>);
function ModalCoverage({ open }: { open: boolean }) { useModalPresence(open); return null; }
beforeEach(() => {
  fixture.projects = []; fixture.activeTab = 'shell';
  fixture.clearSessionSelection.mockClear();
  window.__CLOUDCLI_EMBEDDED__ = true; window.__REMOTE_ID__ = 'alpha'; window.__REMOTE_NAME__ = 'Server Alpha';
  Object.defineProperty(window, 'parent', { configurable: true, value: parentWindow });
});
afterEach(() => {
  delete window.__CLOUDCLI_EMBEDDED__; delete window.__REMOTE_ID__; delete window.__REMOTE_NAME__;
  Object.defineProperty(window, 'parent', { configurable: true, value: originalParent });
});

test('the hub gear opens settings with no sidebar, selected project or chat view and supports closing and reopening', () => {
  workspace();
  expect(screen.queryByText('Sidebar settings')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  receive('alpha');
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('dialog', { name: 'Settings · Server Alpha' }).textContent).toContain('[]');
  expect(parentWindow.postMessage).toHaveBeenCalledWith({ kind: 'cloudcli:settings-opened', remoteId: 'alpha', requestId: 'open-alpha' }, location.origin);
  fireEvent.click(screen.getByText('Close settings'));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByText('Open from tool panel'));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('dialog').textContent).toContain('git');
});

test('commands for another machine or from an untrusted window cannot open this remote settings', () => {
  workspace();
  receive('beta'); receive('alpha', 'https://unrelated.example'); receive('alpha', location.origin, window);
  expect(screen.queryByRole('dialog')).toBeNull();
  receive('alpha');
  expect(screen.getByRole('dialog', { name: 'Settings · Server Alpha' })).toBeTruthy();
  receive('beta');
  expect(screen.queryByRole('dialog', { name: /Beta/ })).toBeNull();
});

test('right drawer commands keep explicit state, acknowledge their fixed remote and expose settings coverage', () => {
  workspace();
  const send = (open: unknown, remoteId = 'alpha', source = parentWindow) => act(() => window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source, data: { kind: 'cloudcli:workspace-panel', remoteId, open, requestId: 'panel-one' } })));
  send(true, 'beta'); send(true, 'alpha', window); send('true');
  expect(screen.getByTestId('panel-state').textContent).toBe('false:preferences');
  send(true); send(true);
  expect(screen.getByTestId('panel-state').textContent).toBe('true:preferences');
  expect(parentWindow.postMessage).toHaveBeenCalledWith({ kind: 'cloudcli:workspace-panel-state', remoteId: 'alpha', open: true, maximized: false, settingsOpen: false, overlayOpen: false, requestId: 'panel-one' }, location.origin);
  receive('alpha');
  expect(parentWindow.postMessage).toHaveBeenCalledWith({ kind: 'cloudcli:workspace-panel-state', remoteId: 'alpha', open: true, maximized: false, settingsOpen: true, overlayOpen: true }, location.origin);
  fireEvent.click(screen.getByText('Close settings'));
  send(false);
  expect(screen.getByTestId('panel-state').textContent).toBe('false:preferences');
});

test('token or review dialogs report overlay coverage and release host controls when closed', () => {
  workspace();
  const modal = render(<ModalCoverage open />);
  expect(parentWindow.postMessage).toHaveBeenCalledWith({ kind: 'cloudcli:workspace-panel-state', remoteId: 'alpha', open: false, maximized: false, settingsOpen: false, overlayOpen: true }, location.origin);
  modal.rerender(<ModalCoverage open={false} />);
  expect(parentWindow.postMessage).toHaveBeenLastCalledWith({ kind: 'cloudcli:workspace-panel-state', remoteId: 'alpha', open: false, maximized: false, settingsOpen: false, overlayOpen: false }, location.origin);
});

test('returning the retained remote to an empty route explicitly clears its chat session binding', () => {
  workspace();
  act(() => window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: window, data: { kind: 'cloudcli:navigate', sessionId: null } })));
  expect(fixture.clearSessionSelection).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: parentWindow, data: { kind: 'cloudcli:navigate', sessionId: null } })));
  expect(fixture.clearSessionSelection).toHaveBeenCalledTimes(1);
});

test('rapid reverse drawer requests cannot attach an obsolete request id to later overlay broadcasts', () => {
  workspace();
  act(() => {
    for (const [open, requestId] of [[true, 'opening'], [false, 'closing']]) window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: parentWindow, data: { kind: 'cloudcli:workspace-panel', remoteId: 'alpha', open, requestId } }));
  });
  expect(screen.getByTestId('panel-state').textContent).toBe('false:preferences');
  expect(parentWindow.postMessage).toHaveBeenCalledWith({ kind: 'cloudcli:workspace-panel-state', remoteId: 'alpha', open: false, maximized: false, settingsOpen: false, overlayOpen: false, requestId: 'closing' }, location.origin);
  render(<ModalCoverage open />);
  expect(parentWindow.postMessage).toHaveBeenLastCalledWith({ kind: 'cloudcli:workspace-panel-state', remoteId: 'alpha', open: false, maximized: false, settingsOpen: false, overlayOpen: true }, location.origin);
});

test('standalone sidebar and panel actions share one complete settings instance with normalized remote folders', () => {
  window.__CLOUDCLI_EMBEDDED__ = false;
  fixture.projects = [{ projectId: 'project-one', displayName: '', fullPath: '', path: '/remote/one' }];
  workspace();
  fireEvent.click(screen.getByText('Sidebar settings'));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('dialog').textContent).toContain('"name":"project-one"');
  expect(screen.getByRole('dialog').textContent).toContain('"fullPath":"/remote/one"');
  fireEvent.click(screen.getByText('Open from tool panel'));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
});


test('open installed plugin closes full settings and selects only an enabled plugin from this remote', () => {
  workspace(); receive('alpha');
  act(() => window.dispatchEvent(new CustomEvent('cloudcli:plugin-open', { detail: { name: 'not-installed' } })));
  expect(screen.getByRole('dialog')).toBeTruthy();
  act(() => window.dispatchEvent(new CustomEvent('cloudcli:plugin-open', { detail: { name: 'fixture-tool' } })));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByTestId('panel-state').textContent).toBe('true:plugin:fixture-tool');
});
