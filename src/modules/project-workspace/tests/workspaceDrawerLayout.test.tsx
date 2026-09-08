import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import WorkspaceMain from '@/modules/project-workspace/WorkspaceMain';
import { WorkspacePanelsProvider, useWorkspacePanelActions } from '@/modules/workspace-panels';
import type { Project } from '@/shared/types';
import { useModalPresence } from '@/shared/hooks/useModalVisibility';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }) }));
vi.mock('@/modules/chat', () => ({ ChatInterface: ({ isActive }: { isActive: boolean }) => <textarea aria-label="chat draft" data-active={String(isActive)} />, AgentsPanel: () => <p>Agent detail</p> }));
vi.mock('@/modules/git-panel', () => ({ GitPanel: () => null }));
vi.mock('@/modules/plugins', () => ({ usePlugins: () => ({ plugins: [] }), PluginIcon: () => null, PluginTabContent: () => null }));
vi.mock('@/modules/browser-use', () => ({ useBrowserUseEnabled: () => true, BrowserUsePanel: () => null }));
vi.mock('@/modules/quick-settings-panel', () => ({ QuickSettingsPanel: () => <p data-testid="inline-preferences">Preferences content</p> }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => {} }));
vi.mock('@/modules/task-master', () => ({ useTaskMasterProjectSync: () => {}, useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }), TaskMasterPanel: () => null }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({ useUiPreferences: () => ({}) }));
vi.mock('@/modules/project-workspace/hooks/useFileOpenResolver', () => ({ useFileOpenResolver: () => vi.fn() }));
vi.mock('@/modules/project-workspace/WorkspaceFilesPanel', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/WorkspaceTerminals', () => ({ default: () => <textarea aria-label="retained terminal" /> }));

const project: Project = { projectId: 'one', displayName: 'Research', fullPath: '/remote/research' };
const settings = vi.fn();
function HubPanelControl() { const actions = useWorkspacePanelActions(); return window.__CLOUDCLI_EMBEDDED__ ? <button onClick={() => actions?.setPanelOpen(true)}>Open from hub</button> : null; }
const workspace = (selectedProject: Project | null = project) => <WorkspacePanelsProvider><HubPanelControl /><WorkspaceMain
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

test('tools live only in the right panel while Settings and the panel toggle stay in the single top header', () => {
  render(workspace());
  expect(screen.getAllByTestId('workspace-header')).toHaveLength(1);
  expect(screen.queryByTestId('workspace-tool-bar')).toBeNull();
  expect(screen.queryByTestId('inline-preferences')).toBeNull();
  const toolbar = screen.getByTestId('workspace-header');
  const panel = screen.getByTestId('workspace-right-panel');
  expect(within(toolbar).queryByRole('tablist')).toBeNull();
  expect(screen.queryByRole('tab')).toBeNull();
  fireEvent.click(within(toolbar).getByRole('button', { name: 'Alpha · Machine settings' }));
  expect(settings).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('inline-preferences')).toBeNull();
  fireEvent.click(within(toolbar).getByRole('button', { name: 'Open workspace panel' }));
  const tools = within(panel).getAllByRole('tab');
  expect(tools.map(tool => tool.getAttribute('aria-label'))).toEqual(['tabs.shell', 'tabs.files', 'workspacePanel.sourceControl', 'workspacePanel.agents', 'tabs.browser']);
  expect(panel.classList.contains('hidden')).toBe(false);
  expect(tools.every(tool => panel.contains(tool) && tool.classList.contains('min-h-11') && tool.textContent === '' && tool.title === tool.getAttribute('aria-label'))).toBe(true);
  expect(screen.queryByRole('tab', { name: 'tabs.chat' })).toBeNull();
  expect(screen.queryByRole('tab', { name: 'workspacePanel.preferences' })).toBeNull();
  expect(tools[0].tabIndex).toBe(0);
  expect(tools.slice(1).every(tool => tool.tabIndex === -1)).toBe(true);
  expect(within(screen.getByTestId('workspace-tool-navigation')).getByTestId('overflow-tool-tabs')).toBeTruthy();
  fireEvent.click(tools[0]);
  expect(within(panel).getByRole('heading', { name: 'tabs.shell' })).toBeTruthy();
  expect(within(panel).getByRole('tablist')).toBeTruthy();
  fireEvent.click(tools[0]);
  expect(panel.classList.contains('hidden')).toBe(true);
  fireEvent.click(within(toolbar).getByRole('button', { name: 'Open workspace panel' }));
  expect(panel.classList.contains('hidden')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Preferences' }));
  expect(screen.getByTestId('inline-preferences')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Alpha · Machine settings' }));
  expect(settings).toHaveBeenCalledTimes(2);
});

test('switching preferences and collapsing preserves the active terminal and chat draft', () => {
  render(workspace());
  const chat = screen.getByLabelText('chat draft');
  fireEvent.change(chat, { target: { value: 'unsent message' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open workspace panel' }));
  fireEvent.click(screen.getByRole('tab', { name: 'tabs.shell' }));
  const terminal = screen.getByLabelText('retained terminal');
  fireEvent.change(terminal, { target: { value: 'ongoing remote work' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preferences' }));
  fireEvent.click(screen.getByRole('tab', { name: 'tabs.shell' }));
  fireEvent.click(screen.getByRole('button', { name: 'Collapse panel; keep work running' }));
  expect(screen.queryByRole('tab')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open workspace panel' }));
  expect(screen.getByLabelText('retained terminal')).toBe(terminal);
  expect((terminal as HTMLTextAreaElement).value).toBe('ongoing remote work');
  expect(screen.getByLabelText('chat draft')).toBe(chat);
  expect((chat as HTMLTextAreaElement).value).toBe('unsent message');
});

test('keyboard navigation starts at the first tool while chat is the main surface', () => {
  render(workspace());
  fireEvent.click(screen.getByRole('button', { name: 'Open workspace panel' }));
  const shell = screen.getByRole('tab', { name: 'tabs.shell' });
  expect(shell.tabIndex).toBe(0);
  fireEvent.keyDown(shell, { key: 'ArrowRight' });
  const files = screen.getByRole('tab', { name: 'tabs.files' });
  expect(document.activeElement).toBe(files);
  expect(files.getAttribute('aria-selected')).toBe('true');
  expect(files.tabIndex).toBe(0);
  expect(shell.tabIndex).toBe(-1);
  fireEvent.click(screen.getByRole('button', { name: 'Collapse panel; keep work running' }));
  expect(shell.tabIndex).toBe(0);
  expect(screen.queryByRole('tab')).toBeNull();
});

test('embedded header reserves symmetric parent sidebar toggles and keeps tools in the drawer', () => {
  window.__CLOUDCLI_EMBEDDED__ = true;
  render(workspace());
  expect(screen.getByTestId('workspace-header').classList.contains('px-14')).toBe(true);
  expect(screen.queryByRole('tab')).toBeNull();
  fireEvent.click(within(screen.getByTestId('workspace-header')).getByRole('button', { name: 'Alpha · Machine settings' }));
  expect(settings).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Open workspace panel' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open from hub' }));
  fireEvent.click(screen.getByRole('tab', { name: 'tabs.shell' }));
  expect(screen.getByLabelText('retained terminal')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'tabs.shell' }));
  expect(screen.queryByRole('tab')).toBeNull();
});

test('top-level settings identity follows this workspace remote while another machine is selected', () => {
  const view = render(workspace());
  fireEvent.click(screen.getByRole('button', { name: 'Alpha · Machine settings' }));
  window.__REMOTE_NAME__ = 'Beta';
  view.rerender(workspace());
  expect(screen.queryByRole('button', { name: 'Alpha · Machine settings' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Beta · Machine settings' }));
  expect(settings).toHaveBeenCalledTimes(2);
});

test('the drawer and full machine settings stay available before selecting any project', () => {
  render(workspace(null));
  fireEvent.click(screen.getByRole('button', { name: 'Open workspace panel' }));
  expect(screen.getByTestId('inline-preferences')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Alpha · Machine settings' }));
  expect(settings).toHaveBeenCalledTimes(1);
});

test('the top-right toggle stays visible while maximizing, collapsing and restoring the right panel', () => {
  render(workspace());
  const header = screen.getByTestId('workspace-header');
  fireEvent.click(within(header).getByRole('button', { name: 'Open workspace panel' }));
  fireEvent.click(screen.getByRole('tab', { name: 'tabs.shell' }));
  const terminal = screen.getByLabelText('retained terminal');
  fireEvent.click(screen.getByRole('button', { name: 'Maximize panel' }));
  const toggle = within(header).getByRole('button', { name: 'Collapse panel; keep work running' });
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(toggle);
  fireEvent.click(within(header).getByRole('button', { name: 'Open workspace panel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Maximize panel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Restore split view' }));
  expect(screen.getByLabelText('retained terminal')).toBe(terminal);
  expect(within(header).getByRole('button', { name: 'Collapse panel; keep work running' })).toBeTruthy();
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
