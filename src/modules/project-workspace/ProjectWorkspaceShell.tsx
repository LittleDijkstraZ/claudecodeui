import { memo } from 'react';

import { WorkspacePanelsProvider } from '@/modules/workspace-panels';
import ProjectHubBridge from '@/modules/project-workspace/ProjectHubBridge';
import ProjectGroupDialogs from '@/modules/project-workspace/ProjectGroupDialogs';
import ProjectSettingsDialog from '@/modules/project-workspace/ProjectSettingsDialog';
import ProjectEffects from '@/modules/project-workspace/controllers/ProjectEffects';
import type { ProjectWorkspaceShellProps } from '@/shared/types';
import ProjectCommandPalette from '@/modules/project-workspace/ProjectCommandPalette';
import ProjectMainRegion from '@/modules/project-workspace/ProjectMainRegion';
import ProjectSidebarRegion from '@/modules/project-workspace/ProjectSidebarRegion';

/** Rendered by ProjectWorkspaceRoute to lay out the workspace sidebar, main region and global overlays. */
function ProjectWorkspaceShell({
  isMobile,
  ws,
  sendMessage,
  navigate,
}: ProjectWorkspaceShellProps) {
  return (
    <WorkspacePanelsProvider>
    <div
      className="fixed inset-0 flex bg-background"
      style={{ bottom: 'var(--keyboard-height, 0px)' }}
    >
      <ProjectEffects navigate={navigate} />
      {!window.__CLOUDCLI_EMBEDDED__ && <ProjectSidebarRegion isMobile={isMobile} />}
      <ProjectHubBridge navigate={navigate} />

      <div className="flex min-w-0 flex-1 flex-col">
        <ProjectMainRegion
          isMobile={isMobile}
          ws={ws}
          sendMessage={sendMessage}
          navigate={navigate}
        />
      </div>

      <ProjectCommandPalette />
      <ProjectSettingsDialog />
      <ProjectGroupDialogs isMobile={isMobile} navigate={navigate} />
    </div>
    </WorkspacePanelsProvider>
  );
}

export default memo(ProjectWorkspaceShell);
