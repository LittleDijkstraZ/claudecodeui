import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import type { ConfirmationRequest, GitRemoteStatus, Project } from '@/shared/types';
import GitPanel from '@/modules/git-panel/GitPanel';
import { useWorktreesController } from '@/modules/git-panel/hooks/useWorktreesController';

const api = vi.hoisted(() => ({
  git: { status: vi.fn(), branches: vi.fn(), remoteStatus: vi.fn(), checkout: vi.fn(), fileWithDiff: vi.fn() },
  worktrees: { list: vi.fn(), open: vi.fn(), create: vi.fn() },
}));
vi.mock('@/shared/api', () => ({ api }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/modules/git-panel/hooks/useSelectedProvider', () => ({ useSelectedProvider: () => 'claude' }));
vi.mock('@/modules/git-panel/hooks/useRevertLocalCommit', () => ({ useRevertLocalCommit: () => ({ isRevertingLocalCommit: false, revertLatestLocalCommit: vi.fn() }) }));
vi.mock('@/modules/git-panel/GitPanelHeader', () => ({ default: ({ currentBranch, branches, remoteStatus, onRequestConfirmation, onSwitchBranch }: {
  currentBranch: string; branches: string[]; remoteStatus: GitRemoteStatus | null;
  onRequestConfirmation: (action: ConfirmationRequest) => void; onSwitchBranch: (branch: string) => Promise<boolean>;
}) => <><output aria-label="repository state">{JSON.stringify({ currentBranch, branches, remoteStatus })}</output>
  <button onClick={() => onRequestConfirmation({ type: 'deleteBranch', message: 'Confirm branch action', onConfirm: () => { void onSwitchBranch('old-branch'); } })}>Request switch</button></> }));
vi.mock('@/modules/git-panel/changes/ChangesView', () => ({ default: ({ onOpenFile }: { onOpenFile: (path: string) => void }) => <button onClick={() => onOpenFile('source.ts')}>Open changed file</button> }));
vi.mock('@/modules/git-panel/history/HistoryView', () => ({ default: () => null }));
vi.mock('@/modules/git-panel/branches/BranchesView', () => ({ default: () => null }));
vi.mock('@/modules/git-panel/worktrees/WorktreesView', () => ({ default: ({ selectedProject }: { selectedProject: Project }) => <output aria-label="worktree directory">{selectedProject.fullPath}</output> }));
vi.mock('@/modules/git-panel/modals/ConfirmActionModal', () => ({ default: ({ action }: { action: ConfirmationRequest | null }) => action ? <div role="dialog">{action.message}</div> : null }));

const project = (projectId: string, fullPath: string): Project => ({ projectId, fullPath, path: fullPath, displayName: projectId, isStarred: false, sessions: [] });
const main = project('main', '/repo');
const worktree = project('feature', '/repo-worktrees/feature');
const response = (body: unknown) => ({ ok: true, json: async () => body } as Response);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  vi.resetAllMocks();
  api.git.status.mockImplementation(async (id: string) => response({ branch: id, modified: [], added: [], deleted: [], untracked: [] }));
  api.git.branches.mockImplementation(async (id: string) => response({ branches: [id], localBranches: [id], remoteBranches: [] }));
  api.git.remoteStatus.mockImplementation(async (id: string) => response({ branch: id, ahead: 0, behind: 0 }));
  api.worktrees.list.mockResolvedValue(response({ success: true, data: { repositoryRoot: '/repo', baseBranch: 'main', worktrees: [] } }));
});

test('the Worktrees tab follows the new conversation directory and late old repository replies cannot replace it', async () => {
  const oldBranches = deferred<Response>();
  const oldRemote = deferred<Response>();
  api.git.branches.mockImplementationOnce(() => oldBranches.promise);
  api.git.remoteStatus.mockImplementationOnce(() => oldRemote.promise);
  const view = render(<GitPanel selectedProject={main} />);
  fireEvent.click(screen.getByRole('tab', { name: 'git:tabs.worktrees' }));
  expect(screen.getByLabelText('worktree directory').textContent).toBe(main.fullPath);
  view.rerender(<GitPanel selectedProject={worktree} />);
  await waitFor(() => expect(screen.getByLabelText('repository state').textContent).toContain('feature'));
  expect(screen.getByLabelText('worktree directory').textContent).toBe(worktree.fullPath);
  await act(async () => {
    oldBranches.resolve(response({ branches: ['stale-main'], localBranches: ['stale-main'] }));
    oldRemote.resolve(response({ branch: 'stale-main', ahead: 99 }));
  });
  const state = JSON.parse(screen.getByLabelText('repository state').textContent!);
  expect(state.branches).toEqual(['feature']);
  expect(state.remoteStatus.branch).toBe('feature');
});

test('switching folders clears a pending Git confirmation without changing the selected tool tab', () => {
  const view = render(<GitPanel selectedProject={main} />);
  fireEvent.click(screen.getByRole('tab', { name: 'git:tabs.worktrees' }));
  fireEvent.click(screen.getByRole('button', { name: 'Request switch' }));
  expect(screen.getByRole('dialog')).toBeDefined();
  view.rerender(<GitPanel selectedProject={worktree} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByLabelText('worktree directory').textContent).toBe(worktree.fullPath);
  expect(api.git.checkout).not.toHaveBeenCalled();
});

test('a late file diff cannot reopen the previous conversation editor', async () => {
  const pending = deferred<Response>();
  api.git.fileWithDiff.mockReturnValue(pending.promise);
  const onFileOpen = vi.fn();
  const view = render(<GitPanel selectedProject={main} onFileOpen={onFileOpen} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open changed file' }));
  view.rerender(<GitPanel selectedProject={worktree} onFileOpen={onFileOpen} />);
  await act(async () => { pending.resolve(response({ oldContent: 'old main', currentContent: 'changed main' })); });
  expect(onFileOpen).not.toHaveBeenCalled();
});

test.each(['open', 'create'] as const)('a late worktree %s result cannot navigate after its source panel was replaced', async operation => {
  const pending = deferred<Response>();
  api.worktrees[operation].mockReturnValue(pending.promise);
  const onProjectSelect = vi.fn();
  const hook = renderHook(() => useWorktreesController({ selectedProject: main, onProjectSelect }));
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  let completion!: Promise<boolean>;
  act(() => { completion = operation === 'open' ? hook.result.current.openWorktree(worktree.fullPath) : hook.result.current.createWorktree('feature', 'main', true); });
  hook.unmount();
  await act(async () => {
    pending.resolve(response({ success: true, data: { project: worktree } }));
    expect(await completion).toBe(false);
  });
  expect(onProjectSelect).not.toHaveBeenCalled();
});
