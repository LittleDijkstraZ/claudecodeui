import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { FileTree } from '@/modules/file-tree';
import { CodeEditor } from '@/modules/code-editor';
import { Button } from '@/shared/ui';
import type { CodeEditorFile, Project } from '@/shared/types';
import { useWorkspacePanelActions, useWorkspacePanels } from '@/modules/workspace-panels';

/** Used by WorkspaceMain to retain file browsing and the editor when other panels are selected. */
export default function WorkspaceFilesPanel({ project, editingFile, editingProject, onFileOpen, onClose }: {
  project: Project | null;
  editingFile: CodeEditorFile | null;
  editingProject: Project | null;
  onFileOpen: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('common');
  const panel = useWorkspacePanels();
  const actions = useWorkspacePanelActions();
  // Return to the file browser without unmounting an editor that may contain unsaved text.
  const [browsing, setBrowsing] = useState(true);
  useEffect(() => { if (editingFile) setBrowsing(false); }, [editingFile]);
  return <div className="flex h-full min-h-0 flex-col">
    {editingFile && <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
      <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => setBrowsing(value => !value)}><FolderOpen className="h-3 w-3" />{t(browsing ? 'workspacePanel.returnEditor' : 'workspacePanel.browseFiles', { defaultValue: browsing ? 'Return to editor' : 'Browse files' })}</Button>
      <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground" title={editingProject?.fullPath || editingProject?.path}>{editingProject?.displayName}</span>
    </div>}
    <div className={`min-h-0 flex-1 ${browsing || !editingFile ? 'block' : 'hidden'}`}>{project ? <FileTree selectedProject={project} onFileOpen={onFileOpen} /> : <p className="p-4 text-sm text-muted-foreground">{t('workspacePanel.chooseProjectFiles', { defaultValue: 'Choose a project to browse its files.' })}</p>}</div>
    {editingFile && <div className={`min-h-0 flex-1 ${browsing ? 'hidden' : 'block'}`}><CodeEditor key={`${editingFile.projectId}:${editingFile.path}`} file={editingFile} projectPath={editingProject?.fullPath || editingProject?.path} isSidebar isExpanded={panel?.maximized} onToggleExpand={actions?.toggleMaximized} onClose={() => { onClose(); setBrowsing(true); }} /></div>}
  </div>;
}
