import { useState } from 'react';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { AgentSettingsProject, Project } from '@/shared/types';
import { ProjectsStateProvider, useProjectMainState, useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';
import ProjectWorkspaceShell from '@/modules/project-workspace/ProjectWorkspaceShell';

const fixture = vi.hoisted(() => ({ projects: [] as Project[], activeTab: 'shell' }));
vi.mock('@/modules/project-workspace/hooks/useProjectsState', () => ({ useProjectsState: () => {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('agents');
  const openSettings = (tab = 'agents') => { setSettingsInitialTab(tab); setShowSettings(true); };
  return { projects: fixture.projects, selectedProject: null, selectedSession: null,
    activeTab: fixture.activeTab, setActiveTab: vi.fn(), showSettings, settingsInitialTab, openSettings,
    closeSettings: () => setShowSettings(false), sidebarOpen: true,
    sidebarSharedProps: { onShowSettings: () => openSettings() } };
} }));
vi.mock('@/modules/project-workspace/ProjectMainRegion', () => ({ default: function MockProjectMainRegion() {
  const { openSettings } = useProjectMainState();
  return <button onClick={() => openSettings('git')}>Open from tool panel</button>;
} }));
vi.mock('@/modules/project-workspace/ProjectSidebarRegion', () => ({ default: function MockProjectSidebarRegion() {
  const { sidebarSharedProps } = useProjectSidebarState();
  return <button onClick={sidebarSharedProps.onShowSettings}>Sidebar settings</button>;
} }));
vi.mock('@/modules/settings', () => ({ Settings: ({ remoteName, projects, initialTab, onClose }: { remoteName?: string; projects: AgentSettingsProject[]; initialTab: string; onClose: () => void }) =>
  <div role="dialog" aria-label={`Settings · ${remoteName ?? 'standalone'}`}><span>{initialTab}</span><output>{JSON.stringify(projects)}</output><button onClick={onClose}>Close settings</button></div>,
}));
vi.mock('@/modules/workspace-panels', () => ({ WorkspacePanelsProvider: ({ children }: { children: ReactNode }) => children }));
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
beforeEach(() => {
  fixture.projects = []; fixture.activeTab = 'shell';
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
