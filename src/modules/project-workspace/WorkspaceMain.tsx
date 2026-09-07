import React, { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { ChatInterface, AgentsPanel } from '@/modules/chat';
import { GitPanel } from '@/modules/git-panel';
import { PluginTabContent } from '@/modules/plugins';
import { BrowserUsePanel, useBrowserUseEnabled } from '@/modules/browser-use';
import { usePaletteOpsRegister } from '@/modules/command-palette';
import { TaskMasterPanel, useTaskMasterProjectSync, useTasksSettings } from '@/modules/task-master';
import type { AppTab, CodeEditorDiffInfo, CodeEditorFile, Project, ProjectSession, SessionEstablishedContext, SessionNavigationOptions, SettingsMainTab, WorkspacePanelTab } from '@/shared/types';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { useFileOpenResolver } from '@/modules/project-workspace/hooks/useFileOpenResolver';
import { SideChatPanel, WorkspacePanelLayout, useWorkspacePanelActions, useWorkspacePanels } from '@/modules/workspace-panels';
import WorkspaceHeader from '@/modules/project-workspace/WorkspaceHeader';
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
  // Existing command-palette and workspace shortcuts still request AppTab values.
  // Consume those requests as panel navigation without hiding or remounting chat.
  useEffect(() => {
    if (activeTab !== 'chat') { selectView(activeTab); setActiveTab('chat'); }
  }, [activeTab, selectView, setActiveTab]);
  const visible = (tab: WorkspacePanelTab) => Boolean(panel?.open && panel.tab === tab);
  const retained = (tab: WorkspacePanelTab) => Boolean(panel?.visited.has(tab));
  const title = panel?.tab === 'agents' ? t('workspacePanel.agents', { defaultValue: 'Agents' })
    : panel?.tab === 'sideChat' ? t('workspacePanel.sideChat', { defaultValue: 'Side chat' })
      : panel?.tab === 'git' ? t('workspacePanel.sourceControl', { defaultValue: 'Source Control' })
        : panel?.tab.startsWith('plugin:') ? panel.tab.slice(7)
          : t(`tabs.${panel?.tab ?? 'files'}`);
  const main = <div className="h-full min-h-0">
    {isLoading ? <WorkspaceStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />
      : !selectedProject ? <WorkspaceStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />
        : <WorkspaceErrorBoundary showDetails><ChatInterface
          isActive={!settingsOpen}
          selectedProject={selectedProject} selectedSession={selectedSession} ws={ws} sendMessage={sendMessage}
          onFileOpen={handleFileOpen} onNavigateToSession={onNavigateToSession} onSessionEstablished={onSessionEstablished}
          onShowSettings={onShowSettings} showRawParameters={showRawParameters} showThinking={showThinking}
          sendByCtrlEnter={sendByCtrlEnter} externalMessageUpdate={externalMessageUpdate} newSessionTrigger={newSessionTrigger}
          onShowAllTasks={tasksEnabled ? showAllTasks : null}
        /></WorkspaceErrorBoundary>}
  </div>;
  return <div className="flex h-full min-h-0 min-w-0 flex-col">
    {selectedProject && <WorkspaceHeader
      activeTab={panel?.open ? panel.tab : 'chat'} setActiveTab={selectView}
      selectedProject={selectedProject} selectedSession={selectedSession} shouldShowTasksTab={shouldShowTasksTab}
      shouldShowBrowserTab={shouldShowBrowserTab} isMobile={isMobile} onMenuClick={onMenuClick} onShowSettings={() => onShowSettings()}
    />}
    <WorkspacePanelLayout main={main} mainCovered={settingsOpen} title={title} sessionId={selectedSession?.id ?? null}>
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
