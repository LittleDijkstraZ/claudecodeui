import { useEffect } from 'react';

import { useProjectMainState } from '@/modules/project-workspace/context/ProjectsStateContext';
import type { ProjectWorkspaceShellProps } from '@/shared/types';

/** Used by the workspace shell to exchange selection and navigation with its owning hub frame. */
export default function ProjectHubBridge({ navigate }: Pick<ProjectWorkspaceShellProps, 'navigate'>) {
  const { selectedSession, selectedProject, openSettings, setActiveTab } = useProjectMainState();
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
      if (event.data?.kind === 'cloudcli:settings') openSettings();
      if (event.data?.kind === 'cloudcli:navigate') {
        const id = event.data.sessionId;
        if (id !== null && (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id))) return;
        setActiveTab('chat');
        navigate(id ? `/session/${encodeURIComponent(id)}` : '/');
      }
    };
    window.addEventListener('message', receive);
    window.parent.postMessage({ kind: 'cloudcli:ready' }, location.origin);
    return () => window.removeEventListener('message', receive);
  }, [navigate, openSettings, setActiveTab]);
  return null;
}
