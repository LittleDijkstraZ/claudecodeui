import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import WorkspaceMain from '@/modules/project-workspace/WorkspaceMain';
import { WorkspacePanelsProvider } from '@/modules/workspace-panels';
import type { Project } from '@/shared/types';
import { useModalPresence } from '@/shared/hooks/useModalVisibility';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }) }));
vi.mock('@/modules/chat', () => ({ ChatInterface: ({ isActive }: { isActive: boolean }) => <textarea aria-label="chat draft" data-active={String(isActive)} />, AgentsPanel: () => <p>Agent detail</p> }));
vi.mock('@/modules/git-panel', () => ({ GitPanel: () => null }));
vi.mock('@/modules/plugins', () => ({ usePlugins: () => ({ plugins: [] }), PluginIcon: () => null, PluginTabContent: () => null }));
vi.mock('@/modules/browser-use', () => ({ useBrowserUseEnabled: () => false, BrowserUsePanel: () => null }));
vi.mock('@/modules/quick-settings-panel', () => ({ QuickSettingsPanel: () => <p data-testid="inline-preferences">Preferences content</p> }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => {} }));
vi.mock('@/modules/task-master', () => ({ useTaskMasterProjectSync: () => {}, useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }), TaskMasterPanel: () => null }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({ useUiPreferences: () => ({}) }));
vi.mock('@/modules/project-workspace/hooks/useFileOpenResolver', () => ({ useFileOpenResolver: () => vi.fn() }));
vi.mock('@/modules/project-workspace/WorkspaceFilesPanel', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/WorkspaceTerminals', () => ({ default: () => <textarea aria-label="retained terminal" /> }));

const project: Project = { projectId: 'one', displayName: 'Research', fullPath: '/remote/research' };
const settings = vi.fn();
const workspace = (selectedProject: Project | null = project) => <WorkspacePanelsProvider><WorkspaceMain
  selectedProject={selectedProject} selectedSession={null} activeTab="chat" setActiveTab={vi.fn()} ws={null} sendMessage={vi.fn()}
  isMobile={false} onMenuClick={vi.fn()} isLoading={false} onNavigateToSession={vi.fn()} onSessionEstablished={vi.fn()}
  onShowSettings={settings} externalMessageUpdate={0} newSessionTrigger={0} onProjectSelect={vi.fn()} onProjectsRefresh={vi.fn()}
/></WorkspacePanelsProvider>;
beforeEach(() => {
  settings.mockClear(); localStorage.clear(); window.__CLOUDCLI_EMBEDDED__ = false; window.__REMOTE_NAME__ = 'Alpha';
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { delete window.__CLOUDCLI_EMBEDDED__; delete window.__REMOTE_NAME__; });
function ModalCoverage({ open }: { open: boolean }) { useModalPresence(open); return null; }

test('tools and settings live inside the right drawer with large labeled hitboxes and no global workspace header', () => {
  render(workspace());
  expect(screen.queryByTestId('workspace-header')).toBeNull();
  expect(screen.queryByTestId('inline-preferences')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open workspace panel' }));
  expect(screen.getByTestId('inline-preferences')).toBeTruthy();
  const tools = screen.getAllByRole('tab');
  expect(tools).toHaveLength(6);
  expect(tools.every(tool => tool.classList.contains('min-h-11') && tool.textContent)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Alpha · Machine settings' }));
  expect(settings).toHaveBeenCalledTimes(1);
});

test('switching preferences and collapsing preserves the active terminal and chat draft', () => {
  render(workspace());
  const chat = screen.getByLabelText('chat draft');
  fireEvent.change(chat, { target: { value: 'unsent message' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open workspace panel' }));
  fireEvent.click(screen.getByRole('tab', { name: 'tabs.shell' }));
  const terminal = screen.getByLabelText('retained terminal');
  fireEvent.change(terminal, { target: { value: 'ongoing remote work' } });
  fireEvent.click(screen.getByRole('tab', { name: 'workspacePanel.preferences' }));
  fireEvent.click(screen.getByRole('tab', { name: 'tabs.shell' }));
  fireEvent.click(screen.getByRole('button', { name: 'Collapse panel; keep work running' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open workspace panel' }));
  expect(screen.getByLabelText('retained terminal')).toBe(terminal);
  expect((terminal as HTMLTextAreaElement).value).toBe('ongoing remote work');
  expect(screen.getByLabelText('chat draft')).toBe(chat);
  expect((chat as HTMLTextAreaElement).value).toBe('unsent message');
});

test('the drawer and full machine settings stay available before selecting any project', () => {
  render(workspace(null));
  fireEvent.click(screen.getByRole('button', { name: 'Open workspace panel' }));
  expect(screen.getByTestId('inline-preferences')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Alpha · Machine settings' }));
  expect(settings).toHaveBeenCalledTimes(1);
});

test('a modal temporarily suspends reading state while preserving drawer and conversation mounts', () => {
  render(workspace());
  const chat = screen.getByLabelText('chat draft');
  fireEvent.change(chat, { target: { value: 'unsent before review' } });
  const modal = render(<ModalCoverage open />);
  expect(chat.getAttribute('data-active')).toBe('false');
  expect(screen.queryByRole('button', { name: 'Open workspace panel' })).toBeNull();
  modal.rerender(<ModalCoverage open={false} />);
  expect(chat.getAttribute('data-active')).toBe('true');
  expect((chat as HTMLTextAreaElement).value).toBe('unsent before review');
  expect(screen.getByRole('button', { name: 'Open workspace panel' })).toBeTruthy();
});
