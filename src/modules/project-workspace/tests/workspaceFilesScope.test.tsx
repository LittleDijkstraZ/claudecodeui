import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import type { CodeEditorFile, Project } from '@/shared/types';
import WorkspaceFilesPanel from '@/modules/project-workspace/WorkspaceFilesPanel';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }) }));
vi.mock('@/modules/workspace-panels', () => ({ useWorkspacePanels: () => null, useWorkspacePanelActions: () => null }));
vi.mock('@/shared/ui', () => ({ Button: ({ variant: _variant, size: _size, ...props }: Record<string, unknown>) => <button {...props} /> }));
vi.mock('@/modules/file-tree', () => ({ FileTree: function MockFileTree({ selectedProject }: { selectedProject: Project }) {
  const [pendingDelete, setPendingDelete] = useState(false);
  return <div data-testid="file-browser"><output>{selectedProject.fullPath}</output><button onClick={() => setPendingDelete(true)}>Delete file</button>{pendingDelete && <div role="dialog">Delete from {selectedProject.fullPath}</div>}</div>;
} }));
vi.mock('@/modules/code-editor', () => ({ CodeEditor: function MockEditor({ file }: { file: CodeEditorFile }) {
  const [draft, setDraft] = useState('');
  return <textarea aria-label={`Editor ${file.path}`} value={draft} onChange={event => setDraft(event.target.value)} />;
} }));

const project = (projectId: string, fullPath: string): Project => ({ projectId, fullPath, path: fullPath, displayName: projectId, isStarred: false, sessions: [] });
const main = project('main', '/repo');
const worktree = project('feature', '/repo-worktrees/feature');
const file: CodeEditorFile = { name: 'source.ts', path: 'source.ts', projectId: main.projectId };

test('switching the main conversation folder shows its file tree while retaining unsaved text in the old editor', () => {
  const props = { editingFile: file, editingProject: main, onFileOpen: vi.fn(), onClose: vi.fn() };
  const view = render(<WorkspaceFilesPanel {...props} project={main} />);
  const editor = screen.getByLabelText('Editor source.ts') as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: 'unsaved work' } });
  expect(editor.parentElement?.classList.contains('block')).toBe(true);
  view.rerender(<WorkspaceFilesPanel {...props} project={worktree} />);
  expect(screen.getByTestId('file-browser').textContent).toContain(worktree.fullPath);
  expect(screen.getByTestId('file-browser').parentElement?.classList.contains('block')).toBe(true);
  expect(editor.parentElement?.classList.contains('hidden')).toBe(true);
  expect(screen.getByTitle(worktree.fullPath).textContent).toBe('feature');
  fireEvent.click(screen.getByRole('button', { name: 'Return to editor' }));
  expect(screen.getByLabelText('Editor source.ts')).toBe(editor);
  expect(editor.value).toBe('unsaved work');
  expect(editor.parentElement?.classList.contains('block')).toBe(true);
  expect(screen.getByTitle(main.fullPath).textContent).toBe('main');
});

test('an old file action is discarded when the main conversation selects another worktree', () => {
  const props = { editingFile: null, editingProject: null, onFileOpen: vi.fn(), onClose: vi.fn() };
  const view = render(<WorkspaceFilesPanel {...props} project={main} />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete file' }));
  expect(screen.getByRole('dialog').textContent).toContain(main.fullPath);
  view.rerender(<WorkspaceFilesPanel {...props} project={worktree} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByTestId('file-browser').textContent).toContain(worktree.fullPath);
});
