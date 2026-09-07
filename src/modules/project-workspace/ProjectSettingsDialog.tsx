import { memo, useMemo } from 'react';
import { createPortal } from 'react-dom';

import { Settings } from '@/modules/settings';
import { useProjectSettingsState } from '@/modules/project-workspace/context/ProjectsStateContext';
import type { Project, SettingsProject } from '@/shared/types';

const normalizeProjectForSettings = (project: Project): SettingsProject => {
  const fallbackPath =
    typeof project.fullPath === 'string' && project.fullPath.length > 0
      ? project.fullPath
      : typeof project.path === 'string'
        ? project.path
        : '';

  // Legacy SettingsProject still expects a `name` field; use the projectId so
  // downstream consumers that rely on a stable identifier continue to work.
  return {
    name: project.projectId,
    displayName:
      typeof project.displayName === 'string' && project.displayName.trim().length > 0
        ? project.displayName
        : project.projectId,
    fullPath: fallbackPath,
    path:
      typeof project.path === 'string' && project.path.length > 0
        ? project.path
        : fallbackPath,
  };
};

/** Used by the workspace shell so complete settings remain available without a sidebar, project or selected tool panel. */
function ProjectSettingsDialog() {
  const { projects, showSettings, settingsInitialTab, closeSettings } = useProjectSettingsState();
  const settingsProjects = useMemo(() => projects.map(normalizeProjectForSettings), [projects]);
  // The hub injects this identity into this frame's document before App mounts.
  // Changing the hub selection never retargets this frame's API or settings.
  const remoteName = window.__REMOTE_NAME__ || window.__REMOTE_ID__;
  if (!showSettings) return null;
  return createPortal(<Settings isOpen onClose={closeSettings} projects={settingsProjects} initialTab={settingsInitialTab} remoteName={remoteName} />, document.body);
}

export default memo(ProjectSettingsDialog);
