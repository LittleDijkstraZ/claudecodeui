import { useEffect, useRef } from 'react';

import { useProjectMainState, useProjectSettingsState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { useWorkspacePanelActions, useWorkspacePanels } from '@/modules/workspace-panels';
import type { ProjectWorkspaceShellProps } from '@/shared/types';
import { useModalVisibility } from '@/shared/hooks/useModalVisibility';

/** Used by the workspace shell to exchange selection and navigation with its owning hub frame. */
export default function ProjectHubBridge({ navigate }: Pick<ProjectWorkspaceShellProps, 'navigate'>) {
  const { selectedSession, selectedProject, openSettings, clearSessionSelection, setActiveTab } = useProjectMainState();
  const { showSettings } = useProjectSettingsState();
  const modalVisible = useModalVisibility();
  const overlayOpen = showSettings || modalVisible;
  const panel = useWorkspacePanels();
  const panelActions = useWorkspacePanelActions();
  const hasPanel = panel !== null;
  const panelOpen = panel?.open ?? false;
  const panelMaximized = panel?.maximized ?? false;
  // Explicit open/close requests are acknowledged only by their fixed remote
  // frame; replaying an unacknowledged request never reverses the desired state.
  const pendingPanelRequest = useRef<string | null>(null);
  useEffect(() => {
    if (!hasPanel || window.parent === window || !window.__CLOUDCLI_EMBEDDED__ || window.__CLOUDCLI_SIDE_CHAT__) return;
    window.parent.postMessage({ kind: 'cloudcli:workspace-panel-state', remoteId: window.__REMOTE_ID__, open: panelOpen, maximized: panelMaximized, settingsOpen: showSettings, overlayOpen, ...(pendingPanelRequest.current ? { requestId: pendingPanelRequest.current } : {}) }, location.origin);
    pendingPanelRequest.current = null;
  }, [hasPanel, panelOpen, panelMaximized, showSettings, overlayOpen]);
  // A startup route transition may replace this workspace before the dialog
  // commits; only acknowledge after settings has actually rendered.
  const pendingSettingsRequest = useRef<string | null>(null);
  useEffect(() => {
    if (!showSettings || !pendingSettingsRequest.current) return;
    window.parent.postMessage({ kind: 'cloudcli:settings-opened', remoteId: window.__REMOTE_ID__, requestId: pendingSettingsRequest.current }, location.origin);
    pendingSettingsRequest.current = null;
  }, [showSettings]);
  useEffect(() => {
    if (window.parent === window || !window.__CLOUDCLI_EMBEDDED__) return;
    if (selectedSession && selectedProject) {
      window.parent.postMessage({
        kind: 'cloudcli:selection', sessionId: selectedSession.id,
        title: selectedSession.summary || selectedSession.title || '新对话',
        projectId: selectedProject.projectId, projectPath: selectedProject.fullPath,
        provider: selectedSession.__provider || selectedSession.provider || 'claude',
      }, location.origin);
    }
  }, [selectedSession, selectedProject]);
  useEffect(() => {
    if (window.parent === window || !window.__CLOUDCLI_EMBEDDED__) return;
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== window.parent) return;
      if (event.data?.kind === 'cloudcli:workspace-panel') {
        if (window.__CLOUDCLI_SIDE_CHAT__ || typeof window.__REMOTE_ID__ !== 'string' || event.data.remoteId !== window.__REMOTE_ID__ || typeof event.data.open !== 'boolean' || typeof event.data.requestId !== 'string' || event.data.requestId.length > 128 || !hasPanel || !panelActions) return;
        if (panelOpen === event.data.open) {
          pendingPanelRequest.current = null;
          window.parent.postMessage({ kind: 'cloudcli:workspace-panel-state', remoteId: window.__REMOTE_ID__, open: panelOpen, maximized: panelMaximized, settingsOpen: showSettings, overlayOpen, requestId: event.data.requestId }, location.origin);
        }
        else pendingPanelRequest.current = event.data.requestId;
        panelActions.setPanelOpen(event.data.open);
      }
      if (event.data?.kind === 'cloudcli:settings') {
        // Route commands by the immutable frame identity, not a selected
        // conversation or the parent window's current machine label.
        if (typeof window.__REMOTE_ID__ !== 'string' || event.data.remoteId !== window.__REMOTE_ID__) return;
        const requestId = typeof event.data.requestId === 'string' ? event.data.requestId : null;
        if (showSettings && requestId) window.parent.postMessage({ kind: 'cloudcli:settings-opened', remoteId: window.__REMOTE_ID__, requestId }, location.origin);
        else pendingSettingsRequest.current = requestId;
        openSettings();
      }
      if (event.data?.kind === 'cloudcli:navigate') {
        const id = event.data.sessionId;
        if (id !== null && (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id))) return;
        if (id === null) clearSessionSelection();
        setActiveTab('chat');
        navigate(id ? `/session/${encodeURIComponent(id)}` : '/');
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [navigate, openSettings, clearSessionSelection, setActiveTab, showSettings, overlayOpen, hasPanel, panelOpen, panelMaximized, panelActions]);
  useEffect(() => {
    if (window.parent !== window && window.__CLOUDCLI_EMBEDDED__) window.parent.postMessage({ kind: 'cloudcli:ready' }, location.origin);
  }, [navigate, openSettings, setActiveTab]);
  return null;
}
