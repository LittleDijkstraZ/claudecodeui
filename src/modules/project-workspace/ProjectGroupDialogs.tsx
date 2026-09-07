import { useEffect } from 'react';

import { ConversationGroupDialogs } from '@/modules/sidebar';
import { useProjectMainState, useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { useConversationGroups } from '@/modules/sidebar';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { ProjectWorkspaceShellProps } from '@/shared/types';

/** Used by ProjectWorkspaceShell to keep group creation connected to workspace selection. */
export default function ProjectGroupDialogs({ isMobile, navigate }: Pick<ProjectWorkspaceShellProps, 'isMobile' | 'navigate'>) {
  const { sidebarSharedProps } = useProjectSidebarState();
  const { selectedProject, handleProjectSelect, registerOptimisticSession, setActiveTab, setSidebarOpen } = useProjectMainState();
  const { refresh } = useConversationGroups();
  const { subscribe } = useWebSocket();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe(event => {
      if (!['session_upserted', 'websocket_reconnected'].includes(event.kind ?? '')) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void refresh(); }, 500);
    });
    return () => { unsubscribe(); if (timer) clearTimeout(timer); };
  }, [refresh, subscribe]);
  return <ConversationGroupDialogs projects={sidebarSharedProps.projects} selectedProject={selectedProject}
    onCreated={(conversation, project) => {
      handleProjectSelect(project);
      registerOptimisticSession({ sessionId: conversation.sessionId, provider: conversation.provider, project, summary: conversation.sessionName });
      setActiveTab('chat');
      navigate(`/session/${conversation.sessionId}`);
      if (isMobile) setSidebarOpen(false);
    }} />;
}
