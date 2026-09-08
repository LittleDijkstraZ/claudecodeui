import React, { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Settings, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ChatInterface, AgentsPanel } from '@/modules/chat';
import { GitPanel } from '@/modules/git-panel';
import { PluginTabContent } from '@/modules/plugins';
import { BrowserUsePanel, useBrowserUseEnabled } from '@/modules/browser-use';
import { QuickSettingsPanel } from '@/modules/quick-settings-panel';
import { usePaletteOpsRegister } from '@/modules/command-palette';
import { TaskMasterPanel, useTaskMasterProjectSync, useTasksSettings } from '@/modules/task-master';
import type { AppTab, CodeEditorDiffInfo, CodeEditorFile, Project, ProjectSession, SessionEstablishedContext, SessionNavigationOptions, SettingsMainTab, WorkspacePanelTab } from '@/shared/types';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { useModalVisibility } from '@/shared/hooks/useModalVisibility';
import { useFileOpenResolver } from '@/modules/project-workspace/hooks/useFileOpenResolver';
import { SideChatPanel, WorkspacePanelLayout, useWorkspacePanelActions, useWorkspacePanels } from '@/modules/workspace-panels';
import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';
import WorkspaceTitle from '@/modules/project-workspace/WorkspaceTitle';
import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';
import WorkspaceStateView from '@/modules/project-workspace/WorkspaceStateView';
import WorkspaceErrorBoundary from '@/modules/project-workspace/WorkspaceErrorBoundary';
import WorkspaceFilesPanel from '@/modules/project-workspace/WorkspaceFilesPanel';
import WorkspaceTerminals from '@/modules/project-workspace/WorkspaceTerminals';

type WorkspaceMainProps = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  /** Settings covers the conversation without stopping its execution or unmounting workspace panels. */
  settingsOpen?: boolean;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  isMobile: boolean;
  onMenuClick: () => void;
  isLoading: boolean;
  onNavigateToSession: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings: (tab?: SettingsMainTab) => void;
  externalMessageUpdate: number;
  newSessionTrigger: number;
  /** Switches the app to another project — used by the git panel's Worktrees view. */
  onProjectSelect: (project: Project) => void;
  /** Silently re-syncs the sidebar project list after worktree projects change. */
  onProjectsRefresh: () => void;
};

/** Used by ProjectMainRegion to keep chat primary and retain auxiliary views in a common right panel. */
function WorkspaceMain({
  selectedProject, selectedSession, activeTab, settingsOpen = false, setActiveTab, ws, sendMessage, isMobile, onMenuClick, isLoading,
  onNavigateToSession, onSessionEstablished, onShowSettings, externalMessageUpdate, newSessionTrigger,
  onProjectSelect, onProjectsRefresh,
}: WorkspaceMainProps) {
  const { t } = useTranslation('common');
  const preferences = useUiPreferences();
  const modalVisible = useModalVisibility();
  const mainCovered = settingsOpen || modalVisible;
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const browserUseEnabled = useBrowserUseEnabled();
  const panel = useWorkspacePanels();
  const panelActions = useWorkspacePanelActions();
  useTaskMasterProjectSync(selectedProject);
  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);
  const shouldShowBrowserTab = browserUseEnabled;
  // Bind the editor to the project that opened it, even if a later chat selects another folder.
  const [editing, setEditing] = useState<{ file: CodeEditorFile; project: Project } | null>(null);
  const handleFileOpen = useCallback((filePath: string, diffInfo: CodeEditorDiffInfo | null = null) => {
    if (!selectedProject) return;
    const path = filePath.replace(/\\/g, '/');
    setEditing({ file: { name: path.split('/').pop() || filePath, path: filePath, projectId: selectedProject.projectId, diffInfo }, project: selectedProject });
    panelActions?.openPanel('files');
  }, [selectedProject, panelActions]);
  const resolvedFileOpen = useFileOpenResolver(selectedProject, handleFileOpen);
  const openFile = useCallback((path: string) => handleFileOpen(path), [handleFileOpen]);
  const openFileInEditor = useCallback((path: string) => { resolvedFileOpen(path); }, [resolvedFileOpen]);
  usePaletteOpsRegister({ openFile, openFileInEditor });
  const showAllTasks = useCallback(() => panelActions?.openPanel('tasks'), [panelActions]);
  const selectView = useCallback((tab: AppTab | WorkspacePanelTab) => {
    if (tab === 'chat') panelActions?.collapsePanel();
    else panelActions?.openPanel(tab);
  }, [panelActions]);
  const toggleView = useCallback((tab: AppTab | WorkspacePanelTab) => {
    if (tab === 'chat') panelActions?.collapsePanel();
    else panelActions?.togglePanel(tab);
  }, [panelActions]);
  // Existing command-palette and workspace shortcuts still request AppTab values.
  // Consume those requests as panel navigation without hiding or remounting chat.
  useEffect(() => {
    if (activeTab !== 'chat') { selectView(activeTab); setActiveTab('chat'); }
  }, [activeTab, selectView, setActiveTab]);
  const visible = (tab: WorkspacePanelTab) => Boolean(panel?.open && panel.tab === tab);
  const retained = (tab: WorkspacePanelTab) => Boolean(panel?.visited.has(tab));
  const title = panel?.tab === 'agents' ? t('workspacePanel.agentsAndWorkflows', { defaultValue: 'Agents & Workflows' })
    : panel?.tab === 'preferences' ? t('workspacePanel.preferences', { defaultValue: 'Preferences' })
    : panel?.tab === 'sideChat' ? t('workspacePanel.sideChat', { defaultValue: 'Side chat' })
      : panel?.tab === 'git' ? t('workspacePanel.sourceControl', { defaultValue: 'Source Control' })
        : panel?.tab.startsWith('plugin:') ? panel.tab.slice(7)
          : t(`tabs.${panel?.tab ?? 'files'}`);
  const main = <div className="h-full min-h-0">
    {isLoading ? <WorkspaceStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />
      : !selectedProject ? <WorkspaceStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />
        : <WorkspaceErrorBoundary showDetails><ChatInterface
          isActive={!mainCovered}
          selectedProject={selectedProject} selectedSession={selectedSession} ws={ws} sendMessage={sendMessage}
          onFileOpen={handleFileOpen} onNavigateToSession={onNavigateToSession} onSessionEstablished={onSessionEstablished}
          onShowSettings={onShowSettings} showRawParameters={showRawParameters} showThinking={showThinking}
          sendByCtrlEnter={sendByCtrlEnter} externalMessageUpdate={externalMessageUpdate} newSessionTrigger={newSessionTrigger}
          onShowAllTasks={tasksEnabled ? showAllTasks : null}
        /></WorkspaceErrorBoundary>}
  </div>;
  const machineLabel = window.__REMOTE_NAME__ || window.__REMOTE_ID__ || t('workspacePanel.currentRemote', { defaultValue: 'Current remote' });
  const workspaceIdentity = selectedProject
    ? <WorkspaceTitle activeTab="chat" machineLabel={machineLabel} selectedProject={selectedProject} selectedSession={selectedSession} shouldShowTasksTab={shouldShowTasksTab} />
    : <div className="truncate text-sm font-medium">{machineLabel}</div>;
  // Chat is the persistent main surface; preferences is a setting, not a tool tab.
  const selectedTool = panel?.open && panel.tab !== 'preferences' ? panel.tab : 'chat';
  return <div className="flex h-full min-h-0 min-w-0 flex-col">
    <div className={`flex min-h-[52px] min-w-0 shrink-0 items-center gap-1 border-b border-border/60 bg-background ${window.__CLOUDCLI_EMBEDDED__ && !window.__CLOUDCLI_SIDE_CHAT__ ? 'pl-14 pr-2' : 'px-2'}`} data-testid="workspace-tool-bar">
      {!window.__CLOUDCLI_EMBEDDED__ && isMobile && selectedProject && <MobileMenuButton onMenuClick={onMenuClick} compact />}
      <div className="min-w-0 max-w-[28%] shrink-0 basis-48 px-1">{workspaceIdentity}</div>
      <div className="flex min-w-0 flex-1 justify-end"><WorkspaceTabs activeTab={selectedTool} sessionId={selectedSession?.id ?? null} setActiveTab={toggleView} onNavigation={selectView} shouldShowTasksTab={shouldShowTasksTab} shouldShowBrowserTab={shouldShowBrowserTab} /></div>
      <button type="button" onClick={() => panelActions?.togglePanel('preferences')} aria-label={t('workspacePanel.preferences', { defaultValue: 'Preferences' })} title={`${machineLabel} · ${t('workspacePanel.preferences', { defaultValue: 'Preferences' })}`} aria-expanded={visible('preferences')} className="flex h-11 min-h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><SlidersHorizontal className="h-[18px] w-[18px]" /></button>
    </div>
    <WorkspacePanelLayout main={main} mainCovered={mainCovered} title={title} sessionId={selectedSession?.id ?? null}>
      {retained('preferences') && <div className={`h-full min-h-0 flex-col ${visible('preferences') ? 'flex' : 'hidden'}`}>
        <div className="shrink-0 border-b border-border/60 p-3"><button type="button" onClick={() => onShowSettings()} className="flex min-h-11 w-full items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" aria-label={`${machineLabel} · ${t('workspacePanel.machineSettings', { defaultValue: 'Machine settings' })}`}><Settings className="h-[18px] w-[18px] shrink-0" /><span>{t('workspacePanel.machineSettings', { defaultValue: 'Machine settings' })}</span></button></div>
        <QuickSettingsPanel />
      </div>}
      {retained('shell') && <div className={`h-full ${visible('shell') ? 'block' : 'hidden'}`}><WorkspaceTerminals project={selectedProject} session={selectedSession} visible={visible('shell')} /></div>}
      {retained('files') && <div className={`h-full ${visible('files') ? 'block' : 'hidden'}`}><WorkspaceFilesPanel project={selectedProject} editingFile={editing?.file ?? null} editingProject={editing?.project ?? null} onFileOpen={openFile} onClose={() => setEditing(null)} /></div>}
      {retained('git') && <div className={`h-full ${visible('git') ? 'block' : 'hidden'}`}>{selectedProject && <GitPanel selectedProject={selectedProject} isMobile={isMobile} onFileOpen={handleFileOpen} onProjectSelect={onProjectSelect} onProjectsRefresh={onProjectsRefresh} />}</div>}
      {retained('agents') && <div className={`h-full ${visible('agents') ? 'block' : 'hidden'}`}><AgentsPanel /></div>}
      {shouldShowTasksTab && retained('tasks') && <TaskMasterPanel isVisible={visible('tasks')} />}
      {shouldShowBrowserTab && retained('browser') && <div className={`h-full ${visible('browser') ? 'block' : 'hidden'}`}><BrowserUsePanel isVisible={visible('browser')} onShowSettings={onShowSettings} /></div>}
      {[...(panel?.visited ?? [])].filter(tab => tab.startsWith('plugin:')).map(tab => <div key={tab} className={`h-full ${visible(tab) ? 'block' : 'hidden'}`}><PluginTabContent pluginName={tab.slice(7)} selectedProject={selectedProject} selectedSession={selectedSession} /></div>)}
      <SideChatPanel onNavigateToSession={onNavigateToSession} />
    </WorkspacePanelLayout>
  </div>;
}

export default React.memo(WorkspaceMain);
